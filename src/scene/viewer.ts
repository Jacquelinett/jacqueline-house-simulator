import { Application, Container, Graphics, Polygon, Text } from "pixi.js";
import { findActivityById } from "./activities";
import { findObjectForActivityLabel, gridToScreen, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";

export { preloadRoomAssets } from "./renderer";

const LABEL_PADDING_X = 6;
const LABEL_PADDING_Y = 3;
const LABEL_GAP = 4; // above the object's own top edge

export interface ViewerCharacterStatus {
  characterId: string;
  characterName: string;
  activityLabel: string;
}

/**
 * Read-only house view for the public status page. Room navigation (click a
 * room, or an object's "navigate" action like a staircase) works the same as
 * the desktop app — it's just looking around, not doing anything. Clicking
 * an "activity" object shows a floating label with its name (e.g. "Piano"),
 * same as always; on desktop width, if that activity is currently
 * attributed to one of the known characters (see applyAllStatuses), the
 * click also switches the viewer straight to them via onCharacterClick —
 * the viewer's own equivalent of House.ts's peek-at-another-character
 * click, except there's no "mine" to protect (the viewer never starts/
 * stops tracking), so a single click is enough, no double-click gate
 * needed. Mobile keeps today's label-only behavior — it already has its
 * own switcher via the mobile title button (see viewer-main.ts).
 */
export class HouseViewer extends SceneRenderer {
  private activeLabel: Container | null = null;
  private allStatuses = new Map<string, ViewerCharacterStatus>();

  constructor(
    app: Application,
    onRoomChange: (roomName: string) => void,
    initial: { devMode: boolean; scale: number },
    private onCharacterClick: (character: { id: string; name: string }) => void,
  ) {
    super(app, onRoomChange, initial);
  }

  /** Pans the camera to whichever object the SELECTED character is currently doing — never touches overlay visibility, which now reflects every known character (see applyAllStatuses below). */
  public focusActivity(label: string | null) {
    if (label) {
      const found = findObjectForActivityLabel(label);
      if (found) this.setViewedRoom(found.roomId, found.objectId);
    }
  }

  /**
   * Recomputes which objects' overlays should be visible from EVERY known
   * character's current activity, not just the one currently selected —
   * the viewer's own equivalent of House.ts's applyAllStatuses, fed by
   * polling val.town's per-character status blobs instead of a WebSocket
   * broadcast. Never moves the camera; only a deliberate click does that.
   */
  public applyAllStatuses(allStatuses: Map<string, ViewerCharacterStatus>) {
    this.allStatuses = allStatuses;
    const labels = new Set(Array.from(allStatuses.values()).map((entry) => entry.activityLabel));
    this.updateActiveOverlays(labels);
  }

  /** Who (if anyone) is currently running `label`, per the last applyAllStatuses — no "mine wins" tie-break needed here, unlike House.ts's own version, since the viewer has no "mine" at all. */
  private attributionFor(label: string): { id: string; name: string } | null {
    for (const entry of this.allStatuses.values()) {
      if (entry.activityLabel === label) return { id: entry.characterId, name: entry.characterName };
    }
    return null;
  }

  protected attachRoomInteraction(container: Container, room: RoomDef) {
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    container.eventMode = "static";
    container.hitArea = new Polygon([back.x, back.y, right.x, right.y, front.x, front.y, left.x, left.y]);
    // Mobile has no manual room navigation at all — the scene only ever
    // moves because the running activity changed (see showActivity), never
    // because of a tap on the canvas itself.
    container.on("pointertap", () => {
      if (!this.isMobileLayout()) this.setViewedRoom(room.id);
    });
  }

  protected attachObjectInteraction(container: Container, roomId: number, obj: ObjectDef) {
    if (!obj.actions?.length) return;

    const navigateAction = obj.actions.find((a) => a.kind === "navigate");
    const activityAction = obj.actions.find((a) => a.kind === "activity");

    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      if (navigateAction) {
        if (!this.isMobileLayout()) this.setViewedRoom(navigateAction.roomId);
        return;
      }

      // The name label is informational, not navigation — keep it
      // working on mobile even though the camera itself won't move.
      if (!this.isMobileLayout()) this.setViewedRoom(roomId, obj.id);
      this.toggleLabel(container, obj);

      // Desktop-width only (same reasoning House.ts's own click-to-peek
      // uses isMobileLayout for): if someone's actually doing this right
      // now, jump the whole viewer to them instead of making the click
      // just look.
      if (!this.isMobileLayout() && activityAction) {
        const label = findActivityById(activityAction.activityId)?.label;
        const attribution = label ? this.attributionFor(label) : null;
        if (attribution) this.onCharacterClick(attribution);
      }
    });
  }

  private toggleLabel(container: Container, obj: ObjectDef) {
    if (this.activeLabel?.parent === container) {
      container.removeChild(this.activeLabel);
      this.activeLabel = null;
      return;
    }
    this.activeLabel?.parent?.removeChild(this.activeLabel);

    // The label sits inside `world`, which the current zoom scales up — a
    // text texture rendered at the default 1x resolution then gets stretched
    // by that transform, which is what was reading as blurry. Rendering it
    // at a resolution matching the zoom (and the display's own pixel ratio)
    // keeps it crisp at any scale.
    const text = new Text({
      text: obj.name,
      style: { fontSize: 12, fill: 0xffffff, fontFamily: "sans-serif" },
      resolution: this.scale * (window.devicePixelRatio || 1),
    });
    text.anchor.set(0.5, 0.5);

    const background = new Graphics()
      .roundRect(
        -text.width / 2 - LABEL_PADDING_X,
        -text.height / 2 - LABEL_PADDING_Y,
        text.width + LABEL_PADDING_X * 2,
        text.height + LABEL_PADDING_Y * 2,
        4,
      )
      .fill({ color: 0x000000, alpha: 0.6 });

    const label = new Container();
    label.addChild(background, text);
    label.position.set(obj.width / 2, -(text.height / 2 + LABEL_PADDING_Y + LABEL_GAP));
    container.addChild(label);
    this.activeLabel = label;
  }
}

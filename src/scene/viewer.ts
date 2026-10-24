import { Application, Container, Polygon } from "pixi.js";
import { findActivityById } from "./activities";
import { findObjectForActivityLabel, gridToScreen, ObjectDef, RoomDef } from "./rooms";
import { OverlayAttribution, SceneRenderer } from "./renderer";

export { preloadRoomAssets } from "./renderer";

export interface ViewerCharacterStatus {
  characterId: string;
  characterName: string;
  characterSpriteName: string | null;
  activityLabel: string;
}

/**
 * Read-only house view for the public status page. Every click recenters
 * the camera on whatever was clicked, period — no menu, ever: the viewer
 * never executes anything, so there's nothing to choose between the way
 * House.ts's picker lets you choose between running an activity yourself
 * or peeking at who's already doing it. If any of the clicked object's
 * activity actions is currently attributed to someone, the click ALSO
 * switches the viewer straight to them (desktop width only) via
 * onCharacterClick. A lone `goTo` action is the one exception — it
 * navigates to the TARGET room instead of recentering on this object.
 * Mobile only ever recenters, never switches character — it already has
 * its own switcher via the mobile title button (see viewer-main.ts).
 */
export class HouseViewer extends SceneRenderer {
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
    const byLabel = new Map<string, OverlayAttribution>();
    for (const entry of allStatuses.values()) {
      byLabel.set(entry.activityLabel, {
        characterId: entry.characterId,
        characterName: entry.characterName,
        characterSpriteName: entry.characterSpriteName,
      });
    }
    this.updateActiveOverlays(byLabel, allStatuses.size);
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
    // See House.ts's own comment — same guarantee on the viewer's side.
    if (obj.clickable === false) {
      container.eventMode = "none";
      return;
    }

    const actions = obj.actions ?? [];

    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;

    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too

      // A lone goTo is the one exception that doesn't recenter on THIS
      // object — it navigates to the target room instead.
      if (actions.length === 1 && actions[0].kind === "goTo") {
        if (!this.isMobileLayout()) this.setViewedRoom(actions[0].roomId);
        return;
      }

      if (!this.isMobileLayout()) this.setViewedRoom(roomId, obj.id);

      // Desktop-width only (same reasoning House.ts's own peek click uses
      // isMobileLayout for) — switch to whoever's attributed to any of
      // this object's activity actions, if anyone. First match wins; an
      // object is never expected to have two activity actions both "in
      // use" by different people at once.
      if (this.isMobileLayout()) return;
      for (const action of actions) {
        if (action.kind !== "activity") continue;
        const label = findActivityById(action.activityId)?.label;
        const attribution = label ? this.attributionFor(label) : null;
        if (attribution) {
          this.onCharacterClick(attribution);
          break;
        }
      }
    });
  }
}

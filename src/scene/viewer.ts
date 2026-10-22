import { Container, Graphics, Polygon, Text } from "pixi.js";
import { findObjectForActivityLabel, gridToScreen, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";

export { preloadRoomAssets } from "./renderer";

const LABEL_PADDING_X = 6;
const LABEL_PADDING_Y = 3;
const LABEL_GAP = 4; // above the object's own top edge

/**
 * Read-only house view for the public status page. Room navigation (click a
 * room, or an object's "navigate" action like a staircase) works the same as
 * the desktop app — it's just looking around, not doing anything. Clicking
 * an "activity" object instead only shows a floating label with its name
 * (e.g. "Piano") — never starts/stops tracking, since a viewer has no AW
 * access and shouldn't be able to change what's running regardless.
 */
export class HouseViewer extends SceneRenderer {
  private activeLabel: Container | null = null;

  /** Highlights whichever activity is currently running and follows its object. */
  public showActivity(current: { label: string } | null) {
    this.updateActiveOverlays(current);
    if (current) {
      const found = findObjectForActivityLabel(current.label);
      if (found) this.setViewedRoom(found.roomId, found.objectId);
    }
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

    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      if (navigateAction) {
        if (!this.isMobileLayout()) this.setViewedRoom(navigateAction.roomId);
      } else {
        // The name label is informational, not navigation — keep it
        // working on mobile even though the camera itself won't move.
        if (!this.isMobileLayout()) this.setViewedRoom(roomId, obj.id);
        this.toggleLabel(container, obj);
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

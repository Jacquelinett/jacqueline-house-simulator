import { Container, Polygon, Text } from "pixi.js";
import { findRoomForActivityLabel, gridToScreen, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";

export { preloadRoomAssets } from "./renderer";

/**
 * Read-only house view for the public status page. Room navigation (click a
 * room, or an object's "navigate" action like a staircase) works the same as
 * the desktop app — it's just looking around, not doing anything. Clicking
 * an "activity" object instead only shows a floating label with its name
 * (e.g. "Piano") — never starts/stops tracking, since a viewer has no AW
 * access and shouldn't be able to change what's running regardless.
 */
export class HouseViewer extends SceneRenderer {
  private activeLabel: Text | null = null;

  /** Highlights whichever activity is currently running and follows its room. */
  public showActivity(current: { label: string } | null) {
    this.updateActiveOverlays(current);
    if (current) {
      const roomId = findRoomForActivityLabel(current.label);
      if (roomId) this.setViewedRoom(roomId);
    }
  }

  protected attachRoomInteraction(container: Container, room: RoomDef) {
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    container.eventMode = "static";
    container.hitArea = new Polygon([back.x, back.y, right.x, right.y, front.x, front.y, left.x, left.y]);
    container.on("pointertap", () => this.setViewedRoom(room.id));
  }

  protected attachObjectInteraction(container: Container, _roomId: string, obj: ObjectDef) {
    if (!obj.actions?.length) return;

    const navigateAction = obj.actions.find((a) => a.kind === "navigate");

    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      if (navigateAction) {
        this.setViewedRoom(navigateAction.roomId);
      } else {
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

    const label = new Text({
      text: obj.name,
      style: { fontSize: 12, fill: 0xffffff, fontFamily: "sans-serif" },
    });
    label.anchor.set(0.5, 1);
    label.position.set(obj.width / 2, -4);
    container.addChild(label);
    this.activeLabel = label;
  }
}

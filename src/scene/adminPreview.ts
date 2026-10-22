import { Container, Polygon } from "pixi.js";
import { gridToScreen, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";

/**
 * Read-only preview renderer for the admin tool — same house scene as the
 * game/viewer (reused via SceneRenderer, not reimplemented), but the only
 * interaction is "click a room to focus it" (for getting around the house)
 * and "click an object to select it" (reported via onObjectClick, which
 * admin-main.ts uses to scroll/highlight the matching row in the plain
 * list below — not drag-to-reposition; see this file's own module-level
 * comment in admin-main.ts for why that's out of scope tonight).
 */
export class AdminPreviewRenderer extends SceneRenderer {
  constructor(
    app: ConstructorParameters<typeof SceneRenderer>[0],
    onRoomChange: (roomName: string) => void,
    private onObjectClick: (roomId: string, objectId: string) => void,
  ) {
    super(app, onRoomChange, { devMode: false, scale: 1.5 });
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

  protected attachObjectInteraction(container: Container, roomId: string, obj: ObjectDef) {
    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation();
      this.onObjectClick(roomId, obj.id);
    });
  }
}

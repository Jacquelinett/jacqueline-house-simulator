import { Application, Container, Polygon } from "pixi.js";
import { findRoomForActivityLabel, gridToScreen, ObjectAction, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";
import { getCurrentActivity, RunningActivity, startActivity, stopActivity } from "../aw/client";

export { preloadRoomAssets } from "./renderer";

/** Adds click/interaction handling (and AW integration) on top of the shared scene renderer — the desktop app's interactive view. */
export class House extends SceneRenderer {
  private menuEl: HTMLDivElement | null = null;

  constructor(
    app: Application,
    private onActivityChange: (current: RunningActivity | null) => void,
    onRoomChange: (roomName: string) => void,
    initial: { devMode: boolean; scale: number },
  ) {
    super(app, onRoomChange, initial);
    app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  protected attachRoomInteraction(container: Container, room: RoomDef) {
    // A rectangle bounding box is much wider than the room's actual diamond
    // floor, so adjacent connected rooms' rectangular hit areas overlap
    // heavily even though their tiles don't — whichever room was added later
    // then swallows clicks meant for the earlier one in that overlap zone.
    // Using the real floor polygon (same corners as the dev-mode outline)
    // avoids that entirely.
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    container.eventMode = "static";
    container.hitArea = new Polygon([back.x, back.y, right.x, right.y, front.x, front.y, left.x, left.y]);
    container.on("pointertap", () => this.setViewedRoom(room.id));
  }

  protected attachObjectInteraction(container: Container, roomId: string, obj: ObjectDef) {
    if (!obj.actions?.length) return;

    container.eventMode = "static";
    container.cursor = "pointer";
    // Without this, Pixi still hit-tests individual children, and sparse
    // art (e.g. the thin vine overlay in piano_top.png) only registers
    // clicks where it happens to have opaque pixels — not the full box.
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      if (obj.actions!.length === 1) {
        this.runAction(roomId, obj.actions![0]);
      } else {
        const native = e.nativeEvent as MouseEvent;
        this.openMenu(roomId, obj.actions!, native.clientX, native.clientY);
      }
    });
    container.on("rightclick", (e) => {
      e.stopPropagation();
      const native = e.nativeEvent as MouseEvent;
      this.openMenu(roomId, obj.actions!, native.clientX, native.clientY);
    });
  }

  private runAction(roomId: string, action: ObjectAction) {
    if (action.kind === "navigate") {
      this.setViewedRoom(action.roomId);
      return;
    }

    const current = getCurrentActivity();
    const op = current?.label === action.label ? stopActivity() : startActivity(action.label);
    op.then(() => {
      this.setViewedRoom(roomId);
      const current = getCurrentActivity();
      this.updateActiveOverlays(current);
      this.onActivityChange(current);
    }).catch((err) => console.error("[house] action failed", err));
  }

  private openMenu(roomId: string, actions: ObjectAction[], clientX: number, clientY: number) {
    this.closeMenu();

    const menu = document.createElement("div");
    menu.className = "object-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.kind === "activity" ? action.label : `Go to ${action.roomId}`;
      btn.onclick = () => {
        this.runAction(roomId, action);
        this.closeMenu();
      };
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.menuEl = menu;

    const closeOnOutside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) this.closeMenu();
    };
    // Defer attaching so the same right-click that opened the menu doesn't also close it.
    setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, { once: true }), 0);
  }

  private closeMenu() {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  /** Re-applies a running activity recovered from AW on startup — same visual effects as clicking its object. */
  public resumeActivity(current: RunningActivity) {
    this.updateActiveOverlays(current);
    const roomId = findRoomForActivityLabel(current.label);
    if (roomId) this.setViewedRoom(roomId);
    this.onActivityChange(current);
  }
}

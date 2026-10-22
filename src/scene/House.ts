import { Application, Container, Polygon } from "pixi.js";
import { findRoomForActivityLabel, gridToScreen, ObjectAction, ObjectDef, RoomDef } from "./rooms";
import { SceneRenderer } from "./renderer";
import { getRemoteStatus, RemoteStatus, sendCommand } from "../client/remoteState";

export { preloadRoomAssets } from "./renderer";

/** Adds click/interaction handling on top of the shared scene renderer — the desktop app's interactive view. Starting/stopping activities is a fire-and-forget command to the Node server now; the overlay highlight and (on startup only) camera focus are driven back by its `status` broadcast via applyRemoteStatus(), not by awaiting the command itself. */
export class House extends SceneRenderer {
  private menuEl: HTMLDivElement | null = null;
  // Which object actually started the currently-running activity — distinct
  // from the activity's label, since two different objects (e.g. a second
  // piano elsewhere) can share a label. null means "unknown" (e.g. right
  // after the server resumes an activity from before this client connected),
  // treated as "assume it's this one" rather than refusing to stop an
  // activity we can't otherwise attribute. Only ever set here, from this
  // client's own clicks — never touched by applyRemoteStatus, so an
  // in-flight click's optimistic attribution isn't wiped out by the status
  // broadcast echoing its own change straight back.
  private currentActivitySource: { roomId: string; objectId: string } | null = null;

  constructor(
    app: Application,
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
        this.runAction(roomId, obj.id, obj.actions![0]);
      } else {
        const native = e.nativeEvent as MouseEvent;
        this.openMenu(roomId, obj.id, obj.actions!, native.clientX, native.clientY);
      }
    });
    container.on("rightclick", (e) => {
      e.stopPropagation();
      const native = e.nativeEvent as MouseEvent;
      this.openMenu(roomId, obj.id, obj.actions!, native.clientX, native.clientY);
    });
  }

  private runAction(roomId: string, objectId: string, action: ObjectAction) {
    if (action.kind === "navigate") {
      this.setViewedRoom(action.roomId);
      return;
    }

    const current = getRemoteStatus();
    const isSameLabel = current.activityLabel === action.label;
    // A different object representing the same ongoing activity (e.g. a
    // second piano elsewhere) shouldn't stop it just by being clicked —
    // only the object that's actually running it (or an unattributed
    // source) toggles it off; anything else just looks at it.
    const isDifferentSource =
      isSameLabel &&
      this.currentActivitySource !== null &&
      (this.currentActivitySource.roomId !== roomId || this.currentActivitySource.objectId !== objectId);

    if (isDifferentSource) {
      this.setViewedRoom(roomId);
      return;
    }

    this.currentActivitySource = isSameLabel ? null : { roomId, objectId };
    this.setViewedRoom(roomId);
    if (isSameLabel) sendCommand("stopActivity");
    else sendCommand("startActivity", { label: action.label });
  }

  private openMenu(roomId: string, objectId: string, actions: ObjectAction[], clientX: number, clientY: number) {
    this.closeMenu();

    const menu = document.createElement("div");
    menu.className = "object-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.kind === "activity" ? action.label : `Go to ${action.roomId}`;
      btn.onclick = () => {
        this.runAction(roomId, objectId, action);
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

  /**
   * Syncs the overlay highlight and camera focus to the server's
   * current-activity broadcast — called once right after connecting (same
   * as the old startup-only AW resume behavior) and again every time the
   * broadcast changes thereafter, including a change from a different
   * device: seeing someone else start something is exactly the kind of
   * "what's happening in the house right now" visibility multi-device
   * access is for, so the camera follows every time, not just on connect.
   */
  public applyRemoteStatus(status: RemoteStatus) {
    this.updateActiveOverlays(status.activityLabel ? { label: status.activityLabel } : null);
    if (status.activityLabel) {
      const roomId = findRoomForActivityLabel(status.activityLabel);
      if (roomId) this.setViewedRoom(roomId);
    }
  }

  /**
   * Start/stop an activity by label with no associated clicked object —
   * used by the mobile Pick Action list, which picks from the flat
   * ACTIVITIES registry rather than tapping a specific object in a
   * specific room. Same start/stop-toggle + camera-focus as runAction(),
   * just always treated as an unattributed source (same "assume it's this
   * one" rule used for an activity resumed before this client connected).
   */
  public toggleActivity(label: string): void {
    const current = getRemoteStatus();
    const isSameLabel = current.activityLabel === label;

    if (isSameLabel) sendCommand("stopActivity");
    else sendCommand("startActivity", { label });
    this.currentActivitySource = null;

    const roomId = findRoomForActivityLabel(label);
    if (roomId) this.setViewedRoom(roomId);
  }
}

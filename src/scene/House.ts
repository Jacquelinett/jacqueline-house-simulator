import { Application, Container, Polygon } from "pixi.js";
import { findObjectForActivityLabel, gridToScreen, ObjectAction, ObjectDef, RoomDef } from "./rooms";
import { findActivityById } from "./activities";
import { SceneRenderer } from "./renderer";
import { AllStatusesEntry, getAllStatuses, getCharacter, getRemoteStatus, RemoteStatus, sendCommand } from "../client/remoteState";
import { setViewingCharacter } from "../dashboard/viewingCharacter";

export { preloadRoomAssets } from "./renderer";

// Mobile has no floor buttons and nowhere obvious to go otherwise — used
// only when toggleActivity() (the mobile Pick Action list) starts an
// activity with no object of its own to focus instead.
const FALLBACK_ROOM_ID = 1; // Jacqueline's Office

const DOUBLE_CLICK_WINDOW_MS = 400;

/**
 * Detects a double-click/double-tap on the same key within a short
 * window — the one small reusable primitive behind the single/double
 * click distinction in attachObjectInteraction below (a single click on
 * another character's active object peeks at their dashboard; a second
 * click on the SAME object within the window proceeds to actually run
 * the action). Keyed by a plain string rather than tied to object clicks
 * specifically, so anything else that ever needs "are these two taps the
 * same gesture" can reuse it instead of re-inventing timestamp tracking.
 */
class DoubleClickTracker {
  private lastKey: string | null = null;
  private lastAt = 0;

  /** True if this call is the second half of a double-click on `key` — consumes it either way, so a third click starts a fresh single rather than chaining into another "double." */
  check(key: string): boolean {
    const now = Date.now();
    const isDouble = this.lastKey === key && now - this.lastAt < DOUBLE_CLICK_WINDOW_MS;
    this.lastKey = isDouble ? null : key;
    this.lastAt = now;
    return isDouble;
  }
}

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
  private currentActivitySource: { roomId: number; objectId: number } | null = null;
  private objectClickTracker = new DoubleClickTracker();

  constructor(
    app: Application,
    onRoomChange: (roomName: string) => void,
    initial: { devMode: boolean; scale: number },
  ) {
    super(app, onRoomChange, initial);
    app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // Clears "peeking at someone else's dashboard" on literally any click,
    // including empty space — a raw DOM listener rather than a Pixi one,
    // specifically so it still fires even when nothing in the scene was
    // actually hit. Native pointerdown fires before Pixi's own synthetic
    // pointertap, so a click that's ABOUT to set a new viewing character
    // (see attachObjectInteraction below) still ends up correct: clear,
    // then set, within the same gesture.
    app.canvas.addEventListener("pointerdown", () => setViewingCharacter(null));
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
    // Mobile has no manual room navigation at all — the scene only ever
    // moves because the running activity changed (see applyRemoteStatus),
    // never because of a tap on the canvas itself.
    container.on("pointertap", () => {
      if (!this.isMobileLayout()) this.setViewedRoom(room.id);
    });
  }

  protected attachObjectInteraction(container: Container, roomId: number, obj: ObjectDef) {
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
        this.handleObjectClick(roomId, obj.id, obj.actions![0]);
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

  /**
   * Gate in front of runAction(), for the single-default-action click path
   * only — a multi-action object's menu (e.g. the PC's gaming/streaming
   * choice) still opens directly via openMenu below; not addressed here,
   * every example of this feature was a single-action object. On desktop,
   * if this action's activity is currently attributed to someone ELSE (not
   * me — see attributionFor), the first click just looks: peeks at their
   * Dashboard and still pans the camera there (a deliberate click, unlike
   * passively seeing their overlay appear — see applyAllStatuses, which
   * never moves the camera), but doesn't touch tracking. A second click on
   * the same object within the double-click window falls through to the
   * normal runAction instead. Mobile skips all of this (same
   * `isMobileLayout()` gate already used for camera panning) — it manages
   * activities through the Pick Action wheel, not by tapping objects, and
   * a double-tap requirement doesn't fit that model.
   */
  private handleObjectClick(roomId: number, objectId: number, action: ObjectAction) {
    if (action.kind === "activity" && !this.isMobileLayout()) {
      const label = findActivityById(action.activityId)?.label;
      const attribution = label ? this.attributionFor(label) : null;
      if (attribution && !attribution.isMine) {
        const isSecondClick = this.objectClickTracker.check(`${roomId}:${objectId}`);
        if (!isSecondClick) {
          setViewingCharacter({ id: attribution.characterId, name: attribution.characterName });
          this.setViewedRoom(roomId, objectId);
          return;
        }
      }
    }
    this.runAction(roomId, objectId, action);
  }

  /** Who (if anyone) is currently running `label` right now — mine wins when both apply, since there's no separate art to otherwise break the tie with (see renderer.ts's updateActiveOverlays). */
  private attributionFor(label: string): { characterId: string; characterName: string; isMine: boolean } | null {
    if (getRemoteStatus().activityLabel === label) {
      const me = getCharacter();
      return { characterId: me.id, characterName: me.name, isMine: true };
    }
    for (const [characterId, entry] of Object.entries(getAllStatuses())) {
      if (entry.activityLabel === label) return { characterId, characterName: entry.characterName, isMine: false };
    }
    return null;
  }

  private runAction(roomId: number, objectId: number, action: ObjectAction) {
    if (action.kind === "navigate") {
      // Mobile: nothing left to do here at all — no object is being
      // toggled, and panning to the destination room is exactly the
      // manual navigation mobile doesn't get.
      if (!this.isMobileLayout()) this.setViewedRoom(action.roomId);
      return;
    }

    const activityLabel = findActivityById(action.activityId)?.label;
    const current = getRemoteStatus();
    const isSameLabel = current.activityLabel === activityLabel;
    // A different object representing the same ongoing activity (e.g. a
    // second piano elsewhere) shouldn't stop it just by being clicked —
    // only the object that's actually running it (or an unattributed
    // source) toggles it off; anything else just looks at it.
    const isDifferentSource =
      isSameLabel &&
      this.currentActivitySource !== null &&
      (this.currentActivitySource.roomId !== roomId || this.currentActivitySource.objectId !== objectId);

    if (isDifferentSource) {
      if (!this.isMobileLayout()) this.setViewedRoom(roomId, objectId);
      return;
    }

    this.currentActivitySource = isSameLabel ? null : { roomId, objectId };
    // On mobile, the click still starts/stops the activity below — it just
    // doesn't pan on its own; applyRemoteStatus() does that once the
    // server's status broadcast confirms the change, so the camera still
    // ends up on the right object, just reactively instead of optimistically.
    if (!this.isMobileLayout()) this.setViewedRoom(roomId, objectId);
    if (isSameLabel) sendCommand("stopActivity");
    else if (activityLabel) sendCommand("startActivity", { label: activityLabel });
  }

  private openMenu(roomId: number, objectId: number, actions: ObjectAction[], clientX: number, clientY: number) {
    this.closeMenu();

    const menu = document.createElement("div");
    menu.className = "object-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.kind === "activity" ? findActivityById(action.activityId)?.label ?? "?" : `Go to ${action.roomId}`;
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
   * Syncs camera focus to the server's current-activity broadcast — called
   * once right after connecting (same as the old startup-only AW resume
   * behavior) and again every time the broadcast changes thereafter,
   * including a change from a different device: seeing someone else start
   * something IS exactly the kind of "what's happening in the house right
   * now" visibility multi-device access is for, so the camera follows
   * every time, not just on connect. This is still scoped to MY OWN
   * character's broadcast only — overlay visibility (which now also
   * reflects every OTHER character) moved to applyAllStatuses below, since
   * seeing that another character started something should never yank
   * your camera the way your own activity changing does.
   */
  public applyRemoteStatus(status: RemoteStatus) {
    if (status.activityLabel) {
      const found = findObjectForActivityLabel(status.activityLabel);
      if (found) this.setViewedRoom(found.roomId, found.objectId);
    }
  }

  /**
   * Recomputes which objects' overlays should be visible from EVERY
   * character's current activity, mine included (computeAllStatuses
   * server-side already covers every character, not just others) — never
   * moves the camera, unlike applyRemoteStatus above. Seeing that Kevin
   * started something should make his object light up without touching
   * where Jacqueline is currently looking; only a deliberate click does
   * that (see handleObjectClick).
   */
  public applyAllStatuses(allStatuses: Record<string, AllStatusesEntry>) {
    const labels = new Set(Object.values(allStatuses).map((entry) => entry.activityLabel));
    this.updateActiveOverlays(labels);
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
    this.currentActivitySource = null;

    if (isSameLabel) {
      sendCommand("stopActivity");
      return;
    }

    sendCommand("startActivity", { label });
    // Always pan here, mobile or not — this is the one deliberate "picking
    // an action" entry point mobile keeps (no floor buttons, no clicking
    // around otherwise). Falls back to a fixed room when this activity has
    // no object of its own to focus instead of just leaving the camera
    // wherever it happened to be.
    const found = findObjectForActivityLabel(label);
    this.setViewedRoom(found?.roomId ?? FALLBACK_ROOM_ID, found?.objectId ?? null);
  }
}

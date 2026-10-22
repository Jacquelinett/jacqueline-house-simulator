import { Application, Container, Polygon } from "pixi.js";
import { findObjectForActivityLabel, gridToScreen, ObjectDef, rooms, RoomDef } from "./rooms";
import { findActivityById } from "./activities";
import { SceneRenderer } from "./renderer";
import { ActionEnvironment, describeAction, DoubleClickTracker, dispatchObjectClick, effectiveActions, runAction } from "./actionDispatch";
import { openActionPicker } from "../ui/actionPicker";
import { AllStatusesEntry, getAllStatuses, getCharacter, getRemoteStatus, RemoteStatus, sendCommand } from "../client/remoteState";
import { setViewingCharacter } from "../dashboard/viewingCharacter";

export { preloadRoomAssets } from "./renderer";

// Mobile has no floor buttons and nowhere obvious to go otherwise — used
// only when toggleActivity() (the mobile Pick Action list) starts an
// activity with no object of its own to focus instead.
const FALLBACK_ROOM_ID = 1; // Jacqueline's Office

/** Adds click/interaction handling on top of the shared scene renderer — the desktop app's interactive view. Starting/stopping activities is a fire-and-forget command to the Node server now; the overlay highlight and (on startup only) camera focus are driven back by its `status` broadcast via applyRemoteStatus(), not by awaiting the command itself. */
export class House extends SceneRenderer {
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
    // (see onActivity below) still ends up correct: clear, then set,
    // within the same gesture.
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
    const actions = effectiveActions(obj.actions);

    container.eventMode = "static";
    container.cursor = "pointer";
    // Without this, Pixi still hit-tests individual children, and sparse
    // art (e.g. the thin vine overlay in piano_top.png) only registers
    // clicks where it happens to have opaque pixels — not the full box.
    container.interactiveChildren = false;

    // onActivity is deliberately ungated here — the peek-before-acting
    // check (attemptActivityPeek below) only ever runs as a pre-check in
    // front of dispatchObjectClick, for the single-default-action click
    // path specifically. A multi-action object's menu (left-click or
    // right-click) always runs whatever got picked immediately — a menu
    // selection is already a deliberate enough choice to skip the gate,
    // same as the object's original behavior before this was shared.
    const env: ActionEnvironment = {
      onView: () => {
        if (!this.isMobileLayout()) this.setViewedRoom(roomId, obj.id);
      },
      onGoTo: (targetRoomId) => {
        // Mobile: nothing left to do here at all — no object is being
        // toggled, and panning to the destination room is exactly the
        // manual navigation mobile doesn't get.
        if (!this.isMobileLayout()) this.setViewedRoom(targetRoomId);
      },
      onActivity: (activityId) => this.runActivity(roomId, obj.id, activityId),
    };
    const openPicker = (pickFrom: typeof actions, run: (action: typeof actions[number]) => void, clientX: number, clientY: number) =>
      openActionPicker(
        clientX,
        clientY,
        pickFrom.map((action) => ({
          label: describeAction(
            action,
            (id) => findActivityById(id)?.label,
            (id) => rooms.find((r) => r.id === id)?.name,
          ),
          onclick: () => run(action),
        })),
      );

    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      const native = e.nativeEvent as MouseEvent;
      const onlyAction = actions.length === 1 ? actions[0] : null;
      if (onlyAction?.kind === "activity" && this.attemptActivityPeek(roomId, obj.id, onlyAction.activityId)) return;
      dispatchObjectClick(actions, env, (pickFrom, run) => openPicker(pickFrom, run, native.clientX, native.clientY));
    });
    // Right-click always shows every action, even for a single-action
    // object — the one deliberate way to reach, say, a piano's "View"
    // without starting/stopping tracking.
    container.on("rightclick", (e) => {
      e.stopPropagation();
      const native = e.nativeEvent as MouseEvent;
      openPicker(actions, (action) => runAction(action, env), native.clientX, native.clientY);
    });
  }

  /**
   * Pre-check in front of the plain single-click default-action path
   * only — a multi-action object's menu (left-click or right-click)
   * never reaches this at all, see attachObjectInteraction above. If
   * this activity is currently attributed to someone ELSE (not me — see
   * attributionFor), the first click just looks: peeks at their Dashboard
   * and still pans the camera there (a deliberate click, unlike passively
   * seeing their overlay appear — see applyAllStatuses, which never moves
   * the camera), but doesn't touch tracking. A second click on the same
   * object within the double-click window returns false, letting the
   * normal runActivity proceed. Mobile skips all of this (same
   * `isMobileLayout()` gate already used for camera panning) — it
   * manages activities through the Pick Action wheel, not by tapping
   * objects, and a double-tap requirement doesn't fit that model.
   */
  private attemptActivityPeek(roomId: number, objectId: number, activityId: number): boolean {
    if (this.isMobileLayout()) return false;
    const label = findActivityById(activityId)?.label;
    const attribution = label ? this.attributionFor(label) : null;
    if (!attribution || attribution.isMine) return false;
    if (this.objectClickTracker.check(`${roomId}:${objectId}`)) return false; // second click — let it through to runActivity
    setViewingCharacter({ id: attribution.characterId, name: attribution.characterName });
    this.setViewedRoom(roomId, objectId);
    return true;
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

  private runActivity(roomId: number, objectId: number, activityId: number) {
    const activityLabel = findActivityById(activityId)?.label;
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
   * that (see attemptActivityPeek/runActivity).
   */
  public applyAllStatuses(allStatuses: Record<string, AllStatusesEntry>) {
    const labels = new Set(Object.values(allStatuses).map((entry) => entry.activityLabel));
    this.updateActiveOverlays(labels);
  }

  /**
   * Start/stop an activity by label with no associated clicked object —
   * used by the mobile Pick Action list, which picks from the flat
   * ACTIVITIES registry rather than tapping a specific object in a
   * specific room. Same start/stop-toggle + camera-focus as runActivity(),
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

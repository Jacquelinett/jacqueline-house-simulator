import { Application, Container, Polygon } from "pixi.js";
import { findObjectForActivityLabel, gridToScreen, ObjectAction, ObjectDef, RoomDef } from "./rooms";
import { findActivityById } from "./activities";
import { OverlayAttribution, SceneRenderer } from "./renderer";
import { describeAction } from "./actionDispatch";
import { openActionPicker } from "../ui/actionPicker";
import { AllStatusesEntry, getAllStatuses, getCharacter, getRemoteStatus, RemoteStatus, sendCommand } from "../client/remoteState";
import { setViewingCharacter } from "../dashboard/viewingCharacter";

export { preloadRoomAssets } from "./renderer";

// Mobile has no floor buttons and nowhere obvious to go otherwise — used
// only when pickActivity() (the mobile Pick Action list) starts an
// activity with no object of its own to focus instead.
const FALLBACK_ROOM_ID = 1; // Jacqueline's Office

/**
 * Adds click/interaction handling on top of the shared scene renderer — the
 * desktop app's interactive view. Starting activities is a fire-and-forget
 * command to the Node server now; the overlay highlight and (on startup
 * only) camera focus are driven back by its `status` broadcast via
 * applyRemoteStatus(), not by awaiting the command itself.
 *
 * Stopping is NOT done by clicking an object/action anymore — that used to
 * be "click the already-running one again," but that made any object with
 * 2+ actions ambiguous (pick a different action, or stop the running one?)
 * and meant the only way to stop was remembering which object you started
 * from. Stopping is now exclusively the dedicated red Stop Activity control
 * (see goals/panel.ts's setupJacquelineStatus, shown only while something
 * is running) — see runActivity()'s own comment for what re-clicking a
 * running action does instead.
 */
export class House extends SceneRenderer {
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
    // still ends up correct: clear, then set, within the same gesture.
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

  /**
   * Every click recenters the camera on whatever was clicked — there's no
   * "view" action to opt into, it's just what clicking does, even for a
   * purely decorative object with no actions at all. The one exception is
   * a lone `goTo` action (a staircase with nothing else assigned): it
   * navigates to the TARGET room directly, with no self-pan first — see
   * the `pointertap` handler below. No double-click gate anymore: a
   * single click on an unattributed/your-own activity action just runs
   * it; if someone ELSE is currently attributed to one of this object's
   * activity actions, the click opens a small menu with "View" (peek at
   * their Dashboard) plus the real action(s) instead of silently running
   * one on their behalf.
   */
  protected attachObjectInteraction(container: Container, roomId: number, obj: ObjectDef) {
    const actions = obj.actions ?? [];

    container.eventMode = "static";
    container.cursor = "pointer";
    // Without this, Pixi still hit-tests individual children, and sparse
    // art (e.g. the thin vine overlay in piano_top.png) only registers
    // clicks where it happens to have opaque pixels — not the full box.
    container.interactiveChildren = false;

    // Only ever reached from the pointertap/rightclick handlers below,
    // both of which already return early on mobile — no mobile guard
    // needed here too.
    const runAction = (action: ObjectAction) => {
      if (action.kind === "goTo") {
        this.setViewedRoom(action.roomId);
      } else {
        this.runActivity(roomId, obj.id, action.activityId);
      }
    };

    const buildMenuItems = () => {
      const peek = this.peekAttributionFor(actions);
      const items = actions.map((action) => ({ label: describeAction(action), onclick: () => runAction(action) }));
      if (peek) items.unshift({ label: "View", onclick: () => setViewingCharacter(peek) });
      return items;
    };

    container.on("pointertap", (e) => {
      e.stopPropagation(); // otherwise this bubbles to the room's own click handler too
      // Mobile has no object interaction at all — the only ways to act are
      // the Home tab's name-tap (switch character) and Pick Action FAB
      // (see main.ts's setupMobilePickAction). Checked live, not cached at
      // attach time, same as the room's own pointertap guard above — a
      // window resized across the breakpoint picks this up immediately.
      if (this.isMobileLayout()) return;

      if (actions.length === 1 && actions[0].kind === "goTo") {
        runAction(actions[0]);
        return;
      }

      this.setViewedRoom(roomId, obj.id); // unconditional recenter baseline
      if (actions.length === 0) return;

      const items = buildMenuItems();
      if (items.length === 1) items[0].onclick();
      else {
        const native = e.nativeEvent as MouseEvent;
        openActionPicker(native.clientX, native.clientY, items);
      }
    });

    // Right-click always shows every option, even for a single action —
    // the one deliberate way to reach "View" without it ever needing to
    // be the default click behavior. (Mobile has no right-click gesture
    // anyway, but the same guard keeps this consistent with pointertap
    // above rather than relying on that incidentally.)
    container.on("rightclick", (e) => {
      e.stopPropagation();
      if (this.isMobileLayout()) return;
      if (actions.length === 0) return;
      const native = e.nativeEvent as MouseEvent;
      openActionPicker(native.clientX, native.clientY, buildMenuItems());
    });
  }

  /** Whoever (other than me) is currently attributed to one of `actions`' activity kinds, if anyone — the trigger for the "View" menu entry above. First match wins; two activity actions on the same object both being "in use" by different people at once isn't a case this needs to resolve precisely. */
  private peekAttributionFor(actions: ObjectAction[]): { id: string; name: string } | null {
    for (const action of actions) {
      if (action.kind !== "activity") continue;
      const label = findActivityById(action.activityId)?.label;
      const attribution = label ? this.attributionFor(label) : null;
      if (attribution && !attribution.isMine) return { id: attribution.characterId, name: attribution.characterName };
    }
    return null;
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

  /**
   * Runs one specific action from an object's menu (or its lone action, on
   * a direct click) — always a START now, never a stop. Stopping used to
   * be "click the already-running object/action again," but that made any
   * object with 2+ actions ambiguous (is this click picking a NEW action,
   * or toggling the running one off?) and buried the only way to stop
   * behind remembering which object you started it from. Stopping is now
   * exclusively the dedicated red Stop Activity control (see
   * goals/panel.ts) — re-clicking a running action just recenters the
   * camera on it (or, for a 2+-action object, still opens the picker so you
   * can switch to a *different* action) rather than silently stopping
   * anything.
   */
  private runActivity(roomId: number, objectId: number, activityId: number) {
    const activityLabel = findActivityById(activityId)?.label;
    const current = getRemoteStatus();
    const isSameLabel = current.activityLabel === activityLabel;

    // On mobile, the click still starts the activity below — it just
    // doesn't pan on its own; applyRemoteStatus() does that once the
    // server's status broadcast confirms the change, so the camera still
    // ends up on the right object, just reactively instead of optimistically.
    if (!this.isMobileLayout()) this.setViewedRoom(roomId, objectId);
    if (!isSameLabel && activityLabel) sendCommand("startActivity", { label: activityLabel });
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
   * that (see runActivity/peekAttributionFor).
   *
   * If Kevin and I are both running the same label at once (two separate
   * pianos, say), MY OWN entry always wins the overlay's art/name tag —
   * processed last here regardless of Object.entries' own iteration
   * order, rather than whichever happens to come last in listCharacters()
   * order. Same "mine wins" rule attributionFor already uses for click
   * attribution, just applied to which character's sprite actually shows.
   */
  public applyAllStatuses(allStatuses: Record<string, AllStatusesEntry>) {
    const myId = getCharacter().id;
    const byLabel = new Map<string, OverlayAttribution>();
    for (const [characterId, entry] of Object.entries(allStatuses)) {
      const existing = byLabel.get(entry.activityLabel);
      if (existing && existing.characterId === myId) continue; // mine already claimed this label — don't let anyone else overwrite it
      byLabel.set(entry.activityLabel, { characterId, characterName: entry.characterName, characterSpriteName: entry.characterSpriteName });
    }
    this.updateActiveOverlays(byLabel);
  }

  /**
   * Starts an activity by label with no associated clicked object — used
   * by the mobile Pick Action list, which picks from the flat ACTIVITIES
   * registry rather than tapping a specific object in a specific room.
   * Renamed from the old toggleActivity() now that tapping the
   * already-running row is a no-op (just recenters) rather than stopping
   * it — same "stop is only the dedicated red button" change as
   * runActivity() above. The list's own ☑/☐ marks are purely informational
   * now (what's running right now), not a checkbox you can uncheck.
   */
  public pickActivity(label: string): void {
    const current = getRemoteStatus();
    const isSameLabel = current.activityLabel === label;

    if (!isSameLabel) sendCommand("startActivity", { label });
    // Always pan here, mobile or not — this is the one deliberate "picking
    // an action" entry point mobile keeps (no floor buttons, no clicking
    // around otherwise). Falls back to a fixed room when this activity has
    // no object of its own to focus instead of just leaving the camera
    // wherever it happened to be.
    const found = findObjectForActivityLabel(label);
    this.setViewedRoom(found?.roomId ?? FALLBACK_ROOM_ID, found?.objectId ?? null);
  }
}

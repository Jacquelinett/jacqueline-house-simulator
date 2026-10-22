import { ObjectAction } from "./rooms";

const DOUBLE_CLICK_WINDOW_MS = 400;

/**
 * Detects a double-click/double-tap on the same key within a short
 * window — a small reusable primitive (keyed by a plain string rather
 * than tied to object clicks specifically) rather than environment-
 * specific state. House.ts is the only current consumer (its own gate on
 * a single click just peeking at someone else's active object instead of
 * acting on it — see House.ts's own ActionEnvironment.onActivity), but
 * anything else that ever needs "are these two taps the same gesture"
 * can reuse it instead of re-inventing timestamp tracking.
 */
export class DoubleClickTracker {
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

/** Every object has at least an implicit "view" action, even with none declared of its own — renderer.ts's buildObject hit-tests every object unconditionally now, so a purely decorative object is clickable (recenter only) instead of inert. */
export function effectiveActions(actions: ObjectAction[] | undefined): ObjectAction[] {
  return actions?.length ? actions : [{ kind: "view" }];
}

/** Human-readable label for one action — shared by the action picker (src/ui/actionPicker.ts) and anything else that needs to describe an action to a person. */
export function describeAction(action: ObjectAction, activityLabel: (id: number) => string | undefined, roomName: (id: number) => string | undefined): string {
  switch (action.kind) {
    case "view":
      return "View";
    case "goTo":
      return `Go to ${roomName(action.roomId) ?? action.roomId}`;
    case "activity":
      return activityLabel(action.activityId) ?? "?";
  }
}

/**
 * What a click on a resolved action actually DOES — deliberately just
 * three callbacks, no attribution/peek/double-click policy baked in here.
 * House.ts and viewer.ts have genuinely different jobs for the same
 * "activity" action (peek-then-start-tracking vs. switch-the-viewer's-
 * selected-character-or-just-look), so that policy stays entirely inside
 * each environment's own onActivity implementation — this interface only
 * carries WHICH action kind resolved, not what running it should mean.
 */
export interface ActionEnvironment {
  onView(): void;
  onGoTo(roomId: number): void;
  onActivity(activityId: number): void;
}

/** Runs one already-resolved action by calling the matching `ActionEnvironment` callback — exported on its own (not just inlined in `dispatchObjectClick` below) so a caller forcing a picker open regardless of action count (House.ts's right-click) can run whichever one gets picked the exact same way a single-action object's direct click does. */
export function runAction(action: ObjectAction, env: ActionEnvironment): void {
  switch (action.kind) {
    case "view":
      env.onView();
      break;
    case "goTo":
      env.onGoTo(action.roomId);
      break;
    case "activity":
      env.onActivity(action.activityId);
      break;
  }
}

/**
 * Resolves `actions` down to one action to actually run — directly for a
 * single-action object, or via `openPicker` for 2+ (e.g. a staircase that
 * can also be sat at to play piano — "allow the user to select which
 * option to use at this object"). This is the one piece House.ts/
 * viewer.ts share for click dispatch; what running an action actually
 * does is entirely up to the environment (see ActionEnvironment's own
 * comment) — including any gating in front of it (e.g. House.ts's peek-
 * before-acting check on someone else's active object), which happens
 * entirely in the caller, before this function is even called.
 */
export function dispatchObjectClick(actions: ObjectAction[], env: ActionEnvironment, openPicker: (actions: ObjectAction[], run: (action: ObjectAction) => void) => void): void {
  if (actions.length === 1) runAction(actions[0], env);
  else openPicker(actions, (action) => runAction(action, env));
}

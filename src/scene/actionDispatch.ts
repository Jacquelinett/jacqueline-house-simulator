import { ObjectAction, rooms } from "./rooms";
import { findActivityById } from "./activities";

/**
 * Human-readable label for one action — shared by House.ts's/viewer.ts's
 * multi-action picker (src/ui/actionPicker.ts) so a staircase that's also
 * a piano reads as "Go to Bedroom" / "Practicing Piano" rather than
 * either file re-deriving the same activity-label/room-name lookups
 * independently. Reads `rooms`/`findActivityById` directly (both plain
 * shared data, not environment-specific) rather than taking resolver
 * callbacks — there's nothing House.ts or viewer.ts could sensibly
 * resolve differently here.
 */
export function describeAction(action: ObjectAction): string {
  if (action.kind === "goTo") return `Go to ${rooms.find((r) => r.id === action.roomId)?.name ?? action.roomId}`;
  return findActivityById(action.activityId)?.label ?? "?";
}

import { getActivities } from "./activities";
import { getObjectTypes } from "./objectTypes";
import { getRoomSpecs } from "./rooms";

/**
 * Whether ANY object anywhere in the house — reachable from a floor or
 * not, this is "does the thing still exist," not a rendering concern —
 * still triggers this activity label, via either its own action override
 * or its type's default actions. False if the activity itself has been
 * deleted too (nothing could possibly still reference it by id then).
 *
 * Used to auto-stop a currently-running activity when the admin tool
 * deletes or reconfigures whatever was tracking it out from under a live
 * session — see rpc.ts's stopOrphanedActivities(), called at server
 * startup and after any admin-tool mutation that could invalidate one.
 */
export function activityLabelHasLiveObject(label: string): boolean {
  const activity = getActivities().find((a) => a.label === label);
  if (!activity) return false;

  const objectTypes = getObjectTypes();
  for (const room of getRoomSpecs()) {
    for (const obj of room.objects) {
      const actions = obj.actions ?? objectTypes[String(obj.type)]?.actions;
      if (actions?.some((a) => a.kind === "activity" && a.activityId === activity.id)) return true;
    }
  }
  return false;
}

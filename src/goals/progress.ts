import { Goal } from "./types";
import { sendQuery } from "../client/remoteState";

/** Query wrapper — real logic server-side now (server/progress.ts). */
export interface GoalProgress {
  activityLabel: string;
  targetMinutes: number;
  minutes: number;
  done: boolean;
  goals: Goal[];
}

/** `viewingCharacterId` (optional) fetches another character's goal progress for this date instead of your own — see dashboard/panel.ts's "peek at another character" feature. */
export function getGoalProgressForDate(dateStr: string, viewingCharacterId?: string): Promise<GoalProgress[]> {
  return sendQuery<GoalProgress[]>("getGoalProgressForDate", { dateStr, viewingCharacterId });
}

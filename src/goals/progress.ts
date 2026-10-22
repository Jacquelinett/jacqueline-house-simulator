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

export function getGoalProgressForDate(dateStr: string): Promise<GoalProgress[]> {
  return sendQuery<GoalProgress[]>("getGoalProgressForDate", { dateStr });
}

import { createJsonFileStore } from "../lib/jsonFileStore";
import { Goal } from "./types";

export const goalsFileStore = createJsonFileStore<Goal[]>("goals.json", []);

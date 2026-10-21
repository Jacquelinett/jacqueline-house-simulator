import { createJsonFileStore } from "../lib/jsonFileStore";
import { Todo } from "./types";

export const todosFileStore = createJsonFileStore<Todo[]>("todos.json", []);

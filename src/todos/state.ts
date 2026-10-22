import { getTodos as remoteGetTodos, onTodosChange as remoteOnTodosChange, sendCommand } from "../client/remoteState";

/** Same pattern as goals/state.ts — thin wrapper, same exported names, real logic server-side now (server/todos.ts). */
export const getTodos = remoteGetTodos;
export const onTodosChange = remoteOnTodosChange;

export async function addTodo(text: string): Promise<void> {
  sendCommand("addTodo", { text });
}

export async function toggleTodo(id: string): Promise<void> {
  sendCommand("toggleTodo", { id });
}

export async function deleteTodo(id: string): Promise<void> {
  sendCommand("deleteTodo", { id });
}

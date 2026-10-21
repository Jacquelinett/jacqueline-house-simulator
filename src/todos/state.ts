import { loadTodos, saveTodos } from "./store";
import { Todo } from "./types";

let todos: Todo[] = [];
const listeners = new Set<() => void>();

export async function initTodosState(): Promise<void> {
  todos = await loadTodos();
}

export function getTodos(): Todo[] {
  return todos;
}

export function onTodosChange(cb: () => void): void {
  listeners.add(cb);
}

async function persist() {
  await saveTodos(todos);
  for (const cb of listeners) cb();
}

export async function addTodo(text: string) {
  todos.push({ id: crypto.randomUUID(), text, done: false });
  await persist();
}

export async function toggleTodo(id: string) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  todo.done = !todo.done;
  await persist();
}

export async function deleteTodo(id: string) {
  todos = todos.filter((t) => t.id !== id);
  await persist();
}

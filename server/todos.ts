import { createPersistedState } from "../src/lib/persistedState";
import { todosStore } from "./stores/todosStore";

const todosState = createPersistedState(todosStore.load, todosStore.save);

export const initTodosState = todosState.init;
export const getTodos = todosState.get;
export const onTodosChange = todosState.onChange;

export async function addTodo(text: string) {
  await todosState.persist([...getTodos(), { id: crypto.randomUUID(), text, done: false }]);
}

export async function toggleTodo(id: string) {
  const todo = getTodos().find((t) => t.id === id);
  if (!todo) return;
  todo.done = !todo.done;
  await todosState.persist(getTodos());
}

export async function deleteTodo(id: string) {
  await todosState.persist(getTodos().filter((t) => t.id !== id));
}

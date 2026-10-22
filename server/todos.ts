import { createPersistedState } from "../src/lib/persistedState";
import { todosStore } from "./stores/todosStore";

/** Same character-scoping pattern as server/goals.ts — see its comment. */
const todosState = createPersistedState(todosStore.load, todosStore.save);

export const initTodosState = todosState.init;
export const onTodosChange = todosState.onChange;

export function getTodos(characterId: string) {
  return todosState.get().filter((t) => t.characterId === characterId);
}

export async function addTodo(characterId: string, text: string) {
  await todosState.persist([...todosState.get(), { id: crypto.randomUUID(), characterId, text, done: false }]);
}

export async function toggleTodo(characterId: string, id: string) {
  const todo = todosState.get().find((t) => t.id === id && t.characterId === characterId);
  if (!todo) return;
  todo.done = !todo.done;
  await todosState.persist(todosState.get());
}

export async function deleteTodo(characterId: string, id: string) {
  await todosState.persist(todosState.get().filter((t) => !(t.id === id && t.characterId === characterId)));
}

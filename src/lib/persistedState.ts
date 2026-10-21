/**
 * In-memory value backed by a load/save pair (see jsonFileStore.ts), with
 * change listeners notified after every persist — the shared shape behind
 * every feature's state.ts (goals/todos/settings/...).
 */
export function createPersistedState<T>(load: () => Promise<T>, save: (value: T) => Promise<void>) {
  let value: T;
  const listeners = new Set<() => void>();

  return {
    async init(): Promise<void> {
      value = await load();
    },
    get(): T {
      return value;
    },
    onChange(cb: () => void): void {
      listeners.add(cb);
    },
    async persist(next: T): Promise<void> {
      value = next;
      await save(value);
      for (const cb of listeners) cb();
    },
  };
}

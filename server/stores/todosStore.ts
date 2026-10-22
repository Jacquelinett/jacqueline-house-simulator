import { db } from "../db";
import { Todo } from "../../src/todos/types";

interface TodoRow {
  id: string;
  text: string;
  done: number;
}

function rowToTodo(row: TodoRow): Todo {
  return { id: row.id, text: row.text, done: !!row.done };
}

/** Same {load, save} shape as goalsStore.ts — see its comment for why "rewrite the whole table" is fine here. */
export const todosStore = {
  async load(): Promise<Todo[]> {
    const rows = db.prepare("SELECT * FROM todos").all() as TodoRow[];
    return rows.map(rowToTodo);
  },
  async save(todos: Todo[]): Promise<void> {
    const insert = db.prepare("INSERT INTO todos (id, text, done) VALUES (@id, @text, @done)");
    const tx = db.transaction((todos: Todo[]) => {
      db.prepare("DELETE FROM todos").run();
      for (const t of todos) {
        insert.run({ id: t.id, text: t.text, done: t.done ? 1 : 0 });
      }
    });
    tx(todos);
  },
};

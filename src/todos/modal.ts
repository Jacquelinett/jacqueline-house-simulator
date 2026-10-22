import { buildModal } from "../ui/modal";
import { addTodo, deleteTodo, getTodos, onTodosChange, toggleTodo } from "./state";

export function setupTodosModal(): { open: () => void } {
  const modal = buildModal("Todos", { resizable: true });

  const form = document.createElement("div");
  form.id = "todo-add-form";
  modal.body.appendChild(form);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "New todo";
  form.appendChild(input);

  const addBtn = document.createElement("button");
  addBtn.textContent = "Add";
  form.appendChild(addBtn);

  async function submit() {
    const text = input.value.trim();
    if (!text) return;
    addBtn.disabled = true;
    try {
      await addTodo(text);
      input.value = "";
    } catch (err) {
      console.error("[todos] failed to add todo", err);
    } finally {
      addBtn.disabled = false;
    }
  }
  addBtn.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };

  const list = document.createElement("div");
  list.id = "todo-list";
  modal.body.appendChild(list);

  function render() {
    const todos = getTodos();
    list.textContent = "";
    if (todos.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No todos yet";
      list.appendChild(empty);
      return;
    }

    for (const todo of todos) {
      const row = document.createElement("div");
      row.className = "todo-row" + (todo.done ? " todo-done" : "");

      const check = document.createElement("span");
      check.className = "todo-check";
      check.textContent = todo.done ? "☑" : "☐";
      check.onclick = async () => {
        try {
          await toggleTodo(todo.id);
        } catch (err) {
          console.error("[todos] failed to toggle todo", err);
        }
      };
      row.appendChild(check);

      const text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = todo.text;
      row.appendChild(text);

      const removeBtn = document.createElement("button");
      removeBtn.className = "goal-remove";
      removeBtn.textContent = "×";
      removeBtn.onclick = async () => {
        removeBtn.disabled = true;
        try {
          await deleteTodo(todo.id);
        } catch (err) {
          console.error("[todos] failed to remove todo", err);
          removeBtn.disabled = false;
        }
      };
      row.appendChild(removeBtn);

      list.appendChild(row);
    }
  }

  onTodosChange(render);
  render();

  return { open: modal.open };
}

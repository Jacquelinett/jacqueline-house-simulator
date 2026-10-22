import { buildModal } from "../ui/modal";
import { deleteMessage, fetchMessages, getBroadcastHealth, InboxMessage } from "./client";

export function setupMessagesModal(): { open: () => void } {
  const modal = buildModal("Messages", { resizable: true });

  const list = document.createElement("div");
  list.id = "messages-list";
  modal.body.appendChild(list);

  async function render() {
    // broadcastUrl is server-only config now (server/serverConfig.ts),
    // not something this client knows locally — ask the server instead
    // of checking a local Settings field.
    const { configured } = await getBroadcastHealth();
    if (!configured) {
      list.textContent = "";
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "Set up status broadcasting on the server to receive messages.";
      list.appendChild(empty);
      return;
    }

    list.textContent = "";
    const loading = document.createElement("div");
    loading.className = "goals-empty";
    loading.textContent = "Loading...";
    list.appendChild(loading);

    let messages: InboxMessage[];
    try {
      messages = await fetchMessages();
    } catch (err) {
      console.error("[messages] failed to load", err);
      list.textContent = "";
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load messages.";
      list.appendChild(error);
      return;
    }

    list.textContent = "";
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No messages yet";
      list.appendChild(empty);
      return;
    }

    for (const message of messages) {
      const row = document.createElement("div");
      row.className = "message-row";

      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = `${message.author || "Anonymous"} — ${new Date(message.created_at).toLocaleString()}`;
      row.appendChild(meta);

      const text = document.createElement("div");
      text.className = "message-text";
      text.textContent = message.text;
      row.appendChild(text);

      const removeBtn = document.createElement("button");
      removeBtn.className = "goal-remove";
      removeBtn.textContent = "×";
      removeBtn.onclick = async () => {
        removeBtn.disabled = true;
        try {
          await deleteMessage(message.id);
          row.remove();
        } catch (err) {
          console.error("[messages] failed to delete", err);
          removeBtn.disabled = false;
        }
      };
      row.appendChild(removeBtn);

      list.appendChild(row);
    }
  }

  return {
    open() {
      modal.open();
      render();
    },
  };
}

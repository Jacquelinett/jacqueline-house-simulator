/**
 * Shared overlay/dialog/header chrome for the app's modals (Goals, Todos,
 * Timer, Settings, ...). `resizable` uses the browser's own CSS `resize`
 * (drag handle at the bottom-right corner, bounded by the `.resizable`
 * rule's min/max width/height) — the dialog already scrolls past its own
 * height regardless of whether that height comes from its default
 * max-height or a user-resized one.
 */
export function buildModal(
  title: string,
  options?: { size?: "default" | "large"; resizable?: boolean },
): {
  body: HTMLElement;
  open: () => void;
  close: () => void;
  onClose(cb: () => void): void;
} {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  document.body.appendChild(overlay);

  const dialog = document.createElement("div");
  dialog.className =
    "modal-dialog" +
    (options?.size === "large" ? " modal-dialog-large" : "") +
    (options?.resizable ? " resizable" : "");
  overlay.appendChild(dialog);

  const header = document.createElement("div");
  header.className = "modal-header";
  dialog.appendChild(header);

  const titleEl = document.createElement("h2");
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  dialog.appendChild(body);

  const closeListeners = new Set<() => void>();

  function close() {
    overlay.classList.remove("open");
    for (const cb of closeListeners) cb();
  }

  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  return {
    body,
    open: () => overlay.classList.add("open"),
    close,
    onClose(cb: () => void) {
      closeListeners.add(cb);
    },
  };
}

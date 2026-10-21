/** Lets `handle` drag `panel` around the screen via fixed left/top, switching off whatever default corner positioning (bottom/right/etc.) it started with. */
export function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
  handle.style.cursor = "move";

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    // Anchor at the panel's current on-screen position before switching to
    // explicit left/top, so the first drag frame doesn't jump it.
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - offsetX}px`;
    panel.style.top = `${e.clientY - offsetY}px`;
  });

  handle.addEventListener("pointerup", () => {
    dragging = false;
  });
  handle.addEventListener("pointercancel", () => {
    dragging = false;
  });
}

/**
 * A draggable floating panel with a uniform title-bar header — unlike
 * buildModal(), has no backdrop and doesn't block interacting with the rest
 * of the screen. Used for both the always-visible corner Goals panel
 * (closable: false — no ×, caller opens it once and never closes it) and
 * the toggleable Dashboard, so their headers/drag behavior stay identical
 * rather than each hand-rolling their own.
 */
export function buildFloatingPanel(
  title: string,
  options?: { closable?: boolean; className?: string },
): {
  body: HTMLElement;
  open: () => void;
  close: () => void;
  onClose(cb: () => void): void;
} {
  const panel = document.createElement("div");
  panel.className = "floating-panel" + (options?.className ? ` ${options.className}` : "");
  document.body.appendChild(panel);

  const header = document.createElement("div");
  header.className = "floating-panel-header";
  panel.appendChild(header);

  const titleEl = document.createElement("span");
  titleEl.className = "floating-panel-title";
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeListeners = new Set<() => void>();
  function close() {
    panel.classList.remove("open");
    for (const cb of closeListeners) cb();
  }

  if (options?.closable ?? true) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "floating-panel-close";
    closeBtn.textContent = "×";
    closeBtn.onclick = close;
    header.appendChild(closeBtn);
  }

  const body = document.createElement("div");
  body.className = "floating-panel-body";
  panel.appendChild(body);

  makeDraggable(panel, header);

  return {
    body,
    open: () => panel.classList.add("open"),
    close,
    onClose(cb: () => void) {
      closeListeners.add(cb);
    },
  };
}

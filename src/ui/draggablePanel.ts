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

/** A closable, draggable floating panel — unlike buildModal(), has no backdrop and doesn't block interacting with the rest of the screen. */
export function buildFloatingPanel(title: string): {
  body: HTMLElement;
  open: () => void;
  close: () => void;
  onClose(cb: () => void): void;
} {
  const panel = document.createElement("div");
  panel.className = "floating-panel";
  document.body.appendChild(panel);

  const header = document.createElement("div");
  header.className = "floating-panel-header";
  panel.appendChild(header);

  const titleEl = document.createElement("span");
  titleEl.className = "floating-panel-title";
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "floating-panel-close";
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "floating-panel-body";
  panel.appendChild(body);

  makeDraggable(panel, header);

  const closeListeners = new Set<() => void>();
  function close() {
    panel.classList.remove("open");
    for (const cb of closeListeners) cb();
  }
  closeBtn.onclick = close;

  return {
    body,
    open: () => panel.classList.add("open"),
    close,
    onClose(cb: () => void) {
      closeListeners.add(cb);
    },
  };
}

/** Top-right row of page-level actions — identical in the desktop app and the viewer, just a different button list. */
export function setupTopButtons(buttons: { label: string; onclick: () => void }[]): void {
  const container = document.createElement("div");
  container.id = "top-buttons";
  for (const { label, onclick } of buttons) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = onclick;
    container.appendChild(btn);
  }
  document.body.appendChild(container);
}

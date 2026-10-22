/**
 * Small floating menu anchored at a screen position — not a buildModal()
 * (no backdrop, no centering; it lives right where the click happened and
 * closes on any outside click). Originally House.ts's own private
 * "object-menu" (opened whenever an object resolves to 2+ actions, or on
 * right-click regardless of count); pulled out here once the viewer
 * needed the exact same thing for its own multi-action objects (see
 * src/scene/actionDispatch.ts's dispatchObjectClick, which calls this
 * instead of running a single action directly).
 */

let currentMenu: HTMLDivElement | null = null;

export function openActionPicker(clientX: number, clientY: number, items: { label: string; onclick: () => void }[]): void {
  closeActionPicker(); // only one at a time

  const menu = document.createElement("div");
  menu.className = "object-menu";
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;

  for (const item of items) {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.onclick = () => {
      item.onclick();
      closeActionPicker();
    };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  currentMenu = menu;

  const closeOnOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) closeActionPicker();
  };
  // Defer attaching so the same click that opened the menu doesn't also close it.
  setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, { once: true }), 0);
}

export function closeActionPicker(): void {
  currentMenu?.remove();
  currentMenu = null;
}

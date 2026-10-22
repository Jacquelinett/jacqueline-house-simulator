export type MobileTab = "home" | "dashboard" | "statistic" | "settings";

const TABS: { id: MobileTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "dashboard", label: "Dashboard" },
  { id: "statistic", label: "Statistic" },
  { id: "settings", label: "Settings" },
];

/**
 * Bottom tab bar + one full-screen page per tab — the mobile UI skeleton,
 * shared by the desktop app and the viewer. Always built (visibility is
 * entirely CSS-driven by shared-chrome.css's mobile media query, so
 * resizing/rotating across the breakpoint needs no JS), but only ever
 * actually visible below that breakpoint.
 *
 * Callers fill in `pages` with whatever content belongs on each tab,
 * using the same setup*Content() functions their desktop panels/modals
 * already use — this module only owns tab-switching, not what's on a tab.
 */
export function setupMobileTabs(): {
  pages: Record<MobileTab, HTMLElement>;
  onTabChange(cb: (tab: MobileTab) => void): void;
} {
  const pages: Record<MobileTab, HTMLElement> = {} as Record<MobileTab, HTMLElement>;
  const buttons: Record<MobileTab, HTMLButtonElement> = {} as Record<MobileTab, HTMLButtonElement>;
  const listeners = new Set<(tab: MobileTab) => void>();

  const tabBar = document.createElement("div");
  tabBar.id = "mobile-tab-bar";

  for (const { id, label } of TABS) {
    const page = document.createElement("div");
    page.className = "mobile-page";
    page.id = `mobile-page-${id}`;
    document.body.appendChild(page);
    pages[id] = page;

    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => showTab(id);
    tabBar.appendChild(btn);
    buttons[id] = btn;
  }

  document.body.appendChild(tabBar);

  function showTab(tab: MobileTab) {
    for (const { id } of TABS) {
      pages[id].classList.toggle("active", id === tab);
      buttons[id].classList.toggle("active", id === tab);
    }
    for (const cb of listeners) cb(tab);
  }

  showTab("home");

  return {
    pages,
    onTabChange(cb) {
      listeners.add(cb);
    },
  };
}

/**
 * Bottom tab bar + one full-screen page per tab — the mobile UI skeleton,
 * shared by the desktop app and the viewer. Always built (visibility is
 * entirely CSS-driven by shared-chrome.css's mobile media query, so
 * resizing/rotating across the breakpoint needs no JS), but only ever
 * actually visible below that breakpoint.
 *
 * `tabs` is supplied by the caller rather than hardcoded here, specifically
 * so a build-specific tab (e.g. the app's "Workout" tab, backed by a
 * desktop-only modal's content — see main.ts's setupMobileUI()) doesn't
 * leak into the viewer's own tab bar just because this skeleton is shared;
 * each build declares exactly the tabs it needs, generic over whatever
 * string-literal ids it passes in. "home" is always first/initial by
 * convention (every caller includes it), not enforced by this function.
 * Callers fill in `pages` with whatever content belongs on each tab, using
 * the same setup*Content() functions their desktop panels/modals already
 * use — this module only owns tab-switching, not what's on a tab.
 */
export function setupMobileTabs<T extends string>(tabs: readonly { id: T; label: string }[]): {
  pages: Record<T, HTMLElement>;
  onTabChange(cb: (tab: T) => void): void;
} {
  const pages = {} as Record<T, HTMLElement>;
  const buttons = {} as Record<T, HTMLButtonElement>;
  const listeners = new Set<(tab: T) => void>();

  const tabBar = document.createElement("div");
  tabBar.id = "mobile-tab-bar";

  for (const { id, label } of tabs) {
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

  function showTab(tab: T) {
    for (const { id } of tabs) {
      pages[id].classList.toggle("active", id === tab);
      buttons[id].classList.toggle("active", id === tab);
    }
    for (const cb of listeners) cb(tab);
  }

  showTab(tabs[0].id);

  return {
    pages,
    onTabChange(cb) {
      listeners.add(cb);
    },
  };
}

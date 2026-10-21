import { Application } from "pixi.js";
import { Theme } from "./types";

/**
 * Pixi's own canvas background (visible wherever no room tile covers the
 * screen, e.g. letterboxing around the isometric scene) isn't reachable by
 * CSS — it has to be set directly on the renderer. This is the one place
 * that color lives per theme, instead of the same hex value getting
 * hardcoded independently everywhere something needs it.
 */
export const THEME_BACKGROUND: Record<Theme, number> = {
  dark: 0x1a1a1a,
  pink: 0xffe4ec,
};

/** Switches both the CSS side (data-theme, read by styles.css's variable blocks) and the Pixi side (THEME_BACKGROUND above) — identical in the desktop app and the viewer. */
export function applyTheme(app: Application, theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  app.renderer.background.color = THEME_BACKGROUND[theme];
}

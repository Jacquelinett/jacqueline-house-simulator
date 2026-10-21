import { Theme } from "./types";

/**
 * Pixi's own canvas background (visible wherever no room tile covers the
 * screen, e.g. letterboxing around the isometric scene) isn't reachable by
 * CSS — it has to be set directly on the renderer. This is the one place
 * that color lives per theme, instead of the same hex value getting
 * hardcoded independently everywhere something needs it (main.ts's
 * runtime theme switch and its own Pixi bootstrap default both read this).
 */
export const THEME_BACKGROUND: Record<Theme, number> = {
  dark: 0x1a1a1a,
  pink: 0xffe4ec,
};

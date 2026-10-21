import { Application } from "pixi.js";

/**
 * Builds and mounts the Pixi Application onto #app — identical setup in
 * the desktop app and the viewer, just a different initial background
 * (whichever theme's each one defaults/was last set to).
 */
export async function setupPixiApp(initialBackground: number): Promise<Application> {
  const app = new Application();
  await app.init({
    background: initialBackground,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  // Pixi's `resizeTo` option has a known bug where it can leave the backing
  // buffer subtly stretched/mismatched after a resize instead of cleanly
  // re-syncing (https://github.com/pixijs/pixijs/issues/6510) — driving
  // resolution + resize together ourselves, on every resize, avoids it.
  // Not perfect (occasional stretch still happens on some resizes) — good
  // enough for now, revisit later.
  function syncRendererSize() {
    app.renderer.resolution = window.devicePixelRatio || 1;
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  syncRendererSize();
  window.addEventListener("resize", syncRendererSize);

  return app;
}

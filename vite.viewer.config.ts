import { defineConfig } from "vite";

// Builds viewer.html — the public read-only status page — as a normal
// multi-asset static site (separate JS/CSS/image files), meant for GitHub
// Pages. Deliberately separate from vite.config.ts (the Tauri app's own
// build): the viewer isn't bundled into the desktop app at all, and Pages
// has no size constraints that would push toward single-file bundling the
// way val.town's 80,000-character val source limit did (ruled out — see
// valtown/houseSimulatorStatus.ts).
export default defineConfig({
  // GitHub Pages serves a project repo (not a user/org root site) from
  // "/<repo-name>/", not domain root — without this, every absolute asset
  // path (the HTML's own script/style tags, and the texture paths resolved
  // via assetUrl() in renderer.ts) would 404 once deployed there. Update
  // this if the repo is ever renamed.
  base: "/jacqueline-house-simulator/",
  build: {
    outDir: "dist-viewer",
    rollupOptions: {
      input: "viewer.html",
    },
  },
});

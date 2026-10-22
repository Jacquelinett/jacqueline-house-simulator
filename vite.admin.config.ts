import { defineConfig } from "vite";

// Builds admin.html — the server-managed admin tool (characters/activities/
// object types/rooms/objects CRUD) — as its own Vite entry, served by the
// Node server itself at /admin/ (see server/index.ts), not bundled into the
// Tauri app and not deployed to GitHub Pages. `base: "/admin/"` matches that
// mount path, same reasoning as vite.viewer.config.ts's own `base` for its
// GitHub Pages subpath — every emitted asset reference needs to resolve
// under the path this is actually served from.
export default defineConfig({
  base: "/admin/",
  build: {
    outDir: "dist-admin",
    rollupOptions: {
      input: "admin.html",
    },
  },
});

import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves the Tauri app's own Vite build output (dist/) as static files, so
 * a plain browser on the LAN gets the exact same frontend bundle a Tauri
 * webview loads from disk — see CLAUDE.md's "One build, two delivery
 * mechanisms". Falls back to index.html for any path that isn't a real
 * file under dist/ (there's no client-side router today, but this also
 * just makes every path serve the one app uniformly).
 *
 * Returns false (and sends nothing) if dist/ itself doesn't exist yet, so
 * the caller can fall through to its own 404 rather than this throwing.
 */
export function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse, urlPathOverride?: string): boolean {
  const root = resolve(distDir);
  if (!existsSync(root)) return false;

  const urlPath = decodeURIComponent((urlPathOverride ?? req.url ?? "/").split("?")[0]);
  // Collapses any leading "../" before resolving, then the startsWith(root)
  // check below catches the rest (e.g. a path that is itself just "..") —
  // this is a server exposed to the whole LAN, so path traversal out of
  // dist/ needs to be impossible, not just discouraged.
  const requested = resolve(root, "." + urlPath);
  if (!requested.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return true;
  }

  let filePath = requested;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = resolve(root, "index.html");
  }
  if (!existsSync(filePath)) return false;

  const mime = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  createReadStream(filePath).pipe(res);
  return true;
}

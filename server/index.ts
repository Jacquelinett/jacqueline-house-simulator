import http from "node:http";
import { WebSocketServer } from "ws";
import { migrate, db } from "./db";
import { initGoalsState } from "./goals";
import { initTodosState } from "./todos";
import { ensureStopwatchBucket } from "../src/aw/client";
import { setupRpc } from "./rpc";

const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  migrate();

  const configRow = db.prepare("SELECT lan_secret FROM server_config WHERE id = 1").get() as
    | { lan_secret: string | null }
    | undefined;
  const lanSecret = configRow?.lan_secret ?? null;
  if (!lanSecret) {
    console.warn(
      "[server] no lan_secret set in server_config — the WebSocket is unauthenticated. " +
        "Set one via: INSERT INTO server_config (id, lan_secret) VALUES (1, '...') ON CONFLICT(id) DO UPDATE SET lan_secret = excluded.lan_secret;",
    );
  }

  await initGoalsState();
  await initTodosState();
  await ensureStopwatchBucket();

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  setupRpc(wss, lanSecret);

  server.listen(PORT, () => {
    console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[server] fatal error during startup", err);
  process.exit(1);
});

import { db } from "./db";

export interface ServerConfig {
  broadcastUrl: string | null;
  broadcastSecret: string | null;
  /** No longer read for WebSocket auth (see server/characters.ts) — kept only as the historical value Jacqueline's character secret was seeded from on first migration. */
  lanSecret: string | null;
  adminSecret: string | null;
}

interface ConfigRow {
  broadcast_url: string | null;
  broadcast_secret: string | null;
  lan_secret: string | null;
  admin_secret: string | null;
}

/**
 * Server-only config — val.town credentials (the server does the pushing
 * now, not individual devices) and the admin tool's shared secret. Meant
 * to be edited by hand on the home server, same spirit as aw-server.toml's
 * own hand-edited config, so there's deliberately no RPC command to
 * change this remotely.
 */
export function getServerConfig(): ServerConfig {
  const row = db
    .prepare("SELECT broadcast_url, broadcast_secret, lan_secret, admin_secret FROM server_config WHERE id = 1")
    .get() as ConfigRow | undefined;
  return {
    broadcastUrl: row?.broadcast_url ?? null,
    broadcastSecret: row?.broadcast_secret ?? null,
    lanSecret: row?.lan_secret ?? null,
    adminSecret: row?.admin_secret ?? null,
  };
}

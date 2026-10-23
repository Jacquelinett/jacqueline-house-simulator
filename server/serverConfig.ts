import { db } from "./db";

export interface ServerConfig {
  broadcastUrl: string | null;
  broadcastSecret: string | null;
  /** No longer read for WebSocket auth (see server/characters.ts) — kept only as the historical value Jacqueline's character secret was seeded from on first migration. */
  lanSecret: string | null;
  adminSecret: string | null;
  /** Base URL of the self-hosted wger instance (e.g. "http://localhost:80"), shared by every character's own account on it — see server/wger.ts. Each character's own DRF API token lives on their own characters.wger_api_token row instead (edited via the admin tool's Characters tab) now that more than one account can be linked at once; null here disables the integration for everyone regardless of whether any character has a token set. */
  wgerBaseUrl: string | null;
}

interface ConfigRow {
  broadcast_url: string | null;
  broadcast_secret: string | null;
  lan_secret: string | null;
  admin_secret: string | null;
  wger_base_url: string | null;
}

/**
 * Server-only config — val.town credentials (the server does the pushing
 * now, not individual devices) and the admin tool's shared secret. Meant
 * to be edited by hand on the home server, same spirit as aw-server.toml's
 * own hand-edited config, so there's deliberately no RPC command to
 * change this remotely.
 */
export function getServerConfig(): ServerConfig {
  const row = db.prepare("SELECT broadcast_url, broadcast_secret, lan_secret, admin_secret, wger_base_url FROM server_config WHERE id = 1").get() as
    | ConfigRow
    | undefined;
  return {
    broadcastUrl: row?.broadcast_url ?? null,
    broadcastSecret: row?.broadcast_secret ?? null,
    lanSecret: row?.lan_secret ?? null,
    adminSecret: row?.admin_secret ?? null,
    wgerBaseUrl: row?.wger_base_url ?? null,
  };
}

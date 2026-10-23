import { db } from "./db";

export interface ServerConfig {
  broadcastUrl: string | null;
  broadcastSecret: string | null;
  /** No longer read for WebSocket auth (see server/characters.ts) — kept only as the historical value Jacqueline's character secret was seeded from on first migration. */
  lanSecret: string | null;
  adminSecret: string | null;
  /** Base URL of the self-hosted wger instance (e.g. "http://localhost:80"), no trailing slash required — see server/wger.ts. Null disables the integration entirely (every wger-backed query/push just no-ops). */
  wgerBaseUrl: string | null;
  /** A DRF API token for one wger account, generated from that account's own "API key" page (Preferences > API key > "Generate new API key") — there is no admin/quickstart default token, this has to come from the wger UI itself. Sent as `Authorization: Token <value>` (not `Bearer`). */
  wgerApiToken: string | null;
  /** Which House Simulator character the wger account's data belongs to — see server/wger.ts's resolveWgerCharacterId() for the "Jacqueline" fallback when this is null. */
  wgerCharacterId: string | null;
}

interface ConfigRow {
  broadcast_url: string | null;
  broadcast_secret: string | null;
  lan_secret: string | null;
  admin_secret: string | null;
  wger_base_url: string | null;
  wger_api_token: string | null;
  wger_character_id: string | null;
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
    .prepare(
      "SELECT broadcast_url, broadcast_secret, lan_secret, admin_secret, wger_base_url, wger_api_token, wger_character_id FROM server_config WHERE id = 1",
    )
    .get() as ConfigRow | undefined;
  return {
    broadcastUrl: row?.broadcast_url ?? null,
    broadcastSecret: row?.broadcast_secret ?? null,
    lanSecret: row?.lan_secret ?? null,
    adminSecret: row?.admin_secret ?? null,
    wgerBaseUrl: row?.wger_base_url ?? null,
    wgerApiToken: row?.wger_api_token ?? null,
    wgerCharacterId: row?.wger_character_id ?? null,
  };
}

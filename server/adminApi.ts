import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getServerConfig } from "./serverConfig";
import { createActivity, deleteActivity, getActivities, updateActivity } from "./activities";
import { createCharacter, deleteCharacter, listCharacters, renameCharacter } from "./characters";
import {
  createObjectType,
  deleteObjectType,
  getObjectTypes,
  updateObjectType,
} from "./objectTypes";
import { createObject, createRoom, deleteObject, deleteRoom, getRoomSpecs, updateObject, updateRoom, updateRoomConnections } from "./rooms";
import { ObjectPlacement } from "../src/scene/rooms";
import { createFloor, deleteFloor, getFloors, updateFloor } from "./floors";
import { Floor } from "../src/scene/floors";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBJECT_ASSETS_DIR = resolve(__dirname, "../public/objects");

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function isAuthorized(req: IncomingMessage): boolean {
  const { adminSecret } = getServerConfig();
  if (!adminSecret) return false; // no admin access until one is set — see server/index.ts's startup warning
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${adminSecret}`;
}

/**
 * Minimal REST CRUD for the admin tool (characters/activities/object
 * types/rooms/objects) — plain method+path matching rather than a router
 * library, since the route count is small and fixed. Separate from the
 * game's WebSocket RPC protocol on purpose: this is a traditional
 * request/response admin surface, not real-time multiplayer state.
 */
export async function handleAdminApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/admin/")) return false;

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["api","admin", ...]
  const method = req.method ?? "GET";

  try {
    // /api/admin/characters[/:id]
    if (parts[2] === "characters") {
      if (parts.length === 3 && method === "GET") return sendJson(res, 200, listCharacters()), true;
      if (parts.length === 3 && method === "POST") {
        const { name } = await readJsonBody(req);
        return sendJson(res, 200, createCharacter(name)), true;
      }
      if (parts.length === 4 && method === "PATCH") {
        const { name } = await readJsonBody(req);
        renameCharacter(parts[3], name);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "DELETE") {
        deleteCharacter(parts[3]);
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    // /api/admin/activities[/:id]
    if (parts[2] === "activities") {
      if (parts.length === 3 && method === "GET") return sendJson(res, 200, getActivities()), true;
      if (parts.length === 3 && method === "POST") {
        const { label, color } = await readJsonBody(req);
        return sendJson(res, 200, createActivity(label, color)), true;
      }
      if (parts.length === 4 && method === "PATCH") {
        const { label, color } = await readJsonBody(req);
        updateActivity(Number(parts[3]), label, color);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "DELETE") {
        deleteActivity(Number(parts[3]));
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    // /api/admin/object-types[/:id]
    if (parts[2] === "object-types") {
      if (parts.length === 3 && method === "GET") return sendJson(res, 200, getObjectTypes()), true;
      if (parts.length === 3 && method === "POST") {
        const def = await readJsonBody(req);
        return sendJson(res, 200, { id: createObjectType(def) }), true;
      }
      if (parts.length === 4 && method === "PATCH") {
        const def = await readJsonBody(req);
        updateObjectType(Number(parts[3]), def);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "DELETE") {
        deleteObjectType(Number(parts[3]));
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    // /api/admin/object-assets — texture picker source list
    if (parts[2] === "object-assets" && method === "GET") {
      const files = readdirSync(OBJECT_ASSETS_DIR).filter((f) => f.endsWith(".png"));
      return sendJson(res, 200, files.map((f) => `/objects/${f}`)), true;
    }

    // /api/admin/rooms[/:id][/objects[/:objectId]]
    if (parts[2] === "rooms") {
      if (parts.length === 3 && method === "GET") return sendJson(res, 200, getRoomSpecs()), true;
      if (parts.length === 3 && method === "POST") {
        const spec = await readJsonBody(req);
        return sendJson(res, 200, { id: createRoom(spec) }), true;
      }
      if (parts.length === 4 && method === "PATCH") {
        const spec = await readJsonBody(req);
        updateRoom({ ...spec, id: Number(parts[3]) });
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "DELETE") {
        deleteRoom(Number(parts[3]));
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 5 && parts[4] === "connections" && method === "PATCH") {
        const { connectedTo } = await readJsonBody(req);
        updateRoomConnections(Number(parts[3]), connectedTo);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 5 && parts[4] === "objects" && method === "POST") {
        const placement = (await readJsonBody(req)) as ObjectPlacement;
        return sendJson(res, 200, { id: createObject(Number(parts[3]), placement) }), true;
      }
      if (parts.length === 6 && parts[4] === "objects" && method === "PATCH") {
        const placement = (await readJsonBody(req)) as ObjectPlacement;
        updateObject(Number(parts[3]), { ...placement, id: Number(parts[5]) });
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 6 && parts[4] === "objects" && method === "DELETE") {
        deleteObject(Number(parts[3]), Number(parts[5]));
        return sendJson(res, 200, { ok: true }), true;
      }
    }

    // /api/admin/floors[/:level]
    if (parts[2] === "floors") {
      if (parts.length === 3 && method === "GET") return sendJson(res, 200, getFloors()), true;
      if (parts.length === 3 && method === "POST") {
        const floor = (await readJsonBody(req)) as Floor;
        createFloor(floor);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "PATCH") {
        const floor = (await readJsonBody(req)) as { label: string; baseRoomId: number };
        updateFloor(Number(parts[3]), floor);
        return sendJson(res, 200, { ok: true }), true;
      }
      if (parts.length === 4 && method === "DELETE") {
        deleteFloor(Number(parts[3]));
        return sendJson(res, 200, { ok: true }), true;
      }
    }
  } catch (err) {
    console.error("[adminApi] request failed", err);
    sendJson(res, 500, { error: (err as Error).message });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

// House Simulator admin tool — a separate app from the Tauri game and the
// public viewer, served by the Node server itself at /admin/. Talks to the
// plain REST surface under /api/admin/* (server/adminApi.ts), not the
// game's WebSocket RPC protocol — this is traditional CRUD, not real-time
// multiplayer state.
//
// Room editing is staged (a local draft, not written until Save) rather
// than saving on every field change — editing a room's objects is a batch
// of related changes, not a series of independent ones, and a mid-edit
// network error shouldn't leave the room half-updated. The room preview
// (AdminPreviewRenderer, reusing the exact same SceneRenderer the game and
// viewer use) lives inside the edit modal, shows only that one room (no
// panning — there's nothing else to pan to), and re-renders from the
// in-memory draft on every field change, so what you see is always what
// Save would actually persist.
//
// x/y can be entered as raw pixels (the underlying storage, always) or,
// with "Tile mode" on, as grid coordinates — converted through
// gridToScreen/screenToGrid, the exact same isometric math the renderer
// itself uses for tile placement, not a flat multiply. "Place" puts the
// preview into click-a-tile mode instead of typing coordinates by hand —
// a snapped, single-click placement rather than continuous drag-and-drop,
// since there's no browser available in this environment to visually
// verify continuous pointer-drag math well enough to trust.
import { Application, Assets, Container, Graphics, Texture } from "pixi.js";
import { buildModal } from "./ui/modal";
import { assetUrl, buildFloorAndWalls, buildLayer, preloadRoomAssets } from "./scene/renderer";
import { AdminPreviewRenderer } from "./scene/adminPreview";
import { setActivities } from "./scene/activities";
import {
  buildFloorTree,
  ConnectedToEntry,
  ConnectionDirection,
  computeFloorMembership,
  FloorTreeNode,
  getUsedRoomIds,
  gridToScreen,
  ObjectTypeDef,
  PAIR_DIRECTION,
  resolveRooms,
  RoomDef,
  roomSpecsFromWire,
  screenToGrid,
  setObjectTypes,
  setRooms,
  SpriteLayer,
  TILE_WIDTH,
} from "./scene/rooms";
import { floor1, wall1 } from "./scene/tileset";
import { Floor } from "./scene/floors";

const ADMIN_SECRET_KEY = "houseSimulatorAdminSecret";

interface Character {
  id: string;
  name: string;
  secret: string;
  awBucketId: string;
}

interface ActivityDef {
  id: number;
  label: string;
  color: number;
}

// id is omitted for a not-yet-saved placement (the room editor's draft for
// a brand-new object the admin just added) — same "global objects.id,
// absent until persisted" contract as ObjectPlacement itself (rooms.ts).
interface ObjectPlacementWire {
  id?: number;
  type: number;
  x: number;
  y: number;
  enabled: boolean;
}

interface RoomSpecWire {
  id: number;
  name: string;
  cols: number;
  rows: number;
  floorVariant: string;
  wallVariant: string;
  showLeftWall?: boolean;
  showRightWall?: boolean;
  connectedTo?: ConnectedToEntry[];
  objects: ObjectPlacementWire[];
}

/** `wrongSecret` turns this into the same form shown again after a 401 — pre-filled with nothing (there's no point re-showing a value just proven wrong) but with an error explaining why, rather than the bare first-launch form. */
function getOrPromptSecret(wrongSecret?: string): Promise<string> {
  const existing = localStorage.getItem(ADMIN_SECRET_KEY);
  if (existing && !wrongSecret) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "admin-secret-overlay";

    const form = document.createElement("form");
    form.id = "admin-secret-form";

    const title = document.createElement("h2");
    title.textContent = wrongSecret ? "Wrong admin secret — try again" : "Admin secret";
    form.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "server_config.admin_secret";
    input.required = true;
    form.appendChild(input);

    if (wrongSecret) {
      const errorEl = document.createElement("div");
      errorEl.className = "admin-error";
      errorEl.textContent = `"${wrongSecret}" was rejected by the server.`;
      form.appendChild(errorEl);
    }

    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Continue";
    form.appendChild(button);

    form.onsubmit = (e) => {
      e.preventDefault();
      const newSecret = input.value.trim();
      if (!newSecret) return;
      localStorage.setItem(ADMIN_SECRET_KEY, newSecret);
      overlay.remove();
      resolve(newSecret);
    };

    overlay.appendChild(form);
    document.body.appendChild(overlay);
    input.focus();
  });
}

let secret = "";

/**
 * On a 401 (wrong/changed secret — e.g. the server_config.admin_secret
 * value itself was just updated), re-prompts immediately instead of
 * clearing localStorage and telling the admin to reload — same
 * self-healing reasoning as the game's own connection form, just without
 * needing a page reload to see the new prompt. Retries the SAME request
 * once the admin enters a new value; `options.body` is always a plain
 * JSON string here (never a one-shot stream), so re-sending it is safe.
 */
async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  while (true) {
    const res = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${secret}`,
        ...options.headers,
      },
    });
    if (res.status === 401) {
      secret = await getOrPromptSecret(secret);
      continue;
    }
    if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} failed (${res.status})`);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }
}

const app = document.getElementById("admin-app")!;

function showError(err: unknown) {
  const el = document.createElement("div");
  el.className = "admin-error";
  el.textContent = err instanceof Error ? err.message : String(err);
  app.prepend(el);
  setTimeout(() => el.remove(), 6000);
}

/** 2 decimals is plenty — most positions aren't tile-aligned at all, so this is routinely a non-round fraction, not floating-point noise to hide. Shared by the room editor's tile mode and the object-type editor's anchor tile mode. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface BroadcastHealthInfo {
  lastSuccessAt: string | null;
  lastError: string | null;
  configured: boolean;
}

/**
 * Manual "push to val.town now" — the server itself only pushes the house
 * layout (activities/object types/rooms/floors) once at its own startup,
 * not on a timer or after every edit (admin changes are infrequent and
 * usually come in a burst), so this is the only way the public viewer
 * picks up a room/activity/object-type edit before the next server
 * restart. Lives at the top of the page, not inside the Rooms tab, since
 * it covers all three tabs' worth of data at once.
 */
function setupSyncButton(): void {
  const container = document.createElement("div");
  container.className = "admin-form";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Sync to viewer";
  container.appendChild(button);

  const statusEl = document.createElement("span");
  statusEl.className = "admin-hint";
  container.appendChild(statusEl);

  button.onclick = async () => {
    button.disabled = true;
    statusEl.textContent = "Syncing…";
    try {
      const health = await adminFetch<BroadcastHealthInfo>("/api/admin/sync-house-layout", { method: "POST" });
      if (!health.configured) {
        statusEl.textContent = "No broadcast_url configured on the server — nothing to sync to.";
      } else if (health.lastError) {
        statusEl.textContent = `Sync failed: ${health.lastError}`;
      } else {
        statusEl.textContent = `Synced at ${health.lastSuccessAt ? new Date(health.lastSuccessAt).toLocaleTimeString() : "?"}`;
      }
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      button.disabled = false;
    }
  };

  app.appendChild(container);
}

// --- Tabs ---

type TabId = "characters" | "activities" | "object-types" | "rooms";
const TABS: { id: TabId; label: string }[] = [
  { id: "characters", label: "Characters" },
  { id: "activities", label: "Activities" },
  { id: "object-types", label: "Object Types" },
  { id: "rooms", label: "Rooms" },
];

function setupTabs(): Record<TabId, HTMLElement> {
  const tabBar = document.createElement("div");
  tabBar.id = "admin-tab-bar";
  app.appendChild(tabBar);

  const pages = {} as Record<TabId, HTMLElement>;
  const buttons = {} as Record<TabId, HTMLButtonElement>;

  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.textContent = tab.label;
    btn.onclick = () => showTab(tab.id);
    tabBar.appendChild(btn);
    buttons[tab.id] = btn;

    const page = document.createElement("div");
    page.className = "admin-tab-page";
    app.appendChild(page);
    pages[tab.id] = page;
  }

  function showTab(id: TabId) {
    for (const tab of TABS) {
      pages[tab.id].classList.toggle("active", tab.id === id);
      buttons[tab.id].classList.toggle("active", tab.id === id);
    }
  }
  showTab("characters");

  return pages;
}

// --- Characters ---

/**
 * Edits (or creates, when `id` is null) a character — matches the
 * Activities/Object-Types tabs' modal-based edit pattern. Secret/bucket id
 * are only editable once a character exists (the server generates both on
 * create); changing the secret immediately invalidates every device still
 * connected with the old one (see updateCharacterSecret's own comment),
 * and changing the bucket id points AW tracking at a different bucket
 * going forward — it doesn't move any existing history over.
 */
function openCharacterEditModal(id: string | null, existing: Character | null, onSaved: () => void): void {
  const modal = buildModal(id ? `Edit Character: ${existing!.name}` : "Add Character", {});

  const form = document.createElement("div");
  form.className = "admin-form";
  modal.body.appendChild(form);

  const nameInput = document.createElement("input");
  nameInput.placeholder = "Name";
  nameInput.value = existing?.name ?? "";
  form.append(document.createTextNode("Name:"), nameInput);

  let secretInput: HTMLInputElement | null = null;
  let bucketInput: HTMLInputElement | null = null;
  if (existing) {
    secretInput = document.createElement("input");
    secretInput.value = existing.secret;
    form.append(document.createTextNode("Secret:"), secretInput);

    bucketInput = document.createElement("input");
    bucketInput.value = existing.awBucketId;
    form.append(document.createTextNode("AW bucket:"), bucketInput);
  }

  const footer = document.createElement("div");
  footer.className = "admin-form";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);
  modal.body.appendChild(footer);

  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showError(new Error("Name is required"));
      return;
    }
    try {
      if (id) {
        await adminFetch(`/api/admin/characters/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, secret: secretInput!.value.trim(), awBucketId: bucketInput!.value.trim() }),
        });
      } else {
        await adminFetch("/api/admin/characters", { method: "POST", body: JSON.stringify({ name }) });
      }
      modal.close();
      onSaved();
    } catch (err) {
      showError(err);
    }
  };
  cancelBtn.onclick = () => modal.close();

  modal.open();
}

async function renderCharacters(body: HTMLElement) {
  body.textContent = "";
  const characters = await adminFetch<Character[]>("/api/admin/characters");

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Name</th><th>Secret</th><th>AW bucket</th><th></th></tr>";
  for (const c of characters) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${c.name}</td><td><code>${c.secret}</code></td><td>${c.awBucketId}</td>`;
    const actionCell = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openCharacterEditModal(c.id, c, () => renderCharacters(body));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete character "${c.name}"? Their goals/todos stay in the database but become unreachable.`)) return;
      try {
        await adminFetch(`/api/admin/characters/${c.id}`, { method: "DELETE" });
        renderCharacters(body);
      } catch (err) {
        showError(err);
      }
    };
    actionCell.append(editBtn, deleteBtn);
    row.appendChild(actionCell);
    table.appendChild(row);
  }
  body.appendChild(table);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add Character";
  addBtn.onclick = () => openCharacterEditModal(null, null, () => renderCharacters(body));
  body.appendChild(addBtn);
}

// --- Activities ---

/** Edits (or creates, when `id` is null) one activity's label/color — matches the Object Types tab's modal-based edit pattern rather than always-editable inline table fields. */
function openActivityEditModal(id: number | null, existing: ActivityDef | null, onSaved: () => void): void {
  const modal = buildModal(id ? `Edit Activity: ${existing!.label}` : "Add Activity", {});

  const form = document.createElement("div");
  form.className = "admin-form";
  modal.body.appendChild(form);

  const labelInput = document.createElement("input");
  labelInput.placeholder = "Label";
  labelInput.value = existing?.label ?? "";
  form.append(document.createTextNode("Label:"), labelInput);

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = `#${(existing?.color ?? 0x888888).toString(16).padStart(6, "0")}`;
  form.append(document.createTextNode("Color:"), colorInput);

  const footer = document.createElement("div");
  footer.className = "admin-form";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);
  modal.body.appendChild(footer);

  saveBtn.onclick = async () => {
    const label = labelInput.value.trim();
    if (!label) {
      showError(new Error("Label is required"));
      return;
    }
    const color = parseInt(colorInput.value.slice(1), 16);
    try {
      if (id) {
        await adminFetch(`/api/admin/activities/${id}`, { method: "PATCH", body: JSON.stringify({ label, color }) });
      } else {
        await adminFetch("/api/admin/activities", { method: "POST", body: JSON.stringify({ label, color }) });
      }
      modal.close();
      onSaved();
    } catch (err) {
      showError(err);
    }
  };
  cancelBtn.onclick = () => modal.close();

  modal.open();
}

async function renderActivities(body: HTMLElement) {
  body.textContent = "";
  const activities = await adminFetch<ActivityDef[]>("/api/admin/activities");

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Label</th><th>Color</th><th></th></tr>";
  for (const a of activities) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = a.label;
    row.appendChild(labelCell);

    const colorCell = document.createElement("td");
    const swatch = document.createElement("span");
    swatch.className = "admin-swatch";
    swatch.style.background = `#${a.color.toString(16).padStart(6, "0")}`;
    colorCell.appendChild(swatch);
    row.appendChild(colorCell);

    const actionCell = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openActivityEditModal(a.id, a, () => renderActivities(body));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete activity "${a.label}"? Any object still referencing it will stop matching anything.`)) return;
      try {
        await adminFetch(`/api/admin/activities/${a.id}`, { method: "DELETE" });
        renderActivities(body);
      } catch (err) {
        showError(err);
      }
    };
    actionCell.append(editBtn, deleteBtn);
    row.appendChild(actionCell);
    table.appendChild(row);
  }
  body.appendChild(table);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add Activity";
  addBtn.onclick = () => openActivityEditModal(null, null, () => renderActivities(body));
  body.appendChild(addBtn);
}

// --- Object types ---

const TYPE_PREVIEW_WIDTH = 260;
const TYPE_PREVIEW_HEIGHT = 240;
// Where the room's (0,0) tile corner lands on the canvas — chosen so a
// couple of tiles' worth of real floor/wall are visible around it, with
// room on every side for a typical object's width/height (plus whatever an
// anchor shifts it by) to not get clipped.
const TYPE_PREVIEW_ORIGIN = { x: 110, y: 70 };
// A minimal but fully real RoomDef — same floor1/wall1 tiles and the same
// buildFloorAndWalls() the actual game renders with, just small (2x2) and
// with no objects of its own, so the anchor can be judged against a real
// room corner instead of a bare wireframe grid.
const TYPE_PREVIEW_ROOM: RoomDef = { id: 0, name: "preview", cols: 2, rows: 2, level: 0, floor: floor1, wall: wall1, objects: [], x: 0, y: 0, width: 0, height: 0 };

function makeDefaultObjectType(): ObjectTypeDef {
  // Anchor defaults to dead center (half width, half height) rather than
  // (0,0) — a much more common "floor contact point" for a generic new
  // object than the sprite's own top-left, and it's what every existing
  // type got bulk-set to when anchors were introduced.
  // id: 0 is a placeholder only — never read for a not-yet-saved type (the
  // server assigns the real id on create); harmless if it rides along in
  // the POST payload since the server never trusts a client-supplied id.
  return { id: 0, name: "", width: 32, height: 32, below: [{ color: 0x888888 }], anchorX: 16, anchorY: 16 };
}

async function ensureTextureLoaded(path: string | undefined): Promise<void> {
  if (!path) return;
  const texture = await Assets.load<Texture>(assetUrl(path));
  texture.source.scaleMode = "nearest"; // keep pixel art crisp, same as preloadRoomAssets
}

/**
 * Edits one object type's name/size/primary sprite/anchor point. Only
 * `below[0]` is editable here (a texture picked from existing files under
 * public/objects/, or a solid-color placeholder) — every current type has
 * at most one `below` entry, so this doesn't lose anything for them;
 * `overlay`/`above`/`actions` are carried through unchanged from whatever
 * was loaded. The preview renders a real floor+wall room corner (sized to
 * the object's own footprint) and repositions the sprite so its anchor
 * point always lands exactly on that corner — so tuning the anchor via the
 * number inputs below shows, live, how the object will actually sit
 * relative to the wall. No click-to-set: a live Pixi canvas turned out to
 * be a fiddly, imprecise way to pick a specific pixel — the text inputs
 * are the only way to set it.
 */
async function openObjectTypeEditModal(
  id: string | null,
  existing: ObjectTypeDef | null,
  assetPaths: string[],
  onSaved: () => void,
) {
  const draftType: ObjectTypeDef = existing
    ? { ...existing, below: existing.below ? [...existing.below] : undefined }
    : makeDefaultObjectType();
  let anchorX = draftType.anchorX ?? 0;
  let anchorY = draftType.anchorY ?? 0;
  // Only a brand-new type keeps auto-centering its anchor as width/height
  // change — an existing type already has a real (now bulk-migrated)
  // anchor the admin may be deliberately tuning, so a width/height edit
  // there must never silently override it.
  let anchorTouched = existing !== null;

  const modal = buildModal(id ? `Edit Object Type: ${draftType.name}` : "Add Object Type", {});

  const form = document.createElement("div");
  form.className = "admin-form";
  modal.body.appendChild(form);

  const nameInput = document.createElement("input");
  nameInput.placeholder = "Name";
  nameInput.value = draftType.name;
  form.append(document.createTextNode("Name:"), nameInput);

  const widthInput = document.createElement("input");
  widthInput.type = "number";
  widthInput.value = String(draftType.width);
  widthInput.style.width = "60px";
  const heightInput = document.createElement("input");
  heightInput.type = "number";
  heightInput.value = String(draftType.height);
  heightInput.style.width = "60px";
  form.append(document.createTextNode("W:"), widthInput, document.createTextNode("H:"), heightInput);

  const spriteSelect = document.createElement("select");
  const colorOpt = document.createElement("option");
  colorOpt.value = "__color__";
  colorOpt.textContent = "(solid color)";
  spriteSelect.appendChild(colorOpt);
  for (const path of assetPaths) {
    const opt = document.createElement("option");
    opt.value = path;
    opt.textContent = path.replace(/^\/objects\//, "");
    spriteSelect.appendChild(opt);
  }
  const initialTexture = draftType.below?.[0]?.texture;
  spriteSelect.value = initialTexture ?? "__color__";
  form.append(document.createTextNode("Sprite:"), spriteSelect);

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  const initialColor = draftType.below?.[0]?.color;
  colorInput.value = `#${(initialColor ?? 0x888888).toString(16).padStart(6, "0")}`;
  colorInput.style.display = initialTexture ? "none" : "";
  form.appendChild(colorInput);
  modal.body.appendChild(form);

  const anchorHint = document.createElement("div");
  anchorHint.className = "admin-hint";
  anchorHint.textContent =
    "Set the anchor point below — the sprite shifts so that point lands on the room corner, same as it will when placed via the room editor's tile mode. Unset defaults to the sprite's own top-left (today's behavior).";
  modal.body.appendChild(anchorHint);

  const anchorTileModeLabel = document.createElement("label");
  anchorTileModeLabel.className = "admin-tile-mode-toggle";
  const anchorTileModeCheckbox = document.createElement("input");
  anchorTileModeCheckbox.type = "checkbox";
  anchorTileModeLabel.append(anchorTileModeCheckbox, document.createTextNode(" Tile mode (snap the anchor to the diamond grid, enter as tile coordinates)"));
  modal.body.appendChild(anchorTileModeLabel);

  const anchorRow = document.createElement("div");
  anchorRow.className = "admin-form";
  const anchorXLabel = document.createTextNode("Anchor X:");
  const anchorXInput = document.createElement("input");
  anchorXInput.type = "number";
  anchorXInput.style.width = "60px";
  const anchorYLabel = document.createTextNode("Anchor Y:");
  const anchorYInput = document.createElement("input");
  anchorYInput.type = "number";
  anchorYInput.style.width = "60px";
  anchorRow.append(anchorXLabel, anchorXInput, anchorYLabel, anchorYInput);
  modal.body.appendChild(anchorRow);

  const previewContainer = document.createElement("div");
  previewContainer.id = "admin-preview-canvas";
  modal.body.appendChild(previewContainer);

  const footer = document.createElement("div");
  footer.className = "admin-form";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);
  modal.body.appendChild(footer);

  const app = new Application();
  await app.init({ width: TYPE_PREVIEW_WIDTH, height: TYPE_PREVIEW_HEIGHT, background: 0x222228 });
  previewContainer.appendChild(app.canvas);

  const stage = new Container();
  stage.position.set(TYPE_PREVIEW_ORIGIN.x, TYPE_PREVIEW_ORIGIN.y);
  app.stage.addChild(stage);

  // Real floor + walls (the exact same buildFloorAndWalls() the actual
  // game uses), not a bare wireframe grid — so the anchor is judged
  // against what a room corner actually looks like. Sized off the
  // object's own footprint (one tile is TILE_WIDTH px) plus one tile of
  // margin, so a big object (e.g. a 64x64 piano, a 2x2 footprint) gets a
  // 3x3 room instead of being cramped against a 2x2 one.
  let floorWallLayer = new Container();
  stage.addChild(floorWallLayer);

  function roomSizeFor(width: number, height: number): number {
    return Math.max(1, Math.ceil(Math.max(width, height) / TILE_WIDTH)) + 1;
  }

  function rebuildRoom() {
    stage.removeChild(floorWallLayer);
    floorWallLayer.destroy({ children: true });
    const size = roomSizeFor(Number(widthInput.value) || 1, Number(heightInput.value) || 1);
    floorWallLayer = buildFloorAndWalls({ ...TYPE_PREVIEW_ROOM, cols: size, rows: size });
    stage.addChildAt(floorWallLayer, 0);
  }

  let spriteLayer = new Container();
  stage.addChild(spriteLayer);
  // Fixed, never moves — it marks the room corner (stage-local (0,0)) that
  // the sprite's anchor point always lands on by construction (see
  // rebuildSprite below), not the anchor's own shifting pixel location.
  const crosshair = new Graphics()
    .moveTo(-6, 0)
    .lineTo(6, 0)
    .moveTo(0, -6)
    .lineTo(0, 6)
    .stroke({ width: 2, color: 0xff3366 })
    .circle(0, 0, 3)
    .fill({ color: 0xff3366 });
  stage.addChild(crosshair);

  function currentPrimaryLayer(): SpriteLayer {
    return spriteSelect.value === "__color__" ? { color: parseInt(colorInput.value.slice(1), 16) } : { texture: spriteSelect.value };
  }

  /** Mirrors the room editor's tile-mode display convention: shows anchorX/anchorY as raw pixels, or as the tile (u,v) they correspond to. */
  function syncAnchorInputs() {
    anchorXLabel.textContent = anchorTileModeCheckbox.checked ? "Anchor tile u:" : "Anchor X:";
    anchorYLabel.textContent = anchorTileModeCheckbox.checked ? "Anchor tile v:" : "Anchor Y:";
    if (anchorTileModeCheckbox.checked) {
      const { u, v } = screenToGrid(anchorX, anchorY);
      anchorXInput.value = String(round2(u));
      anchorYInput.value = String(round2(v));
    } else {
      anchorXInput.value = String(anchorX);
      anchorYInput.value = String(anchorY);
    }
  }

  // Rebuilds the sprite AND repositions it so the anchor point (anchorX,
  // anchorY) always lands exactly at stage-local (0,0) — the pinned
  // crosshair — instead of the sprite always sitting at (0,0) with the
  // crosshair floating over it. This is what makes moving the anchor
  // visibly shift the object relative to the room corner.
  function rebuildSprite() {
    rebuildRoom();
    stage.removeChild(spriteLayer);
    spriteLayer.destroy({ children: true });
    spriteLayer = new Container();
    const width = Number(widthInput.value) || 1;
    const height = Number(heightInput.value) || 1;
    for (const layer of [currentPrimaryLayer(), ...(draftType.above ?? [])]) {
      spriteLayer.addChild(buildLayer(layer, width, height));
    }
    spriteLayer.position.set(-anchorX, -anchorY);
    stage.addChildAt(spriteLayer, 1); // above the floor/walls, below the crosshair
    syncAnchorInputs();
    app.render();
  }

  spriteSelect.onchange = async () => {
    colorInput.style.display = spriteSelect.value === "__color__" ? "" : "none";
    if (spriteSelect.value !== "__color__") await ensureTextureLoaded(spriteSelect.value);
    rebuildSprite();
  };
  colorInput.oninput = () => rebuildSprite();
  function applyWidthHeight() {
    if (!anchorTouched) {
      anchorX = Math.round((Number(widthInput.value) || 0) / 2);
      anchorY = Math.round((Number(heightInput.value) || 0) / 2);
    }
    rebuildSprite();
  }
  widthInput.onchange = applyWidthHeight;
  heightInput.onchange = applyWidthHeight;
  anchorTileModeCheckbox.onchange = () => syncAnchorInputs(); // redisplay only — doesn't change the underlying anchor
  function applyAnchorInputs() {
    anchorTouched = true;
    if (anchorTileModeCheckbox.checked) {
      const screen = gridToScreen(Number(anchorXInput.value), Number(anchorYInput.value));
      anchorX = Math.round(screen.x);
      anchorY = Math.round(screen.y);
    } else {
      anchorX = Number(anchorXInput.value);
      anchorY = Number(anchorYInput.value);
    }
    rebuildSprite();
  }
  anchorXInput.onchange = applyAnchorInputs;
  anchorYInput.onchange = applyAnchorInputs;

  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showError(new Error("Name is required"));
      return;
    }
    const payload: ObjectTypeDef = {
      ...draftType,
      name,
      width: Number(widthInput.value),
      height: Number(heightInput.value),
      below: [currentPrimaryLayer()],
      anchorX,
      anchorY,
    };
    try {
      if (id) {
        await adminFetch(`/api/admin/object-types/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await adminFetch("/api/admin/object-types", { method: "POST", body: JSON.stringify(payload) });
      }
      modal.close();
      onSaved();
    } catch (err) {
      showError(err);
    }
  };
  cancelBtn.onclick = () => modal.close();
  modal.onClose(() => app.destroy());

  await ensureTextureLoaded(initialTexture);
  rebuildSprite();
  modal.open();
}

async function renderObjectTypes(body: HTMLElement) {
  body.textContent = "";
  const [types, assetPaths] = await Promise.all([
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
    adminFetch<string[]>("/api/admin/object-assets"),
  ]);

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Name</th><th>Size</th><th>Anchor</th><th></th></tr>";
  for (const [id, type] of Object.entries(types)) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${type.name}</td><td>${type.width}×${type.height}</td><td>${type.anchorX ?? 0}, ${type.anchorY ?? 0}</td>`;

    const actionCell = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openObjectTypeEditModal(id, type, assetPaths, () => renderObjectTypes(body));
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete object type "${type.name}"? Any room placement still referencing it will stop rendering.`)) return;
      try {
        await adminFetch(`/api/admin/object-types/${id}`, { method: "DELETE" });
        renderObjectTypes(body);
      } catch (err) {
        showError(err);
      }
    };
    actionCell.append(editBtn, deleteBtn);
    row.appendChild(actionCell);
    table.appendChild(row);
  }
  body.appendChild(table);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "Add Object Type";
  addBtn.onclick = () => openObjectTypeEditModal(null, null, assetPaths, () => renderObjectTypes(body));
  body.appendChild(addBtn);
}

// --- Rooms ---

function cloneObjects(objects: ObjectPlacementWire[]): ObjectPlacementWire[] {
  return objects.map((o) => ({ ...o }));
}

/**
 * Edits one room in isolation: a local draft array of its objects, a
 * preview that re-renders from that draft on every change (never from the
 * server), and a Save button gated on the draft actually differing from
 * what was loaded. Cancel/closing the modal without saving discards the
 * draft entirely — nothing reaches the server until Save.
 */
async function openRoomEditModal(room: RoomSpecWire, objectTypes: Record<string, ObjectTypeDef>, onSaved: () => void) {
  const typeIds = Object.keys(objectTypes);
  const original = cloneObjects(room.objects);
  const draft = cloneObjects(room.objects);

  /** Pixel offset from a type's top-left to its "floor contact" point — see ObjectTypeDef.anchorX/anchorY. Unknown/unset types default to (0,0), i.e. today's behavior. */
  function anchorFor(typeId: number): { x: number; y: number } {
    const type = objectTypes[String(typeId)];
    return { x: type?.anchorX ?? 0, y: type?.anchorY ?? 0 };
  }

  // Purely a relabeling of which integer tile mode shows/accepts as the
  // room's corner — gridToScreen/screenToGrid themselves (and everything
  // outside this modal) are untouched. The engine's own (0,0) already sits
  // exactly where the back walls meet (confirmed: floor's first tile and
  // the wall corner piece both key off it) — but by eye, with the wall
  // art's own height, what reads as "the corner" one tile further in. This
  // shift just moves which label the admin tool prints/accepts for a given
  // point, by a constant (-1,-1), so that spot displays as tile (0,0)
  // instead of (1,1).
  const TILE_LABEL_SHIFT = 1;
  function tileLabelToScreen(u: number, v: number) {
    return gridToScreen(u + TILE_LABEL_SHIFT, v + TILE_LABEL_SHIFT);
  }
  function screenToTileLabel(x: number, y: number): { u: number; v: number } {
    const raw = screenToGrid(x, y);
    return { u: raw.u - TILE_LABEL_SHIFT, v: raw.v - TILE_LABEL_SHIFT };
  }

  const modal = buildModal(`Edit Room: ${room.name}`, { size: "large", resizable: true });

  const previewContainer = document.createElement("div");
  previewContainer.id = "admin-preview-canvas";
  modal.body.appendChild(previewContainer);

  const hint = document.createElement("div");
  hint.className = "admin-hint";
  hint.textContent = "Preview reflects unsaved changes below — nothing is written until you press Save.";
  modal.body.appendChild(hint);

  // Room-level fields (size + wall visibility) — a separate draft from the
  // objects draft above, since they're independent concerns, but saved
  // together: Save below both PATCHes the room's own fields (if changed)
  // and diffs the object draft, in one click. No bounds-checking against
  // object positions when shrinking — objects simply aren't clamped to the
  // room's own footprint anywhere else in this engine, so resizing smaller
  // than where an object sits is allowed (same "not our problem" stance).
  const roomFields = { name: room.name, cols: room.cols, rows: room.rows, showLeftWall: room.showLeftWall !== false, showRightWall: room.showRightWall !== false };

  const roomPropsForm = document.createElement("div");
  roomPropsForm.className = "admin-form";
  modal.body.appendChild(roomPropsForm);

  const nameInput = document.createElement("input");
  nameInput.value = roomFields.name;
  roomPropsForm.append(document.createTextNode("Name:"), nameInput);

  const colsInput = document.createElement("input");
  colsInput.type = "number";
  colsInput.min = "1";
  colsInput.value = String(roomFields.cols);
  colsInput.style.width = "60px";
  const rowsInput = document.createElement("input");
  rowsInput.type = "number";
  rowsInput.min = "1";
  rowsInput.value = String(roomFields.rows);
  rowsInput.style.width = "60px";
  roomPropsForm.append(document.createTextNode("Cols:"), colsInput, document.createTextNode("Rows:"), rowsInput);

  // Its own row, not crammed onto the Name/Cols/Rows line above — two
  // checkboxes read much easier with room to breathe.
  const wallVisibilityForm = document.createElement("div");
  wallVisibilityForm.className = "admin-form";
  modal.body.appendChild(wallVisibilityForm);

  const showLeftWallLabel = document.createElement("label");
  const showLeftWallCheckbox = document.createElement("input");
  showLeftWallCheckbox.type = "checkbox";
  showLeftWallCheckbox.checked = roomFields.showLeftWall;
  showLeftWallLabel.append(showLeftWallCheckbox, document.createTextNode(" Top-left wall"));
  const showRightWallLabel = document.createElement("label");
  const showRightWallCheckbox = document.createElement("input");
  showRightWallCheckbox.type = "checkbox";
  showRightWallCheckbox.checked = roomFields.showRightWall;
  showRightWallLabel.append(showRightWallCheckbox, document.createTextNode(" Top-right wall"));
  wallVisibilityForm.append(showLeftWallLabel, showRightWallLabel);

  function applyRoomFields() {
    roomFields.name = nameInput.value;
    // Clamped to >=1 rather than rejected — an in-between value (e.g.
    // clearing the field while typing) shouldn't block editing, it should
    // just floor at the minimum, same spirit as the input's own min="1".
    roomFields.cols = Math.max(1, Math.round(Number(colsInput.value) || 1));
    roomFields.rows = Math.max(1, Math.round(Number(rowsInput.value) || 1));
    colsInput.value = String(roomFields.cols);
    rowsInput.value = String(roomFields.rows);
    roomFields.showLeftWall = showLeftWallCheckbox.checked;
    roomFields.showRightWall = showRightWallCheckbox.checked;
    updateSaveState();
    renderPreview();
  }
  nameInput.onchange = applyRoomFields;
  colsInput.onchange = applyRoomFields;
  rowsInput.onchange = applyRoomFields;
  showLeftWallCheckbox.onchange = applyRoomFields;
  showRightWallCheckbox.onchange = applyRoomFields;

  const tileModeLabel = document.createElement("label");
  tileModeLabel.className = "admin-tile-mode-toggle";
  const tileModeCheckbox = document.createElement("input");
  tileModeCheckbox.type = "checkbox";
  tileModeLabel.append(tileModeCheckbox, document.createTextNode(" Tile mode (enter grid coordinates instead of raw pixels)"));
  modal.body.appendChild(tileModeLabel);

  const table = document.createElement("table");
  table.className = "admin-table";
  modal.body.appendChild(table);

  const addForm = document.createElement("form");
  addForm.className = "admin-form";
  modal.body.appendChild(addForm);

  const footer = document.createElement("div");
  footer.className = "admin-form";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  footer.append(saveBtn, cancelBtn);
  modal.body.appendChild(footer);

  let currentApp: Application | null = null;
  let currentRenderer: AdminPreviewRenderer | null = null;
  let placingObjectId: number | null = null;

  const originalRoomFields = { ...roomFields };
  function isRoomFieldsDirty(): boolean {
    return JSON.stringify(originalRoomFields) !== JSON.stringify(roomFields);
  }

  function isDirty(): boolean {
    return isRoomFieldsDirty() || JSON.stringify(original) !== JSON.stringify(draft);
  }

  function updateSaveState() {
    saveBtn.disabled = !isDirty();
  }

  function highlightRow(_roomId: number, objectId: number) {
    const row = document.getElementById(`modal-obj-row-${objectId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("admin-row-highlight");
    setTimeout(() => row.classList.remove("admin-row-highlight"), 1500);
  }

  /**
   * Full scene rebuild — only for changes a live move can't express (type,
   * enabled, add/remove). x/y-only edits use moveObject() instead (see
   * applyPosition below), which never tears down the canvas.
   *
   * Self-contained error handling (not left to callers) on purpose: every
   * call site below fires this without awaiting/catching it, so a thrown
   * error here would otherwise become a silent unhandled rejection —
   * exactly how the connectedTo bug this fixed manifested as "the preview
   * just doesn't update," not a visible error.
   */
  async function renderPreview() {
    placingObjectId = null;
    try {
      currentApp?.destroy();
      previewContainer.textContent = "";

      // Single-room spec, connectedTo stripped — nothing else exists to
      // connect to, and nothing else exists to pan to, which is the point.
      // Without this, any room that normally connects to another one
      // (most of them — only office/bedroom/basement have no connectedTo
      // at all) sent resolveRooms() chasing a connectedTo.roomId that
      // doesn't exist in this one-room array, throwing inside setRooms()
      // before the Pixi app ever got far enough to render anything.
      setRooms(roomSpecsFromWire([{ ...room, ...roomFields, objects: draft, connectedTo: undefined }]), []);

      currentApp = new Application();
      await currentApp.init({ width: 420, height: 320, background: 0x222228 });
      previewContainer.appendChild(currentApp.canvas);
      currentRenderer = new AdminPreviewRenderer(currentApp, () => {}, highlightRow);
      console.log("[admin] renderPreview rebuilt OK, currentRenderer set:", !!currentRenderer);
    } catch (err) {
      console.error("[admin] renderPreview failed", err);
      showError(err);
    }
  }

  function renderTable() {
    const tileMode = tileModeCheckbox.checked;
    table.innerHTML = `<tr><th>Type</th><th>${tileMode ? "tile u" : "x"}</th><th>${tileMode ? "tile v" : "y"}</th><th>Enabled</th><th></th><th></th></tr>`;
    for (const obj of draft) {
      const row = document.createElement("tr");
      // Row id still keys off the real/placeholder numeric id internally
      // (DOM scroll/highlight target) — just never shown to the admin.
      row.id = `modal-obj-row-${obj.id}`;

      const typeSelect = document.createElement("select");
      for (const typeId of typeIds) {
        const opt = document.createElement("option");
        opt.value = typeId;
        opt.textContent = objectTypes[typeId]?.name ?? typeId;
        opt.selected = Number(typeId) === obj.type;
        typeSelect.appendChild(opt);
      }
      const typeCell = document.createElement("td");
      typeCell.appendChild(typeSelect);
      row.appendChild(typeCell);

      // In tile mode the displayed coordinate is the anchor's tile, not the
      // sprite's raw top-left — screenToGrid(x + anchorX, y + anchorY)
      // rather than screenToGrid(x, y) — so it round-trips correctly
      // through applyPosition()/the Place button below.
      const anchor = anchorFor(obj.type);
      const displayed = tileMode ? screenToTileLabel(obj.x + anchor.x, obj.y + anchor.y) : { u: obj.x, v: obj.y };
      const xInput = document.createElement("input");
      xInput.type = "number";
      xInput.value = String(round2(displayed.u));
      xInput.style.width = "60px";
      const xCell = document.createElement("td");
      xCell.appendChild(xInput);
      row.appendChild(xCell);

      const yInput = document.createElement("input");
      yInput.type = "number";
      yInput.value = String(round2(displayed.v));
      yInput.style.width = "60px";
      const yCell = document.createElement("td");
      yCell.appendChild(yInput);
      row.appendChild(yCell);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = obj.enabled;
      const enabledCell = document.createElement("td");
      enabledCell.appendChild(checkbox);
      row.appendChild(enabledCell);

      // x/y move the object live (AdminPreviewRenderer.moveObject) instead
      // of a full scene rebuild — this is the fix for the "blip" when
      // nudging a number input's spinner/arrow keys repeatedly, which was
      // tearing down and recreating the whole Pixi canvas on every change.
      function applyPosition() {
        const enteredU = Number(xInput.value);
        const enteredV = Number(yInput.value);
        if (tileModeCheckbox.checked) {
          const screen = tileLabelToScreen(enteredU, enteredV);
          const a = anchorFor(obj.type);
          obj.x = screen.x - a.x;
          obj.y = screen.y - a.y;
        } else {
          obj.x = enteredU;
          obj.y = enteredV;
        }
        updateSaveState();
        console.log(`[admin] applyPosition("${obj.id}") -> (${obj.x},${obj.y}), currentRenderer:`, !!currentRenderer);
        currentRenderer?.moveObject(obj.id ?? -1, obj.x, obj.y);
      }
      xInput.onchange = applyPosition;
      yInput.onchange = applyPosition;

      // Type/enabled changes need a real rebuild — the object's sprite/size
      // (or whether it renders at all) actually changes, not just its
      // position, so there's nothing to "move" in place.
      function applyTypeAndEnabled() {
        obj.type = Number(typeSelect.value);
        obj.enabled = checkbox.checked;
        updateSaveState();
        renderPreview();
      }
      typeSelect.onchange = applyTypeAndEnabled;
      checkbox.onchange = applyTypeAndEnabled;

      const placeCell = document.createElement("td");
      const placeBtn = document.createElement("button");
      placeBtn.type = "button";
      function setPlacingUI(active: boolean) {
        placeBtn.textContent = active ? "Click a tile…" : "Place";
        placeBtn.classList.toggle("admin-placing-active", active);
      }
      setPlacingUI(false);
      placeBtn.onclick = () => {
        // Unsaved placements have no real id yet, so they all resolve to
        // the same -1 sentinel in the preview (see resolveObjectPlacement) —
        // fine as long as only one is ever being placed at a time.
        const previewId = obj.id ?? -1;
        if (placingObjectId === previewId) {
          currentRenderer?.disablePlacement();
          placingObjectId = null;
          setPlacingUI(false);
          return;
        }
        placingObjectId = previewId;
        setPlacingUI(true);
        currentRenderer?.enablePlacement(previewId, (u, v) => {
          const screen = gridToScreen(u, v);
          const a = anchorFor(obj.type);
          obj.x = screen.x - a.x;
          obj.y = screen.y - a.y;
          if (tileModeCheckbox.checked) {
            xInput.value = String(round2(u - TILE_LABEL_SHIFT));
            yInput.value = String(round2(v - TILE_LABEL_SHIFT));
          } else {
            xInput.value = String(obj.x);
            yInput.value = String(obj.y);
          }
          updateSaveState();
          currentRenderer?.moveObject(previewId, obj.x, obj.y);
          currentRenderer?.disablePlacement();
          placingObjectId = null;
          setPlacingUI(false);
        });
      };
      placeCell.appendChild(placeBtn);
      row.appendChild(placeCell);

      const actionCell = document.createElement("td");
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Remove";
      deleteBtn.onclick = () => {
        const idx = draft.indexOf(obj);
        if (idx !== -1) draft.splice(idx, 1);
        renderTable();
        updateSaveState();
        renderPreview();
      };
      actionCell.appendChild(deleteBtn);
      row.appendChild(actionCell);

      table.appendChild(row);
    }
  }

  tileModeCheckbox.onchange = () => renderTable();

  function renderAddForm() {
    addForm.textContent = "";
    // No id input anymore — objects.id is now a global server-assigned
    // serial id (see ObjectPlacementWire's own comment); a brand-new
    // placement simply has no id until Save persists it.
    const newTypeSelect = document.createElement("select");
    for (const typeId of typeIds) {
      const opt = document.createElement("option");
      opt.value = typeId;
      opt.textContent = objectTypes[typeId]?.name ?? typeId;
      newTypeSelect.appendChild(opt);
    }
    const newXInput = document.createElement("input");
    newXInput.type = "number";
    newXInput.placeholder = "x";
    newXInput.value = "0";
    newXInput.style.width = "60px";
    const newYInput = document.createElement("input");
    newYInput.type = "number";
    newYInput.placeholder = "y";
    newYInput.value = "0";
    newYInput.style.width = "60px";
    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.textContent = "Add Object";
    addForm.append(newTypeSelect, newXInput, newYInput, addBtn);
    addForm.onsubmit = (e) => {
      e.preventDefault();
      draft.push({ type: Number(newTypeSelect.value), x: Number(newXInput.value), y: Number(newYInput.value), enabled: true });
      renderTable();
      updateSaveState();
      renderPreview();
    };
  }

  saveBtn.onclick = async () => {
    if (!isDirty()) return;
    try {
      if (isRoomFieldsDirty()) {
        await adminFetch(`/api/admin/rooms/${room.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...room, ...roomFields }),
        });
      }
      const draftIds = new Set(draft.filter((o): o is ObjectPlacementWire & { id: number } => o.id !== undefined).map((o) => o.id));
      for (const obj of draft) {
        if (obj.id === undefined) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects`, { method: "POST", body: JSON.stringify(obj) });
          continue;
        }
        const orig = original.find((o) => o.id === obj.id);
        if (!orig) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects`, { method: "POST", body: JSON.stringify(obj) });
        } else if (JSON.stringify(orig) !== JSON.stringify(obj)) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects/${obj.id}`, { method: "PATCH", body: JSON.stringify(obj) });
        }
      }
      for (const orig of original) {
        if (orig.id !== undefined && !draftIds.has(orig.id)) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects/${orig.id}`, { method: "DELETE" });
        }
      }
      modal.close();
      onSaved();
    } catch (err) {
      showError(err);
    }
  };

  cancelBtn.onclick = () => modal.close();
  modal.onClose(() => currentApp?.destroy());

  renderTable();
  renderAddForm();
  updateSaveState();
  await renderPreview();
  modal.open();
}

// --- Room connections ---

const EDGE_LABELS: Record<ConnectionDirection, string> = {
  behindLeft: "Top-Left Wall",
  behindRight: "Top-Right Wall",
  frontLeft: "Bottom-Left (open)",
  frontRight: "Bottom-Right (open)",
};
const EDGE_ORDER: ConnectionDirection[] = ["behindLeft", "behindRight", "frontLeft", "frontRight"];

/**
 * Edits `room`'s own outgoing connections — "a room only has to worry
 * about what it connects to, not which room connects to it," so this
 * never looks at any OTHER room's connectedTo array, only room's own
 * (room.connectedTo is a plain list, read and written directly — no
 * reverse/incoming lookup like an earlier version of this had). A room
 * can connect to several other rooms; see ConnectedToEntry's own comment
 * for why only entries[0] affects room's actual position, further entries
 * are additional declared attachments.
 *
 * Every target room, once claimed by ANY connectedTo entry anywhere in
 * the graph (by this room or any other) or assigned as a floor's base
 * room, is excluded from the "pick a room to connect to" picker —
 * getUsedRoomIds() enforces this globally, so no two connections ever
 * claim the same target (this is also what stops the same room being
 * connected twice to one room by accident).
 *
 * Every action is an immediate PATCH (no staged draft, unlike the object
 * editor) — simple enough now that a draft isn't needed; every write only
 * ever touches room's own record.
 */
async function openRoomConnectionsModal(room: RoomSpecWire, allRooms: RoomSpecWire[], floors: Floor[], onSaved: () => void) {
  const modal = buildModal(`Connections: ${room.name}`, { size: "large" });

  const previewContainer = document.createElement("div");
  previewContainer.id = "admin-preview-canvas";
  modal.body.appendChild(previewContainer);

  const zoomRow = document.createElement("div");
  zoomRow.className = "admin-form";
  const zoomInput = document.createElement("input");
  zoomInput.type = "range";
  zoomInput.min = "0.5";
  zoomInput.max = "2.5";
  zoomInput.step = "0.1";
  zoomInput.value = "1.5"; // matches AdminPreviewRenderer's own default scale
  const zoomValueLabel = document.createElement("span");
  zoomValueLabel.textContent = `${zoomInput.value}x`;
  zoomRow.append(document.createTextNode("Zoom:"), zoomInput, zoomValueLabel);
  modal.body.appendChild(zoomRow);
  zoomInput.oninput = () => {
    zoomValueLabel.textContent = `${zoomInput.value}x`;
    currentRenderer?.setScale(Number(zoomInput.value));
  };

  const hint = document.createElement("div");
  hint.className = "admin-hint";
  hint.textContent = "Each action below saves immediately — there's no separate Save step.";
  modal.body.appendChild(hint);

  const errorEl = document.createElement("div");
  errorEl.className = "admin-error";
  errorEl.style.display = "none";
  modal.body.appendChild(errorEl);

  function showInlineError(err: unknown) {
    errorEl.textContent = err instanceof Error ? err.message : String(err);
    errorEl.style.display = "";
  }
  function clearInlineError() {
    errorEl.style.display = "none";
  }

  const table = document.createElement("table");
  table.className = "admin-table";
  modal.body.appendChild(table);

  let currentApp: Application | null = null;
  let currentRenderer: AdminPreviewRenderer | null = null;

  /**
   * `room` plus every room it connects to, so the preview actually shows
   * what's attached instead of just the one isolated room. `room` itself
   * is forced to be the local anchor (connectedTo stripped) and each of
   * its own targets gets a SYNTHESIZED single-entry connectedTo pointing
   * back at `room` instead — `direction` on room's own entry names the
   * TARGET's edge, so the target's forced entry needs
   * PAIR_DIRECTION[entry.direction] (room's own touching edge) to
   * correctly invert which side is "attaching to" which. Verified against
   * the real global resolveRooms() output with a standalone script before
   * relying on it here (this exact inversion, including the
   * PAIR_DIRECTION step) — relative positions matched exactly. `room` is
   * placed first in the array specifically because SceneRenderer defaults
   * viewedRoomId to the array's first room — giving the "one room in
   * focus, neighbors dimmed but visible" rendering the real game already
   * has, for free, instead of needing a new public focus method.
   */
  function buildPreviewRoomSet(): RoomSpecWire[] {
    const forcedRoom: RoomSpecWire = { ...room, connectedTo: undefined };
    const forcedNeighbors = (room.connectedTo ?? []).flatMap((entry) => {
      const neighbor = allRooms.find((r) => r.id === entry.roomId);
      if (!neighbor) return [];
      const lateralOffset = entry.lateralOffset ?? 0;
      return [{ ...neighbor, connectedTo: [{ roomId: room.id, direction: PAIR_DIRECTION[entry.direction], gapTiles: entry.gapTiles, lateralOffset }] }];
    });
    return [forcedRoom, ...forcedNeighbors];
  }

  async function renderPreview() {
    currentApp?.destroy();
    previewContainer.textContent = "";
    try {
      // [] for floors, not the real floor list — this preview is `room`
      // plus a stripped-down synthetic neighbor set, which the real floors'
      // base rooms almost never reach, and resolveRooms() now excludes
      // anything unreachable from a floor's base room. Passing [] opts out
      // of that filtering entirely (see resolveRooms's own comment) so this
      // intentionally-partial subset still resolves.
      setRooms(roomSpecsFromWire(buildPreviewRoomSet()), []);
      currentApp = new Application();
      await currentApp.init({ width: 480, height: 380, background: 0x222228 });
      previewContainer.appendChild(currentApp.canvas);
      currentRenderer = new AdminPreviewRenderer(currentApp, () => {}, () => {});
      currentRenderer.setScale(Number(zoomInput.value));
    } catch (err) {
      showError(err);
    }
  }

  /**
   * Gap/lateral-offset edits only ever move an already-shown neighbor —
   * the set of rooms in the scene doesn't change — so this recomputes
   * positions via the engine's own resolveRooms() (cheap, pure math) and
   * repositions each neighbor's existing container directly via
   * moveRoom(), the same "never tear down the canvas for a position-only
   * change" fix already applied to the room object editor's x/y fields
   * (the "blip"). Connect/disconnect still go through the full
   * renderPreview() rebuild — those actually add/remove a whole room's
   * worth of containers, a genuinely structural change, same split as the
   * object editor's type/enabled changes.
   */
  function repositionNeighbors() {
    try {
      const resolved = resolveRooms(roomSpecsFromWire(buildPreviewRoomSet()), []); // see renderPreview's own comment on why []
      for (const r of resolved) {
        if (r.id === room.id) continue; // room itself is the fixed local anchor, never moves
        currentRenderer?.moveRoom(r.id, r.x, r.y);
      }
    } catch (err) {
      showError(err);
    }
  }

  /**
   * Missing-room check reusing the engine's own resolveRooms() against the
   * FULL room list (not a subset) with this one candidate change — thrown
   * errors surface as a blocking inline error instead of silently
   * corrupting the layout. Despite the name, an actual connectedTo cycle
   * is no longer an error the floor-tree algorithm can hit: it's a plain
   * BFS over the undirected graph, so a cycle just means one of the
   * redundant edges in the loop never gets used for position — same as
   * any room with more than one connection already works. The only thing
   * this can still catch is a connectedTo entry pointing at a room id that
   * doesn't exist at all.
   */
  function assertNoCycle(newConnectedTo: ConnectedToEntry[] | undefined) {
    const candidateRooms = allRooms.map((r) => (r.id === room.id ? { ...r, connectedTo: newConnectedTo } : r));
    resolveRooms(roomSpecsFromWire(candidateRooms), floors);
  }

  /**
   * Throws (cycle/missing-room rejection, or a failed PATCH) rather than
   * swallowing its own error, specifically so the caller — openConnectPicker
   * below — can keep its dialog open and show the failure right there. It
   * used to call showInlineError() on the parent modal itself and `return`,
   * but openConnectPicker's confirm handler closed its own picker dialog
   * unconditionally right afterward — closing right on top of an error that
   * WAS being shown, just on a modal now hidden behind the one that just
   * closed. Looked exactly like "nothing happened, no explanation."
   */
  async function addConnection(targetRoomId: number, direction: ConnectionDirection, gapTiles: number, lateralOffset: number): Promise<void> {
    const newConnectedTo = [...(room.connectedTo ?? []), { roomId: targetRoomId, direction, gapTiles, lateralOffset }];
    assertNoCycle(newConnectedTo);
    await adminFetch(`/api/admin/rooms/${room.id}/connections`, { method: "PATCH", body: JSON.stringify({ connectedTo: newConnectedTo }) });
    room.connectedTo = newConnectedTo; // keep the local allRooms copy in sync, no refetch needed
    clearInlineError();
    renderTable();
    await renderPreview();
  }

  async function updateConnection(entryIndex: number, gapTiles: number, lateralOffset: number) {
    const newConnectedTo = (room.connectedTo ?? []).map((entry, i) => (i === entryIndex ? { ...entry, gapTiles, lateralOffset } : entry));
    try {
      assertNoCycle(newConnectedTo);
    } catch (err) {
      showInlineError(err);
      return;
    }
    try {
      await adminFetch(`/api/admin/rooms/${room.id}/connections`, { method: "PATCH", body: JSON.stringify({ connectedTo: newConnectedTo }) });
      room.connectedTo = newConnectedTo;
      clearInlineError();
      renderTable();
      repositionNeighbors();
    } catch (err) {
      showError(err);
    }
  }

  async function removeConnection(entryIndex: number) {
    const newConnectedTo = (room.connectedTo ?? []).filter((_, i) => i !== entryIndex);
    const payloadConnectedTo = newConnectedTo.length ? newConnectedTo : undefined;
    try {
      await adminFetch(`/api/admin/rooms/${room.id}/connections`, { method: "PATCH", body: JSON.stringify({ connectedTo: payloadConnectedTo }) });
      room.connectedTo = payloadConnectedTo;
      clearInlineError();
      renderTable();
      await renderPreview();
    } catch (err) {
      showError(err);
    }
  }

  /** Rooms available to connect `room` to — every room already claimed by someone's connectedTo or a floor's base room, excluded globally; `room` itself exempted from its OWN existing claims so adding a second connection doesn't hide the first one's target. */
  function pickableRooms(): RoomSpecWire[] {
    const used = getUsedRoomIds(
      allRooms,
      floors.map((f) => f.baseRoomId),
      room.id,
    );
    return allRooms.filter((r) => r.id !== room.id && !used.has(r.id));
  }

  function openAddConnectionPicker() {
    const candidates = pickableRooms();
    if (candidates.length === 0) {
      showInlineError(new Error("No unclaimed rooms left to connect to."));
      return;
    }

    const pickerModal = buildModal(`Add connection from ${room.name}`, {});
    const form = document.createElement("div");
    form.className = "admin-form";
    pickerModal.body.appendChild(form);

    const roomSelect = document.createElement("select");
    for (const r of candidates) {
      const opt = document.createElement("option");
      opt.value = String(r.id);
      opt.textContent = r.name;
      roomSelect.appendChild(opt);
    }
    form.append(document.createTextNode("Room:"), roomSelect);

    const directionSelect = document.createElement("select");
    for (const d of EDGE_ORDER) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = `its ${EDGE_LABELS[d]} edge`;
      directionSelect.appendChild(opt);
    }
    form.append(document.createTextNode("Attach to:"), directionSelect);

    const gapInput = document.createElement("input");
    gapInput.type = "number";
    gapInput.value = "1";
    gapInput.style.width = "50px";
    form.append(document.createTextNode("Gap:"), gapInput);

    const offsetInput = document.createElement("input");
    offsetInput.type = "number";
    offsetInput.value = "0";
    offsetInput.style.width = "50px";
    form.append(document.createTextNode("Lateral offset:"), offsetInput);

    const pickerErrorEl = document.createElement("div");
    pickerErrorEl.className = "admin-error";
    pickerErrorEl.style.display = "none";
    pickerModal.body.appendChild(pickerErrorEl);

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.textContent = "Connect";
    confirmBtn.onclick = async () => {
      try {
        await addConnection(Number(roomSelect.value), directionSelect.value as ConnectionDirection, Number(gapInput.value), Number(offsetInput.value));
        pickerModal.close();
      } catch (err) {
        // Only close on success — closing unconditionally here used to mask
        // a cycle-rejection error shown on the parent modal, since this
        // dialog closed right on top of it. Shown right here instead, where
        // the user is actually looking.
        pickerErrorEl.textContent = err instanceof Error ? err.message : String(err);
        pickerErrorEl.style.display = "";
      }
    };
    form.appendChild(confirmBtn);

    pickerModal.open();
  }

  function buildConnectionRow(entryIndex: number, entry: ConnectedToEntry): HTMLTableRowElement {
    const row = document.createElement("tr");

    const target = allRooms.find((r) => r.id === entry.roomId);
    const roomCell = document.createElement("td");
    roomCell.textContent = target ? target.name : `(missing: ${entry.roomId})`;
    row.appendChild(roomCell);

    const edgeCell = document.createElement("td");
    edgeCell.textContent = EDGE_LABELS[entry.direction];
    row.appendChild(edgeCell);

    const gapInput = document.createElement("input");
    gapInput.type = "number";
    gapInput.value = String(entry.gapTiles);
    gapInput.style.width = "50px";
    const gapCell = document.createElement("td");
    gapCell.appendChild(gapInput);
    row.appendChild(gapCell);

    const offsetInput = document.createElement("input");
    offsetInput.type = "number";
    offsetInput.value = String(entry.lateralOffset ?? 0);
    offsetInput.style.width = "50px";
    const offsetCell = document.createElement("td");
    offsetCell.appendChild(offsetInput);
    row.appendChild(offsetCell);

    function applyEdit() {
      updateConnection(entryIndex, Number(gapInput.value), Number(offsetInput.value));
    }
    gapInput.onchange = applyEdit;
    offsetInput.onchange = applyEdit;

    const actionCell = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.onclick = () => removeConnection(entryIndex);
    actionCell.appendChild(removeBtn);
    row.appendChild(actionCell);

    return row;
  }

  /** A flat list of room's own connections — no more grouping by room's own 4 edges, since `direction` names the TARGET's edge, not room's; room doesn't track/display "which of my edges" at all. */
  function renderTable() {
    table.innerHTML = "<tr><th>Connects to</th><th>Their edge</th><th>Gap</th><th>Lateral offset</th><th></th></tr>";
    (room.connectedTo ?? []).forEach((entry, entryIndex) => {
      table.appendChild(buildConnectionRow(entryIndex, entry));
    });
    const addRow = document.createElement("tr");
    addRow.appendChild(document.createElement("td"));
    addRow.appendChild(document.createElement("td"));
    addRow.appendChild(document.createElement("td"));
    addRow.appendChild(document.createElement("td"));
    const addCell = document.createElement("td");
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "+ Add connection";
    addBtn.onclick = () => openAddConnectionPicker();
    addCell.appendChild(addBtn);
    addRow.appendChild(addCell);
    table.appendChild(addRow);
  }

  modal.onClose(() => {
    currentApp?.destroy();
    onSaved();
  });
  renderTable();
  await renderPreview();
  modal.open();
}

/** Rooms nothing else connects to (plus not already another floor's own base room) — `exemptFloorLevel` keeps one floor's own current base room selectable in its own edit dropdown even though it'd otherwise count as "another floor's base room" against itself. */
function pickableBaseRooms(rooms: RoomSpecWire[], floors: Floor[], exemptFloorLevel?: number): RoomSpecWire[] {
  const otherFloorBaseRoomIds = floors.filter((f) => f.level !== exemptFloorLevel).map((f) => f.baseRoomId);
  const used = getUsedRoomIds(rooms, otherFloorBaseRoomIds);
  return rooms.filter((r) => !used.has(r.id));
}

function renderFloorsSection(body: HTMLElement, rooms: RoomSpecWire[], floors: Floor[]) {
  const floorsHeading = document.createElement("h3");
  floorsHeading.textContent = "Floors";
  body.appendChild(floorsHeading);

  const floorsHint = document.createElement("div");
  floorsHint.className = "admin-hint";
  floorsHint.textContent = "Each floor is a level plus which room the floor-switch button jumps to. The pickers below only offer rooms nothing connects to, so a base room stays that way as long as you edit through here.";
  body.appendChild(floorsHint);

  const floorsTable = document.createElement("table");
  floorsTable.className = "admin-table";
  floorsTable.innerHTML = "<tr><th>Level</th><th>Label</th><th>Base room</th><th></th></tr>";
  for (const floor of floors) {
    const row = document.createElement("tr");
    const levelCell = document.createElement("td");
    levelCell.textContent = String(floor.level);
    row.appendChild(levelCell);

    const labelCell = document.createElement("td");
    labelCell.textContent = floor.label;
    row.appendChild(labelCell);

    const baseRoomCell = document.createElement("td");
    const baseRoom = rooms.find((r) => r.id === floor.baseRoomId);
    baseRoomCell.textContent = baseRoom ? baseRoom.name : `(missing: ${floor.baseRoomId})`;
    row.appendChild(baseRoomCell);

    const floorActionCell = document.createElement("td");
    const editFloorBtn = document.createElement("button");
    editFloorBtn.type = "button";
    editFloorBtn.textContent = "Edit";
    editFloorBtn.onclick = () => {
      // Swaps the base-room cell for a dropdown in place, rather than a
      // separate modal — it's one field, a modal would be overkill.
      baseRoomCell.textContent = "";
      const select = document.createElement("select");
      // The floor's own current base room is always included even if it
      // would otherwise read as "used" against itself.
      const candidates = pickableBaseRooms(rooms, floors, floor.level);
      const options = baseRoom && !candidates.some((r) => r.id === baseRoom.id) ? [baseRoom, ...candidates] : candidates;
      for (const r of options) {
        const opt = document.createElement("option");
        opt.value = String(r.id);
        opt.textContent = r.name;
        opt.selected = r.id === floor.baseRoomId;
        select.appendChild(opt);
      }
      baseRoomCell.appendChild(select);

      editFloorBtn.textContent = "Save";
      editFloorBtn.onclick = async () => {
        try {
          await adminFetch(`/api/admin/floors/${floor.level}`, { method: "PATCH", body: JSON.stringify({ label: floor.label, baseRoomId: Number(select.value) }) });
          renderRooms(body);
        } catch (err) {
          showError(err);
        }
      };
    };
    const removeFloorBtn = document.createElement("button");
    removeFloorBtn.type = "button";
    removeFloorBtn.textContent = "Remove";
    removeFloorBtn.onclick = async () => {
      try {
        await adminFetch(`/api/admin/floors/${floor.level}`, { method: "DELETE" });
        renderRooms(body);
      } catch (err) {
        showError(err);
      }
    };
    floorActionCell.append(editFloorBtn, removeFloorBtn);
    row.appendChild(floorActionCell);
    floorsTable.appendChild(row);
  }
  body.appendChild(floorsTable);

  const floorForm = document.createElement("form");
  floorForm.className = "admin-form";
  const floorLevelInput = document.createElement("input");
  floorLevelInput.type = "number";
  floorLevelInput.placeholder = "level";
  floorLevelInput.required = true;
  const floorLabelInput = document.createElement("input");
  floorLabelInput.placeholder = "label (e.g. 3F)";
  floorLabelInput.required = true;
  const floorBaseRoomSelect = document.createElement("select");
  const availableBaseRooms = pickableBaseRooms(rooms, floors);
  for (const r of availableBaseRooms) {
    const opt = document.createElement("option");
    opt.value = String(r.id);
    opt.textContent = r.name;
    floorBaseRoomSelect.appendChild(opt);
  }
  const addFloorBtn = document.createElement("button");
  addFloorBtn.type = "submit";
  addFloorBtn.textContent = "Add Floor";
  if (availableBaseRooms.length === 0) addFloorBtn.disabled = true;
  floorForm.append(floorLevelInput, floorLabelInput, floorBaseRoomSelect, addFloorBtn);
  floorForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await adminFetch("/api/admin/floors", {
        method: "POST",
        body: JSON.stringify({ level: Number(floorLevelInput.value), label: floorLabelInput.value, baseRoomId: Number(floorBaseRoomSelect.value) }),
      });
      renderRooms(body);
    } catch (err) {
      showError(err);
    }
  };
  body.appendChild(floorForm);
}

/**
 * One `<li>` per node, nested `<ul>`s for children — a plain indented tree,
 * not a graphical chart, consistent with the rest of this tool's plain-table
 * style. The tree is what manages connections now — clicking a room's own
 * label opens its connections editor directly, rather than a separate
 * "Connections" button living on the room list below (see buildRoomsTable,
 * which is for editing the room itself).
 */
function buildTreeNodeEl(node: FloorTreeNode, onRoomClick: (room: FloorTreeNode["room"]) => void): HTMLLIElement {
  const li = document.createElement("li");
  const label = document.createElement("span");
  label.className = "admin-tree-room";
  label.textContent = node.room.name;
  label.onclick = () => onRoomClick(node.room);
  li.appendChild(label);
  if (node.children.length > 0) {
    const ul = document.createElement("ul");
    for (const child of node.children) ul.appendChild(buildTreeNodeEl(child, onRoomClick));
    li.appendChild(ul);
  }
  return li;
}

function buildTreeChartEl(node: FloorTreeNode, onRoomClick: (room: FloorTreeNode["room"]) => void): HTMLElement {
  const container = document.createElement("div");
  container.className = "admin-tree";
  const ul = document.createElement("ul");
  ul.appendChild(buildTreeNodeEl(node, onRoomClick));
  container.appendChild(ul);
  return container;
}

// Every room/connection edit closes its modal via onSaved -> renderRooms(body),
// which rebuilds the whole Rooms tab from scratch — including the sub-tab
// bar, which used to always default back to the first tab (2F) regardless
// of which floor you were actually working in. Remembered across those
// rebuilds here so editing something on 1F doesn't keep bouncing you back
// to 2F after every single save.
let lastActiveRoomSubTab: string | null = null;

async function renderRooms(body: HTMLElement) {
  body.textContent = "";
  const [rooms, objectTypes, floors] = await Promise.all([
    adminFetch<RoomSpecWire[]>("/api/admin/rooms"),
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
    adminFetch<Floor[]>("/api/admin/floors"),
  ]);

  renderFloorsSection(body, rooms, floors);

  // Unorganized rooms have no floor tree to click for connections (there's
  // nothing to draw a tree from yet), so they're the one case that still
  // needs a Connections button on the row itself — every room already on a
  // floor manages connections via its tree item instead (see buildTreeNodeEl).
  function buildRoomsTable(roomsForTab: RoomSpecWire[], showConnectionsButton: boolean): HTMLElement {
    const table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML = "<tr><th>Room</th><th>Size</th><th>Objects</th><th></th></tr>";
    for (const room of roomsForTab) {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${room.name}</td><td>${room.cols}×${room.rows}</td><td>${room.objects.length}</td>`;

      const actionCell = document.createElement("td");
      const editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.onclick = () => openRoomEditModal(room, objectTypes, () => renderRooms(body));
      const buttons = [editBtn];
      if (showConnectionsButton) {
        const connectionsBtn = document.createElement("button");
        connectionsBtn.type = "button";
        connectionsBtn.textContent = `Connections (${room.connectedTo?.length ?? 0})`;
        connectionsBtn.onclick = () => openRoomConnectionsModal(room, rooms, floors, () => renderRooms(body));
        buttons.push(connectionsBtn);
      }
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = async () => {
        if (!confirm(`Delete room "${room.name}" and all its objects?`)) return;
        try {
          await adminFetch(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
          renderRooms(body);
        } catch (err) {
          showError(err);
        }
      };
      buttons.push(deleteBtn);
      actionCell.append(...buttons);
      row.appendChild(actionCell);

      table.appendChild(row);
    }
    return table;
  }

  function buildAddRoomForm(): HTMLElement {
    const form = document.createElement("form");
    form.className = "admin-form";
    // No id/level inputs — rooms.id is now a server-assigned serial id, and
    // level is derived from floor-connection membership (see RoomDef.level's
    // own comment), not something to pick when creating a room.
    const nameInput = document.createElement("input");
    nameInput.placeholder = "Name";
    nameInput.required = true;
    const colsInput = document.createElement("input");
    colsInput.type = "number";
    colsInput.placeholder = "cols";
    colsInput.value = "10";
    const rowsInput = document.createElement("input");
    rowsInput.type = "number";
    rowsInput.placeholder = "rows";
    rowsInput.value = "10";
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.textContent = "Add Room (floor1/wall1, unconnected)";
    form.append(nameInput, colsInput, rowsInput, submitBtn);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await adminFetch("/api/admin/rooms", {
          method: "POST",
          body: JSON.stringify({
            name: nameInput.value,
            cols: Number(colsInput.value),
            rows: Number(rowsInput.value),
            floorVariant: "floor1",
            wallVariant: "wall1",
          }),
        });
        renderRooms(body);
      } catch (err) {
        showError(err);
      }
    };
    return form;
  }

  // --- Room sub-tabs: one per floor (highest level first, matching
  // floorButtons.ts's own ordering) plus one "Unorganized" tab for rooms
  // not reachable from any floor's base room. A room's tab is derived
  // (computeFloorMembership, BFS over every connectedTo edge from either
  // room — any connection counts, not just the one that determines
  // position), never a field you set directly — connect a room to
  // anything already on a floor and it moves there on its own next render.
  const subTabBar = document.createElement("div");
  subTabBar.className = "admin-subtab-bar";
  body.appendChild(subTabBar);

  interface SubTab {
    id: string;
    label: string;
    floor: Floor | null;
  }
  const sortedFloors = [...floors].sort((a, b) => b.level - a.level);
  const subTabs: SubTab[] = [...sortedFloors.map((f): SubTab => ({ id: `floor-${f.level}`, label: f.label, floor: f })), { id: "unorganized", label: "Unorganized", floor: null }];

  const subPages: Record<string, HTMLElement> = {};
  const subButtons: Record<string, HTMLButtonElement> = {};
  for (const tab of subTabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = tab.label;
    btn.onclick = () => showSubTab(tab.id);
    subTabBar.appendChild(btn);
    subButtons[tab.id] = btn;

    const page = document.createElement("div");
    page.className = "admin-subtab-page";
    body.appendChild(page);
    subPages[tab.id] = page;
  }

  function showSubTab(id: string) {
    lastActiveRoomSubTab = id;
    for (const tab of subTabs) {
      subPages[tab.id].classList.toggle("active", tab.id === id);
      subButtons[tab.id].classList.toggle("active", tab.id === id);
    }
  }
  // Restore whichever tab was active before this rebuild, if it still
  // exists (a floor could've been removed) — otherwise fall back to the
  // first tab, same as before.
  const initialSubTab = subTabs.find((t) => t.id === lastActiveRoomSubTab) ? lastActiveRoomSubTab! : (subTabs[0]?.id ?? "unorganized");
  showSubTab(initialSubTab);

  const membership = computeFloorMembership(rooms, floors);
  for (const tab of subTabs) {
    const page = subPages[tab.id];
    if (tab.floor) {
      const tree = buildFloorTree(tab.floor.baseRoomId, rooms);
      if (tree) {
        page.appendChild(
          buildTreeChartEl(tree, (treeRoom) => {
            const room = rooms.find((r) => r.id === treeRoom.id)!;
            openRoomConnectionsModal(room, rooms, floors, () => renderRooms(body));
          }),
        );
      }
    }
    const roomsForTab = rooms.filter((r) => {
      const level = membership.get(r.id) ?? null;
      return tab.floor ? level === tab.floor.level : level === null;
    });
    page.appendChild(buildRoomsTable(roomsForTab, !tab.floor));
    if (!tab.floor) page.appendChild(buildAddRoomForm());
  }
}

async function main() {
  secret = await getOrPromptSecret();

  const header = document.createElement("h1");
  header.textContent = "House Simulator Admin";
  app.appendChild(header);

  setupSyncButton();

  const pages = setupTabs();

  // Activities/object types need to be set once so the single-room preview
  // can resolve action labels and object sprite/size data regardless of
  // which room's modal is opened later — rooms themselves are set fresh
  // per-modal (see openRoomEditModal), scoped to just the room being edited.
  const [activities, objectTypes] = await Promise.all([
    adminFetch<ActivityDef[]>("/api/admin/activities"),
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
  ]);
  setActivities(activities);
  setObjectTypes(objectTypes);
  await preloadRoomAssets();

  try {
    await Promise.all([
      renderCharacters(pages.characters),
      renderActivities(pages.activities),
      renderObjectTypes(pages["object-types"]),
      renderRooms(pages.rooms),
    ]);
  } catch (err) {
    showError(err);
  }
}

main().catch(showError);

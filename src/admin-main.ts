// House Simulator admin tool — a separate app from the Tauri game and the
// public viewer, served by the Node server itself at /admin/. Talks to the
// plain REST surface under /api/admin/* (server/adminApi.ts), not the
// game's WebSocket RPC protocol — this is traditional CRUD, not real-time
// multiplayer state.
//
// The room list below is editable (position/type/enabled, add/delete) via
// plain form fields, not drag-and-drop — there's no browser available in
// this environment to visually verify pointer-based drag math actually
// works, so the one visual piece built is a read-only Pixi preview
// (AdminPreviewRenderer, reusing the exact same SceneRenderer the game and
// viewer use) with click-to-select instead: clicking an object in the
// preview scrolls to and highlights its row below, where the actual edit
// happens. Real visual value without inventing an interaction this session
// can't actually test.
import { Application } from "pixi.js";
import { preloadRoomAssets } from "./scene/renderer";
import { AdminPreviewRenderer } from "./scene/adminPreview";
import { setActivities } from "./scene/activities";
import { roomSpecsFromWire, setObjectTypes, setRooms } from "./scene/rooms";

const ADMIN_SECRET_KEY = "houseSimulatorAdminSecret";

interface Character {
  id: string;
  name: string;
  secret: string;
  awBucketId: string;
}

interface ActivityDef {
  id: string;
  label: string;
  color: number;
}

interface ObjectTypeDef {
  name: string;
  width: number;
  height: number;
}

interface ObjectPlacementWire {
  id: string;
  type: string;
  x: number;
  y: number;
  enabled: boolean;
}

interface RoomSpecWire {
  id: string;
  name: string;
  cols: number;
  rows: number;
  level: number;
  floorVariant: string;
  wallVariant: string;
  objects: ObjectPlacementWire[];
}

function getOrPromptSecret(): Promise<string> {
  const existing = localStorage.getItem(ADMIN_SECRET_KEY);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "admin-secret-overlay";

    const form = document.createElement("form");
    form.id = "admin-secret-form";

    const title = document.createElement("h2");
    title.textContent = "Admin secret";
    form.appendChild(title);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "server_config.admin_secret";
    input.required = true;
    form.appendChild(input);

    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Continue";
    form.appendChild(button);

    form.onsubmit = (e) => {
      e.preventDefault();
      const secret = input.value.trim();
      if (!secret) return;
      localStorage.setItem(ADMIN_SECRET_KEY, secret);
      overlay.remove();
      resolve(secret);
    };

    overlay.appendChild(form);
    document.body.appendChild(overlay);
    input.focus();
  });
}

let secret = "";

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${secret}`,
      ...options.headers,
    },
  });
  if (res.status === 401) {
    // Wrong secret saved locally — clear it so a reload re-prompts, same
    // self-healing reasoning as the game's own connection form.
    localStorage.removeItem(ADMIN_SECRET_KEY);
    throw new Error("Unauthorized — wrong admin secret. Reload to re-enter it.");
  }
  if (!res.ok) throw new Error(`${options.method ?? "GET"} ${path} failed (${res.status})`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const app = document.getElementById("admin-app")!;

function section(title: string, hint?: string): { el: HTMLElement; body: HTMLElement } {
  const el = document.createElement("div");
  el.className = "admin-section";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  el.appendChild(h2);
  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "admin-hint";
    hintEl.textContent = hint;
    el.appendChild(hintEl);
  }
  const body = document.createElement("div");
  el.appendChild(body);
  app.appendChild(el);
  return { el, body };
}

function showError(err: unknown) {
  const el = document.createElement("div");
  el.className = "admin-error";
  el.textContent = err instanceof Error ? err.message : String(err);
  app.prepend(el);
  setTimeout(() => el.remove(), 6000);
}

// --- Characters ---

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
    actionCell.appendChild(deleteBtn);
    row.appendChild(actionCell);
    table.appendChild(row);
  }
  body.appendChild(table);

  const form = document.createElement("form");
  form.className = "admin-form";
  const nameInput = document.createElement("input");
  nameInput.placeholder = "New character name";
  nameInput.required = true;
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Add Character";
  form.append(nameInput, submitBtn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await adminFetch("/api/admin/characters", { method: "POST", body: JSON.stringify({ name: nameInput.value }) });
      renderCharacters(body);
    } catch (err) {
      showError(err);
    }
  };
  body.appendChild(form);
}

// --- Activities ---

async function renderActivities(body: HTMLElement) {
  body.textContent = "";
  const activities = await adminFetch<ActivityDef[]>("/api/admin/activities");

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Label</th><th>Color</th><th></th></tr>";
  for (const a of activities) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    const labelInput = document.createElement("input");
    labelInput.value = a.label;
    labelCell.appendChild(labelInput);
    row.appendChild(labelCell);

    const colorCell = document.createElement("td");
    const swatch = document.createElement("span");
    swatch.className = "admin-swatch";
    swatch.style.background = `#${a.color.toString(16).padStart(6, "0")}`;
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = `#${a.color.toString(16).padStart(6, "0")}`;
    colorCell.append(swatch, colorInput);
    row.appendChild(colorCell);

    const actionCell = document.createElement("td");
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.onclick = async () => {
      try {
        const color = parseInt(colorInput.value.slice(1), 16);
        await adminFetch(`/api/admin/activities/${a.id}`, {
          method: "PATCH",
          body: JSON.stringify({ label: labelInput.value, color }),
        });
        renderActivities(body);
      } catch (err) {
        showError(err);
      }
    };
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
    actionCell.append(saveBtn, deleteBtn);
    row.appendChild(actionCell);
    table.appendChild(row);
  }
  body.appendChild(table);

  const form = document.createElement("form");
  form.className = "admin-form";
  const labelInput = document.createElement("input");
  labelInput.placeholder = "New activity label";
  labelInput.required = true;
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#888888";
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Add Activity";
  form.append(labelInput, colorInput, submitBtn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const color = parseInt(colorInput.value.slice(1), 16);
      await adminFetch("/api/admin/activities", { method: "POST", body: JSON.stringify({ label: labelInput.value, color }) });
      renderActivities(body);
    } catch (err) {
      showError(err);
    }
  };
  body.appendChild(form);
}

// --- Object types (read-only list — creating/editing sprite layers needs
// a texture picker, which belongs with the visual room editor, not a plain
// form here) ---

async function renderObjectTypes(body: HTMLElement) {
  body.textContent = "";
  const types = await adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types");

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Id</th><th>Name</th><th>Size</th></tr>";
  for (const [id, type] of Object.entries(types)) {
    const row = document.createElement("tr");
    row.innerHTML = `<td><code>${id}</code></td><td>${type.name}</td><td>${type.width}×${type.height}</td>`;
    table.appendChild(row);
  }
  body.appendChild(table);
}

// --- Rooms + their objects (list only — no visual placement yet) ---

async function renderRooms(body: HTMLElement) {
  body.textContent = "";
  const [rooms, objectTypes] = await Promise.all([
    adminFetch<RoomSpecWire[]>("/api/admin/rooms"),
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
  ]);
  const typeIds = Object.keys(objectTypes);

  for (const room of rooms) {
    const block = document.createElement("div");
    block.className = "admin-room-block";

    const title = document.createElement("div");
    title.className = "admin-room-title";
    title.textContent = `${room.name} (${room.id}) — ${room.cols}×${room.rows}, level ${room.level}`;
    const previewBtn = document.createElement("button");
    previewBtn.textContent = "Preview";
    previewBtn.onclick = () => previewRenderer?.goToRoom(room.id);
    title.appendChild(previewBtn);
    block.appendChild(title);

    const table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML = "<tr><th>Object</th><th>Type</th><th>x</th><th>y</th><th>Enabled</th><th></th></tr>";
    for (const obj of room.objects) {
      const row = document.createElement("tr");
      row.id = `obj-row-${room.id}-${obj.id}`;
      const idCell = document.createElement("td");
      idCell.textContent = obj.id;
      row.appendChild(idCell);

      const typeCell = document.createElement("td");
      const typeSelect = document.createElement("select");
      for (const typeId of typeIds) {
        const opt = document.createElement("option");
        opt.value = typeId;
        opt.textContent = typeId;
        opt.selected = typeId === obj.type;
        typeSelect.appendChild(opt);
      }
      typeCell.appendChild(typeSelect);
      row.appendChild(typeCell);

      const xInput = document.createElement("input");
      xInput.type = "number";
      xInput.value = String(obj.x);
      xInput.style.width = "60px";
      const xCell = document.createElement("td");
      xCell.appendChild(xInput);
      row.appendChild(xCell);

      const yInput = document.createElement("input");
      yInput.type = "number";
      yInput.value = String(obj.y);
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

      async function saveObject() {
        try {
          await adminFetch(`/api/admin/rooms/${room.id}/objects/${obj.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              type: typeSelect.value,
              x: Number(xInput.value),
              y: Number(yInput.value),
              enabled: checkbox.checked,
            }),
          });
        } catch (err) {
          showError(err);
        }
      }
      typeSelect.onchange = saveObject;
      xInput.onchange = saveObject;
      yInput.onchange = saveObject;
      checkbox.onchange = saveObject;

      const actionCell = document.createElement("td");
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete";
      deleteBtn.onclick = async () => {
        if (!confirm(`Delete object "${obj.id}" from ${room.name}?`)) return;
        try {
          await adminFetch(`/api/admin/rooms/${room.id}/objects/${obj.id}`, { method: "DELETE" });
          renderRooms(body);
        } catch (err) {
          showError(err);
        }
      };
      actionCell.appendChild(deleteBtn);
      row.appendChild(actionCell);

      table.appendChild(row);
    }
    block.appendChild(table);

    const addObjectForm = document.createElement("form");
    addObjectForm.className = "admin-form";
    const newIdInput = document.createElement("input");
    newIdInput.placeholder = "object id";
    newIdInput.required = true;
    const newTypeSelect = document.createElement("select");
    for (const typeId of typeIds) {
      const opt = document.createElement("option");
      opt.value = typeId;
      opt.textContent = typeId;
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
    const addObjectBtn = document.createElement("button");
    addObjectBtn.type = "submit";
    addObjectBtn.textContent = "Add Object";
    addObjectForm.append(newIdInput, newTypeSelect, newXInput, newYInput, addObjectBtn);
    addObjectForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await adminFetch(`/api/admin/rooms/${room.id}/objects`, {
          method: "POST",
          body: JSON.stringify({ id: newIdInput.value, type: newTypeSelect.value, x: Number(newXInput.value), y: Number(newYInput.value) }),
        });
        renderRooms(body);
      } catch (err) {
        showError(err);
      }
    };
    block.appendChild(addObjectForm);

    const deleteRoomBtn = document.createElement("button");
    deleteRoomBtn.textContent = "Delete Room";
    deleteRoomBtn.onclick = async () => {
      if (!confirm(`Delete room "${room.name}" and all its objects?`)) return;
      try {
        await adminFetch(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
        renderRooms(body);
      } catch (err) {
        showError(err);
      }
    };
    block.appendChild(deleteRoomBtn);

    body.appendChild(block);
  }

  const form = document.createElement("form");
  form.className = "admin-form";
  const idInput = document.createElement("input");
  idInput.placeholder = "id (e.g. attic)";
  idInput.required = true;
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
  const levelInput = document.createElement("input");
  levelInput.type = "number";
  levelInput.placeholder = "level";
  levelInput.value = "0";
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.textContent = "Add Room (floor1/wall1, unconnected — reposition isn't editable here yet)";
  form.append(idInput, nameInput, colsInput, rowsInput, levelInput, submitBtn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await adminFetch("/api/admin/rooms", {
        method: "POST",
        body: JSON.stringify({
          id: idInput.value,
          name: nameInput.value,
          cols: Number(colsInput.value),
          rows: Number(rowsInput.value),
          level: Number(levelInput.value),
          floorVariant: "floor1",
          wallVariant: "wall1",
        }),
      });
      renderRooms(body);
    } catch (err) {
      showError(err);
    }
  };
  body.appendChild(form);
}

let previewRenderer: AdminPreviewRenderer | null = null;

/** Click an object in the preview -> scroll to and flash its row in the plain list below, where the actual edit happens. */
function highlightObjectRow(roomId: string, objectId: string) {
  const row = document.getElementById(`obj-row-${roomId}-${objectId}`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("admin-row-highlight");
  setTimeout(() => row.classList.remove("admin-row-highlight"), 1500);
}

/** Fetches the same scene data the game/viewer get over WebSocket, but via the admin REST endpoints, and feeds it into the exact same setActivities/setObjectTypes/setRooms live bindings — see those files' own comments on why every consumer (SceneRenderer included) just works against whatever's currently set. */
async function setupPreview(previewBody: HTMLElement): Promise<void> {
  const [activities, objectTypes, roomSpecs] = await Promise.all([
    adminFetch<ActivityDef[]>("/api/admin/activities"),
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
    adminFetch<RoomSpecWire[]>("/api/admin/rooms"),
  ]);
  setActivities(activities);
  setObjectTypes(objectTypes);
  setRooms(roomSpecsFromWire(roomSpecs));

  await preloadRoomAssets();

  const canvasContainer = document.createElement("div");
  canvasContainer.id = "admin-preview-canvas";
  previewBody.appendChild(canvasContainer);

  const roomLabel = document.createElement("div");
  roomLabel.className = "admin-hint";
  previewBody.appendChild(roomLabel);

  const app = new Application();
  await app.init({ width: 560, height: 360, background: 0x222228 });
  canvasContainer.appendChild(app.canvas);

  previewRenderer = new AdminPreviewRenderer(
    app,
    (roomName) => (roomLabel.textContent = `Viewing: ${roomName} — click a room to pan, an object to find it below`),
    highlightObjectRow,
  );
}

async function main() {
  secret = await getOrPromptSecret();

  const header = document.createElement("h1");
  header.textContent = "House Simulator Admin";
  app.appendChild(header);

  const preview = section("Room Preview", "Read-only — click a room to pan the camera, an object to jump to its row below.");
  const characters = section("Characters");
  const activities = section("Activities");
  const objectTypes = section(
    "Object Types",
    "Read-only here — creating a new type needs a texture picker, which belongs with the visual room editor.",
  );
  const rooms = section("Rooms & Objects", "Edit position/type/enabled directly, or add/delete rooms and objects.");

  try {
    await setupPreview(preview.body);
    await Promise.all([
      renderCharacters(characters.body),
      renderActivities(activities.body),
      renderObjectTypes(objectTypes.body),
      renderRooms(rooms.body),
    ]);
  } catch (err) {
    showError(err);
  }
}

main().catch(showError);

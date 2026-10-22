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
// Save would actually persist. No drag-and-drop: there's no browser
// available in this environment to visually verify pointer-based
// placement math actually works, so the interaction stays "edit the row's
// plain fields, watch the preview update."
import { Application } from "pixi.js";
import { buildModal } from "./ui/modal";
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

function showError(err: unknown) {
  const el = document.createElement("div");
  el.className = "admin-error";
  el.textContent = err instanceof Error ? err.message : String(err);
  app.prepend(el);
  setTimeout(() => el.remove(), 6000);
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
// a texture picker, out of scope here) ---

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
async function openRoomEditModal(room: RoomSpecWire, typeIds: string[], onSaved: () => void) {
  const original = cloneObjects(room.objects);
  const draft = cloneObjects(room.objects);

  const modal = buildModal(`Edit Room: ${room.name}`, { size: "large", resizable: true });

  const previewContainer = document.createElement("div");
  previewContainer.id = "admin-preview-canvas";
  modal.body.appendChild(previewContainer);

  const hint = document.createElement("div");
  hint.className = "admin-hint";
  hint.textContent = "Preview reflects unsaved changes below — nothing is written until you press Save.";
  modal.body.appendChild(hint);

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

  function isDirty(): boolean {
    return JSON.stringify(original) !== JSON.stringify(draft);
  }

  function updateSaveState() {
    saveBtn.disabled = !isDirty();
  }

  function highlightRow(_roomId: string, objectId: string) {
    const row = document.getElementById(`modal-obj-row-${objectId}`);
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    row.classList.add("admin-row-highlight");
    setTimeout(() => row.classList.remove("admin-row-highlight"), 1500);
  }

  async function renderPreview() {
    currentApp?.destroy();
    previewContainer.textContent = "";

    // Single-room spec, connectedTo stripped — nothing else exists to
    // connect to, and nothing else exists to pan to, which is the point.
    setRooms(roomSpecsFromWire([{ ...room, objects: draft }]));

    currentApp = new Application();
    await currentApp.init({ width: 420, height: 320, background: 0x222228 });
    previewContainer.appendChild(currentApp.canvas);
    new AdminPreviewRenderer(currentApp, () => {}, highlightRow);
  }

  function renderTable() {
    table.innerHTML = "<tr><th>Object</th><th>Type</th><th>x</th><th>y</th><th>Enabled</th><th></th></tr>";
    for (const obj of draft) {
      const row = document.createElement("tr");
      row.id = `modal-obj-row-${obj.id}`;

      const idCell = document.createElement("td");
      idCell.textContent = obj.id;
      row.appendChild(idCell);

      const typeSelect = document.createElement("select");
      for (const typeId of typeIds) {
        const opt = document.createElement("option");
        opt.value = typeId;
        opt.textContent = typeId;
        opt.selected = typeId === obj.type;
        typeSelect.appendChild(opt);
      }
      const typeCell = document.createElement("td");
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

      function applyFieldsToDraft() {
        obj.type = typeSelect.value;
        obj.x = Number(xInput.value);
        obj.y = Number(yInput.value);
        obj.enabled = checkbox.checked;
        updateSaveState();
        renderPreview();
      }
      typeSelect.onchange = applyFieldsToDraft;
      xInput.onchange = applyFieldsToDraft;
      yInput.onchange = applyFieldsToDraft;
      checkbox.onchange = applyFieldsToDraft;

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

  function renderAddForm() {
    addForm.textContent = "";
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
    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.textContent = "Add Object";
    addForm.append(newIdInput, newTypeSelect, newXInput, newYInput, addBtn);
    addForm.onsubmit = (e) => {
      e.preventDefault();
      if (draft.some((o) => o.id === newIdInput.value)) {
        showError(new Error(`"${newIdInput.value}" already exists in this room`));
        return;
      }
      draft.push({ id: newIdInput.value, type: newTypeSelect.value, x: Number(newXInput.value), y: Number(newYInput.value), enabled: true });
      renderTable();
      updateSaveState();
      renderPreview();
    };
  }

  saveBtn.onclick = async () => {
    if (!isDirty()) return;
    try {
      const draftIds = new Set(draft.map((o) => o.id));
      for (const obj of draft) {
        const orig = original.find((o) => o.id === obj.id);
        if (!orig) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects`, { method: "POST", body: JSON.stringify(obj) });
        } else if (JSON.stringify(orig) !== JSON.stringify(obj)) {
          await adminFetch(`/api/admin/rooms/${room.id}/objects/${obj.id}`, { method: "PATCH", body: JSON.stringify(obj) });
        }
      }
      for (const orig of original) {
        if (!draftIds.has(orig.id)) {
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

async function renderRooms(body: HTMLElement) {
  body.textContent = "";
  const [rooms, objectTypes] = await Promise.all([
    adminFetch<RoomSpecWire[]>("/api/admin/rooms"),
    adminFetch<Record<string, ObjectTypeDef>>("/api/admin/object-types"),
  ]);
  const typeIds = Object.keys(objectTypes);

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = "<tr><th>Room</th><th>Size</th><th>Level</th><th>Objects</th><th></th></tr>";
  for (const room of rooms) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${room.name} (${room.id})</td><td>${room.cols}×${room.rows}</td><td>${room.level}</td><td>${room.objects.length}</td>`;

    const actionCell = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => openRoomEditModal(room, typeIds, () => renderRooms(body));
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
    actionCell.append(editBtn, deleteBtn);
    row.appendChild(actionCell);

    table.appendChild(row);
  }
  body.appendChild(table);

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
  submitBtn.textContent = "Add Room (floor1/wall1, unconnected)";
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

async function main() {
  secret = await getOrPromptSecret();

  const header = document.createElement("h1");
  header.textContent = "House Simulator Admin";
  app.appendChild(header);

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

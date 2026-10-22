// Room/object specs below are declarative data (grid sizes + relationships).
// The only logic in this file is deriving pixel positions from that grid —
// no Pixi/rendering code lives here, see House.ts for that.
//
// Floor/walls are rendered as a real tilemap, each room picking a named
// floor/wall variant from tileset.ts (see House.ts for the renderer) — not
// a per-room background image. Object sprite layers still use individual
// files: public/objects/<object-id>.png, referenced via `texture` in
// `below`/`overlay`/`above`.
import { FLOOR_VARIANTS, FloorVariant, TileOverride, WALL_VARIANTS, WallVariant, floor1, wall1 } from "./tileset";
import { ACTIVITIES, findActivityById } from "./activities";
import { Floor, STATIC_FLOORS } from "./floors";

export interface SpriteLayer {
  texture?: string; // path to art asset; omitted -> rendered as a placeholder color box
  color?: number; // placeholder fill used when texture is omitted
  offsetX?: number;
  offsetY?: number;
}

// activityId (not label) so renaming an activity via the admin tool
// cascades to every object that triggers it, instead of orphaning a
// hardcoded label string that was only ever resolved at authoring time.
export type ObjectAction =
  | { kind: "activity"; activityId: number }
  | { kind: "navigate"; roomId: number }; // e.g. a staircase — jumps the view to another room, no AW tracking

export interface ObjectDef {
  id: number;
  name: string;
  enabled?: boolean; // default true; set false to skip rendering entirely (e.g. no real art yet)
  // Pixel position relative to the room's own origin (the same (0,0) floor
  // and wall tiles are placed from, i.e. gridToScreen(0,0)) — not snapped to
  // the tile grid. Negative values are fine/expected for anything sitting
  // up on the wall rather than on the floor.
  x: number;
  y: number;
  width: number;
  height: number;
  below?: SpriteLayer[]; // rendered first — base sprite, shadow/rug, etc.
  above?: SpriteLayer[]; // rendered last, e.g. clothing/case-color overlay
  // actions[0] is the default (left-click). Right-click opens a menu of all of them.
  // Omitted/empty -> pure decoration, no click handling at all.
  actions?: ObjectAction[];
  // Rendered between `below` and `above`, only while one of this object's own
  // activity actions is the currently-running one (e.g. a character sprite
  // showing it's in use). Array for future animation frames/variants — for
  // now typically just one entry. offsetX/offsetY relative to the object's
  // own (0,0) top-left, same as any other SpriteLayer.
  overlay?: SpriteLayer[];
  // Carried through from the type's own anchorX/anchorY (see
  // ObjectTypeDef) purely so the admin tool's placement code can read it
  // off the same resolved ObjectDef it already has in hand, instead of a
  // second lookup into objectTypes by type id. Ignored by renderer.ts/
  // House.ts/viewer.ts — x/y above is still always the top-left pixel,
  // unaffected by this.
  anchorX?: number;
  anchorY?: number;
}

// --- Object types: what an object looks like + what it does, independent
// of where it's placed. A room's `objects` list below is a list of
// *placements* (type + x/y) that get resolved into the full ObjectDef shape
// above — the same spec->resolved split resolveRooms() already does for
// rooms themselves (see RoomSpec/RoomDef). Two placements referencing the
// same type (e.g. a second piano somewhere) are then guaranteed to share
// identical sprites/actions by construction, not by coincidentally
// duplicating the same fields twice.
export interface ObjectTypeDef {
  id: number;
  name: string;
  width: number;
  height: number;
  below?: SpriteLayer[];
  overlay?: SpriteLayer[];
  above?: SpriteLayer[];
  // Default actions for this type. A placement can override this entirely
  // (see ObjectPlacement.actions) — needed for things like a staircase,
  // where every placement has its own destination and there's nothing
  // sensible to default to.
  actions?: ObjectAction[];
  // Pixel offset from the sprite's own top-left to its "floor contact"
  // point — the spot that should land on a tile's corner when placed via
  // the admin tool's tile mode. Most sprites include padding for height/
  // perspective, so x/y (always the top-left, unaffected by this field —
  // see adminPreview.ts/admin-main.ts) landing a tile's corner directly at
  // the top-left routinely leaves the object floating off its tile (e.g.
  // not flush against a wall at tile (0,0)). Only consumed by the admin
  // tool's tile-mode (u,v)<->(x,y) conversion and placement-ghost
  // positioning — unset (default 0,0) reproduces today's behavior exactly,
  // and nothing outside the admin tool ever reads this.
  anchorX?: number;
  anchorY?: number;
}

/**
 * The static definitions below (STATIC_OBJECT_TYPES, roomSpecs further
 * down) are the one-time seed source for the object_types/rooms/objects
 * SQLite tables (see server/objectTypes.ts etc.) — NOT the runtime source
 * of truth anymore. `objectTypes`/`rooms` (further down) are mutable `let`
 * bindings that main.ts/viewer-main.ts overwrite with server-fetched data
 * right after connecting (setObjectTypes/setRooms), before any room is
 * built — every other module that `import`s them gets the live ES-module
 * binding, so House.ts/viewer.ts/renderer.ts/floorButtons.ts need no
 * changes at all despite reading what's now server-provided data.
 *
 * `id` is a plain serial integer matching object_types' own INTEGER
 * PRIMARY KEY — explicit here the same way STATIC_ACTIVITIES's ids are
 * (see that file's own comment): seedObjectTypesIfEmpty() inserts these
 * values verbatim; only an admin-tool-created type omits id and gets one
 * auto-assigned.
 */
const STATIC_OBJECT_TYPES = {
  piano: {
    id: 1,
    name: "Piano",
    width: 64,
    height: 64,
    below: [{ texture: "/objects/piano_base.png" }],
    above: [{ texture: "/objects/piano_top.png" }],
    overlay: [{ texture: "/characters/playing_piano.png", offsetX: 32, offsetY: 0 }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.practicingPiano.id }],
  },
  workLaptop: {
    id: 2,
    name: "Work Laptop",
    width: 32,
    height: 32,
    below: [{ color: 0x5a5a6a }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.working.id }],
  },
  personalLaptop: {
    id: 3,
    name: "Personal Laptop",
    width: 32,
    height: 32,
    below: [{ color: 0x4a6a5a }],
    actions: [
      { kind: "activity", activityId: ACTIVITIES.programming.id },
      { kind: "activity", activityId: ACTIVITIES.administrativeWork.id },
    ],
  },
  pc: {
    id: 4,
    name: "PC",
    width: 48,
    height: 32,
    below: [{ color: 0x4a4a4a }],
    actions: [
      { kind: "activity", activityId: ACTIVITIES.gaming.id },
      { kind: "activity", activityId: ACTIVITIES.streaming.id },
    ],
  },
  ddrCabinet: {
    id: 5,
    name: "DDR Cabinet",
    width: 48,
    height: 64,
    below: [{ color: 0x7a2b5a }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.ddr.id }],
  },
  stairs: {
    id: 6,
    name: "Stairs",
    width: 32,
    height: 32,
    below: [{ color: 0x8a8a8a }],
    // No default actions — every placement supplies its own destination.
  },
} satisfies Record<string, ObjectTypeDef>;

export { STATIC_OBJECT_TYPES };

export let objectTypes: Record<string, ObjectTypeDef> = STATIC_OBJECT_TYPES;

/** Swaps in server-fetched object types, re-keyed by id — see this file's top-of-objectTypes comment. */
export function setObjectTypes(types: Record<string, ObjectTypeDef>): void {
  objectTypes = types;
}

function findObjectType(typeId: number): ObjectTypeDef | undefined {
  return Object.values(objectTypes).find((t) => t.id === typeId);
}

export interface ObjectPlacement {
  type: number; // object_types.id
  id?: number; // global objects.id — omitted for a not-yet-saved placement (the admin tool's draft), always present once persisted
  enabled?: boolean;
  x: number;
  y: number;
  actions?: ObjectAction[]; // overrides the type's default actions (e.g. a staircase's per-placement destination)
}

function resolveObjectPlacement(placement: ObjectPlacement): ObjectDef {
  const type = findObjectType(placement.type);
  if (!type) {
    console.error(`[rooms] unknown object type: ${placement.type}`);
    return { id: placement.id ?? -1, name: "(unknown)", enabled: false, x: placement.x, y: placement.y, width: 0, height: 0 };
  }
  return {
    id: placement.id ?? -1,
    name: type.name,
    enabled: placement.enabled,
    x: placement.x,
    y: placement.y,
    width: type.width,
    height: type.height,
    below: type.below,
    overlay: type.overlay,
    above: type.above,
    actions: placement.actions ?? type.actions,
    anchorX: type.anchorX,
    anchorY: type.anchorY,
  };
}

// --- Isometric tile math -------------------------------------------------
// Single source of truth: TILE_SIZE is the only magic number. Room pixel
// sizes and room-to-room connection offsets are both derived from it, so
// they stay correct automatically as room grid sizes change (incl. future
// non-square rooms) instead of being hand-tuned pixel constants.
export const TILE_SIZE = 16; // base square tile, px
export const TILE_WIDTH = TILE_SIZE * 2; // 32 — tile's iso-projected screen width
export const TILE_HEIGHT = TILE_SIZE; // 16 — tile's iso-projected screen height (2:1 iso)

// Vertical stacking between floors (level: 1 = upper floor, -1 = basement,
// etc.) is just a fixed screen-Y offset per level — unlike room-to-room
// connections, floors don't need a chain-resolution system since they're
// always directly above/below, not at one of 4 directions. Placeholder
// value until there's real multi-story art to measure against.
export const FLOOR_HEIGHT = 80;

export function gridToScreen(u: number, v: number) {
  return { x: (u - v) * (TILE_WIDTH / 2), y: (u + v) * (TILE_HEIGHT / 2) };
}

/** Exact inverse of gridToScreen — solving x=(u-v)*(TW/2), y=(u+v)*(TH/2) for u,v. Not rounded (a non-tile-aligned pixel position, which plenty of existing objects have, legitimately produces a fractional tile coordinate) — callers that want a snapped tile should floor/round themselves. */
export function screenToGrid(x: number, y: number): { u: number; v: number } {
  return { u: x / TILE_WIDTH + y / TILE_HEIGHT, v: y / TILE_HEIGHT - x / TILE_WIDTH };
}

// Which edge of the ANCHOR (the room named by roomId, not the declaring
// room itself) this connection extends from. Matches the x/y convention
// used elsewhere (x/u runs top->bottom-right, y/v runs top->bottom-left):
//  - behindLeft:  extends from anchor's u=0 (back-left/wall) edge, -u
//  - behindRight: extends from anchor's v=0 (back-right/wall) edge, -v
//  - frontLeft:   extends from anchor's v=rows (open, left-to-front) edge, +v
//  - frontRight:  extends from anchor's u=cols (open, right-to-front) edge, +u
export type ConnectionDirection = "behindLeft" | "behindRight" | "frontLeft" | "frontRight";

/**
 * A room can connect to several other rooms (an array) — but "each room
 * only has to worry about what it connects to, not which room connects to
 * it": every entry here is always THIS room's own outgoing declaration,
 * never something read in reverse off another room's array. There's no
 * dual-ownership question to resolve (an earlier version had one — "did
 * this edge's fact come from my own array or the other room's?" — which
 * is exactly what made the whole thing hard to reason about). Only
 * entries[0] is ever used to compute this room's own position (see
 * resolveRooms()); further entries are additional declared attachments
 * that don't feed back into layout math.
 *
 * The admin tool enforces, globally across every room's entries (plus
 * every floor's base room — floors.ts), that a given target room id is
 * claimed by at most one entry anywhere — once SOME room connects to X, X
 * is removed from every "pick a room to connect to" picker until that
 * connection is removed. Not enforced by the engine itself (same
 * "hand-coordinated, no automatic validation" spirit as the rest of this
 * system) — resolveRooms() still only reports a cycle as an error rather
 * than assuming one can't happen.
 */
export interface ConnectedToEntry {
  roomId: number;
  direction: ConnectionDirection;
  gapTiles: number; // 0 = flush shared edge, 1 = one empty tile row between
  // Shift along the wall, on whichever axis `direction` doesn't already
  // move on — e.g. for behindLeft/frontRight (which move along u), this
  // shifts v; for behindRight/frontLeft (which move along v), this shifts
  // u. 0 (default) reproduces the original flush-at-the-corner behavior.
  lateralOffset?: number;
}

// Each direction's counterpart on the OTHER side of the same physical
// edge — e.g. a wall edge (behindLeft) only ever meets an open edge on the
// same axis (frontRight), never the perpendicular axis's pair. Exported so
// the admin tool can label which edge of the TARGET room a connection
// actually lands on.
export const PAIR_DIRECTION: Record<ConnectionDirection, ConnectionDirection> = {
  behindLeft: "frontRight",
  frontRight: "behindLeft",
  behindRight: "frontLeft",
  frontLeft: "behindRight",
};

export interface RoomSpec {
  id: number;
  name: string;
  cols: number; // room size in tiles along the iso "u" axis
  rows: number; // room size in tiles along the iso "v" axis
  floor: FloorVariant;
  wall: WallVariant;
  // Per-tile replacements for the default floor/wall at specific (u,v)
  // positions — e.g. a gap in a wall run for a doorway between rooms.
  floorOverrides?: TileOverride[];
  wallOverrides?: TileOverride[];
  objects: ObjectPlacement[];
  // Placement relative to another room's edge, instead of an absolute pixel
  // offset — stays correct if either room's size changes. Unset/empty means
  // this room sits at the grid origin, i.e. "the anchor" (typically a
  // floor's own base room — see floors.ts). See ConnectedToEntry for why
  // only entries[0] affects this room's own position.
  connectedTo?: ConnectedToEntry[];
}

export interface RoomDef extends Omit<RoomSpec, "objects"> {
  objects: ObjectDef[]; // resolved from RoomSpec's placements
  x: number;
  y: number;
  width: number;
  height: number;
  // Which floor this room is on — DERIVED (see computeFloorMembership),
  // not stored: a room with no path back to any floor's base room (via
  // ANY connectedTo edge, from either side) defaults to 0 rather than
  // being undefined, same as the old stored field's own default.
  level: number;
}

/**
 * Server-sent room shape — floor/wall as named strings (what's actually
 * stored, and what an admin-tool dropdown would pick from) instead of the
 * full FloorVariant/WallVariant object RoomSpec itself expects. Converted
 * via roomSpecsFromWire() before resolveRooms() ever sees it, so
 * resolveRooms()/buildFloorAndWalls() (renderer.ts) don't need to know
 * variants can arrive as strings at all.
 */
export interface RoomSpecWire {
  id: number;
  name: string;
  cols: number;
  rows: number;
  floorVariant: string;
  wallVariant: string;
  floorOverrides?: TileOverride[];
  wallOverrides?: TileOverride[];
  connectedTo?: ConnectedToEntry[];
  objects: ObjectPlacement[];
}

export function roomSpecsFromWire(wire: RoomSpecWire[]): RoomSpec[] {
  return wire.map((w) => ({
    id: w.id,
    name: w.name,
    cols: w.cols,
    rows: w.rows,
    floor: FLOOR_VARIANTS[w.floorVariant],
    wall: WALL_VARIANTS[w.wallVariant],
    floorOverrides: w.floorOverrides,
    wallOverrides: w.wallOverrides,
    connectedTo: w.connectedTo,
    objects: w.objects,
  }));
}

/** Minimal shape computeFloorMembership/buildUndirectedAdjacency actually need — both RoomSpec[] and RoomSpecWire[] satisfy this structurally, so one implementation serves resolveRooms() (RoomSpec) and the admin tool's organization UI (RoomSpecWire) alike. */
interface RoomConnectivity {
  id: number;
  connectedTo?: ConnectedToEntry[];
}

/** Every room id already claimed as a target by SOME room's connectedTo entry (any entry, by any room), or as a floor's base room (floors.ts) — excluded from "pick a room to connect to" pickers so no two connections (from the same room or different ones) ever claim the same target. `exceptRoomId` exempts one room's OWN existing targets from its own exclusion (editing/adding another connection for a room shouldn't make its already-made choices disappear from its own picker). */
export function getUsedRoomIds(allRooms: RoomSpecWire[], baseRoomIds: number[], exceptRoomId?: number): Set<number> {
  const used = new Set<number>(baseRoomIds);
  for (const r of allRooms) {
    if (r.id === exceptRoomId) continue;
    for (const entry of r.connectedTo ?? []) used.add(entry.roomId);
  }
  return used;
}

/**
 * Every connectedTo entry, from either room, as one undirected edge —
 * floor organization is "is this room attached to the floor's base room
 * at all," not "does this room's position specifically derive from it,"
 * so ALL entries count here (not just entries[0], which is the one
 * resolveRooms() treats specially for POSITION — a different concern
 * from which floor a room organizationally belongs to). A room with 3
 * connections is reachable via any of the 3, regardless of which one
 * happens to be entries[0].
 */
function buildUndirectedAdjacency(allRooms: RoomConnectivity[]): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  function ensure(id: number): Set<number> {
    let set = adj.get(id);
    if (!set) {
      set = new Set();
      adj.set(id, set);
    }
    return set;
  }
  for (const r of allRooms) {
    ensure(r.id);
    for (const entry of r.connectedTo ?? []) {
      ensure(r.id).add(entry.roomId);
      ensure(entry.roomId).add(r.id);
    }
  }
  return adj;
}

/**
 * Which floor every room belongs to, computed once for the whole house —
 * a BFS from each floor's base room over the undirected connectedTo graph
 * (see buildUndirectedAdjacency). A room not reachable from any floor's
 * base room is simply absent from the returned map ("unorganized").
 */
export function computeFloorMembership(allRooms: RoomConnectivity[], floors: Floor[]): Map<number, number> {
  const adj = buildUndirectedAdjacency(allRooms);
  const membership = new Map<number, number>();
  for (const floor of floors) {
    if (membership.has(floor.baseRoomId)) continue; // already claimed by an earlier floor's walk
    const queue = [floor.baseRoomId];
    const visited = new Set([floor.baseRoomId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      membership.set(current, floor.level);
      for (const neighbor of adj.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return membership;
}

export interface FloorTreeNode {
  room: RoomSpecWire;
  children: FloorTreeNode[];
}

/**
 * Starting at a floor's base room, walk the same undirected connectedTo
 * graph computeFloorMembership() uses — each room appears exactly once
 * (first discovery wins, via the `visited` set threaded through the
 * recursion), becoming a child of whichever already-visited room led to
 * it. Cycle-safe the same way resolveRooms() is, just by silently not
 * re-descending into an already-visited room rather than throwing — this
 * is a read-only visualization, not something that needs to reject bad
 * data.
 */
export function buildFloorTree(baseRoomId: number, allRooms: RoomSpecWire[]): FloorTreeNode | null {
  const base = allRooms.find((r) => r.id === baseRoomId);
  if (!base) return null;

  const adj = buildUndirectedAdjacency(allRooms);
  const visited = new Set<number>([baseRoomId]);
  function buildNode(roomId: number): FloorTreeNode {
    const room = allRooms.find((r) => r.id === roomId)!;
    const children: FloorTreeNode[] = [];
    for (const neighbor of adj.get(roomId) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      children.push(buildNode(neighbor));
    }
    return { room, children };
  }
  return buildNode(baseRoomId);
}

/** `floors` determines each room's vertical `level` — see RoomDef.level's own comment on why this is derived rather than stored. */
export function resolveRooms(specs: RoomSpec[], floors: Floor[]): RoomDef[] {
  const specById = new Map(specs.map((s) => [s.id, s]));
  const origins = new Map<number, { u: number; v: number }>();
  const membership = computeFloorMembership(specs, floors);

  // `visiting` detects a connectedTo cycle (A's primary entry chains back to
  // A) — a fresh Set per top-level originOf() call below (default params are
  // evaluated per call), not shared across different rooms' own traversals.
  function originOf(id: number, visiting: Set<number> = new Set()): { u: number; v: number } {
    const cached = origins.get(id);
    if (cached) return cached;
    if (visiting.has(id)) {
      throw new Error(`[rooms] connectedTo cycle detected involving room "${id}"`);
    }
    visiting.add(id);

    const spec = specById.get(id)!;
    // Only the first entry ever determines this room's own position — see
    // ConnectedToEntry's own comment for why further entries are inert here.
    const primary = spec.connectedTo?.[0];
    let origin: { u: number; v: number };
    if (!primary) {
      origin = { u: 0, v: 0 };
    } else {
      const { roomId, direction, gapTiles } = primary;
      const lateralOffset = primary.lateralOffset ?? 0;
      if (!specById.has(roomId)) {
        throw new Error(`[rooms] room "${id}" connects to unknown room "${roomId}"`);
      }
      const anchor = originOf(roomId, visiting);
      const anchorSpec = specById.get(roomId)!;
      switch (direction) {
        // behindLeft/behindRight: this room's own far edge touches the
        // anchor's u=0/v=0 edge, so the shift uses THIS room's own size
        // (to clear its own extent before reaching the anchor's edge).
        // The OTHER axis (the one not being shifted to clear the gap) is
        // the "lateral" one — free to slide along the wall via lateralOffset,
        // 0 reproducing the original flush-at-the-corner placement.
        case "behindLeft":
          origin = { u: anchor.u - spec.cols - gapTiles, v: anchor.v + lateralOffset };
          break;
        case "behindRight":
          origin = { u: anchor.u + lateralOffset, v: anchor.v - spec.rows - gapTiles };
          break;
        // frontLeft/frontRight: this room starts right where the anchor's
        // own extent ends, so the shift uses the ANCHOR's size instead.
        case "frontLeft":
          origin = { u: anchor.u + lateralOffset, v: anchor.v + anchorSpec.rows + gapTiles };
          break;
        case "frontRight":
          origin = { u: anchor.u + anchorSpec.cols + gapTiles, v: anchor.v + lateralOffset };
          break;
      }
    }
    origins.set(id, origin);
    visiting.delete(id);
    return origin;
  }

  return specs.map((spec) => {
    const { u, v } = originOf(spec.id);
    const { x, y } = gridToScreen(u, v);
    const level = membership.get(spec.id) ?? 0;
    return {
      ...spec,
      x,
      y: y - level * FLOOR_HEIGHT,
      level,
      width: (spec.cols + spec.rows) * (TILE_WIDTH / 2),
      height: (spec.cols + spec.rows) * (TILE_HEIGHT / 2),
      objects: spec.objects.map(resolveObjectPlacement),
    };
  });
}

// Explicit numeric ids throughout (rooms 1-6, object placements 1-9
// globally — not per-room anymore, see ObjectPlacement's own comment)
// matching exactly what server/rooms.ts's seedRoomsIfEmpty() inserts
// verbatim. STATIC_FLOORS (floors.ts) references these same room ids.
export const STATIC_ROOM_SPECS: RoomSpec[] = [
  {
    id: 1,
    name: "Jacqueline's Office",
    cols: 10,
    rows: 10,
    floor: floor1,
    wall: wall1,
    // Doorway toward the DDR Room: it connects along this room's u=0 (left)
    // wall, so that's the one that needs the gap — DDR's own facing edge
    // (its u=cols corner) has no wall by default already. Adjust v / widen
    // to more than one tile once you see how it looks.
    wallOverrides: [{ u: 0, v: 5, tile: null }],
    objects: [
      { id: 1, type: STATIC_OBJECT_TYPES.piano.id, x: 48, y: 48 },
      { id: 2, type: STATIC_OBJECT_TYPES.workLaptop.id, enabled: false, x: 64, y: 40 },
      { id: 3, type: STATIC_OBJECT_TYPES.personalLaptop.id, enabled: false, x: 80, y: 48 },
      { id: 4, type: STATIC_OBJECT_TYPES.pc.id, enabled: false, x: 24, y: 56 },
    ],
  },
  {
    id: 2,
    name: "DDR Room",
    cols: 10,
    rows: 6,
    floor: floor1,
    wall: wall1,
    connectedTo: [{ roomId: 1, direction: "behindLeft", gapTiles: 1 }],
    objects: [{ id: 5, type: STATIC_OBJECT_TYPES.ddrCabinet.id, x: 8, y: 0 }],
  },
  {
    id: 3,
    name: "Living Room",
    cols: 10,
    rows: 20,
    floor: floor1,
    wall: wall1,
    connectedTo: [{ roomId: 2, direction: "frontLeft", gapTiles: 1 }],
    // DDR's facing edge is open by default, but this room's own v=0 wall
    // (facing back toward DDR) still gets its default wall — needs a gap too.
    wallOverrides: [{ u: 5, v: 0, tile: null }],
    objects: [
      {
        id: 6,
        type: STATIC_OBJECT_TYPES.stairs.id,
        x: 32,
        y: 48,
        actions: [{ kind: "navigate", roomId: 6 }],
      },
    ],
  },
  {
    id: 4,
    name: "Entrance",
    cols: 8,
    rows: 6,
    floor: floor1,
    wall: wall1,
    // Connects along office's own v=rows (open, south) edge — lands entrance
    // right below office with no overlap. It also ends up immediately
    // adjacent to Living Room's open east edge for free: Living Room/DDR
    // already align to the same u boundary this lands on (u=0), since they
    // in turn connect off office's u=0 edge. Two separate doors below: one
    // in entrance's own v=0 wall (faces office, "top right"), one in its
    // own u=0 wall (faces Living Room, "top left").
    connectedTo: [{ roomId: 1, direction: "frontLeft", gapTiles: 1 }],
    wallOverrides: [
      { u: 4, v: 0, tile: null }, // door to office
      { u: 0, v: 3, tile: null }, // door to Living Room
    ],
    objects: [
      {
        id: 7,
        type: STATIC_OBJECT_TYPES.stairs.id,
        x: 16,
        y: 16,
        actions: [{ kind: "navigate", roomId: 5 }],
      },
    ],
  },
  {
    id: 5,
    name: "Bedroom",
    cols: 10,
    rows: 10,
    floor: floor1,
    wall: wall1,
    // Same (u,v) footprint as the office, directly below it (no connectedTo
    // needed — level is derived from floor membership, a pure vertical
    // offset, not a horizontal relationship).
    objects: [
      {
        id: 8,
        type: STATIC_OBJECT_TYPES.stairs.id,
        x: -112,
        y: 48,
        actions: [{ kind: "navigate", roomId: 4 }],
      },
    ],
  },
  {
    id: 6,
    name: "Basement",
    cols: 10,
    rows: 10,
    floor: floor1,
    wall: wall1,
    objects: [
      {
        id: 9,
        type: STATIC_OBJECT_TYPES.stairs.id,
        x: -112,
        y: 48,
        actions: [{ kind: "navigate", roomId: 3 }],
      },
    ],
  },
];

export let rooms: RoomDef[] = resolveRooms(STATIC_ROOM_SPECS, STATIC_FLOORS);

/** Swaps in server-fetched rooms — see this file's top-of-objectTypes comment. */
export function setRooms(specs: RoomSpec[], floors: Floor[]): void {
  rooms = resolveRooms(specs, floors);
}

/**
 * The room + object whose action matches this activity label, if any — for
 * camera focus when an activity starts (the default is to center on the
 * specific object, not just its room; see House.ts/viewer.ts). If more than
 * one object shares the same label (e.g. a second piano elsewhere), this
 * just returns whichever comes first in room order — there's no signal
 * carried over the wire about which physical object a *remote* device
 * actually clicked, so this is a reasonable default rather than something
 * worth plumbing through the RPC protocol for.
 */
export function findObjectForActivityLabel(label: string): { roomId: number; objectId: number } | undefined {
  for (const room of rooms) {
    for (const obj of room.objects) {
      for (const action of obj.actions ?? []) {
        if (action.kind === "activity" && findActivityById(action.activityId)?.label === label) {
          return { roomId: room.id, objectId: obj.id };
        }
      }
    }
  }
  return undefined;
}

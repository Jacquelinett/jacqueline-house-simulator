// Room/object specs below are declarative data (grid sizes + relationships).
// The only logic in this file is deriving pixel positions from that grid —
// no Pixi/rendering code lives here, see House.ts for that.
//
// Floor/walls are rendered as a real tilemap, each room picking a named
// floor/wall variant from tileset.ts (see House.ts for the renderer) — not
// a per-room background image. Object sprite layers still use individual
// files: public/objects/<object-id>.png, referenced via `texture` in
// `below`/`overlay`/`above`.
import { FloorVariant, resolveFloorVariant, resolveWallVariant, TileOverride, WallVariant, floor1, wall1 } from "./tileset";
import { ACTIVITIES, findActivityById } from "./activities";
import { Floor, STATIC_FLOORS } from "./floors";

export interface SpriteLayer {
  // Below/above only in practice now — the interaction sprite resolves its
  // texture purely from spriteKey below, never this field (see that
  // field's own comment for why a separately-authored fallback texture is
  // no longer needed at all).
  texture?: string; // path to art asset; omitted -> rendered as a placeholder color box
  color?: number; // placeholder fill used when texture is omitted
  // Interaction-sprite-only now — below/above are always rendered at
  // (0,0), forced to the object's own width/height (see renderer.ts's
  // buildLayer), so there's nothing for an offset to mean there. The
  // interaction sprite has no width/height of its own (renders at its
  // resolved texture's native size), so IT genuinely needs positioning —
  // carried on ObjectTypeDef.spriteOffsetX/spriteOffsetY (a per-TYPE
  // field, not this shared layer shape) and mirrored onto this resolved
  // layer's offsetX/offsetY by server/objectTypes.ts for renderer.ts to
  // read.
  offsetX?: number;
  offsetY?: number;
  // Interaction-sprite-only in practice (see ObjectTypeDef.sprite) — when
  // set, this layer's actual texture is resolved per-character at render time
  // (src/scene/characterSprites.ts: "<spriteName>_<spriteKey>.png"),
  // falling back to the SAME convention applied to DEFAULT_SPRITE_CHARACTER
  // ("jacqueline") when the attributed character has no spriteName set, or
  // no matching file exists for them specifically. That default
  // character's own file doubles as the universal "shared default" art, so
  // there's no separate admin-authored fallback texture to maintain.
  spriteKey?: string;
  // frameCount > 1 means the resolved texture is a single spritesheet
  // image, sliced into this many EQUAL-WIDTH frames laid out left-to-right
  // starting at (0,0) and animated by swapping frames every
  // frameDurationMs (default ~150ms). Frame width/height are derived at
  // load time (texture's own natural width / frameCount, and its full
  // natural height) rather than authored — a spritesheet's frames are
  // always the sheet's own height, and equal-width slices of its own
  // width, so there's nothing for an admin to get wrong by typing them in
  // separately. Omitted/1 is a plain static image, unchanged.
  frameCount?: number;
  frameDurationMs?: number;
}

// activityId (not label) so renaming an activity via the admin tool
// cascades to every object that triggers it, instead of orphaning a
// hardcoded label string that was only ever resolved at authoring time.
// There's deliberately no "view" kind — every click recenters the camera
// on whatever was clicked unconditionally (see renderer.ts's buildObject/
// House.ts's/viewer.ts's attachObjectInteraction), so "just look at this"
// isn't a real assignable action, just the baseline thing clicking does.
// The one UI-level exception is House.ts's "View" menu entry, which only
// ever appears when another character is currently attributed to one of
// an object's activity actions — that's constructed on the fly from the
// attribution, not a persisted ObjectAction.
export type ObjectAction =
  | { kind: "activity"; activityId: number }
  | { kind: "goTo"; roomId: number }; // e.g. a staircase — jumps the view to another room, no AW tracking

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
  // A single action runs directly on click; 2+ opens a picker (left-click
  // or right-click, either way — see House.ts). Omitted/empty -> pure
  // decoration: the click still recenters the camera (every click does),
  // there's just nothing further to run.
  actions?: ObjectAction[];
  // Rendered between `below` and `above`, only while one of this object's own
  // activity actions is the currently-running one (e.g. a character sprite
  // showing it's in use). Array for future animation frames/variants — for
  // now typically just one entry. offsetX/offsetY relative to the object's
  // own (0,0) top-left, same as any other SpriteLayer.
  sprite?: SpriteLayer[];
  // Carried through from the type's own anchorX/anchorY (see
  // ObjectTypeDef) purely so the admin tool's placement code can read it
  // off the same resolved ObjectDef it already has in hand, instead of a
  // second lookup into objectTypes by type id. Ignored by renderer.ts/
  // House.ts/viewer.ts — x/y above is still always the top-left pixel,
  // unaffected by this.
  anchorX?: number;
  anchorY?: number;
  // Default true. False makes this placement fully inert in the real
  // game/viewer — no click at all, not even the baseline "recenter the
  // camera" every other object gets regardless of actions — e.g. pure
  // background clutter that shouldn't steal a click meant for whatever's
  // behind/near it. Never affects the admin tool's own click-to-select,
  // which always stays clickable for editing purposes (see House.ts's/
  // viewer.ts's own attachObjectInteraction, and AdminPreviewRenderer's
  // separate override, which never reads this field at all).
  clickable?: boolean;
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
  // Always derived/read-only — resolved server-side (server/objectTypes.ts)
  // by joining whichever sprites row spriteId points at (for
  // spriteKey/frameCount/frameDurationMs) with THIS type's own
  // spriteOffsetX/Y (for position), never written back directly.
  // spriteId/spriteOffsetX/spriteOffsetY are the real fields: both read
  // (what this type currently has, if any) and write (set these on
  // create/update) go through them, so multiple types can reference the
  // same named sprite (e.g. "playPiano") while each still positioning it
  // independently — the same way below/above's own offsetX/offsetY are
  // already per-type rather than shared, see server/sprites.ts and
  // admin-main.ts's Sprites tab.
  sprite?: SpriteLayer[];
  spriteId?: number | null;
  spriteOffsetX?: number;
  spriteOffsetY?: number;
  above?: SpriteLayer[];
  // Deliberately no `actions` here — what an object DOES is purely a
  // per-placement concern now (see ObjectPlacement.actions), not
  // something a type defaults and a placement merely overrides. Two
  // placements of the same type (e.g. a second piano) look identical but
  // can do completely different things, authored independently in the
  // room editor.
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
    sprite: [{ offsetX: 32, offsetY: 0, spriteKey: "playPiano" }],
  },
  workLaptop: {
    id: 2,
    name: "Work Laptop",
    width: 32,
    height: 32,
    below: [{ color: 0x5a5a6a }],
  },
  personalLaptop: {
    id: 3,
    name: "Personal Laptop",
    width: 32,
    height: 32,
    below: [{ color: 0x4a6a5a }],
  },
  pc: {
    id: 4,
    name: "PC",
    width: 48,
    height: 32,
    below: [{ color: 0x4a4a4a }],
  },
  ddrCabinet: {
    id: 5,
    name: "DDR Cabinet",
    width: 48,
    height: 64,
    below: [{ color: 0x7a2b5a }],
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
  // What clicking THIS specific placement does — purely per-placement,
  // not inherited from the type (see ObjectTypeDef's own comment on why
  // that fallback was removed). Omitted/empty -> pure decoration.
  actions?: ObjectAction[];
  // See ObjectDef's own comment — default true, per-placement (not
  // per-type) same as actions above: two placements of the same type can
  // differ on whether either one is clickable at all.
  clickable?: boolean;
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
    sprite: type.sprite,
    above: type.above,
    actions: placement.actions,
    anchorX: type.anchorX,
    anchorY: type.anchorY,
    clickable: placement.clickable,
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

/** RoomSpec.wallHeight's own default when unset — see that field's own comment and tileset.ts's WALL_PART_SIZE (16px per stacked piece, so 7 -> a 112px-tall wall). */
export const DEFAULT_WALL_HEIGHT = 7;

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
 * A room can connect to several other rooms (an array) — authored as
 * "each room only has to worry about what it connects to, not which room
 * connects to it": every entry here is always THIS room's own outgoing
 * declaration when you're the one adding it through the admin tool, never
 * something you read in reverse off another room's array.
 *
 * How this feeds into actual position differs by which resolveRooms()
 * path is in play (see that function's own comment): the normal
 * floor-tree path positions every reachable room relative to whichever
 * neighbor discovered it in the BFS, using WHICHEVER of the two rooms'
 * entries links them (inverting one declared by the other side — see
 * positionNeighbor()) — so despite the "no dual-ownership" authoring
 * rule, position resolution itself does end up reading entries from
 * either direction, just resolved deterministically by tree-walk order
 * rather than needing a human to reconcile the two sides. The `floors: []`
 * fallback path (admin-tool previews only) is the one place the OLDER
 * "only entries[0], walk up to whatever ancestor has none" rule still
 * applies, since there's no floor/tree context to BFS from there.
 *
 * The admin tool enforces, globally across every room's entries (plus
 * every floor's base room — floors.ts), that a given target room id is
 * claimed by at most one entry anywhere — once SOME room connects to X, X
 * is removed from every "pick a room to connect to" picker until that
 * connection is removed. Not enforced by the engine itself (same
 * "hand-coordinated, no automatic validation" spirit as the rest of this
 * system).
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
  // Whether the back-left (u=0 edge) / back-right (v=0 edge) wall run
  // renders at all — default true (unset means "render it," same as
  // today's unconditional behavior). A wallOverrides entry for a tile on a
  // hidden side still renders (gap or replacement tile alike) — these two
  // flags only change the DEFAULT for a side, not the override mechanism,
  // which stays the "exception" it's always been (see
  // placeTileWithOverrides in renderer.ts).
  showLeftWall?: boolean;
  showRightWall?: boolean;
  // The front two edges (u=cols / v=rows) — opposite default from the back
  // walls above: unset/false means "don't render it," since most rooms are
  // meant to be looked INTO from the front, not fully enclosed. Turning
  // one on "finishes the diamond" with a wall reusing the PARALLEL back
  // wall's own tile style — bottom-right (u=cols edge) reuses the left
  // wall's tiles (same u=0-edge direction, just shifted to u=cols),
  // bottom-left (v=rows edge) reuses the right wall's tiles. See
  // renderer.ts's buildBackWalls/buildBottomWalls for the actual placement.
  showBottomLeftWall?: boolean;
  showBottomRightWall?: boolean;
  // How many 16px autotile pieces tall a wall renders (see tileset.ts's
  // WallPart/WALL_PART_SIZE and renderer.ts's placeWallStack) — unset
  // means DEFAULT_WALL_HEIGHT, same "undefined means the default" contract
  // every other optional field on this interface already uses.
  wallHeight?: number;
  // Whether the room + everything inside it actually renders/is clickable
  // client-side — default false (unlike the wall-show flags above, which
  // default true). Deliberately NEVER read by resolveRooms() or
  // computeFloorMembership() — an invisible room still fully participates
  // in position/floor-membership resolution, since other rooms may be
  // connectedTo it. Purely a renderer/input concern (see renderer.ts's
  // applyFocus) — an activity tracked on an object inside an invisible room
  // keeps running server-side exactly as if it were visible.
  visible?: boolean;
  objects: ObjectPlacement[];
  // Placement relative to another room's edge, instead of an absolute pixel
  // offset — stays correct if either room's size changes. Unset/empty means
  // this room sits at the grid origin, i.e. "the anchor" (typically a
  // floor's own base room — see floors.ts). See ConnectedToEntry's own
  // comment for how this feeds into actual position.
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
  showLeftWall?: boolean;
  showRightWall?: boolean;
  showBottomLeftWall?: boolean;
  showBottomRightWall?: boolean;
  wallHeight?: number;
  visible?: boolean;
  connectedTo?: ConnectedToEntry[];
  objects: ObjectPlacement[];
}

export function roomSpecsFromWire(wire: RoomSpecWire[]): RoomSpec[] {
  return wire.map((w) => ({
    id: w.id,
    name: w.name,
    cols: w.cols,
    rows: w.rows,
    floor: resolveFloorVariant(w.floorVariant),
    wall: resolveWallVariant(w.wallVariant),
    floorOverrides: w.floorOverrides,
    wallOverrides: w.wallOverrides,
    showLeftWall: w.showLeftWall,
    showRightWall: w.showRightWall,
    showBottomLeftWall: w.showBottomLeftWall,
    showBottomRightWall: w.showBottomRightWall,
    wallHeight: w.wallHeight,
    visible: w.visible,
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
 * Every connectedTo entry, from either room, as one undirected edge — this
 * is both "is this room attached to the floor's base room at all" (used
 * by computeFloorMembership/buildFloorTree) and the actual graph
 * resolveRooms()'s floor-tree path walks for position (see
 * resolveViaFloorTree). A room with 3 connections is reachable via any of
 * the 3, regardless of which one — unlike the `floors: []` fallback path,
 * which only ever looks at a room's own entries[0].
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

/**
 * Core placement math shared by both resolution strategies below: given a
 * known anchor origin and a connection's `direction` (which edge of the
 * anchor it extends from — see ConnectionDirection's own comment), returns
 * the origin of the room on the OTHER end. `cols`/`rows` are always the
 * room being positioned's own size; `anchorCols`/`anchorRows` are the
 * anchor's — behindLeft/behindRight shift by the positioned room's own
 * size (clearing its own extent before reaching the anchor's edge),
 * frontLeft/frontRight shift by the anchor's size instead (starting right
 * where the anchor's extent ends). lateralOffset slides along whichever
 * axis isn't being shifted to clear the gap; 0 reproduces flush-at-the-
 * corner placement.
 */
function placeRelativeTo(
  direction: ConnectionDirection,
  anchor: { u: number; v: number },
  cols: number,
  rows: number,
  anchorCols: number,
  anchorRows: number,
  gapTiles: number,
  lateralOffset: number,
): { u: number; v: number } {
  switch (direction) {
    case "behindLeft":
      return { u: anchor.u - cols - gapTiles, v: anchor.v + lateralOffset };
    case "behindRight":
      return { u: anchor.u + lateralOffset, v: anchor.v - rows - gapTiles };
    case "frontLeft":
      return { u: anchor.u + lateralOffset, v: anchor.v + anchorRows + gapTiles };
    case "frontRight":
      return { u: anchor.u + anchorCols + gapTiles, v: anchor.v + lateralOffset };
  }
}

/**
 * `floors` determines each room's vertical `level` — see RoomDef.level's
 * own comment on why this is derived rather than stored — and now ALSO
 * drives HOW rooms get positioned and which ones render at all: starting
 * from each floor's base room (origin (0,0)), a BFS walks the same
 * undirected connectedTo graph computeFloorMembership()/buildFloorTree()
 * use — every room reachable this way gets positioned relative to
 * whichever already-positioned room led to it in that walk, regardless of
 * which of the two rooms actually DECLARED the connectedTo entry (see
 * positionNeighbor() below for the self-vs-other-declared handling). A
 * room with no path back to any floor's base room is excluded entirely
 * rather than defaulting to the origin and silently overlapping whatever
 * else is there — "not connected to anything, and not a base room" means
 * "not built into the house yet," not "render it at (0,0) anyway."
 *
 * Passing `floors: []` opts out of all of this — every spec resolves via
 * each room's own entries[0] chain (the pre-floor-tree algorithm,
 * preserved below as resolveViaOwnChain()) — the admin tool's own
 * isolated single/subset-room previews rely on this: they intentionally
 * show a room (or a room plus synthesized neighbor entries built
 * specifically for that chain-based algorithm) stripped of the rest of
 * the house, which has no floor to BFS from in the first place.
 */
export function resolveRooms(specs: RoomSpec[], floors: Floor[]): RoomDef[] {
  const membership = computeFloorMembership(specs, floors);
  const specById = new Map(specs.map((s) => [s.id, s]));

  const origins = floors.length === 0 ? resolveViaOwnChain(specs, specById) : resolveViaFloorTree(specs, specById, floors);

  const included = floors.length === 0 ? specs : specs.filter((s) => origins.has(s.id));

  return included.map((spec) => {
    const { u, v } = origins.get(spec.id)!;
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

/**
 * Pre-floor-tree algorithm: each room resolves itself independently by
 * walking up its OWN connectedTo[0] chain to whatever ancestor has none
 * (defaulting that ancestor to the origin) — only ever used for `floors:
 * []` now (see resolveRooms's own comment), so every spec given always
 * gets *some* origin here, never excluded.
 */
function resolveViaOwnChain(specs: RoomSpec[], specById: Map<number, RoomSpec>): Map<number, { u: number; v: number }> {
  const origins = new Map<number, { u: number; v: number }>();

  // `visiting` detects a connectedTo cycle (A's primary entry chains back to
  // A) — a fresh Set per top-level call below (default params are evaluated
  // per call), not shared across different rooms' own traversals.
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
      origin = placeRelativeTo(direction, anchor, spec.cols, spec.rows, anchorSpec.cols, anchorSpec.rows, gapTiles, lateralOffset);
    }
    origins.set(id, origin);
    visiting.delete(id);
    return origin;
  }

  for (const spec of specs) originOf(spec.id);
  return origins;
}

/**
 * New floor-tree algorithm: BFS from each floor's base room over the
 * undirected connectedTo graph, positioning each newly-discovered room
 * relative to whichever already-positioned room discovered it —
 * regardless of which of the two actually declared the connectedTo entry
 * (see positionNeighbor()). A room already visited via an earlier floor's
 * walk, or not reachable from any floor's base room at all, simply never
 * gets an entry here — resolveRooms() filters the final output to exactly
 * what's in this map.
 */
function resolveViaFloorTree(specs: RoomSpec[], specById: Map<number, RoomSpec>, floors: Floor[]): Map<number, { u: number; v: number }> {
  const adj = buildUndirectedAdjacency(specs);
  const origins = new Map<number, { u: number; v: number }>();

  for (const floor of floors) {
    if (origins.has(floor.baseRoomId)) continue; // already claimed by an earlier floor's walk
    if (!specById.has(floor.baseRoomId)) continue; // floor points at a room that doesn't exist — nothing to walk from

    origins.set(floor.baseRoomId, { u: 0, v: 0 });
    const queue = [floor.baseRoomId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighborId of adj.get(current) ?? []) {
        if (origins.has(neighborId)) continue; // already visited via an earlier branch/floor
        if (!specById.has(neighborId)) {
          throw new Error(`[rooms] room "${current}" connects to unknown room "${neighborId}"`);
        }
        origins.set(neighborId, positionNeighbor(current, neighborId, specById, origins.get(current)!));
        queue.push(neighborId);
      }
    }
  }

  return origins;
}

/**
 * Positions `neighborId` relative to `knownId`'s already-resolved origin —
 * the connectedTo entry linking them may live on EITHER room (a room only
 * has to worry about what IT connects to when authoring, never which room
 * connects to it, so by the time we're walking the tree both directions
 * are equally valid data). Prefers the neighbor's own entry pointing at
 * knownId when present (used directly, no inversion needed); otherwise
 * inverts knownId's entry pointing at neighborId — flip the direction to
 * its pair, negate lateralOffset, keep gapTiles, and swap which room's
 * cols/rows plays which role in placeRelativeTo(). Derived algebraically
 * from placeRelativeTo() itself (solve each case for the anchor's
 * position given the far room's, confirmed to invert to exactly the
 * paired direction with a sign-flipped lateralOffset in all four cases) —
 * not just asserted.
 */
function positionNeighbor(
  knownId: number,
  neighborId: number,
  specById: Map<number, RoomSpec>,
  knownOrigin: { u: number; v: number },
): { u: number; v: number } {
  const neighborSpec = specById.get(neighborId)!;
  const knownSpec = specById.get(knownId)!;

  const direct = neighborSpec.connectedTo?.find((e) => e.roomId === knownId);
  if (direct) {
    return placeRelativeTo(direct.direction, knownOrigin, neighborSpec.cols, neighborSpec.rows, knownSpec.cols, knownSpec.rows, direct.gapTiles, direct.lateralOffset ?? 0);
  }

  const reverse = knownSpec.connectedTo?.find((e) => e.roomId === neighborId);
  if (!reverse) {
    // Shouldn't happen — buildUndirectedAdjacency only ever links two rooms
    // when one of them has a real entry pointing at the other.
    throw new Error(`[rooms] no connectedTo entry found between room "${knownId}" and room "${neighborId}"`);
  }
  return placeRelativeTo(
    PAIR_DIRECTION[reverse.direction],
    knownOrigin,
    neighborSpec.cols,
    neighborSpec.rows,
    knownSpec.cols,
    knownSpec.rows,
    reverse.gapTiles,
    -(reverse.lateralOffset ?? 0),
  );
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
    // One of the few rooms default-visible on a fresh install — set here
    // directly rather than via a separate server-side backfill, since this
    // room always exists from the initial seed (unlike e.g. Gym, which only
    // exists at all because it was hand-added through the admin tool on the
    // live install — nothing to default there until an admin adds it).
    visible: true,
    // Doorway toward the DDR Room: it connects along this room's u=0 (left)
    // wall, so that's the one that needs the gap — DDR's own facing edge
    // (its u=cols corner) has no wall by default already. Adjust v / widen
    // to more than one tile once you see how it looks.
    wallOverrides: [{ u: 0, v: 5, tile: null }],
    objects: [
      { id: 1, type: STATIC_OBJECT_TYPES.piano.id, x: 48, y: 48, actions: [{ kind: "activity", activityId: ACTIVITIES.practicingPiano.id }] },
      {
        id: 2,
        type: STATIC_OBJECT_TYPES.workLaptop.id,
        enabled: false,
        x: 64,
        y: 40,
        actions: [{ kind: "activity", activityId: ACTIVITIES.working.id }],
      },
      {
        id: 3,
        type: STATIC_OBJECT_TYPES.personalLaptop.id,
        enabled: false,
        x: 80,
        y: 48,
        actions: [
          { kind: "activity", activityId: ACTIVITIES.programming.id },
          { kind: "activity", activityId: ACTIVITIES.administrativeWork.id },
        ],
      },
      {
        id: 4,
        type: STATIC_OBJECT_TYPES.pc.id,
        enabled: false,
        x: 24,
        y: 56,
        actions: [
          { kind: "activity", activityId: ACTIVITIES.gaming.id },
          { kind: "activity", activityId: ACTIVITIES.streaming.id },
        ],
      },
    ],
  },
  {
    id: 2,
    name: "DDR Room",
    cols: 10,
    rows: 6,
    floor: floor1,
    wall: wall1,
    visible: true, // see Jacqueline's Office's own comment above
    connectedTo: [{ roomId: 1, direction: "behindLeft", gapTiles: 1 }],
    objects: [{ id: 5, type: STATIC_OBJECT_TYPES.ddrCabinet.id, x: 8, y: 0, actions: [{ kind: "activity", activityId: ACTIVITIES.ddr.id }] }],
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
        actions: [{ kind: "goTo", roomId: 6 }],
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
        actions: [{ kind: "goTo", roomId: 5 }],
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
        actions: [{ kind: "goTo", roomId: 4 }],
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
        actions: [{ kind: "goTo", roomId: 3 }],
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

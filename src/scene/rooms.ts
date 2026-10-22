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
  | { kind: "activity"; activityId: string }
  | { kind: "navigate"; roomId: string }; // e.g. a staircase — jumps the view to another room, no AW tracking

export interface ObjectDef {
  id: string;
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
 */
const STATIC_OBJECT_TYPES = {
  piano: {
    name: "Piano",
    width: 64,
    height: 64,
    below: [{ texture: "/objects/piano_base.png" }],
    above: [{ texture: "/objects/piano_top.png" }],
    overlay: [{ texture: "/characters/playing_piano.png", offsetX: 32, offsetY: 0 }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.practicingPiano.id }],
  },
  workLaptop: {
    name: "Work Laptop",
    width: 32,
    height: 32,
    below: [{ color: 0x5a5a6a }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.working.id }],
  },
  personalLaptop: {
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
    name: "DDR Cabinet",
    width: 48,
    height: 64,
    below: [{ color: 0x7a2b5a }],
    actions: [{ kind: "activity", activityId: ACTIVITIES.ddr.id }],
  },
  stairs: {
    name: "Stairs",
    width: 32,
    height: 32,
    below: [{ color: 0x8a8a8a }],
    // No default actions — every placement supplies its own destination.
  },
} satisfies Record<string, ObjectTypeDef>;

export { STATIC_OBJECT_TYPES };

export let objectTypes: Record<string, ObjectTypeDef> = STATIC_OBJECT_TYPES;

/** Swaps in server-fetched object types — see this file's top-of-objectTypes comment. */
export function setObjectTypes(types: Record<string, ObjectTypeDef>): void {
  objectTypes = types;
}

export interface ObjectPlacement {
  type: string; // object_types.id — was keyof typeof objectTypes before types became dynamic
  id?: string; // disambiguates multiple instances of the same type in one room; defaults to `type`
  enabled?: boolean;
  x: number;
  y: number;
  actions?: ObjectAction[]; // overrides the type's default actions (e.g. a staircase's per-placement destination)
}

function resolveObjectPlacement(placement: ObjectPlacement): ObjectDef {
  const type = objectTypes[placement.type];
  if (!type) {
    console.error(`[rooms] unknown object type: ${placement.type}`);
    return { id: placement.id ?? placement.type, name: "(unknown)", enabled: false, x: placement.x, y: placement.y, width: 0, height: 0 };
  }
  return {
    id: placement.id ?? placement.type,
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

// Which edge of the anchor this room extends from. Matches the x/y convention
// used elsewhere (x/u runs top->bottom-right, y/v runs top->bottom-left):
//  - behindLeft:  extends from anchor's u=0 (back-left/wall) edge, -u
//  - behindRight: extends from anchor's v=0 (back-right/wall) edge, -v
//  - frontLeft:   extends from anchor's v=rows (open, left-to-front) edge, +v
//  - frontRight:  extends from anchor's u=cols (open, right-to-front) edge, +u
export type ConnectionDirection = "behindLeft" | "behindRight" | "frontLeft" | "frontRight";

export interface RoomSpec {
  id: string;
  name: string;
  cols: number; // room size in tiles along the iso "u" axis
  rows: number; // room size in tiles along the iso "v" axis
  level?: number; // default 0 (ground floor); 1 = upper floor, -1 = basement, etc.
  floor: FloorVariant;
  wall: WallVariant;
  // Per-tile replacements for the default floor/wall at specific (u,v)
  // positions — e.g. a gap in a wall run for a doorway between rooms.
  floorOverrides?: TileOverride[];
  wallOverrides?: TileOverride[];
  objects: ObjectPlacement[];
  // Placement relative to another room's edge, instead of an absolute pixel
  // offset — stays correct if either room's size changes. Exactly one room
  // should omit this (the anchor, placed at the grid origin).
  connectedTo?: {
    roomId: string;
    direction: ConnectionDirection;
    gapTiles: number; // 0 = flush shared edge, 1 = one empty tile row between
  };
}

export interface RoomDef extends Omit<RoomSpec, "objects"> {
  objects: ObjectDef[]; // resolved from RoomSpec's placements
  x: number;
  y: number;
  width: number;
  height: number;
  level: number; // resolved — always a number, never undefined, unlike RoomSpec's
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
  id: string;
  name: string;
  cols: number;
  rows: number;
  level: number;
  floorVariant: string;
  wallVariant: string;
  floorOverrides?: TileOverride[];
  wallOverrides?: TileOverride[];
  connectedTo?: { roomId: string; direction: ConnectionDirection; gapTiles: number };
  objects: ObjectPlacement[];
}

export function roomSpecsFromWire(wire: RoomSpecWire[]): RoomSpec[] {
  return wire.map((w) => ({
    id: w.id,
    name: w.name,
    cols: w.cols,
    rows: w.rows,
    level: w.level,
    floor: FLOOR_VARIANTS[w.floorVariant],
    wall: WALL_VARIANTS[w.wallVariant],
    floorOverrides: w.floorOverrides,
    wallOverrides: w.wallOverrides,
    connectedTo: w.connectedTo,
    objects: w.objects,
  }));
}

export function resolveRooms(specs: RoomSpec[]): RoomDef[] {
  const specById = new Map(specs.map((s) => [s.id, s]));
  const origins = new Map<string, { u: number; v: number }>();

  function originOf(id: string): { u: number; v: number } {
    const cached = origins.get(id);
    if (cached) return cached;

    const spec = specById.get(id)!;
    let origin: { u: number; v: number };
    if (!spec.connectedTo) {
      origin = { u: 0, v: 0 };
    } else {
      const { roomId, direction, gapTiles } = spec.connectedTo;
      const anchor = originOf(roomId);
      const anchorSpec = specById.get(roomId)!;
      switch (direction) {
        // behindLeft/behindRight: this room's own far edge touches the
        // anchor's u=0/v=0 edge, so the shift uses THIS room's own size
        // (to clear its own extent before reaching the anchor's edge).
        case "behindLeft":
          origin = { u: anchor.u - spec.cols - gapTiles, v: anchor.v };
          break;
        case "behindRight":
          origin = { u: anchor.u, v: anchor.v - spec.rows - gapTiles };
          break;
        // frontLeft/frontRight: this room starts right where the anchor's
        // own extent ends, so the shift uses the ANCHOR's size instead.
        case "frontLeft":
          origin = { u: anchor.u, v: anchor.v + anchorSpec.rows + gapTiles };
          break;
        case "frontRight":
          origin = { u: anchor.u + anchorSpec.cols + gapTiles, v: anchor.v };
          break;
      }
    }
    origins.set(id, origin);
    return origin;
  }

  return specs.map((spec) => {
    const { u, v } = originOf(spec.id);
    const { x, y } = gridToScreen(u, v);
    const level = spec.level ?? 0;
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

export const STATIC_ROOM_SPECS: RoomSpec[] = [
  {
    id: "office",
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
      { type: "piano", id: "piano", x: 48, y: 48 },
      { type: "workLaptop", id: "work-laptop", enabled: false, x: 64, y: 40 },
      { type: "personalLaptop", id: "personal-laptop", enabled: false, x: 80, y: 48 },
      { type: "pc", id: "pc", enabled: false, x: 24, y: 56 },
    ],
  },
  {
    id: "ddr-room",
    name: "DDR Room",
    cols: 10,
    rows: 6,
    floor: floor1,
    wall: wall1,
    connectedTo: { roomId: "office", direction: "behindLeft", gapTiles: 1 },
    objects: [{ type: "ddrCabinet", id: "ddr-cabinet", x: 8, y: 0 }],
  },
  {
    id: "living-room",
    name: "Living Room",
    cols: 10,
    rows: 20,
    floor: floor1,
    wall: wall1,
    connectedTo: { roomId: "ddr-room", direction: "frontLeft", gapTiles: 1 },
    // DDR's facing edge is open by default, but this room's own v=0 wall
    // (facing back toward DDR) still gets its default wall — needs a gap too.
    wallOverrides: [{ u: 5, v: 0, tile: null }],
    objects: [
      {
        type: "stairs",
        id: "stairs-down",
        x: 32,
        y: 48,
        actions: [{ kind: "navigate", roomId: "basement" }],
      },
    ],
  },
  {
    id: "entrance",
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
    connectedTo: { roomId: "office", direction: "frontLeft", gapTiles: 1 },
    wallOverrides: [
      { u: 4, v: 0, tile: null }, // door to office
      { u: 0, v: 3, tile: null }, // door to Living Room
    ],
    objects: [
      {
        type: "stairs",
        id: "stairs-up",
        x: 16,
        y: 16,
        actions: [{ kind: "navigate", roomId: "bedroom" }],
      },
    ],
  },
  {
    id: "bedroom",
    name: "Bedroom",
    cols: 10,
    rows: 10,
    level: 1,
    floor: floor1,
    wall: wall1,
    // Same (u,v) footprint as the office, directly below it (no connectedTo
    // needed — level is a pure vertical offset, not a horizontal relationship).
    objects: [
      {
        type: "stairs",
        id: "stairs-down",
        x: -112,
        y: 48,
        actions: [{ kind: "navigate", roomId: "entrance" }],
      },
    ],
  },
  {
    id: "basement",
    name: "Basement",
    cols: 10,
    rows: 10,
    level: -1,
    floor: floor1,
    wall: wall1,
    objects: [
      {
        type: "stairs",
        id: "stairs-up",
        x: -112,
        y: 48,
        actions: [{ kind: "navigate", roomId: "living-room" }],
      },
    ],
  },
];

export let rooms: RoomDef[] = resolveRooms(STATIC_ROOM_SPECS);

/** Swaps in server-fetched rooms — see this file's top-of-objectTypes comment. */
export function setRooms(specs: RoomSpec[]): void {
  rooms = resolveRooms(specs);
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
export function findObjectForActivityLabel(label: string): { roomId: string; objectId: string } | undefined {
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

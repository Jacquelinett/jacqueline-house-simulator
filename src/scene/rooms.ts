// Room/object specs below are declarative data (grid sizes + relationships).
// The only logic in this file is deriving pixel positions from that grid —
// no Pixi/rendering code lives here, see House.ts for that.
//
// Floor/walls are rendered as a real tilemap, each room picking a named
// floor/wall variant from tileset.ts (see House.ts for the renderer) — not
// a per-room background image. Object sprite layers still use individual
// files: public/objects/<object-id>.png, referenced via `texture` in
// `below`/`overlay`/`above`.
import { FloorVariant, WallVariant, floor1, wall1 } from "./tileset";

export interface SpriteLayer {
  texture?: string; // path to art asset; omitted -> rendered as a placeholder color box
  color?: number; // placeholder fill used when texture is omitted
  offsetX?: number;
  offsetY?: number;
}

export type ObjectAction = { kind: "activity"; label: string };

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

// --- Isometric tile math -------------------------------------------------
// Single source of truth: TILE_SIZE is the only magic number. Room pixel
// sizes and room-to-room connection offsets are both derived from it, so
// they stay correct automatically as room grid sizes change (incl. future
// non-square rooms) instead of being hand-tuned pixel constants.
export const TILE_SIZE = 16; // base square tile, px
export const TILE_WIDTH = TILE_SIZE * 2; // 32 — tile's iso-projected screen width
export const TILE_HEIGHT = TILE_SIZE; // 16 — tile's iso-projected screen height (2:1 iso)

export function gridToScreen(u: number, v: number) {
  return { x: (u - v) * (TILE_WIDTH / 2), y: (u + v) * (TILE_HEIGHT / 2) };
}

interface RoomSpec {
  id: string;
  name: string;
  cols: number; // room size in tiles along the iso "u" axis
  rows: number; // room size in tiles along the iso "v" axis
  floor: FloorVariant;
  wall: WallVariant;
  objects: ObjectDef[];
  // Placement relative to another room's back-left edge, instead of an
  // absolute pixel offset — stays correct if either room's size changes.
  // Exactly one room should omit this (the anchor, placed at the grid origin).
  connectedTo?: {
    roomId: string; // this room sits behind-and-left of that room's u=0 edge
    gapTiles: number; // 0 = flush shared edge, 1 = one empty tile row between
  };
}

export interface RoomDef extends RoomSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

function resolveRooms(specs: RoomSpec[]): RoomDef[] {
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
      const anchor = originOf(spec.connectedTo.roomId);
      // This room's own u=cols edge touches the anchor's u=0 edge (one row
      // of tiles sits between them when gapTiles=1), with v left aligned so
      // the two rooms share the same depth band along that edge.
      origin = {
        u: anchor.u - spec.cols - spec.connectedTo.gapTiles,
        v: anchor.v,
      };
    }
    origins.set(id, origin);
    return origin;
  }

  return specs.map((spec) => {
    const { u, v } = originOf(spec.id);
    const { x, y } = gridToScreen(u, v);
    return {
      ...spec,
      x,
      y,
      width: (spec.cols + spec.rows) * (TILE_WIDTH / 2),
      height: (spec.cols + spec.rows) * (TILE_HEIGHT / 2),
    };
  });
}

const roomSpecs: RoomSpec[] = [
  {
    id: "office",
    name: "Jacqueline's Office",
    cols: 10,
    rows: 10,
    floor: floor1,
    wall: wall1,
    objects: [
      {
        id: "piano",
        name: "Piano",
        x: 48,
        y: 48,
        width: 64,
        height: 64,
        below: [{ texture: "/objects/piano_base.png" }],
        above: [{ texture: "/objects/piano_top.png" }],
        actions: [{ kind: "activity", label: "Practicing Piano" }],
        overlay: [
          { texture: "/characters/playing_piano.png", offsetX: 32, offsetY: 0 },
        ],
      },
      {
        id: "work-laptop",
        name: "Work Laptop",
        enabled: false,
        x: 64,
        y: 40,
        width: 32,
        height: 32,
        below: [{ color: 0x5a5a6a }],
        actions: [{ kind: "activity", label: "Working" }],
      },
      {
        id: "personal-laptop",
        name: "Personal Laptop",
        enabled: false,
        x: 80,
        y: 48,
        width: 32,
        height: 32,
        below: [{ color: 0x4a6a5a }],
        actions: [
          { kind: "activity", label: "Programming" },
          { kind: "activity", label: "Administrative Work" },
        ],
      },
      {
        id: "pc",
        name: "PC",
        enabled: false,
        x: 24,
        y: 56,
        width: 48,
        height: 32,
        below: [{ color: 0x4a4a4a }],
        actions: [
          { kind: "activity", label: "Gaming" },
          { kind: "activity", label: "Streaming" },
        ],
      },
    ],
  },
  {
    id: "ddr-room",
    name: "DDR Room",
    cols: 10,
    rows: 10,
    floor: floor1,
    wall: wall1,
    connectedTo: { roomId: "office", gapTiles: 1 },
    objects: [
      {
        id: "ddr-cabinet",
        name: "DDR Cabinet",
        enabled: false,
        x: 8,
        y: 0,
        width: 48,
        height: 64,
        below: [{ color: 0x7a2b5a }],
        actions: [{ kind: "activity", label: "DDR" }],
      },
    ],
  },
];

export const rooms: RoomDef[] = resolveRooms(roomSpecs);

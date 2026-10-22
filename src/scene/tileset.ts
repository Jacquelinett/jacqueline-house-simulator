// Tile variants: each is a named, reusable group of tile rects within some
// sheet. A room picks one floor variant + one wall variant (see rooms.ts).
// Adding a new style later (floor2/wall2) is just a new object in the same
// shape below — doesn't have to live in the same sheet as these.
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorVariant {
  texture: string;
  mid: TileRect; // general, sandwiched on all sides
  edgeBottomRight: TileRect; // used at the room's max-x (u) edge
  edgeTopLeft: TileRect; // used at the room's x=0 (u=0) edge
}

export interface WallVariant {
  texture: string;
  edgeLeft: TileRect; // far-end cap of the left wall run
  left: TileRect; // repeats along the u=0 edge
  right: TileRect; // repeats along the v=0 edge
  edgeRight: TileRect; // far-end cap of the right wall run
  corner: TileRect; // shared joint at u=0,v=0
}

// A tile rect plus which sheet it lives in — self-contained, so an override
// can reference a tile from a different variant/sheet than the room's default.
export interface PlacedTile extends TileRect {
  texture: string;
}

// Per-tile override for floor/wall placement, keyed by exact (u,v). REPLACES
// the default tile at that position rather than rendering on top of it —
// `tile: null` means render nothing there at all (e.g. a doorway gap).
export interface TileOverride {
  u: number;
  v: number;
  tile: PlacedTile | null;
}

const SHEET = "/tileset.png";

// Floor tiles are a 32x32 canvas rendered as a 32x16 iso diamond footprint
// (TILE_WIDTH/HEIGHT in rooms.ts) — the extra canvas height is the tile's
// visible "thickness" below the diamond, not part of the grid spacing.
export const floor1: FloorVariant = {
  texture: SHEET,
  mid: { x: 0, y: 0, w: 32, h: 32 },
  edgeBottomRight: { x: 32, y: 0, w: 32, h: 32 },
  edgeTopLeft: { x: 64, y: 0, w: 32, h: 32 },
};

export const wall1: WallVariant = {
  texture: SHEET,
  edgeLeft: { x: 96, y: 0, w: 32, h: 64 },
  left: { x: 128, y: 0, w: 32, h: 64 },
  right: { x: 160, y: 0, w: 32, h: 64 },
  edgeRight: { x: 192, y: 0, w: 32, h: 64 },
  corner: { x: 224, y: 0, w: 32, h: 64 },
};

// Named registries so a room spec can reference a variant by string name
// (what the server stores/sends, and what an admin-tool dropdown would
// pick from) instead of the full tile-rect object — resolved back to the
// real object client-side before calling resolveRooms(). Only one variant
// of each exists today; adding floor2/wall2 later just means a new entry
// here, nothing structural.
export const FLOOR_VARIANTS: Record<string, FloorVariant> = { floor1 };
export const WALL_VARIANTS: Record<string, WallVariant> = { wall1 };

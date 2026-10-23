// Tile variants: a floor/wall "variant" is just a texture file path now —
// every floor sheet (public/floors/*.png) shares one fixed tile layout,
// and every wall sheet (public/walls/*.png) shares a separate fixed
// layout, so the only thing that actually differs between e.g. floor1 and
// floor2 is which file supplies the pixels (see resolveFloorVariant/
// resolveWallVariant below). A room picks one floor file + one wall file
// (see rooms.ts) — the admin tool's Floor/Wall dropdowns list whatever's
// in those two folders, the same way an object's below/above texture
// picker lists public/objects/ (see admin-main.ts).
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

// Every floor sheet is 3 side-by-side 32x32 tiles (mid, edgeBottomRight,
// edgeTopLeft) — confirmed against floor1.png/floor2.png's own pixel
// dimensions (96x32). Every wall sheet is 5 side-by-side 32x64 tiles
// (edgeLeft, left, right, edgeRight, corner) — confirmed against
// wall1.png (160x64). Each sheet is its own standalone file under
// public/floors/ or public/walls/ (no longer packed alongside anything
// else), so these layouts are always based at x=0 within whichever file
// is actually picked.
const FLOOR_LAYOUT: Omit<FloorVariant, "texture"> = {
  mid: { x: 0, y: 0, w: 32, h: 32 },
  edgeBottomRight: { x: 32, y: 0, w: 32, h: 32 },
  edgeTopLeft: { x: 64, y: 0, w: 32, h: 32 },
};

const WALL_LAYOUT: Omit<WallVariant, "texture"> = {
  edgeLeft: { x: 0, y: 0, w: 32, h: 64 },
  left: { x: 32, y: 0, w: 32, h: 64 },
  right: { x: 64, y: 0, w: 32, h: 64 },
  edgeRight: { x: 96, y: 0, w: 32, h: 64 },
  corner: { x: 128, y: 0, w: 32, h: 64 },
};

/** Combines a texture path (a room's own floorVariant string, e.g. "/floors/floor1.png") with the one shared floor layout into the full shape renderer.ts's buildFloor expects. */
export function resolveFloorVariant(texture: string): FloorVariant {
  return { texture, ...FLOOR_LAYOUT };
}

/** Same idea as resolveFloorVariant, for wallVariant/buildBackWalls+buildBottomWalls. */
export function resolveWallVariant(texture: string): WallVariant {
  return { texture, ...WALL_LAYOUT };
}

// Convenience constants for seed data (STATIC_ROOM_SPECS in rooms.ts) and
// admin-tool previews that want an actual FloorVariant/WallVariant object
// rather than a bare path string — not a registry to look names up in
// anymore (see roomSpecsFromWire, which calls resolveFloorVariant/
// resolveWallVariant directly on whatever path a room's own data has).
export const floor1: FloorVariant = resolveFloorVariant("/floors/floor1.png");
export const floor2: FloorVariant = resolveFloorVariant("/floors/floor2.png");
export const wall1: WallVariant = resolveWallVariant("/walls/wall1.png");

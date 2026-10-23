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

// One wall "part" — a 16px-wide column, itself 3 stacked 16x16 tiles
// rather than one flat rect, since a wall's actual on-screen height is no
// longer baked into the art at a fixed size: `top`/`bottom` are the two
// end caps and `mid` is the piece repeated to reach whatever height a
// room's own wallHeight asks for (see renderer.ts's placeWallStack) — the
// same "reusable" piece is also what repeats WIDTHWISE along a wall run
// (one `mid`-capped-by-`top`-and-`bottom` stack per grid step), unrelated
// to this vertical repetition.
export interface WallPart {
  top: TileRect;
  mid: TileRect;
  bottom: TileRect;
}

export interface WallVariant {
  texture: string;
  edgeLeft: WallPart; // far-end cap of the left wall run
  left: WallPart; // repeats along the u=0 edge
  right: WallPart; // repeats along the v=0 edge
  edgeRight: WallPart; // far-end cap of the right wall run
  // There's no longer a single dedicated corner joint tile — a true
  // corner (both back walls shown) is synthesized from two half-width
  // stacks side by side: `left`'s own reusable part for the left half,
  // this part for the right half. See renderer.ts's placeCorner.
  connection: WallPart;
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
// dimensions (96x32). Floors didn't change with the wall autotile rework
// below.
//
// Every wall sheet is 5 side-by-side 16px-wide "part" columns (edgeLeft,
// left, right, edgeRight, connection — in that order, x = 0/16/32/48/64),
// each itself 3 stacked 16x16 tiles top-to-bottom (top end / reusable mid
// / bottom end) — confirmed against wall1.png's own pixel dimensions
// (80x48 = 5*16 wide, 3*16 tall). This replaced an older layout of 5
// side-by-side flat 32x64 tiles (edgeLeft/left/right/edgeRight/corner,
// one fixed-height rect each, confirmed then against a 160x64 sheet) —
// a room's wall height used to be whatever that art was drawn at; now
// it's `wallHeight` 16px pieces stacked at render time (see renderer.ts's
// placeWallStack/buildBackWalls), which is also why there's no `corner`
// part anymore (see WallVariant's own comment).
const FLOOR_LAYOUT: Omit<FloorVariant, "texture"> = {
  mid: { x: 0, y: 0, w: 32, h: 32 },
  edgeBottomRight: { x: 32, y: 0, w: 32, h: 32 },
  edgeTopLeft: { x: 64, y: 0, w: 32, h: 32 },
};

/** Pixel size of one wall autotile piece (both its width as a "part" column and the height of each of its 3 stacked top/mid/bottom tiles) — see WallPart's own comment. Exported for renderer.ts's stacking math. */
export const WALL_PART_SIZE = 16;

function wallPart(columnIndex: number): WallPart {
  const x = columnIndex * WALL_PART_SIZE;
  return {
    top: { x, y: 0, w: WALL_PART_SIZE, h: WALL_PART_SIZE },
    mid: { x, y: WALL_PART_SIZE, w: WALL_PART_SIZE, h: WALL_PART_SIZE },
    bottom: { x, y: WALL_PART_SIZE * 2, w: WALL_PART_SIZE, h: WALL_PART_SIZE },
  };
}

const WALL_LAYOUT: Omit<WallVariant, "texture"> = {
  edgeLeft: wallPart(0),
  left: wallPart(1),
  right: wallPart(2),
  edgeRight: wallPart(3),
  connection: wallPart(4),
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

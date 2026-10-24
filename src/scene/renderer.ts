import { AlphaFilter, Application, Assets, BlurFilter, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { DEFAULT_WALL_HEIGHT, gridToScreen, rooms as roomDefs, screenToGrid, ObjectDef, PaletteDef, RoomDef, SpriteLayer, TILE_HEIGHT, TILE_WIDTH } from "./rooms";
import { findActivityById } from "./activities";
import { characterSpritePath, DEFAULT_SPRITE_CHARACTER } from "./characterSprites";
import { resolveWallVariant, TileOverride, TileRect, WallPart, WallPartName, WallVariant, WALL_PART_SIZE } from "./tileset";
import { buildPaletteTexture } from "./paletteRecolor";

// Exported for AdminPreviewRenderer (adminPreview.ts), which reuses this
// same dim level for its own whole-room dimming instead of a separately
// hand-picked value.
export const DIM_ALPHA = 0.4;
// How transparent a room's front (bottom) walls go once that room is the
// one actually being viewed — lower than DIM_ALPHA, not just equal to
// it, since they paint above objects/overlays there (see buildRoom), and
// without the extra fade the wall would block your own view of the room
// you're looking at. Kept barely visible rather than fully invisible so
// the wall doesn't just disappear outright.
const FRONT_WALL_FOCUSED_ALPHA = 0.08;
const PAN_EASE = 0.15;
// How far (screen pixels, negative = up) the currently-viewed room lifts
// above its normal resting position — purely a visual "this one's
// focused" cue, eased in/out the same way the camera itself pans (see
// ROOM_FOCUS_EASE/tick), not an instant snap.
const ROOM_RAISE_PX = -15;
const ROOM_FOCUS_EASE = 0.2;
// A soft blurred glow sitting behind the viewed room's own floor
// silhouette (see buildRoom) — not a crisp outline, a filled-then-blurred
// copy of the same shape, so it reads as the whole room giving off a
// little ambient light rather than being traced by a line. The other
// half of the "this one's focused" cue, alongside the raise above.
const GLOW_COLOR = 0xff6b9d; // pink, matching --accent-solid's dark-theme value rather than an unrelated amber
const GLOW_ALPHA = 0.55;
const GLOW_BLUR_STRENGTH = 16;
// Exported for the admin tool's object-type preview (admin-main.ts),
// which simulates the overlay layer too now (defaulting to Jacqueline's
// own art) and needs the same default-duration fallback.
export const DEFAULT_OVERLAY_FRAME_DURATION_MS = 150;

// --- Day/night ambient tint ---
//
// A full-viewport multiply-blended color wash, driven purely by the
// player's own local wall-clock time (`hour`, 0-24, fractional) — no
// admin configuration yet, these are the one place the look lives for
// now (same "module-level constant, not yet exposed" spirit GLOW_COLOR/
// GLOW_ALPHA already have). Multiply blending darkens/tints everything
// under it without fully obscuring — alpha 0 at midday means "no tint at
// all," not "transparent dark navy." Stops must span the full 0-24 range
// (first and last hour implicitly wrap to the same look, since a day
// has no real start/end) and be in ascending hour order.
interface AmbientStop {
  hour: number;
  color: number;
  alpha: number;
}
const AMBIENT_STOPS: AmbientStop[] = [
  { hour: 0, color: 0x1a1a40, alpha: 0.45 }, // midnight: deep navy
  { hour: 5, color: 0x1a1a40, alpha: 0.45 }, // still night
  { hour: 7, color: 0xff9966, alpha: 0.18 }, // dawn: warm orange, fading in
  { hour: 9, color: 0xffffff, alpha: 0 }, // full daylight: no tint
  { hour: 17, color: 0xffffff, alpha: 0 }, // still full daylight
  { hour: 19, color: 0xff9966, alpha: 0.18 }, // dusk: warm orange
  { hour: 21, color: 0x1a1a40, alpha: 0.45 }, // night falls
  { hour: 24, color: 0x1a1a40, alpha: 0.45 }, // wraps back to hour 0's own look
];
// The eye can't tell a color wash is stale for a few seconds — recomputed
// this often rather than every frame, same "doesn't need per-frame
// precision" reasoning as everywhere else timing is approximate in this
// renderer.
const AMBIENT_RECOMPUTE_INTERVAL_MS = 30_000;

function lerpColorChannelwise(a: number, b: number, t: number): number {
  const channel = (n: number, shift: number) => (n >> shift) & 0xff;
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = lerp(channel(a, 16), channel(b, 16));
  const g = lerp(channel(a, 8), channel(b, 8));
  const bch = lerp(channel(a, 0), channel(b, 0));
  return (r << 16) | (g << 8) | bch;
}

function computeAmbientTint(now: Date): { color: number; alpha: number } {
  const hour = now.getHours() + now.getMinutes() / 60;
  for (let i = 0; i < AMBIENT_STOPS.length - 1; i++) {
    const a = AMBIENT_STOPS[i];
    const b = AMBIENT_STOPS[i + 1];
    if (hour >= a.hour && hour <= b.hour) {
      const t = (hour - a.hour) / (b.hour - a.hour);
      return { color: lerpColorChannelwise(a.color, b.color, t), alpha: a.alpha + (b.alpha - a.alpha) * t };
    }
  }
  return { color: AMBIENT_STOPS[0].color, alpha: AMBIENT_STOPS[0].alpha }; // unreachable given stops span the full 0-24 range
}
const NAME_TAG_PADDING_X = 5;
const NAME_TAG_PADDING_Y = 2;
const NAME_TAG_GAP = 3; // above the overlay sprite's own top edge

/** Who (if anyone) is driving an overlay's visibility right now — the richer replacement for updateActiveOverlays' old bare `Set<string>` of running labels, carrying enough identity to resolve a sprite-keyed layer's per-character texture AND label it with a name tag (see ActiveOverlay/characterSprites.ts). */
export interface OverlayAttribution {
  characterId: string;
  characterName: string;
  characterSpriteName: string | null;
}

/**
 * One overlay sprite's full runtime state — `layer` is kept alongside the
 * Pixi node so updateActiveOverlays/resolveOverlayTexture can read its
 * spriteKey/frame settings without threading them through separately.
 * `attemptedPaths` remembers which per-character paths already 404'd
 * this session, so a character with no art for this key doesn't get
 * re-requested on every single status update. `frames`/`frameIndex`/
 * `frameElapsedMs` are only populated once a resolved texture actually
 * turns out to be a spritesheet (frameCount > 1) — tick() below only
 * ever advances overlays that have them.
 */
interface ActiveOverlay {
  labels: string[];
  sprite: Sprite;
  layer: SpriteLayer;
  resolvedPath: string | null;
  attemptedPaths: Set<string>;
  frames: Texture[] | null;
  frameIndex: number;
  frameElapsedMs: number;
  // Name tag floating above the SPRITE's own position (layer.offsetX/
  // offsetY + its actual rendered width/height) — not the object's whole
  // bounding box, since the sprite can sit anywhere within it (e.g. the
  // piano's overlay is offset well into the object). nameTagText caches
  // what it currently shows so repeated updateActiveOverlays calls with
  // an unchanged attribution don't rebuild the Text/Graphics every time.
  nameTag: Container;
  nameTagText: string | null;
}

/**
 * One object's full light runtime state — tracked per-object (not per
 * light, since all of an object's lights toggle together, see LightDef's
 * own comment). Purely a set of glow Graphics, one per LightDef — a
 * light is nothing but a point that radiates a glow, no sprite/texture
 * involvement at all (that's PaletteDef's job, tracked completely
 * separately below).
 */
interface ActiveLight {
  glows: Graphics[];
  on: boolean;
}

/**
 * One object's full palette runtime state — tracked per-object, covering
 * every PaletteDef on its type at once (they combine into a single
 * recolored texture, see buildPaletteTexture's own comment). `defs`/
 * `frameIndices`/`frameElapsedMs` are parallel arrays, one entry per
 * PaletteDef on this object; a def with no cycleIntervalMs (or only one
 * color) simply never advances past index 0 — "just a regular palette
 * swap." `url` is cached (see paletteRecolor.ts) so re-deriving a frame
 * on every color change doesn't re-fetch/re-decode the source image.
 */
interface ActivePalette {
  sprite: Sprite;
  url: string;
  defs: PaletteDef[];
  frameIndices: number[];
  frameElapsedMs: number[];
}

/** Slices one spritesheet texture into `frameCount` equal-width frames laid out left-to-right starting at (0,0) — same sub-rect-of-one-sheet technique tileset.ts's floor/wall variants use, just a uniform grid instead of hand-placed rects (animation frames are naturally uniform-sized, unlike tileset corners/edges). Frame width/height are derived from the sheet's own natural size (width / frameCount, full height) rather than authored — a spritesheet's frames are always its own height, and equal-width slices of its own width. Exported for the admin tool's object-type preview, which reuses this exact slicing to simulate overlay animation. */
export function sliceFrames(base: Texture, frameCount: number): Texture[] {
  const frameWidth = base.width / frameCount;
  const frameHeight = base.height;
  const frames: Texture[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(new Texture({ source: base.source, frame: new Rectangle(i * frameWidth, 0, frameWidth, frameHeight) }));
  }
  return frames;
}

// Mirrors shared-chrome.css's own mobile breakpoint exactly — below it,
// manual room/object panning is suppressed (see House.ts/viewer.ts): mobile
// has no floor buttons and is meant to just auto-follow whatever's
// currently running, not be manually navigated around.
const MOBILE_BREAKPOINT_QUERY = "(max-width: 700px) and (orientation: portrait)";

// rooms.ts's texture paths (e.g. "/objects/piano_base.png") are written as if
// served from the domain root — true for the Tauri app, but the public
// viewer build can be served from a subpath (e.g. GitHub Pages project
// sites: "/<repo>/"). BASE_URL is "/" for the Tauri app (no-op here) and the
// configured subpath for the viewer build (see vite.viewer.config.ts),
// so resolving every texture path through this keeps both working.
/** Exported for the admin tool's object-type texture picker (admin-main.ts), which needs to Assets.load() an arbitrary asset path on demand — one not necessarily referenced by any currently-placed object, so preloadRoomAssets() alone wouldn't have loaded it. */
export function assetUrl(path: string): string {
  return import.meta.env.BASE_URL + path.replace(/^\//, "");
}

/** Preloads every texture referenced by `rooms.ts` so sprites can be built synchronously. */
export async function preloadRoomAssets(): Promise<void> {
  const paths = new Set<string>();
  for (const room of roomDefs) {
    paths.add(room.floor.texture);
    paths.add(room.wall.texture);
    for (const o of [...(room.floorOverrides ?? []), ...(room.wallOverrides ?? [])]) {
      if (o.tile) paths.add(o.tile.texture);
      if (o.wallVariant) paths.add(o.wallVariant);
    }
    for (const obj of room.objects) {
      const layers = [...(obj.below ?? []), ...(obj.sprite ?? []), ...(obj.above ?? [])];
      for (const layer of layers) {
        if (layer.texture) paths.add(layer.texture);
      }
    }
  }

  const loaded = await Assets.load<Texture>([...paths].map(assetUrl));
  for (const texture of Object.values(loaded)) {
    texture.source.scaleMode = "nearest"; // keep pixel art crisp, not blurred on scale
  }
}

/**
 * Exported for the admin tool's placement-ghost preview (adminPreview.ts),
 * which builds a lightweight stand-in sprite from the same SpriteLayer
 * data instead of duplicating this logic. Always positioned at (0,0) — a
 * below/above layer has no width/height of its own, it's forced to the
 * object's own width/height right below, so there's nothing for an
 * offset to meaningfully mean (unlike overlay, which renders at its
 * resolved texture's native size and genuinely needs one — see
 * buildObject's own overlay construction).
 */
export function buildLayer(layer: SpriteLayer, width: number, height: number): Container {
  const node: Container = layer.texture
    ? new Sprite(Assets.get<Texture>(assetUrl(layer.texture)))
    : new Graphics().rect(0, 0, width, height).fill(layer.color ?? 0xffffff);
  if (layer.texture) {
    (node as Sprite).width = width;
    (node as Sprite).height = height;
  }
  return node;
}

/** Frames a sub-region of a tileset texture — no per-tile files needed. */
function tileTexture(texturePath: string, rect: TileRect): Texture {
  const sheet = Assets.get<Texture>(assetUrl(texturePath));
  return new Texture({ source: sheet.source, frame: new Rectangle(rect.x, rect.y, rect.w, rect.h) });
}

function placeTile(
  container: Container,
  texturePath: string,
  rect: TileRect,
  u: number,
  v: number,
  groundOffset: number,
) {
  const sprite = new Sprite(tileTexture(texturePath, rect));
  const { x, y } = gridToScreen(u, v);
  sprite.position.set(x - TILE_WIDTH / 2, y - groundOffset);
  container.addChild(sprite);
}

/**
 * Like placeTile, but checks `overrides` for this exact (u,v) first — an
 * override REPLACES the default tile (a matching `tile: null` entry means
 * render nothing at all here, e.g. a doorway gap in a wall run) rather than
 * rendering on top of it. `renderDefault` (default true) is checked only
 * when there's no override — it's how a whole wall side can be turned off
 * (showLeftWall/showRightWall) while a wallOverrides entry on that same
 * side still renders regardless, exactly the "exception" it's always been.
 */
function placeTileWithOverrides(
  container: Container,
  overrides: TileOverride[] | undefined,
  defaultTexture: string,
  defaultRect: TileRect,
  u: number,
  v: number,
  groundOffset: number,
  renderDefault = true,
) {
  const override = overrides?.find((o) => o.u === u && o.v === v);
  if (override) {
    if (override.tile) placeTile(container, override.tile.texture, override.tile, u, v, groundOffset);
    return; // override.tile === null -> gap, render nothing
  }
  if (!renderDefault) return;
  placeTile(container, defaultTexture, defaultRect, u, v, groundOffset);
}

/** How tall a room's walls actually render, in pixels — `wallHeight` 16px autotile pieces stacked (see tileset.ts's WallPart/WALL_PART_SIZE), falling back to DEFAULT_WALL_HEIGHT when unset (e.g. a hand-built RoomSpec that never set it). Exported for wallSegments below (and AdminPreviewRenderer, which needs the same number to build matching hit-rects). */
export function totalWallHeight(room: RoomDef): number {
  return (room.wallHeight ?? DEFAULT_WALL_HEIGHT) * WALL_PART_SIZE;
}

/** Which of the four wall runs a segment belongs to — matches buildBackWalls'/buildBottomWalls' own "left"/"right" naming (named for which WallVariant part family it reuses, not screen-left/right — see those functions' own comments). */
export type WallSide = "backLeft" | "backRight" | "frontLeft" | "frontRight";

/** One clickable wall position — same thing buildBackWalls/buildBottomWalls place a sprite stack at, just as plain position/size data instead of a built Sprite. `x`/`y`/`width`/`height` are in the room's own local coordinate space (same space gridToScreen returns, no room offset baked in) — the same space any child added to that room's own container (see SceneRenderer.roomContainers) already renders in. */
export interface WallSegmentInfo {
  side: WallSide;
  u: number;
  v: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Every wall segment a room's back/front walls actually render right now
 * — the exact same (u,v)/xOffset/yOffset combinations buildBackWalls/
 * buildBottomWalls use to place a sprite stack, returned as hit-rect data
 * instead of built sprites. This is what the admin tool's wall-edit mode
 * (AdminPreviewRenderer.enableWallEditMode) builds its hover/click targets
 * from, rather than re-deriving the same position math a second time —
 * this exact math has already produced three separate live bugs earlier
 * in this file's history (the corner/connection-slot overlap, both end
 * caps sagging below their run), so a second independent copy of it is
 * exactly the kind of thing that drifts out of sync silently.
 *
 * Deliberately only includes segments for a side that's actually shown
 * (showLeftWall/showRightWall default true, showBottomLeftWall/
 * showBottomRightWall default false, same flags buildBackWalls/
 * buildBottomWalls gate on) — a hidden side has nothing rendered to point
 * at yet, so there's nothing for wall-edit mode to highlight there; turn
 * the side on first, then use wall-edit mode once it's visible. Within a
 * shown side, every position is included regardless of whether a
 * wallOverrides gap already hides it there — the gap IS the current
 * state of that one position, and should stay clickable to change or
 * remove it.
 */
export function wallSegments(room: RoomDef): WallSegmentInfo[] {
  const wallHeightUnits = room.wallHeight ?? DEFAULT_WALL_HEIGHT;
  const groundOffset = totalWallHeight(room) - room.floor.mid.h;
  const capRise = TILE_HEIGHT / 2;
  const showLeft = room.showLeftWall !== false;
  const showRight = room.showRightWall !== false;
  const showBottomLeft = room.showBottomLeftWall === true;
  const showBottomRight = room.showBottomRightWall === true;
  const rightWallShift = showLeft && showRight ? WALL_PART_SIZE : 0;
  const height = wallHeightUnits * WALL_PART_SIZE;

  const segments: WallSegmentInfo[] = [];
  const add = (side: WallSide, u: number, v: number, xOffset: number, yOffset: number) => {
    const { x, y } = gridToScreen(u, v);
    segments.push({ side, u, v, x: x - TILE_WIDTH / 2 + xOffset, y: y - groundOffset + yOffset, width: WALL_PART_SIZE, height });
  };

  // Back corner — one segment per side actually shown there (placeCorner
  // draws a single un-shifted stack when only one side is shown, which is
  // exactly what rightWallShift already reduces to as 0 in that case).
  if (showLeft) add("backLeft", 0, 0, 0, 0);
  if (showRight) add("backRight", 0, 0, rightWallShift, 0);

  if (showLeft) {
    for (let v = 1; v < room.rows; v++) add("backLeft", 0, v, 0, 0);
    add("backLeft", 0, room.rows, 0, -capRise);
  }
  if (showRight) {
    for (let u = 1; u < room.cols; u++) add("backRight", u, 0, rightWallShift, 0);
    add("backRight", room.cols, 0, rightWallShift, -capRise);
  }
  if (showBottomRight) {
    add("frontRight", room.cols, 0, 0, 0);
    for (let v = 1; v < room.rows; v++) add("frontRight", room.cols, v, 0, 0);
    add("frontRight", room.cols, room.rows, 0, -capRise);
  }
  if (showBottomLeft) {
    add("frontLeft", 0, room.rows, 0, 0);
    for (let u = 1; u < room.cols; u++) add("frontLeft", u, room.rows, 0, 0);
    add("frontLeft", room.cols, room.rows, 0, -capRise);
  }

  return segments;
}

/**
 * Places one vertical wall "stack" at grid position (u,v) — `part.top` for
 * the topmost piece, `part.bottom` for the bottommost, `part.mid` repeated
 * for every piece in between (a stack of exactly 1 piece uses `part.top`
 * alone; exactly 2 uses `part.top` + `part.bottom`, no mid). This is the
 * same reusable-middle-piece trick used widthwise along a wall run (one
 * stack per grid step) applied heightwise instead — see WallPart's own
 * comment. `xOffset`/`yOffset` (default 0) shift the whole stack by that
 * many pixels without touching its (u,v) grid position (and therefore its
 * override lookup, see placeWallWithOverrides) at all. `xOffset` is used
 * by placeCorner, to lay a second half-width stack immediately to the
 * right of the first, and by buildBackWalls' right-wall run, to make room
 * for that same extra half-width (see its own comment). `yOffset` is used
 * by buildBackWalls' end caps, to anchor a cap to its last regular panel's
 * own height instead of continuing the per-step stagger one step further.
 */
function placeWallStack(
  container: Container,
  texturePath: string,
  part: WallPart,
  u: number,
  v: number,
  groundOffset: number,
  wallHeightUnits: number,
  xOffset = 0,
  yOffset = 0,
) {
  const { x, y } = gridToScreen(u, v);
  const baseX = x - TILE_WIDTH / 2 + xOffset;
  const baseY = y - groundOffset + yOffset;
  for (let i = 0; i < wallHeightUnits; i++) {
    const rect = i === 0 ? part.top : i === wallHeightUnits - 1 ? part.bottom : part.mid;
    const sprite = new Sprite(tileTexture(texturePath, rect));
    sprite.position.set(baseX, baseY + i * rect.h);
    container.addChild(sprite);
  }
}

/**
 * Like placeTileWithOverrides, but for a wall stack rather than a single
 * tile: checks `overrides` for this exact (u,v) first. Three outcomes, in
 * priority order — see TileOverride's own comment for the full reasoning:
 *  1. `override.wallVariant` set — still a real autotile stack, same
 *     structural `partName` this position already uses, just reading that
 *     part's pixels from a DIFFERENT wall sheet (resolveWallVariant) than
 *     the room's own `wall`.
 *  2. `override.tile` set (and no wallVariant) — one flat custom texture/
 *     rect, bypassing the stack entirely.
 *  3. `override.tile === null` — a gap, render nothing.
 * Falls through to the room's own default stack only when there's no
 * override at all and `renderDefault` is true, same gating
 * placeTileWithOverrides already uses for showLeftWall/showRightWall etc.
 * `xOffset`/`yOffset` just forward to placeWallStack — the override
 * lookup itself always stays keyed by the logical (u,v), never the
 * shifted pixel position.
 */
function placeWallWithOverrides(
  container: Container,
  overrides: TileOverride[] | undefined,
  wall: WallVariant,
  partName: WallPartName,
  u: number,
  v: number,
  groundOffset: number,
  wallHeightUnits: number,
  renderDefault = true,
  xOffset = 0,
  yOffset = 0,
) {
  const override = overrides?.find((o) => o.u === u && o.v === v);
  if (override?.wallVariant) {
    const altWall = resolveWallVariant(override.wallVariant);
    placeWallStack(container, altWall.texture, altWall[partName], u, v, groundOffset, wallHeightUnits, xOffset, yOffset);
    return;
  }
  if (override) {
    if (override.tile) placeTile(container, override.tile.texture, override.tile, u, v, groundOffset);
    return;
  }
  if (!renderDefault) return;
  placeWallStack(container, wall.texture, wall[partName], u, v, groundOffset, wallHeightUnits, xOffset, yOffset);
}

/**
 * The back-vertex (0,0) joint where the left and right back walls meet —
 * its own function since it's the one position that can draw TWO
 * half-width stacks side by side rather than zero or one (see
 * WallVariant's own comment on why there's no single dedicated corner
 * tile anymore). An override here still replaces the whole joint first —
 * a wallVariant override redraws the SAME one-or-two-stack shape the
 * default path would (still respecting showLeft/showRight), just from a
 * different sheet; a tile/null override still bypasses that shape
 * entirely for one flat replacement or a gap, checked once up front so
 * neither override case needs to re-check it per half. When only one
 * side is shown, that side's own reusable part just continues straight
 * through the joint — same "no dedicated joint piece unless both sides
 * are real" behavior the old single-corner-tile version had.
 */
function placeCorner(
  container: Container,
  overrides: TileOverride[] | undefined,
  wall: WallVariant,
  u: number,
  v: number,
  groundOffset: number,
  wallHeightUnits: number,
  showLeft: boolean,
  showRight: boolean,
) {
  const override = overrides?.find((o) => o.u === u && o.v === v);
  const effectiveWall = override?.wallVariant ? resolveWallVariant(override.wallVariant) : null;
  if (override && !effectiveWall) {
    if (override.tile) placeTile(container, override.tile.texture, override.tile, u, v, groundOffset);
    return;
  }
  const w = effectiveWall ?? wall;
  if (!showLeft && !showRight) return;
  if (showLeft && showRight) {
    placeWallStack(container, w.texture, w.left, u, v, groundOffset, wallHeightUnits);
    placeWallStack(container, w.texture, w.connection, u, v, groundOffset, wallHeightUnits, WALL_PART_SIZE);
    return;
  }
  placeWallStack(container, w.texture, showLeft ? w.left : w.right, u, v, groundOffset, wallHeightUnits);
}

/**
 * Builds just the back two walls (u=0/v=0 edges) for a room, tiled per
 * its chosen wall variant. Split out from the floor (see buildFloor
 * below) specifically so SceneRenderer's buildRoom can give walls their
 * own AlphaFilter, independent of the floor/objects — a same-floor room
 * you're not currently viewing dims only its walls, not everything in it
 * (see applyFocus's own comment on why). Paints BEHIND the floor (see
 * buildRoom) — these sit at the room's back/top, so they never visually
 * overlap it the way the front walls below do.
 */
export function buildBackWalls(room: RoomDef): Container {
  const container = new Container();
  // Purely decorative — only the room itself (attachRoomInteraction) and
  // its objects (attachObjectInteraction) are ever meant to be clickable.
  // Pixi's own default eventMode ("passive") already shouldn't block a
  // click from reaching a sibling underneath, but this makes that a
  // guarantee rather than an assumption riding on an unset default —
  // confirmed live as the fix for a reported case of the bottom-right
  // wall (painted in FRONT of objects, see buildBottomWalls below)
  // appearing to steal clicks meant for an object sitting close to that
  // edge, regardless of what Pixi version/render-order changes later.
  container.eventMode = "none";
  const { floor, wall } = room;

  // Walls sit on the same ground level as the floor, just drawn taller: their
  // canvas extends further UP from that shared level, not further down. So a
  // wall's top is offset by only its *extra* height beyond the floor's own
  // canvas (wall height - floor.h) — not its full height — otherwise it
  // renders one floor-tile-height too high, floating above the floor with a
  // gap.
  const wallHeightUnits = room.wallHeight ?? DEFAULT_WALL_HEIGHT;
  const groundOffset = totalWallHeight(room) - floor.mid.h;

  // Corner joint at the back vertex, then a run of repeating panels along
  // each back edge, capped with an edge tile at the far end — the cap
  // takes the very next grid step right after the last regular panel
  // (room.rows/room.cols, never touched by the loops below), same
  // groundOffset as everything else EXCEPT for capRise below.
  // showLeftWall/showRightWall (default true when unset) gate the DEFAULT
  // tile only — a wallOverrides entry on a hidden side still renders (see
  // placeWallWithOverrides's own comment). If only one side renders, that
  // side's own panel tile extends through the joint instead of the
  // two-stack corner (see placeCorner), so a single wall reads as one
  // continuous run rather than stopping at a joint with nothing on the
  // other side to join.
  const wo = room.wallOverrides;
  const showLeft = room.showLeftWall !== false;
  const showRight = room.showRightWall !== false;
  placeCorner(container, wo, wall, 0, 0, groundOffset, wallHeightUnits, showLeft, showRight);

  // An end cap sits at the very next grid step past the last regular
  // panel — but that step's OWN natural per-step stagger would drop it
  // TILE_HEIGHT/2 further down than the last panel, continuing the run's
  // diagonal recession one step past where the wall actually ends. A cap
  // isn't a continuation of that recession, it's the flat end of the
  // run, so it's pulled back up by that same half-step to land flush
  // with the last panel's own height instead (confirmed live: without
  // this, the cap visibly sagged below the run and undershot its own top).
  const capRise = TILE_HEIGHT / 2;

  for (let v = 1; v < room.rows; v++) {
    placeWallWithOverrides(container, wo, wall, "left", 0, v, groundOffset, wallHeightUnits, showLeft);
  }
  placeWallWithOverrides(container, wo, wall, "edgeLeft", 0, room.rows, groundOffset, wallHeightUnits, showLeft, 0, -capRise);

  // The right run needs one more correction the left run doesn't: when
  // the corner draws a true two-stack joint (see placeCorner), its
  // `connection` half occupies a second half-width slot immediately
  // after the corner's own (xOffset=WALL_PART_SIZE) — space the old
  // single 32px-wide corner tile never needed, since one tile covered
  // the whole joint. The left side doesn't have this problem: the
  // corner's own left half uses wall.left at xOffset=0, the exact same
  // alignment every regular left panel already uses, so v=1 picks up
  // right where it left off with nothing extra to account for. But
  // without this shift, the right run's regular panels/cap landed at
  // the SAME x as the corner's connection half (confirmed by computing
  // both: u=1's own gridToScreen position and the connection half's
  // xOffset=WALL_PART_SIZE position are numerically identical), directly
  // overlapping it instead of continuing past it — which is what made
  // the whole right run (and therefore its cap) read as one tile short
  // of where it should actually end.
  const rightWallShift = showLeft && showRight ? WALL_PART_SIZE : 0;
  for (let u = 1; u < room.cols; u++) {
    placeWallWithOverrides(container, wo, wall, "right", u, 0, groundOffset, wallHeightUnits, showRight, rightWallShift);
  }
  placeWallWithOverrides(container, wo, wall, "edgeRight", room.cols, 0, groundOffset, wallHeightUnits, showRight, rightWallShift, -capRise);

  return container;
}

/**
 * Builds just the front two walls (u=cols/v=rows edges), opt-in via
 * showBottomLeftWall/showBottomRightWall (both default off — most rooms
 * are meant to be looked INTO from the front, not fully enclosed).
 * Turning one on "finishes the diamond" with a wall reusing the PARALLEL
 * back wall's own tile style: bottom-right (u=cols edge) reuses the LEFT
 * wall's tiles (same u-fixed, v-varying direction, just shifted from u=0
 * to u=cols); bottom-left (v=rows edge) reuses the RIGHT wall's tiles the
 * same way. Paints IN FRONT of the floor (see buildRoom) — unlike the
 * back walls above, these sit between the floor and the camera.
 *
 * The right vertex (cols,0) / left vertex (0,rows) each just extend
 * their own front wall's panel tile one step further — never the back
 * corner's dedicated joint piece, since each is only ever touched by a
 * single front wall, not a true meeting of two edges. At the OTHER end —
 * the room's own front (cols,rows) corner, where a front wall's run
 * actually terminates — each wall gets its own end cap (edgeLeft for the
 * bottom-right wall, edgeRight for the bottom-left wall, same capRise
 * pull-up buildBackWalls' own caps use), finishing the run the same way
 * a back wall's far end does, instead of just stopping on a flat panel.
 * If somehow both front walls are enabled at once, both caps target this
 * same (cols,rows) position — unlike the true back corner, there's no
 * two-stack split for it, so whichever call runs second simply wins;
 * not worth a dedicated joint piece for a combination this app doesn't
 * actually use (most rooms show at most one front wall, see RoomSpec's
 * own comment on why).
 */
export function buildBottomWalls(room: RoomDef): Container {
  const container = new Container();
  // See buildBackWalls' own comment — same explicit non-interactivity
  // guarantee, just more important here specifically: this is the wall
  // that paints IN FRONT of objects (the whole point of this function),
  // so it's the one actually positioned to visually sit between the
  // camera and an object's sprite for an object placed near this edge.
  container.eventMode = "none";
  const { floor, wall } = room;
  const wallHeightUnits = room.wallHeight ?? DEFAULT_WALL_HEIGHT;
  const groundOffset = totalWallHeight(room) - floor.mid.h;
  const capRise = TILE_HEIGHT / 2;

  const wo = room.wallOverrides;
  const showBottomLeft = room.showBottomLeftWall === true;
  const showBottomRight = room.showBottomRightWall === true;

  for (let v = 1; v < room.rows; v++) {
    placeWallWithOverrides(container, wo, wall, "left", room.cols, v, groundOffset, wallHeightUnits, showBottomRight);
  }
  for (let u = 1; u < room.cols; u++) {
    placeWallWithOverrides(container, wo, wall, "right", u, room.rows, groundOffset, wallHeightUnits, showBottomLeft);
  }

  // Right vertex (cols,0) / left vertex (0,rows) — just the first tile of
  // each front wall's own run, not a joint with anything.
  placeWallWithOverrides(container, wo, wall, "left", room.cols, 0, groundOffset, wallHeightUnits, showBottomRight);
  placeWallWithOverrides(container, wo, wall, "right", 0, room.rows, groundOffset, wallHeightUnits, showBottomLeft);

  // Far end of each front wall's own run — see this function's own
  // header comment on why (cols,rows) is safe to use now that a cap is
  // a trimmed, capRise-adjusted piece rather than a full regular panel.
  placeWallWithOverrides(container, wo, wall, "edgeLeft", room.cols, room.rows, groundOffset, wallHeightUnits, showBottomRight, 0, -capRise);
  placeWallWithOverrides(container, wo, wall, "edgeRight", room.cols, room.rows, groundOffset, wallHeightUnits, showBottomLeft, 0, -capRise);

  return container;
}

/**
 * An object's depth for the room-build's own painter's-algorithm sort
 * (see buildRoom's object loop) — the (u,v) grid cell its floor-contact
 * point falls in, summed into one scalar the same way buildFloor's own
 * cells.sort(u+v) already orders floor tiles. `obj.x`/`obj.y` is always
 * the sprite's raw top-left (never grid-snapped, see ObjectDef's own
 * comment), which can include arbitrary padding unrelated to where the
 * object actually "stands" — anchorX/anchorY (defaulting to 0,0 — see
 * ObjectTypeDef's own comment) is the offset from that top-left to the
 * spot that should land on a tile corner, so adding it in before
 * converting back to grid space is what actually gives the object's real
 * footprint position, not just wherever its canvas happens to start.
 */
function objectDepth(obj: ObjectDef): number {
  const { u, v } = screenToGrid(obj.x + (obj.anchorX ?? 0), obj.y + (obj.anchorY ?? 0));
  return u + v;
}

/** Builds just the floor for a room, tiled per its chosen floor variant — see buildBackWalls's own comment on why walls are split out separately. */
export function buildFloor(room: RoomDef): Container {
  const container = new Container();
  // Same "purely decorative, never clickable" guarantee as the walls/
  // glow/dev-outline — see buildBackWalls' own comment for the full
  // reasoning.
  container.eventMode = "none";
  const { floor } = room;

  // Drawn back-to-front (painter's algorithm) so each tile's visible
  // "thickness" is correctly covered by the tile in front of it.
  const fo = room.floorOverrides;
  const cells: { u: number; v: number }[] = [];
  for (let u = 0; u < room.cols; u++) {
    for (let v = 0; v < room.rows; v++) cells.push({ u, v });
  }
  cells.sort((a, b) => a.u + a.v - (b.u + b.v));
  for (const { u, v } of cells) {
    const tile = u === room.cols - 1 ? floor.edgeBottomRight : u === 0 ? floor.edgeTopLeft : floor.mid;
    placeTileWithOverrides(container, fo, floor.texture, tile, u, v, 0);
  }

  return container;
}

/** Combined back-walls+floor+front-walls in one container, in that paint order (see buildRoom's own comment on why front walls paint after the floor) — e.g. for the admin tool's object-type preview (admin-main.ts), which renders a real tiny room corner behind the sprite instead of a bare wireframe grid, and has no independent wall-dimming to care about. */
export function buildFloorAndWalls(room: RoomDef): Container {
  const container = new Container();
  container.addChild(buildBackWalls(room));
  container.addChild(buildFloor(room));
  container.addChild(buildBottomWalls(room));
  return container;
}

/**
 * Depth-sort comparator for SceneRenderer's constructor (which rooms paint
 * first/behind vs. last/in-front) — negative means `a` paints first.
 *
 * Real rooms never overlap in (u,v) grid space (that would mean two rooms
 * occupying the same floor tiles), so wherever two rooms' SCREEN
 * footprints do visually overlap, one of their two grid axes — v or u —
 * always cleanly separates them: either one room's v-range ends before
 * the other's begins (one is straightforwardly further "north," i.e.
 * further back), or failing that, one's u-range ends before the other's
 * begins. A single derived scalar (room.y, or any one corner/center of
 * it) can't capture this in general — confirmed live with two real
 * regressions before this: Small Garage's ORIGIN sits further south than
 * Big Garage's despite Big Garage's much larger footprint (origin-based
 * sort got it backwards); Living Room's FARTHEST corner is further south
 * than Entrance's even though Entrance is the one actually in front of it
 * (far-corner-based sort got it backwards, Living Room's long/thin shape
 * extends somewhere Entrance never overlaps); Front Side Lawn's CENTER
 * is further south than Jacqueline's Office's despite Front Side Lawn
 * sitting entirely behind Office along their actual shared u-band
 * (center-based sort got it backwards too). Comparing the real (u,v)
 * footprints directly (recovered via screenToGrid — the inverse of the
 * same gridToScreen transform that produced room.x/y in the first place)
 * sidesteps all three failure modes at once, verified against every one
 * of those plus every connectedTo-derived ground truth in the live house
 * data. The final fallback (true (u,v) overlap) should never actually
 * trigger for a sane layout — two rooms can't really occupy the same
 * floor tiles — but center-depth is kept as a last resort rather than an
 * arbitrary tie-break in case a layout somehow produces one anyway.
 */
function compareRoomDepth(a: RoomDef, b: RoomDef): number {
  const originA = screenToGrid(a.x, a.y);
  const originB = screenToGrid(b.x, b.y);
  const aV0 = originA.v;
  const aV1 = originA.v + a.rows;
  const bV0 = originB.v;
  const bV1 = originB.v + b.rows;
  if (aV1 <= bV0) return -1;
  if (bV1 <= aV0) return 1;
  const aU0 = originA.u;
  const aU1 = originA.u + a.cols;
  const bU0 = originB.u;
  const bU1 = originB.u + b.cols;
  if (aU1 <= bU0) return -1;
  if (bU1 <= aU0) return 1;
  return a.y + a.height / 2 - (b.y + b.height / 2);
}

/**
 * Builds and renders the isometric house scene: rooms, objects, camera
 * panning, floor-dimming focus, and "currently doing X" overlay highlighting.
 * Deliberately has NO click/interaction handling of its own — that's added by
 * subclasses via `attachRoomInteraction`/`attachObjectInteraction` (see
 * `House`, used by the desktop app). The base renderer with those hooks left
 * as no-ops is exactly what the read-only public viewer needs.
 */
export class SceneRenderer {
  protected world = new Container();
  protected roomContainers = new Map<number, Container>();
  // Each room's own resting (x,y) — captured once at construction so
  // tick()'s per-frame raise-easing never needs to re-look the room up
  // out of roomDefs.
  private roomBasePositions = new Map<number, { x: number; y: number }>();
  // Current eased raise offset per room (0 = resting, ROOM_RAISE_PX =
  // fully lifted) — ticks toward whichever target applyFocus set most
  // recently (see tick()).
  private roomRaiseOffsets = new Map<number, number>();
  private roomRaiseTargets = new Map<number, number>();
  // The viewed-room ambient glow (see GLOW_COLOR/GLOW_ALPHA/
  // GLOW_BLUR_STRENGTH) — one per room, built once in buildRoom and just
  // toggled visible/invisible by applyFocus rather than rebuilt.
  private roomGlows = new Map<number, Graphics>();
  // Only the WALLS dim for a same-floor room you're not currently viewing
  // — floor/objects stay fully visible, so you can still see (and click)
  // everything in a neighboring room at a glance. Dimming via AlphaFilter
  // (rather than per-child alpha) lets overlapping/adjacent opaque wall
  // tiles show through each other ("x-ray" look); AlphaFilter flattens the
  // walls container to a texture first and applies alpha to that single
  // result instead, so dimmed walls read as one solid translucent piece.
  // A DIFFERENT floor entirely is still fully hidden room-wide (see
  // applyFocus) — that's a `container.visible` toggle, not this.
  protected roomWallAlphaFilters = new Map<number, AlphaFilter>();
  // Front (bottom) walls paint ABOVE objects/overlays (see buildRoom) —
  // unlike the back walls, they sit between the floor/objects and the
  // camera, so a real wall there would actually occlude whatever's behind
  // it. Dims the same DIM_ALPHA amount as the back walls for any room
  // that isn't the one being viewed, but fades further still — down to
  // FRONT_WALL_FOCUSED_ALPHA — for the room you ARE viewing, since a
  // solid wall there would block your own view of the very objects
  // you're looking at (see applyFocus). Kept as its own filter/map rather
  // than sharing roomWallAlphaFilters above purely because the two need
  // an extra dim step at a different trigger, not because the baseline
  // differs.
  protected roomFrontWallAlphaFilters = new Map<number, AlphaFilter>();
  // Sprites shown only while one of their object's activity labels is the
  // currently-running activity (e.g. a character sprite at the piano).
  protected activeOverlays: ActiveOverlay[] = [];
  // Keyed by object placement id (not index) so applyLightStates (fed by
  // the live lightStates broadcast, see client/remoteState.ts) can look
  // one up directly without a scan.
  protected activeLights = new Map<number, ActiveLight>();
  // Keyed by object placement id too — every object with at least one
  // PaletteDef, ticked forward in tick() below.
  protected activePalettes = new Map<number, ActivePalette>();
  // Objects are clickable in any room on the SAME FLOOR as the one
  // currently viewed, not just the exact viewed room — clicking one both
  // recenters the camera on its room (see House.ts's attachObjectInteraction,
  // which already does this unconditionally) and runs its action in one
  // click, rather than needing a first click just to "enter" the room. A
  // DIFFERENT floor's objects stay non-interactive (see applyFocus).
  protected interactiveObjects: { roomId: number; container: Container }[] = [];
  // Built always (not just when dev mode is on) so toggling it in Settings
  // can just flip visibility live, without rebuilding any room/object.
  protected devOutlines: Graphics[] = [];
  protected viewedRoomId: number;
  // Which object (if any) within viewedRoomId the camera is centered on,
  // rather than the room's own silhouette center — set whenever a specific
  // object is clicked or an activity starts; cleared by a plain room click.
  protected viewedObjectId: number | null = null;
  protected cameraTarget = { x: 0, y: 0 };
  protected scale: number;
  protected devMode: boolean;
  // Sits directly on app.stage (not this.world), so it covers the whole
  // viewport uniformly regardless of camera pan/zoom — see
  // "Day/night ambient tint" above.
  private ambientTint = new Graphics();
  private ambientTintElapsedMs = 0;

  constructor(
    protected app: Application,
    protected onRoomChange: (roomName: string) => void,
    initial: { devMode: boolean; scale: number },
  ) {
    this.scale = initial.scale;
    this.devMode = initial.devMode;
    app.stage.addChild(this.world);
    this.world.scale.set(this.scale);

    // Depth-sort back-to-front so a room further back paints first and a
    // room in front of it paints on top — matters once rooms dim/overlap:
    // without this, whichever happened to be later in roomDefs always
    // rendered above the other regardless of which is actually behind.
    const depthSorted = [...roomDefs].sort(compareRoomDepth);
    for (const room of depthSorted) {
      const container = this.buildRoom(room);
      container.position.set(room.x, room.y);
      this.world.addChild(container);
      this.roomContainers.set(room.id, container);
      this.roomBasePositions.set(room.id, { x: room.x, y: room.y });
      this.roomRaiseOffsets.set(room.id, 0);
      this.roomRaiseTargets.set(room.id, 0);
    }

    this.viewedRoomId = roomDefs[0].id;
    this.applyFocus();
    this.computeCameraTarget();
    this.world.position.set(this.cameraTarget.x, this.cameraTarget.y);
    this.onRoomChange(roomDefs[0].name);

    // Added after `this.world` so it always paints on top of the whole
    // scene, and on `app.stage` directly (not `this.world`) so panning/
    // zooming the camera never moves or scales it.
    this.ambientTint.eventMode = "none";
    this.ambientTint.blendMode = "multiply";
    app.stage.addChild(this.ambientTint);
    if (this.isAmbientTintEnabled()) this.redrawAmbientTint();

    // A bound instance method (not an inline arrow), specifically so
    // destroy() below can remove THIS EXACT listener — the admin tool's
    // room/object-type previews construct a brand-new SceneRenderer
    // (AdminPreviewRenderer) on every single field edit (see
    // openRoomEditModal's/openObjectTypeEditModal's own renderPreview/
    // rebuildSprite), so without an explicit removal every one of those
    // short-lived instances' resize listeners would pile up forever,
    // each still holding this.app after admin-main.ts has already
    // called app.destroy() on it — confirmed live as the exact crash
    // ("Cannot read properties of null (reading 'screen')") the next
    // real window resize triggered.
    window.addEventListener("resize", this.handleResize);
    app.ticker.add(() => this.tick());
  }

  private handleResize = () => {
    this.computeCameraTarget();
    if (this.isAmbientTintEnabled()) this.redrawAmbientTint();
  };

  /**
   * Admin-tool-only cleanup (the real game/viewer build exactly one
   * SceneRenderer for their whole lifetime, so this never needs calling
   * there) — removes the window resize listener registered above.
   * Callers that destroy their own Application instance (admin-main.ts's
   * currentApp?.destroy()) must call this too, or that destroyed app
   * stays reachable forever through an orphaned listener.
   */
  public destroy(): void {
    window.removeEventListener("resize", this.handleResize);
  }

  /** Overridden to `false` by AdminPreviewRenderer — same "editing chrome should look the same regardless of real-world time" reasoning isRoomFocusEffectsEnabled already uses. */
  protected isAmbientTintEnabled(): boolean {
    return true;
  }

  private redrawAmbientTint(): void {
    const { color, alpha } = computeAmbientTint(new Date());
    this.ambientTint.clear().rect(0, 0, this.app.screen.width, this.app.screen.height).fill({ color, alpha });
  }

  protected buildRoom(room: RoomDef): Container {
    const container = new Container();
    this.attachRoomInteraction(container, room);

    // Floor tiles are top-aligned at their grid point and extend DOWN by
    // their own canvas height (diamond + visible "thickness" below it), so
    // the silhouette's true edge sits one tile-height lower than the raw
    // grid corners used for camera/hit-area math. Computed up front (not
    // just before the dev outline, which used to be the only thing that
    // needed them) since the glow below needs the exact same silhouette
    // points, just built into the paint order much earlier.
    const dy = TILE_HEIGHT / 2;
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);

    // Back walls get their own AlphaFilter (see roomWallAlphaFilters' own
    // comment) — floor has none, it's always full opacity whenever the
    // room itself is visible at all. Back walls paint BEFORE the floor
    // (they sit behind it, never visually overlapping).
    const wallsFilter = new AlphaFilter();
    const backWalls = buildBackWalls(room);
    backWalls.filters = [wallsFilter];
    container.addChild(backWalls);
    this.roomWallAlphaFilters.set(room.id, wallsFilter);

    // Same floor silhouette as the dev outline below, FILLED (not
    // stroked) and blurred, toggled by applyFocus (isViewed) instead of
    // devMode — the "this one's focused" ambient glow. Paints right after
    // the back walls — confirmed live that painting it any earlier (e.g.
    // behind everything) left it hidden under the back walls' own opaque
    // tiles — so it still sits behind the floor/objects (reads as light
    // coming from underneath them) while showing up in front of the back
    // walls instead of being occluded by them.
    const glow = new Graphics()
      .poly([back.x, back.y + dy, right.x, right.y + dy, front.x, front.y + dy, left.x, left.y + dy])
      .fill({ color: GLOW_COLOR, alpha: GLOW_ALPHA });
    glow.filters = [new BlurFilter({ strength: GLOW_BLUR_STRENGTH })];
    glow.visible = false;
    // Same "purely decorative" guarantee as buildBackWalls/buildBottomWalls/
    // the dev outline above — this already sits behind the floor/objects
    // in paint order so it's unlikely to matter in practice, but explicit
    // beats relying on z-order alone, same reasoning throughout this fix.
    glow.eventMode = "none";
    this.roomGlows.set(room.id, glow);
    container.addChild(glow);

    container.addChild(buildFloor(room));

    // Painter's algorithm, same spirit as buildFloor's own cells.sort(u+v)
    // a few lines up — an object nearer the room's own front vertex
    // (bigger u+v) needs to paint OVER one nearer the back, or the
    // farther object's sprite would wrongly cover the nearer one's own
    // base/legs. objectDepth() uses the object's floor-CONTACT point
    // (x+anchorX, y+anchorY), not its raw top-left (x,y) — the same
    // adjustment the admin tool's tile-mode display already makes (see
    // admin-main.ts's anchorFor()/screenToTileLabel()) — since x/y is
    // just wherever the sprite's own canvas happens to start, which can
    // include arbitrary padding unrelated to where the object actually
    // "stands." Array.prototype.sort is stable, so two objects landing on
    // the exact same depth keep their original (insertion) order rather
    // than flickering between runs.
    for (const obj of [...room.objects].filter((o) => o.enabled !== false).sort((a, b) => objectDepth(a) - objectDepth(b))) {
      container.addChild(this.buildObject(room.id, obj));
    }

    // Front (bottom) walls paint LAST — above objects/overlays, not just
    // the floor — since they sit between the room's interior and the
    // camera; a real wall there would occlude whatever's behind it. Own
    // filter (not wallsFilter above) since the alpha RULE differs too —
    // see roomFrontWallAlphaFilters'/FRONT_WALL_FOCUSED_ALPHA's own
    // comments and applyFocus below.
    const frontWallsFilter = new AlphaFilter();
    const bottomWalls = buildBottomWalls(room);
    bottomWalls.filters = [frontWallsFilter];
    container.addChild(bottomWalls);
    this.roomFrontWallAlphaFilters.set(room.id, frontWallsFilter);

    const outline = new Graphics()
      .poly([back.x, back.y + dy, right.x, right.y + dy, front.x, front.y + dy, left.x, left.y + dy])
      .stroke({ width: 2, color: 0xff0000 });
    outline.visible = this.devMode;
    // Dev-only visualization, painted last/on top of everything in the
    // room — same "purely decorative, never clickable" guarantee as
    // buildBackWalls/buildBottomWalls above, so toggling dev mode on
    // can't introduce its own click-stealing on top of whatever the
    // walls already don't do anymore.
    outline.eventMode = "none";
    this.devOutlines.push(outline);
    container.addChild(outline);

    this.onRoomContainerBuilt(room.id, container);
    return container;
  }

  /** Override point for a subclass that wants to wrap/instrument a room's whole container right after it's built — e.g. AdminPreviewRenderer attaching its own whole-room dim filter (see applyRoomDim). No-op by default. */
  protected onRoomContainerBuilt(_roomId: number, _container: Container): void {}

  /**
   * True by default (the real game/viewer); overridden by
   * AdminPreviewRenderer to disable the viewed-room raise/halo entirely
   * — its own moveRoom() drives a room's position directly (the
   * connections editor's live gap/offset edits), which the raise half of
   * this feature would otherwise fight/undo every tick once a room's
   * raise offset isn't exactly 0 (see applyFocus/tick). A METHOD, not a
   * field, specifically — applyFocus runs once synchronously inside this
   * base class's own constructor (during super()), before any subclass's
   * own field initializers would have run; a field here would silently
   * read the base class's own default for that entire first call, the
   * same class-field-initialization-order bug adminPreview.ts's own
   * objectContainers/roomAlphaFilters comments already document — a
   * method override doesn't have that problem, since the prototype chain
   * (and therefore which override `this.method()` resolves to) is
   * already in place before the constructor body runs at all.
   */
  protected isRoomFocusEffectsEnabled(): boolean {
    return true;
  }

  /**
   * True by default (the real game/viewer) — a room with `visible: false`
   * hides along with its contents (see applyFocus). Overridden by
   * AdminPreviewRenderer to return false: the admin tool needs to show and
   * edit a room regardless of whether it's currently flagged visible to
   * players, since that's exactly the flag being edited. A METHOD, not a
   * field, for the same class-field-initialization-order reason as
   * isRoomFocusEffectsEnabled above — applyFocus runs once synchronously
   * during this base class's own constructor.
   */
  protected respectsRoomVisibility(): boolean {
    return true;
  }

  protected buildObject(roomId: number, obj: ObjectDef): Container {
    const container = new Container();
    // Plain pixel offset from the room's own origin (same (0,0) the floor
    // and wall tiles are placed from) — not grid-snapped, negative allowed.
    container.position.set(obj.x, obj.y);

    // Captures the FIRST texture-backed below sprite only — a palette's
    // recolor only ever targets below[0] (see PaletteDef's own comment),
    // and every real object today has at most one below entry anyway
    // (same assumption the sprite/above loops already make).
    let belowSprite: Sprite | null = null;
    for (const layer of obj.below ?? []) {
      const node = buildLayer(layer, obj.width, obj.height);
      container.addChild(node);
      if (!belowSprite && node instanceof Sprite) belowSprite = node;
    }

    if (obj.lights && obj.lights.length > 0) {
      const glows: Graphics[] = [];
      for (const light of obj.lights) {
        // Same filled-then-blurred-circle technique as the room-focus
        // glow (GLOW_COLOR/GLOW_BLUR_STRENGTH above), just object-scoped
        // instead of room-scoped, and using the light's own color/alpha.
        const glow = new Graphics().circle(light.offsetX, light.offsetY, light.radius).fill({ color: light.color, alpha: light.alpha });
        glow.filters = [new BlurFilter({ strength: GLOW_BLUR_STRENGTH })];
        glow.eventMode = "none";
        glow.visible = obj.lightOn ?? false;
        container.addChild(glow);
        glows.push(glow);
      }
      this.activeLights.set(obj.id, { glows, on: obj.lightOn ?? false });
    }

    if (obj.palettes && obj.palettes.length > 0 && belowSprite && obj.below?.[0]?.texture) {
      const activePalette: ActivePalette = {
        sprite: belowSprite,
        url: assetUrl(obj.below[0].texture),
        defs: obj.palettes,
        frameIndices: obj.palettes.map(() => 0),
        frameElapsedMs: obj.palettes.map(() => 0),
      };
      this.activePalettes.set(obj.id, activePalette);
      this.applyPaletteFrame(activePalette);
    }

    // Name tags are UI, not world geometry — collected here and added to
    // the container only after the `above` loop below, so they always
    // paint on top of every other layer this object has (below/overlay/
    // above), regardless of which overlay layer they belong to. Adding
    // each one inline in the loop below (the previous behavior) put it
    // BEFORE `above`'s own children in paint order, so an `above` layer
    // (e.g. a case-color overlay) could visually cover the tag.
    const nameTags: Container[] = [];

    for (const layer of obj.sprite ?? []) {
      // No texture loaded yet -> Pixi's own blank/empty texture, stays
      // invisible (see below) until the first updateActiveOverlays call
      // resolves someone's attribution — there's no synchronous "shared
      // default" to apply eagerly anymore, since every overlay texture
      // (including the DEFAULT_SPRITE_CHARACTER fallback) is resolved the
      // same per-character way (resolveOverlayTexture).
      const overlay = new Sprite();
      overlay.position.set(layer.offsetX ?? 0, layer.offsetY ?? 0);
      overlay.visible = false;
      container.addChild(overlay);
      const nameTag = new Container();
      nameTag.visible = false;
      nameTags.push(nameTag);
      const labels = (obj.actions ?? [])
        .filter((a) => a.kind === "activity")
        .map((a) => findActivityById(a.activityId)?.label)
        .filter((label): label is string => label !== undefined);
      const activeOverlay: ActiveOverlay = {
        labels,
        sprite: overlay,
        layer,
        resolvedPath: null,
        attemptedPaths: new Set(),
        frames: null,
        frameIndex: 0,
        frameElapsedMs: 0,
        nameTag,
        nameTagText: null,
      };
      this.activeOverlays.push(activeOverlay);
    }

    for (const layer of obj.above ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    for (const nameTag of nameTags) container.addChild(nameTag);

    // Every object is hit-testable now, even with no actions of its own —
    // actionDispatch.ts treats a missing/empty actions array as an
    // implicit single "view" action (recenter, no side effect), so a
    // purely decorative object is clickable instead of inert.
    this.attachObjectInteraction(container, roomId, obj);
    container.hitArea = new Rectangle(0, 0, obj.width, obj.height);
    this.interactiveObjects.push({ roomId, container });

    const outline = new Graphics().rect(0, 0, obj.width, obj.height).stroke({ width: 1, color: 0xff0000 });
    outline.visible = this.devMode;
    this.devOutlines.push(outline);
    container.addChild(outline);

    return container;
  }

  /** Shared by House.ts/viewer.ts to gate click-driven camera panning — see MOBILE_BREAKPOINT_QUERY. */
  protected isMobileLayout(): boolean {
    return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
  }

  /** Override to wire up room click-to-focus — the base renderer has none (used by the read-only public viewer). */
  protected attachRoomInteraction(_container: Container, _room: RoomDef): void {}

  /** Override to wire up object click-to-act — the base renderer has none (used by the read-only public viewer). */
  protected attachObjectInteraction(_container: Container, _roomId: number, _obj: ObjectDef): void {}

  /**
   * `runningByLabel` carries every label CURRENTLY running, across every
   * character, keyed by label and valued by who's attributed to it — an
   * object's overlay shows as long as ANY of its labels has an entry
   * (see House.ts's/viewer.ts's own applyAllStatuses for how that map
   * gets built). If two characters happen to run the same label at once,
   * whichever one's entry the caller put in the map wins the art — same
   * "no separate per-character art to otherwise break the tie with"
   * spirit this already had for pure visibility before sprite keys
   * existed, just also deciding texture now instead of only visibility.
   *
   * `activeCharacterCount` is the number of DISTINCT characters currently
   * running something at all, system-wide — passed in separately rather
   * than derived from `runningByLabel.size`, since collapsing by label
   * already loses a character the moment two of them share one label
   * (two pianos, say): `runningByLabel` would have one entry for that
   * label, but two characters are genuinely active. Name tags only show
   * once 2+ characters are active (nothing to disambiguate with just
   * one) — sprite visibility itself is unaffected, still purely
   * per-object attribution.
   */
  protected updateActiveOverlays(runningByLabel: Map<string, OverlayAttribution>, activeCharacterCount: number) {
    const showNameTags = activeCharacterCount > 1;
    for (const overlay of this.activeOverlays) {
      const attribution = overlay.labels.map((l) => runningByLabel.get(l)).find((a): a is OverlayAttribution => a !== undefined);
      overlay.sprite.visible = !!attribution;
      overlay.nameTag.visible = !!attribution && showNameTags;
      if (attribution) {
        this.resolveOverlayTexture(overlay, attribution.characterSpriteName);
        this.setOverlayNameTag(overlay, attribution.characterName);
      }
    }
  }

  /**
   * Flips every tracked object's lit/unlit texture + glow visibility per
   * the live lightStates broadcast (keyed by object placement id — see
   * client/remoteState.ts's lightStates store) — called from House.ts/
   * viewer.ts whenever that store changes. A missing key (an object with
   * no light groups at all, or one this broadcast hasn't mentioned) is
   * simply skipped; only objects actually tracked in activeLights (built
   * in buildObject, see ActiveLight's own comment) do anything here.
   * Public (unlike updateActiveOverlays) since both House.ts and
   * viewer.ts call it with the exact same shape — no per-subclass
   * computation needed first, unlike attributing an overlay to a
   * character.
   */
  public applyLightStates(states: Record<number, boolean>) {
    for (const [objectId, light] of this.activeLights) {
      const on = states[objectId] ?? light.on;
      if (on === light.on) continue;
      light.on = on;
      for (const glow of light.glows) glow.visible = on;
    }
  }

  /** Rebuilds and applies one object's current combined palette texture — called once at build time (the initial frame) and again whenever tick() below advances any of its PaletteDefs past their own cycleIntervalMs. */
  private applyPaletteFrame(p: ActivePalette) {
    const groups = p.defs.map((def, i) => ({
      match: { anchorColor: def.anchorColor, tolerancePercent: def.tolerancePercent },
      color: def.colors[p.frameIndices[i] % def.colors.length],
    }));
    buildPaletteTexture(p.url, groups)
      .then((texture) => {
        p.sprite.texture = texture;
      })
      .catch((err) => console.error("[renderer] buildPaletteTexture failed", err));
  }

  /** Updates (rebuilding the actual text/background only if the name changed — see nameTagText's own comment) the small floating tag above an overlay sprite showing who's attributed to it. Always repositions regardless (see repositionOverlayNameTag), since that's cheap and depends on the sprite's current rendered size, not just the name. */
  private setOverlayNameTag(overlay: ActiveOverlay, name: string) {
    if (overlay.nameTagText !== name) {
      overlay.nameTagText = name;
      overlay.nameTag.removeChildren();

      const text = new Text({
        text: name,
        style: { fontSize: 11, fill: 0xffffff, fontFamily: "sans-serif" },
        resolution: this.scale * (window.devicePixelRatio || 1),
      });
      text.anchor.set(0.5, 0.5);

      const background = new Graphics()
        .roundRect(
          -text.width / 2 - NAME_TAG_PADDING_X,
          -text.height / 2 - NAME_TAG_PADDING_Y,
          text.width + NAME_TAG_PADDING_X * 2,
          text.height + NAME_TAG_PADDING_Y * 2,
          4,
        )
        .fill({ color: 0x000000, alpha: 0.6 });

      overlay.nameTag.addChild(background, text);
    }
    this.repositionOverlayNameTag(overlay);
  }

  /**
   * Centers the tag horizontally on the overlay SPRITE's own current
   * rendered width (offsetX + half that width), not the object's whole
   * bounding box — the sprite can sit anywhere within it (e.g. the
   * piano's overlay is offset well into the object), same "label floats
   * above the thing it's labeling" idea viewer.ts's own object-name label
   * already uses, just anchored to the sprite instead of the object.
   * Called both right after (re)building the tag's content (setOverlayNameTag)
   * and every time the sprite's texture actually changes (applyOverlayTexture)
   * — the latter matters because resolveOverlayTexture's own Assets.load()
   * can resolve asynchronously: if a name tag gets set before that texture
   * finishes loading, overlay.sprite.width is still the blank placeholder
   * Sprite's width (0) at that moment, which would otherwise leave the tag
   * stuck off-center indefinitely once the real texture (and its real
   * width) does arrive, since setOverlayNameTag's own rebuild is skipped
   * for an unchanged name.
   */
  private repositionOverlayNameTag(overlay: ActiveOverlay): void {
    const text = overlay.nameTag.children[1] as Text | undefined;
    if (!text) return; // tag not built yet
    const offsetX = overlay.layer.offsetX ?? 0;
    const offsetY = overlay.layer.offsetY ?? 0;
    overlay.nameTag.position.set(offsetX + overlay.sprite.width / 2, offsetY - (text.height / 2 + NAME_TAG_PADDING_Y + NAME_TAG_GAP));
  }

  /** Builds (and, if frameCount > 1, slices into animation frames) whichever texture an overlay should show right now — shared by the synchronous shared-default path at build time and the lazy per-character path below. */
  private applyOverlayTexture(overlay: ActiveOverlay, baseTexture: Texture) {
    const { layer } = overlay;
    if (layer.frameCount && layer.frameCount > 1) {
      overlay.frames = sliceFrames(baseTexture, layer.frameCount);
      overlay.frameIndex = 0;
      overlay.frameElapsedMs = 0;
      overlay.sprite.texture = overlay.frames[0];
    } else {
      overlay.frames = null;
      overlay.sprite.texture = baseTexture;
    }
    // The sprite's rendered width (what the name tag centers on) just
    // changed — see repositionOverlayNameTag's own comment on why this
    // needs to run here too, not just when the tag's text first gets set.
    if (overlay.nameTagText !== null) this.repositionOverlayNameTag(overlay);
  }

  /**
   * Lazily resolves a sprite-keyed overlay's texture — tries the
   * attributed character's own file first, falling back to
   * DEFAULT_SPRITE_CHARACTER's file for the same key when that character
   * has no spriteName, or no matching file exists for them specifically
   * (see characterSprites.ts's own comment on this fallback contract).
   * Never blocks the (synchronous) render — kicks off an Assets.load the
   * first time a given path is needed and swaps the texture in once it
   * resolves.
   */
  private resolveOverlayTexture(overlay: ActiveOverlay, characterSpriteName: string | null) {
    const { layer } = overlay;
    if (!layer.spriteKey) return;
    const primaryName = characterSpriteName ?? DEFAULT_SPRITE_CHARACTER;
    const fallbackName = primaryName === DEFAULT_SPRITE_CHARACTER ? null : DEFAULT_SPRITE_CHARACTER;
    this.tryResolveOverlayPath(overlay, characterSpritePath(primaryName, layer.spriteKey), fallbackName);
  }

  /**
   * Tries one path; on a 404 (or an already-known 404 from earlier this
   * session) falls through to `fallbackCharacterName`'s own file for the
   * same spriteKey, if given. `resolveOverlayTexture` only ever passes
   * DEFAULT_SPRITE_CHARACTER as the fallback, so this is at most one hop
   * deep, never a longer chain. A final 404 (fallback also missing, or no
   * fallback given) is expected, not an error — the overlay just keeps
   * showing whatever it already had, or stays blank if nothing's resolved
   * yet.
   */
  private tryResolveOverlayPath(overlay: ActiveOverlay, path: string, fallbackCharacterName: string | null) {
    if (overlay.resolvedPath === path) return; // already showing this
    const url = assetUrl(path);
    if (Assets.cache.has(url)) {
      overlay.resolvedPath = path;
      this.applyOverlayTexture(overlay, Assets.get<Texture>(url));
      return;
    }
    const fallThrough = () => {
      if (fallbackCharacterName) this.tryResolveOverlayPath(overlay, characterSpritePath(fallbackCharacterName, overlay.layer.spriteKey!), null);
    };
    if (overlay.attemptedPaths.has(path)) {
      fallThrough(); // already tried + failed this session
      return;
    }
    overlay.attemptedPaths.add(path);
    Assets.load<Texture>(url)
      .then((texture) => {
        texture.source.scaleMode = "nearest"; // keep pixel art crisp, same as preloadRoomAssets
        overlay.resolvedPath = path;
        this.applyOverlayTexture(overlay, texture);
        this.app.render(); // force an immediate repaint rather than waiting for the next ticker frame
      })
      .catch(fallThrough);
  }

  /**
   * objectId focuses the camera on that specific object's own position
   * instead of the room's silhouette center — omit it (or pass null) for
   * plain room-level framing, e.g. clicking the room itself rather than
   * anything in it. A no-op only when neither the room nor the focused
   * object actually changes, since the same room can still need a camera
   * re-center when the focused object within it changes.
   */
  protected setViewedRoom(roomId: number, objectId: number | null = null) {
    // A goTo action's target (or any other room reference) can go stale —
    // an admin reorganizing connectedTo can silently exclude a room from
    // resolveRooms()'s output (see that function's own comment on why),
    // and nothing validates a goTo action's roomId against that at save
    // time. This used to be a bare non-null-asserted `roomDefs.find(...)!`
    // here (and in applyFocus/computeCameraTarget below, both only ever
    // reached via this function) — reaching a missing room threw inside
    // the Pixi click handler, which the browser swallows silently with no
    // visible error, reading as "nothing happens" rather than a crash.
    // Staying on the current room instead is the same "don't let bad data
    // make the whole scene unusable" stance resolveRooms() itself takes.
    if (!roomDefs.some((r) => r.id === roomId)) {
      console.warn(`[renderer] setViewedRoom("${roomId}") — no such room in the currently-resolved scene, ignoring`);
      return;
    }
    const roomChanged = this.viewedRoomId !== roomId;
    if (!roomChanged && this.viewedObjectId === objectId) return;
    this.viewedRoomId = roomId;
    this.viewedObjectId = objectId;
    if (roomChanged) {
      this.applyFocus();
      this.onRoomChange(roomDefs.find((r) => r.id === roomId)!.name);
    }
    this.computeCameraTarget();
  }

  /** For external UI (e.g. a floor-switcher) — same path as clicking a room/object. */
  public goToRoom(roomId: number) {
    this.setViewedRoom(roomId);
  }

  protected applyFocus() {
    const viewedLevel = roomDefs.find((r) => r.id === this.viewedRoomId)!.level;
    for (const [id, container] of this.roomContainers) {
      const room = roomDefs.find((r) => r.id === id)!;
      if (room.level !== viewedLevel || (this.respectsRoomVisibility() && room.visible === false)) {
        // A different floor entirely — hide rather than dim, since it's not
        // spatially related to what's in view the way a same-floor
        // neighboring room is (that's still worth seeing in full). Also
        // disable interactivity: same-footprint rooms on different levels
        // (e.g. a bedroom directly above the office) can geometrically
        // overlap on screen, and a hidden room's hitArea would otherwise
        // still intercept clicks meant for the visible one on top of it.
        //
        // room.visible === false (admin-controlled, defaults false — see
        // RoomSpec's own comment) piggybacks on this exact same hide path:
        // the room still fully participates in position/floor-membership
        // resolution (resolveRooms never reads this flag), it just never
        // renders or receives clicks. An activity tracked on an object
        // inside it keeps running server-side regardless — this is a
        // client-only rendering/input concern.
        container.visible = false;
        container.eventMode = "none";
      } else {
        container.visible = true;
        const isViewed = id === this.viewedRoomId;
        this.applyRoomDim(id, isViewed);
        // Raise/glow are the "this one's focused" cue — see
        // ROOM_RAISE_PX/GLOW_COLOR's own comments. Targets only set here;
        // tick() does the actual easing toward them every frame. Gated off
        // for AdminPreviewRenderer (see isRoomFocusEffectsEnabled's own
        // comment).
        if (this.isRoomFocusEffectsEnabled()) {
          this.roomRaiseTargets.set(id, isViewed ? ROOM_RAISE_PX : 0);
          this.roomGlows.get(id)!.visible = isViewed;
        }
        // Front walls dim the same amount as the back walls (DIM_ALPHA)
        // for any room that isn't the one actually being viewed, then dim
        // further still — all the way down to FRONT_WALL_FOCUSED_ALPHA —
        // specifically for the viewed room, since they paint above
        // objects/overlays there (see buildRoom) and would otherwise
        // block your own view of what you're looking at. Not routed
        // through applyRoomDim's override (AdminPreviewRenderer included
        // — its own whole-room filter wraps this one too, so a non-focal
        // room there still ends up uniformly dimmed overall).
        this.roomFrontWallAlphaFilters.get(id)!.alpha = isViewed ? FRONT_WALL_FOCUSED_ALPHA : DIM_ALPHA;
        container.eventMode = "static";
      }
    }

    for (const { roomId, container } of this.interactiveObjects) {
      // Same floor as the viewed room (not just the exact viewed room
      // itself) — a neighboring same-floor room's objects are directly
      // clickable without first clicking into the room, since the
      // object's own click handler already recenters the camera on its
      // room as the first thing it does (see House.ts's
      // attachObjectInteraction) — one click now does both.
      const room = roomDefs.find((r) => r.id === roomId)!;
      const visibleEnough = !this.respectsRoomVisibility() || room.visible !== false;
      container.eventMode = room.level === viewedLevel && visibleEnough ? "static" : "none";
    }
  }

  /** Default (the real game/viewer): only the room's walls dim when it isn't the one actually being viewed — see roomWallAlphaFilters' own comment on why, and onRoomContainerBuilt for how a subclass overriding this can supply a different filter entirely. Overridden by AdminPreviewRenderer to dim the WHOLE room instead, since the admin tool's focus is purely on editing one room at a time, not glancing at a live neighboring room's floor/objects the way the real game wants to. */
  protected applyRoomDim(roomId: number, isViewed: boolean) {
    const wallsFilter = this.roomWallAlphaFilters.get(roomId)!;
    wallsFilter.alpha = isViewed ? 1 : DIM_ALPHA;
  }

  protected computeCameraTarget() {
    const room = roomDefs.find((r) => r.id === this.viewedRoomId)!;
    const obj = this.viewedObjectId ? room.objects.find((o) => o.id === this.viewedObjectId) : undefined;

    let cx: number, cy: number;
    if (obj) {
      // obj.x/y/width/height are already a plain pixel box relative to the
      // room's own origin (see buildObject) — center on that directly.
      cx = room.x + obj.x + obj.width / 2;
      cy = room.y + obj.y + obj.height / 2;
    } else {
      // Derived from the room's actual corner points, not room.x/width —
      // room.x is the back-vertex, which isn't the left edge of the
      // bounding box, so "room.x + width/2" was double-counting and
      // skewing the camera off-center.
      const left = gridToScreen(0, room.rows);
      const right = gridToScreen(room.cols, 0);
      const front = gridToScreen(room.cols, room.rows);
      cx = room.x + (left.x + right.x) / 2;
      // Center on the room's full visible silhouette (walls + floor), not
      // just the floor's own box — walls add height purely above the
      // floor, so the true vertical center sits half a wall-height higher
      // than the floor's.
      cy = room.y + front.y / 2 - totalWallHeight(room) / 2;
    }

    // world.position is in unscaled screen space, but (cx,cy) is in world's
    // own local space, which gets multiplied by world.scale when rendered —
    // so the offset needed to land it on screen center must account for that.
    this.cameraTarget = {
      x: this.app.screen.width / 2 - cx * this.scale,
      y: this.app.screen.height / 2 - cy * this.scale,
    };
  }

  public setDevMode(enabled: boolean) {
    for (const outline of this.devOutlines) outline.visible = enabled;
  }

  public setScale(scale: number) {
    this.scale = scale;
    this.world.scale.set(scale);
    this.computeCameraTarget();
    this.world.position.set(this.cameraTarget.x, this.cameraTarget.y);
  }

  private tick() {
    const deltaMs = this.app.ticker.deltaMS;

    if (this.isAmbientTintEnabled()) {
      this.ambientTintElapsedMs += deltaMs;
      if (this.ambientTintElapsedMs >= AMBIENT_RECOMPUTE_INTERVAL_MS) {
        this.ambientTintElapsedMs = 0;
        this.redrawAmbientTint();
      }
    }

    // Each PaletteDef on an object advances independently (its own
    // cycleIntervalMs, its own elapsed accumulator) — a def with no
    // interval or only one color never has anywhere to advance TO, so
    // it's skipped entirely rather than wastefully rebuilding an
    // unchanged texture every frame.
    for (const p of this.activePalettes.values()) {
      let changed = false;
      p.defs.forEach((def, i) => {
        if (!def.cycleIntervalMs || def.colors.length <= 1) return;
        p.frameElapsedMs[i] += deltaMs;
        if (p.frameElapsedMs[i] >= def.cycleIntervalMs) {
          p.frameElapsedMs[i] -= def.cycleIntervalMs;
          p.frameIndices[i] = (p.frameIndices[i] + 1) % def.colors.length;
          changed = true;
        }
      });
      if (changed) this.applyPaletteFrame(p);
    }

    this.world.x += (this.cameraTarget.x - this.world.x) * PAN_EASE;
    this.world.y += (this.cameraTarget.y - this.world.y) * PAN_EASE;

    // Eases every room's raise offset toward whichever target applyFocus
    // last set (see ROOM_RAISE_PX) — skips rooms already at rest (the
    // common case, once the animation settles) rather than re-writing an
    // unchanged position every frame. Gated off for AdminPreviewRenderer
    // (see isRoomFocusEffectsEnabled's own comment) — its own moveRoom()
    // drives room position directly, which this would otherwise
    // fight/undo the moment a room's raise offset isn't exactly 0.
    if (this.isRoomFocusEffectsEnabled()) {
      for (const [id, container] of this.roomContainers) {
        const currentRaise = this.roomRaiseOffsets.get(id)!;
        const targetRaise = this.roomRaiseTargets.get(id)!;
        if (currentRaise !== targetRaise) {
          const next = Math.abs(targetRaise - currentRaise) < 0.05 ? targetRaise : currentRaise + (targetRaise - currentRaise) * ROOM_FOCUS_EASE;
          this.roomRaiseOffsets.set(id, next);
          const base = this.roomBasePositions.get(id)!;
          container.position.set(base.x, base.y + next);
        }
      }
    }

    // Only ever non-null once a resolved texture actually turned out to
    // have frameCount > 1 (see applyOverlayTexture) — a plain static
    // overlay (frames === null, the common case today) costs nothing
    // here beyond the one visible+frames check.
    for (const overlay of this.activeOverlays) {
      if (!overlay.sprite.visible || !overlay.frames) continue;
      overlay.frameElapsedMs += deltaMs;
      const duration = overlay.layer.frameDurationMs ?? DEFAULT_OVERLAY_FRAME_DURATION_MS;
      if (overlay.frameElapsedMs >= duration) {
        overlay.frameElapsedMs -= duration;
        overlay.frameIndex = (overlay.frameIndex + 1) % overlay.frames.length;
        overlay.sprite.texture = overlay.frames[overlay.frameIndex];
      }
    }
  }
}

import { AlphaFilter, Application, Assets, Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import { gridToScreen, rooms as roomDefs, ObjectDef, RoomDef, SpriteLayer, TILE_HEIGHT, TILE_WIDTH } from "./rooms";
import { findActivityById } from "./activities";
import { characterSpritePath, DEFAULT_SPRITE_CHARACTER } from "./characterSprites";
import { TileOverride, TileRect } from "./tileset";

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
// Exported for the admin tool's object-type preview (admin-main.ts),
// which simulates the overlay layer too now (defaulting to Jacqueline's
// own art) and needs the same default-duration fallback.
export const DEFAULT_OVERLAY_FRAME_DURATION_MS = 150;
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
    }
    for (const obj of room.objects) {
      const layers = [...(obj.below ?? []), ...(obj.overlay ?? []), ...(obj.above ?? [])];
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
  const { floor, wall } = room;

  // Walls sit on the same ground level as the floor, just drawn taller: their
  // canvas extends further UP from that shared level, not further down. So a
  // wall's top is offset by only its *extra* height beyond the floor's own
  // canvas (wall.h - floor.h) — not its full height — otherwise it renders
  // one floor-tile-height too high, floating above the floor with a gap.
  const groundOffset = wall.left.h - floor.mid.h;
  // Edge caps sit one grid step further out than the last regular panel (see
  // below), which drops their natural ground level by one grid step — pull
  // them back up by that same amount so they stay flush with the run.
  const edgeGroundOffset = groundOffset + TILE_HEIGHT;

  // Corner joint at the back vertex, then a run of repeating panels along
  // each back edge, capped with an edge tile at the far end.
  // showLeftWall/showRightWall (default true when unset) gate the DEFAULT
  // tile only — a wallOverrides entry on a hidden side still renders (see
  // placeTileWithOverrides's own comment). If only one side renders, that
  // side's own panel tile extends through the joint instead of the
  // dedicated corner piece, so a single wall reads as one continuous run
  // rather than stopping at a joint with nothing on the other side to
  // join.
  const wo = room.wallOverrides;
  const showLeft = room.showLeftWall !== false;
  const showRight = room.showRightWall !== false;
  const topCorner = showLeft && showRight ? wall.corner : showLeft ? wall.left : wall.right;
  placeTileWithOverrides(container, wo, wall.texture, topCorner, 0, 0, groundOffset, showLeft || showRight);

  for (let v = 1; v < room.rows; v++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.left, 0, v, groundOffset, showLeft);
  }
  placeTileWithOverrides(container, wo, wall.texture, wall.edgeLeft, 0, room.rows + 1, edgeGroundOffset, showLeft);
  for (let u = 1; u < room.cols; u++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.right, u, 0, groundOffset, showRight);
  }
  placeTileWithOverrides(container, wo, wall.texture, wall.edgeRight, room.cols + 1, 0, edgeGroundOffset, showRight);

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
 * single front wall, not a true meeting of two edges. The two front
 * walls never get a tile of their own at the shared (cols,rows) corner
 * either: each wall's own run (vertex + panels) already covers its full
 * edge exactly (u=0..cols-1 for bottom-left, v=0..rows-1 for
 * bottom-right — matching the room's own column/row count 1:1), so a
 * tile at (cols,rows) would sit one step past both already-complete
 * spans — confirmed live, it read as the wall extending a full tile too
 * far past the room's actual corner.
 */
export function buildBottomWalls(room: RoomDef): Container {
  const container = new Container();
  const { floor, wall } = room;
  const groundOffset = wall.left.h - floor.mid.h;

  const wo = room.wallOverrides;
  const showBottomLeft = room.showBottomLeftWall === true;
  const showBottomRight = room.showBottomRightWall === true;

  for (let v = 1; v < room.rows; v++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.left, room.cols, v, groundOffset, showBottomRight);
  }
  for (let u = 1; u < room.cols; u++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.right, u, room.rows, groundOffset, showBottomLeft);
  }

  // Right vertex (cols,0) / left vertex (0,rows) — just the first tile of
  // each front wall's own run, not a joint with anything.
  placeTileWithOverrides(container, wo, wall.texture, wall.left, room.cols, 0, groundOffset, showBottomRight);
  placeTileWithOverrides(container, wo, wall.texture, wall.right, 0, room.rows, groundOffset, showBottomLeft);

  // No tile at the front (cols,rows) vertex where the two front walls
  // would otherwise meet — each wall's own run (vertex above + panels
  // above) already covers its full edge exactly (u=0..cols-1 for
  // bottom-left, v=0..rows-1 for bottom-right, matching the room's own
  // column/row count 1:1). A tile at (cols,rows) would sit one step
  // PAST both of those already-complete spans — confirmed live, it read
  // as the wall extending a full tile too far past the room's actual
  // corner.

  return container;
}

/** Builds just the floor for a room, tiled per its chosen floor variant — see buildBackWalls's own comment on why walls are split out separately. */
export function buildFloor(room: RoomDef): Container {
  const container = new Container();
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
    //
    // Sorted by each room's CENTER depth (y + height/2), not either
    // extreme corner. room.y alone is just the origin tile's screen Y (see
    // resolveRooms()) — it ignores the room's own footprint size, so two
    // differently-sized adjacent rooms can have their origin Ys ordered
    // opposite to how they should actually paint (confirmed live: Small
    // Garage's origin sits further "south" than Big Garage's despite Big
    // Garage's much larger footprint). Sorting by the FARTHEST corner
    // (y + height) instead fixes that, but breaks the opposite way for a
    // long/thin room like Living Room overlapping a small room like
    // Entrance near just one edge — Living Room's far corner is further
    // south than Entrance's even though Entrance is the one actually in
    // front of it (per its own frontRight connection), because most of
    // Living Room's footprint extends somewhere Entrance never overlaps.
    // Neither extreme represents "depth where these two rooms actually
    // meet" well. The CENTER does: verified by hand against every
    // connectedTo edge in the live room data (all 9 pairs, including both
    // cases above) — center-depth ordering matches every one of them.
    const depthSorted = [...roomDefs].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
    for (const room of depthSorted) {
      const container = this.buildRoom(room);
      container.position.set(room.x, room.y);
      this.world.addChild(container);
      this.roomContainers.set(room.id, container);
    }

    this.viewedRoomId = roomDefs[0].id;
    this.applyFocus();
    this.computeCameraTarget();
    this.world.position.set(this.cameraTarget.x, this.cameraTarget.y);
    this.onRoomChange(roomDefs[0].name);

    window.addEventListener("resize", () => this.computeCameraTarget());
    app.ticker.add(() => this.tick());
  }

  protected buildRoom(room: RoomDef): Container {
    const container = new Container();
    this.attachRoomInteraction(container, room);

    // Back walls get their own AlphaFilter (see roomWallAlphaFilters' own
    // comment) — floor has none, it's always full opacity whenever the
    // room itself is visible at all. Back walls paint BEFORE the floor
    // (they sit behind it, never visually overlapping).
    const wallsFilter = new AlphaFilter();
    const backWalls = buildBackWalls(room);
    backWalls.filters = [wallsFilter];
    container.addChild(backWalls);
    this.roomWallAlphaFilters.set(room.id, wallsFilter);

    container.addChild(buildFloor(room));

    for (const obj of room.objects) {
      if (obj.enabled === false) continue;
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

    // Floor tiles are top-aligned at their grid point and extend DOWN by
    // their own canvas height (diamond + visible "thickness" below it), so
    // the silhouette's true edge sits one tile-height lower than the raw
    // grid corners used for camera/hit-area math.
    const dy = TILE_HEIGHT / 2;
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    const outline = new Graphics()
      .poly([back.x, back.y + dy, right.x, right.y + dy, front.x, front.y + dy, left.x, left.y + dy])
      .stroke({ width: 2, color: 0xff0000 });
    outline.visible = this.devMode;
    this.devOutlines.push(outline);
    container.addChild(outline);

    this.onRoomContainerBuilt(room.id, container);
    return container;
  }

  /** Override point for a subclass that wants to wrap/instrument a room's whole container right after it's built — e.g. AdminPreviewRenderer attaching its own whole-room dim filter (see applyRoomDim). No-op by default. */
  protected onRoomContainerBuilt(_roomId: number, _container: Container): void {}

  protected buildObject(roomId: number, obj: ObjectDef): Container {
    const container = new Container();
    // Plain pixel offset from the room's own origin (same (0,0) the floor
    // and wall tiles are placed from) — not grid-snapped, negative allowed.
    container.position.set(obj.x, obj.y);

    for (const layer of obj.below ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    for (const layer of obj.overlay ?? []) {
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
      container.addChild(nameTag);
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
   */
  protected updateActiveOverlays(runningByLabel: Map<string, OverlayAttribution>) {
    for (const overlay of this.activeOverlays) {
      const attribution = overlay.labels.map((l) => runningByLabel.get(l)).find((a): a is OverlayAttribution => a !== undefined);
      overlay.sprite.visible = !!attribution;
      overlay.nameTag.visible = !!attribution;
      if (attribution) {
        this.resolveOverlayTexture(overlay, attribution.characterSpriteName);
        this.setOverlayNameTag(overlay, attribution.characterName);
      }
    }
  }

  /** Updates (building fresh only if the name actually changed — see nameTagText's own comment) the small floating tag above an overlay sprite showing who's attributed to it. Positioned off the sprite's own offsetX/offsetY + rendered size, not the object's whole bounding box — same "label floats above the thing it's labeling, not the furniture it's sitting on" idea viewer.ts's own object-name label already uses, just anchored to the sprite instead of the object. */
  private setOverlayNameTag(overlay: ActiveOverlay, name: string) {
    if (overlay.nameTagText === name) return;
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
      if (room.level !== viewedLevel) {
        // A different floor entirely — hide rather than dim, since it's not
        // spatially related to what's in view the way a same-floor
        // neighboring room is (that's still worth seeing in full). Also
        // disable interactivity: same-footprint rooms on different levels
        // (e.g. a bedroom directly above the office) can geometrically
        // overlap on screen, and a hidden room's hitArea would otherwise
        // still intercept clicks meant for the visible one on top of it.
        container.visible = false;
        container.eventMode = "none";
      } else {
        container.visible = true;
        const isViewed = id === this.viewedRoomId;
        this.applyRoomDim(id, isViewed);
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
      container.eventMode = room.level === viewedLevel ? "static" : "none";
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
      cy = room.y + front.y / 2 - room.wall.left.h / 2;
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
    this.world.x += (this.cameraTarget.x - this.world.x) * PAN_EASE;
    this.world.y += (this.cameraTarget.y - this.world.y) * PAN_EASE;

    // Only ever non-null once a resolved texture actually turned out to
    // have frameCount > 1 (see applyOverlayTexture) — a plain static
    // overlay (frames === null, the common case today) costs nothing
    // here beyond the one visible+frames check.
    const deltaMs = this.app.ticker.deltaMS;
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

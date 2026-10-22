import { AlphaFilter, Application, Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { gridToScreen, rooms as roomDefs, ObjectDef, RoomDef, SpriteLayer, TILE_HEIGHT, TILE_WIDTH } from "./rooms";
import { findActivityById } from "./activities";
import { TileOverride, TileRect } from "./tileset";

const DIM_ALPHA = 0.15;
const PAN_EASE = 0.15;
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

/** Exported for the admin tool's placement-ghost preview (adminPreview.ts), which builds a lightweight stand-in sprite from the same SpriteLayer data instead of duplicating this logic. */
export function buildLayer(layer: SpriteLayer, width: number, height: number): Container {
  const node: Container = layer.texture
    ? new Sprite(Assets.get<Texture>(assetUrl(layer.texture)))
    : new Graphics().rect(0, 0, width, height).fill(layer.color ?? 0xffffff);
  if (layer.texture) {
    (node as Sprite).width = width;
    (node as Sprite).height = height;
  }
  node.position.set(layer.offsetX ?? 0, layer.offsetY ?? 0);
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
 * rendering on top of it.
 */
function placeTileWithOverrides(
  container: Container,
  overrides: TileOverride[] | undefined,
  defaultTexture: string,
  defaultRect: TileRect,
  u: number,
  v: number,
  groundOffset: number,
) {
  const override = overrides?.find((o) => o.u === u && o.v === v);
  if (override) {
    if (override.tile) placeTile(container, override.tile.texture, override.tile, u, v, groundOffset);
    return; // override.tile === null -> gap, render nothing
  }
  placeTile(container, defaultTexture, defaultRect, u, v, groundOffset);
}

/** Builds the floor + back walls for a room, tiled per its chosen floor/wall variant. Exported for the admin tool's object-type preview (admin-main.ts), which renders a real tiny room corner behind the sprite instead of a bare wireframe grid. */
export function buildFloorAndWalls(room: RoomDef): Container {
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

  // Walls first: corner joint at the back vertex, then a run of repeating
  // panels along each back edge, capped with an edge tile at the far end.
  const wo = room.wallOverrides;
  placeTileWithOverrides(container, wo, wall.texture, wall.corner, 0, 0, groundOffset);
  for (let v = 1; v < room.rows; v++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.left, 0, v, groundOffset);
  }
  placeTileWithOverrides(container, wo, wall.texture, wall.edgeLeft, 0, room.rows + 1, edgeGroundOffset);
  for (let u = 1; u < room.cols; u++) {
    placeTileWithOverrides(container, wo, wall.texture, wall.right, u, 0, groundOffset);
  }
  placeTileWithOverrides(container, wo, wall.texture, wall.edgeRight, room.cols + 1, 0, edgeGroundOffset);

  // Floor, drawn back-to-front (painter's algorithm) so each tile's visible
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
  protected roomContainers = new Map<string, Container>();
  // Dimming the room via per-child alpha lets overlapping/adjacent opaque
  // tiles show through each other ("x-ray" look). AlphaFilter flattens the
  // whole container to a texture first and applies alpha to that single
  // result instead, so a dimmed room reads as one solid translucent room.
  protected roomAlphaFilters = new Map<string, AlphaFilter>();
  // Sprites shown only while one of their object's activity labels is the
  // currently-running activity (e.g. a character sprite at the piano).
  protected activeOverlays: { labels: string[]; sprite: Sprite }[] = [];
  // Objects are only clickable (when interaction is wired up) in the room
  // currently viewed — a dimmed neighboring room shows what's there, but you
  // have to click into it first before you can interact with anything inside.
  protected interactiveObjects: { roomId: string; container: Container }[] = [];
  // Built always (not just when dev mode is on) so toggling it in Settings
  // can just flip visibility live, without rebuilding any room/object.
  protected devOutlines: Graphics[] = [];
  protected viewedRoomId: string;
  // Which object (if any) within viewedRoomId the camera is centered on,
  // rather than the room's own silhouette center — set whenever a specific
  // object is clicked or an activity starts; cleared by a plain room click.
  protected viewedObjectId: string | null = null;
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

    // Depth-sort back-to-front by screen Y so a room further back (e.g.
    // DDR, which sits behind-and-left of the office) paints first and a
    // room in front of it paints on top — matters once rooms dim/overlap:
    // without this, whichever happened to be later in roomDefs always
    // rendered above the other regardless of which is actually behind.
    const depthSorted = [...roomDefs].sort((a, b) => a.y - b.y);
    for (const room of depthSorted) {
      const container = this.buildRoom(room);
      container.position.set(room.x, room.y);
      const alphaFilter = new AlphaFilter();
      container.filters = [alphaFilter];
      this.world.addChild(container);
      this.roomContainers.set(room.id, container);
      this.roomAlphaFilters.set(room.id, alphaFilter);
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

    container.addChild(buildFloorAndWalls(room));

    for (const obj of room.objects) {
      if (obj.enabled === false) continue;
      container.addChild(this.buildObject(room.id, obj));
    }

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

    return container;
  }

  protected buildObject(roomId: string, obj: ObjectDef): Container {
    const container = new Container();
    // Plain pixel offset from the room's own origin (same (0,0) the floor
    // and wall tiles are placed from) — not grid-snapped, negative allowed.
    container.position.set(obj.x, obj.y);

    for (const layer of obj.below ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    for (const layer of obj.overlay ?? []) {
      const overlay = new Sprite(Assets.get<Texture>(assetUrl(layer.texture!)));
      overlay.position.set(layer.offsetX ?? 0, layer.offsetY ?? 0);
      overlay.visible = false;
      container.addChild(overlay);
      const labels = (obj.actions ?? [])
        .filter((a) => a.kind === "activity")
        .map((a) => findActivityById(a.activityId)?.label)
        .filter((label): label is string => label !== undefined);
      this.activeOverlays.push({ labels, sprite: overlay });
    }

    for (const layer of obj.above ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    this.attachObjectInteraction(container, roomId, obj);
    if (obj.actions?.length) {
      container.hitArea = new Rectangle(0, 0, obj.width, obj.height);
      this.interactiveObjects.push({ roomId, container });
    }

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
  protected attachObjectInteraction(_container: Container, _roomId: string, _obj: ObjectDef): void {}

  protected updateActiveOverlays(current: { label: string } | null) {
    for (const { labels, sprite } of this.activeOverlays) {
      sprite.visible = current !== null && labels.includes(current.label);
    }
  }

  /**
   * objectId focuses the camera on that specific object's own position
   * instead of the room's silhouette center — omit it (or pass null) for
   * plain room-level framing, e.g. clicking the room itself rather than
   * anything in it. A no-op only when neither the room nor the focused
   * object actually changes, since the same room can still need a camera
   * re-center when the focused object within it changes.
   */
  protected setViewedRoom(roomId: string, objectId: string | null = null) {
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
  public goToRoom(roomId: string) {
    this.setViewedRoom(roomId);
  }

  protected applyFocus() {
    const viewedLevel = roomDefs.find((r) => r.id === this.viewedRoomId)!.level;
    for (const [id, filter] of this.roomAlphaFilters) {
      const room = roomDefs.find((r) => r.id === id)!;
      const container = this.roomContainers.get(id)!;
      if (room.level !== viewedLevel) {
        // A different floor entirely — hide rather than dim, since it's not
        // spatially related to what's in view the way a same-floor
        // neighboring room is (that's still worth seeing faintly). Also
        // disable interactivity: same-footprint rooms on different levels
        // (e.g. a bedroom directly above the office) can geometrically
        // overlap on screen, and a hidden room's hitArea would otherwise
        // still intercept clicks meant for the visible one on top of it.
        filter.alpha = 0;
        container.eventMode = "none";
      } else {
        filter.alpha = id === this.viewedRoomId ? 1 : DIM_ALPHA;
        container.eventMode = "static";
      }
    }

    for (const { roomId, container } of this.interactiveObjects) {
      container.eventMode = roomId === this.viewedRoomId ? "static" : "none";
    }
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
  }
}

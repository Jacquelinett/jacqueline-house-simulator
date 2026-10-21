import { AlphaFilter, Application, Assets, Container, Graphics, Polygon, Rectangle, Sprite, Texture } from "pixi.js";
import { gridToScreen, rooms as roomDefs, ObjectAction, ObjectDef, RoomDef, SpriteLayer, TILE_HEIGHT, TILE_WIDTH } from "./rooms";
import { TileRect } from "./tileset";
import {
  getCurrentActivity,
  RunningActivity,
  startActivity,
  stopActivity,
} from "../aw/client";
import { DEV_MODE, SCALE } from "../config";

const DIM_ALPHA = 0.1;
const PAN_EASE = 0.15;

/** Preloads every texture referenced by `rooms.ts` so sprites can be built synchronously. */
export async function preloadRoomAssets(): Promise<void> {
  const paths = new Set<string>();
  for (const room of roomDefs) {
    paths.add(room.floor.texture);
    paths.add(room.wall.texture);
    for (const obj of room.objects) {
      const layers = [...(obj.below ?? []), ...(obj.overlay ?? []), ...(obj.above ?? [])];
      for (const layer of layers) {
        if (layer.texture) paths.add(layer.texture);
      }
    }
  }

  const loaded = await Assets.load<Texture>([...paths]);
  for (const texture of Object.values(loaded)) {
    texture.source.scaleMode = "nearest"; // keep pixel art crisp, not blurred on scale
  }
}

function buildLayer(layer: SpriteLayer, width: number, height: number): Container {
  const node: Container = layer.texture
    ? new Sprite(Assets.get<Texture>(layer.texture))
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
  const sheet = Assets.get<Texture>(texturePath);
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

/** Builds the floor + back walls for a room, tiled per its chosen floor/wall variant. */
function buildFloorAndWalls(room: RoomDef): Container {
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
  placeTile(container, wall.texture, wall.corner, 0, 0, groundOffset);
  for (let v = 1; v < room.rows; v++) placeTile(container, wall.texture, wall.left, 0, v, groundOffset);
  placeTile(container, wall.texture, wall.edgeLeft, 0, room.rows + 1, edgeGroundOffset);
  for (let u = 1; u < room.cols; u++) placeTile(container, wall.texture, wall.right, u, 0, groundOffset);
  placeTile(container, wall.texture, wall.edgeRight, room.cols + 1, 0, edgeGroundOffset);

  // Floor, drawn back-to-front (painter's algorithm) so each tile's visible
  // "thickness" is correctly covered by the tile in front of it.
  const cells: { u: number; v: number }[] = [];
  for (let u = 0; u < room.cols; u++) {
    for (let v = 0; v < room.rows; v++) cells.push({ u, v });
  }
  cells.sort((a, b) => a.u + a.v - (b.u + b.v));
  for (const { u, v } of cells) {
    const tile = u === room.cols - 1 ? floor.edgeBottomRight : u === 0 ? floor.edgeTopLeft : floor.mid;
    placeTile(container, floor.texture, tile, u, v, 0);
  }

  return container;
}

export class House {
  private world = new Container();
  private roomContainers = new Map<string, Container>();
  // Dimming the room via per-child alpha lets overlapping/adjacent opaque
  // tiles show through each other ("x-ray" look). AlphaFilter flattens the
  // whole container to a texture first and applies alpha to that single
  // result instead, so a dimmed room reads as one solid translucent room.
  private roomAlphaFilters = new Map<string, AlphaFilter>();
  // Sprites shown only while one of their object's activity labels is the
  // currently-running activity (e.g. a character sprite at the piano).
  private activeOverlays: { labels: string[]; sprite: Sprite }[] = [];
  private viewedRoomId: string;
  private cameraTarget = { x: 0, y: 0 };
  private menuEl: HTMLDivElement | null = null;

  constructor(
    private app: Application,
    private onActivityChange: (current: RunningActivity | null) => void,
    private onRoomChange: (roomName: string) => void,
  ) {
    app.stage.addChild(this.world);
    this.world.scale.set(SCALE);

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
    this.computeCameraTarget(this.viewedRoomId);
    this.world.position.set(this.cameraTarget.x, this.cameraTarget.y);
    this.onRoomChange(roomDefs[0].name);

    app.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("resize", () => this.computeCameraTarget(this.viewedRoomId));
    app.ticker.add(() => this.tick());
  }

  private buildRoom(room: RoomDef): Container {
    const container = new Container();
    container.eventMode = "static";
    // A rectangle bounding box is much wider than the room's actual diamond
    // floor, so adjacent connected rooms' rectangular hit areas overlap
    // heavily even though their tiles don't — whichever room was added later
    // then swallows clicks meant for the earlier one in that overlap zone.
    // Using the real floor polygon (same corners as the dev-mode outline)
    // avoids that entirely.
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    container.hitArea = new Polygon([back.x, back.y, right.x, right.y, front.x, front.y, left.x, left.y]);
    container.on("pointertap", () => this.setViewedRoom(room.id));

    container.addChild(buildFloorAndWalls(room));

    for (const obj of room.objects) {
      if (obj.enabled === false) continue;
      container.addChild(this.buildObject(room.id, obj));
    }

    if (DEV_MODE) {
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
      container.addChild(outline);
    }

    return container;
  }

  private buildObject(roomId: string, obj: ObjectDef): Container {
    const container = new Container();
    // Plain pixel offset from the room's own origin (same (0,0) the floor
    // and wall tiles are placed from) — not grid-snapped, negative allowed.
    container.position.set(obj.x, obj.y);

    for (const layer of obj.below ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    for (const layer of obj.overlay ?? []) {
      const overlay = new Sprite(Assets.get<Texture>(layer.texture!));
      overlay.position.set(layer.offsetX ?? 0, layer.offsetY ?? 0);
      overlay.visible = false;
      container.addChild(overlay);
      const labels = (obj.actions ?? []).filter((a) => a.kind === "activity").map((a) => a.label);
      this.activeOverlays.push({ labels, sprite: overlay });
    }

    for (const layer of obj.above ?? []) {
      container.addChild(buildLayer(layer, obj.width, obj.height));
    }

    if (obj.actions?.length) {
      container.eventMode = "static";
      container.cursor = "pointer";
      container.hitArea = new Rectangle(0, 0, obj.width, obj.height);
      // Without this, Pixi still hit-tests individual children, and sparse
      // art (e.g. the thin vine overlay in piano_top.png) only registers
      // clicks where it happens to have opaque pixels — not the full box.
      container.interactiveChildren = false;
      container.on("pointertap", (e) => {
        if (obj.actions!.length === 1) {
          this.runAction(roomId, obj.actions![0]);
        } else {
          const native = e.nativeEvent as MouseEvent;
          this.openMenu(roomId, obj.actions!, native.clientX, native.clientY);
        }
      });
      container.on("rightclick", (e) => {
        const native = e.nativeEvent as MouseEvent;
        this.openMenu(roomId, obj.actions!, native.clientX, native.clientY);
      });
    }

    if (DEV_MODE) {
      const outline = new Graphics()
        .rect(0, 0, obj.width, obj.height)
        .stroke({ width: 1, color: 0xff0000 });
      container.addChild(outline);
    }

    return container;
  }

  private runAction(roomId: string, action: ObjectAction) {
    if (action.kind !== "activity") return;
    const current = getCurrentActivity();
    const op =
      current?.label === action.label ? stopActivity() : startActivity(action.label);
    op.then(() => {
      this.setViewedRoom(roomId);
      const current = getCurrentActivity();
      this.updateActiveOverlays(current);
      this.onActivityChange(current);
    }).catch((err) => console.error("[house] action failed", err));
  }

  private updateActiveOverlays(current: RunningActivity | null) {
    for (const { labels, sprite } of this.activeOverlays) {
      sprite.visible = current !== null && labels.includes(current.label);
    }
  }

  private openMenu(roomId: string, actions: ObjectAction[], clientX: number, clientY: number) {
    this.closeMenu();

    const menu = document.createElement("div");
    menu.className = "object-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    for (const action of actions) {
      const btn = document.createElement("button");
      btn.textContent = action.kind === "activity" ? action.label : "?";
      btn.onclick = () => {
        this.runAction(roomId, action);
        this.closeMenu();
      };
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.menuEl = menu;

    const closeOnOutside = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) this.closeMenu();
    };
    // Defer attaching so the same right-click that opened the menu doesn't also close it.
    setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, { once: true }), 0);
  }

  private closeMenu() {
    this.menuEl?.remove();
    this.menuEl = null;
  }

  private setViewedRoom(roomId: string) {
    if (this.viewedRoomId === roomId) return;
    this.viewedRoomId = roomId;
    this.applyFocus();
    this.computeCameraTarget(roomId);
    this.onRoomChange(roomDefs.find((r) => r.id === roomId)!.name);
  }

  private applyFocus() {
    for (const [id, filter] of this.roomAlphaFilters) {
      filter.alpha = id === this.viewedRoomId ? 1 : DIM_ALPHA;
    }
  }

  private computeCameraTarget(roomId: string) {
    const room = roomDefs.find((r) => r.id === roomId)!;
    // Derived from the room's actual corner points, not room.x/width — room.x
    // is the back-vertex, which isn't the left edge of the bounding box, so
    // "room.x + width/2" was double-counting and skewing the camera off-center.
    const left = gridToScreen(0, room.rows);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const cx = room.x + (left.x + right.x) / 2;
    // Center on the room's full visible silhouette (walls + floor), not just
    // the floor's own box — walls add height purely above the floor, so the
    // true vertical center sits half a wall-height higher than the floor's.
    const cy = room.y + front.y / 2 - room.wall.left.h / 2;
    // world.position is in unscaled screen space, but (cx,cy) is in world's
    // own local space, which gets multiplied by world.scale when rendered —
    // so the offset needed to land it on screen center must account for that.
    this.cameraTarget = {
      x: this.app.screen.width / 2 - cx * SCALE,
      y: this.app.screen.height / 2 - cy * SCALE,
    };
  }

  private tick() {
    this.world.x += (this.cameraTarget.x - this.world.x) * PAN_EASE;
    this.world.y += (this.cameraTarget.y - this.world.y) * PAN_EASE;
  }
}

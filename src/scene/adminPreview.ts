import { AlphaFilter, Container, FederatedPointerEvent, Graphics, Polygon } from "pixi.js";
import { gridToScreen, ObjectDef, RoomDef, screenToGrid } from "./rooms";
import { buildLayer, DIM_ALPHA, SceneRenderer } from "./renderer";

/**
 * Read-only-except-for-placement preview renderer for the admin tool —
 * same house scene as the game/viewer (reused via SceneRenderer, not
 * reimplemented). Three things layer on top of the base renderer:
 *
 * - "click a room to focus it" / "click an object to select it" (reported
 *   via onObjectClick, which admin-main.ts uses to scroll/highlight the
 *   matching row in the plain list) — the original read-only behavior.
 * - moveObject(): repositions one object's own container directly,
 *   bypassing a full scene rebuild — used for continuous x/y field edits
 *   (holding an arrow key) so that doesn't tear down and recreate the
 *   whole Pixi canvas on every keystroke (that's what was causing the
 *   "blip"). Only ever called for an object whose size/sprite hasn't
 *   changed; a type change still goes through a full rebuild.
 * - Tile placement mode: enablePlacement()/disablePlacement() draw a
 *   snapped-to-grid diamond under the pointer and report the clicked
 *   tile back — the "pseudo drag and drop" (click a tile instead of
 *   dragging continuously, which there's no browser available to verify
 *   pointer math for well enough to trust).
 */
/**
 * Keyed by renderer instance, entirely OUTSIDE the class's own field
 * system — not a class field, not even an optional one. Confirmed by
 * direct evidence (not just reasoning): instance logging showed
 * attachObjectInteraction successfully populating `this.objectContainers`
 * *during* super()'s execution (two "registered" log lines), immediately
 * followed by the constructor's own post-super() log reporting size 0 on
 * the exact same instance. That's TypeScript/JS's own class-fields
 * semantics: declaring `objectContainers?: Map<...>` with no initializer
 * still performs an implicit `this.objectContainers = undefined` the
 * moment super() returns (a real [[DefineField]] step, not a no-op just
 * because no value was written) — silently overwriting whatever a
 * polymorphic call made during super() had already set. A `??=` guard
 * inside attachObjectInteraction looked like a fix and even worked
 * *during* construction, but couldn't survive the wipe that happens
 * right after. A module-level WeakMap is never touched by any class's
 * construction sequence, so this entirely sidesteps the issue rather
 * than fighting field-initialization timing again.
 */
interface RegisteredObject {
  container: Container;
  def: ObjectDef;
}

const objectContainersByRenderer = new WeakMap<AdminPreviewRenderer, Map<number, RegisteredObject>>();
function objectContainersFor(renderer: AdminPreviewRenderer): Map<number, RegisteredObject> {
  let map = objectContainersByRenderer.get(renderer);
  if (!map) {
    map = new Map();
    objectContainersByRenderer.set(renderer, map);
  }
  return map;
}

export class AdminPreviewRenderer extends SceneRenderer {
  // Diagnostic only — STATIC (not instance) fields so they're readable
  // from attachObjectInteraction while it's being called from inside the
  // base class's own constructor, before `this.instanceId` (an instance
  // field) is assigned.
  private static instanceCounter = 0;
  private static currentlyConstructingId = 0;
  private readonly instanceId: number;

  private hoverDiamond: Graphics | null = null;
  private placingRoomContainer: Container | null = null;
  private placingGhost: Container | null = null;
  private placingObjectId: number | null = null;
  // One whole-room AlphaFilter per room, keyed here rather than reusing
  // the base class's walls-only roomWallAlphaFilters — the admin tool's
  // focus is purely on editing one room at a time, so a non-viewed room
  // (e.g. a synthesized neighbor in the connections preview) dims
  // entirely, not just its walls, unlike the real game/viewer (see
  // applyRoomDim below and renderer.ts's own comment on why those differ).
  private roomAlphaFilters = new Map<number, AlphaFilter>();

  constructor(
    app: ConstructorParameters<typeof SceneRenderer>[0],
    onRoomChange: (roomName: string) => void,
    private onObjectClick: (roomId: number, objectId: number) => void,
  ) {
    const instanceId = ++AdminPreviewRenderer.instanceCounter;
    AdminPreviewRenderer.currentlyConstructingId = instanceId;
    console.log(`[adminPreview] constructing instance #${instanceId}`);
    super(app, onRoomChange, { devMode: false, scale: 1.5 });
    this.instanceId = instanceId;
    console.log(`[adminPreview] instance #${instanceId} constructed, objectContainers size:`, objectContainersFor(this).size);
  }

  protected attachRoomInteraction(container: Container, room: RoomDef) {
    const back = gridToScreen(0, 0);
    const right = gridToScreen(room.cols, 0);
    const front = gridToScreen(room.cols, room.rows);
    const left = gridToScreen(0, room.rows);
    container.eventMode = "static";
    container.hitArea = new Polygon([back.x, back.y, right.x, right.y, front.x, front.y, left.x, left.y]);
    container.on("pointertap", () => this.setViewedRoom(room.id));
  }

  protected attachObjectInteraction(container: Container, roomId: number, obj: ObjectDef) {
    objectContainersFor(this).set(obj.id, { container, def: obj });
    console.log(
      `[adminPreview] instance #${AdminPreviewRenderer.currentlyConstructingId} registered "${obj.id}" at (${container.position.x}, ${container.position.y})`,
    );
    container.eventMode = "static";
    container.cursor = "pointer";
    container.interactiveChildren = false;
    container.on("pointertap", (e) => {
      e.stopPropagation();
      this.onObjectClick(roomId, obj.id);
    });
  }

  /** Gives every room its own whole-room AlphaFilter (see roomAlphaFilters' own comment) — walls already got their own from the base class's buildRoom, this just adds a second one wrapping the WHOLE room container on top. */
  protected onRoomContainerBuilt(roomId: number, container: Container): void {
    const filter = new AlphaFilter();
    container.filters = [filter];
    this.roomAlphaFilters.set(roomId, filter);
  }

  /** Dims the whole room (not just walls, unlike the base class's default) — the admin tool's focus is purely on editing one room at a time. */
  protected applyRoomDim(roomId: number, isViewed: boolean): void {
    const filter = this.roomAlphaFilters.get(roomId);
    if (filter) filter.alpha = isViewed ? 1 : DIM_ALPHA;
  }

  /** Moves one object's own sprite directly — no scene rebuild, so this never blips. Only valid for an already-built object (same type/size as when the scene was last built). */
  public moveObject(objectId: number, x: number, y: number): void {
    const entry = objectContainersFor(this).get(objectId);
    if (!entry) {
      console.warn(
        `[adminPreview] instance #${this.instanceId} moveObject("${objectId}") — no container registered for this id. Known ids:`,
        [...objectContainersFor(this).keys()],
      );
      return;
    }
    const { container } = entry;
    console.log(`[adminPreview] instance #${this.instanceId} moveObject("${objectId}") (${container.position.x},${container.position.y}) -> (${x},${y})`);
    container.position.set(x, y);
    // Forces an immediate repaint rather than waiting for the next
    // autoStart ticker frame — harmless if the ticker was already going
    // to pick this up on its own next frame regardless.
    this.app.render();
  }

  /** Same idea as moveObject, one level up: repositions an already-built room's own container directly — no scene rebuild — for the room-connections editor's gap/lateral-offset edits, which only ever change where an already-shown room sits, never which rooms are shown. roomContainers is SceneRenderer's own (protected) map, already populated at construction — no parallel tracking needed the way objects required a WeakMap workaround. */
  public moveRoom(roomId: number, x: number, y: number): void {
    const container = this.roomContainers.get(roomId);
    if (!container) {
      console.warn(`[adminPreview] instance #${this.instanceId} moveRoom("${roomId}") — no container registered for this id.`);
      return;
    }
    container.position.set(x, y);
    this.app.render();
  }

  /**
   * Starts tile-placement mode on whichever room is currently viewed, for
   * one specific object (`objectId`): that object's existing sprite is
   * dimmed to half-transparent in place (so it's clear it's the thing being
   * moved, not just left behind), and a ghost built from the same sprite
   * layers follows the pointer snapped to the tile grid, with the diamond
   * drawn at the ghost's own back corner — same point, so the diamond is
   * naturally "at the base" of the ghost with no separate anchor math. A
   * click reports that tile's (u, v) back to onTileClick. Call
   * disablePlacement() when done (committing or cancelling) — it does not
   * auto-disable itself on click, since the caller may want to keep placing
   * more objects.
   */
  public enablePlacement(objectId: number, onTileClick: (u: number, v: number) => void): void {
    this.disablePlacement();

    const container = this.roomContainers.get(this.viewedRoomId);
    if (!container) {
      console.warn(`[adminPreview] instance #${this.instanceId} enablePlacement — no room container for viewedRoomId "${this.viewedRoomId}"`);
      return;
    }
    const entry = objectContainersFor(this).get(objectId);
    if (!entry) {
      console.warn(`[adminPreview] instance #${this.instanceId} enablePlacement — no registered object for id "${objectId}"`);
      return;
    }
    console.log(`[adminPreview] instance #${this.instanceId} enablePlacement on room "${this.viewedRoomId}" for object "${objectId}"`);
    this.placingRoomContainer = container;
    this.placingObjectId = objectId;
    entry.container.alpha = 0.4;

    const ghost = new Container();
    ghost.alpha = 0.6;
    for (const layer of entry.def.below ?? []) {
      ghost.addChild(buildLayer(layer, entry.def.width, entry.def.height));
    }
    for (const layer of entry.def.above ?? []) {
      ghost.addChild(buildLayer(layer, entry.def.width, entry.def.height));
    }
    this.placingGhost = ghost;
    container.addChild(ghost);

    const diamond = new Graphics();
    this.hoverDiamond = diamond;
    container.addChild(diamond);

    const anchorX = entry.def.anchorX ?? 0;
    const anchorY = entry.def.anchorY ?? 0;
    const drawAt = (u: number, v: number) => {
      const back = gridToScreen(u, v);
      const right = gridToScreen(u + 1, v);
      const frontPt = gridToScreen(u + 1, v + 1);
      const left = gridToScreen(u, v + 1);
      // Ghost's anchor point (not its top-left) lands on the tile's back
      // corner — the diamond itself stays drawn at the plain tile corners,
      // so the ghost visibly shifts to show where its anchor sits relative
      // to the tile, exactly the alignment tile-mode placement produces.
      ghost.position.set(back.x - anchorX, back.y - anchorY);
      diamond
        .clear()
        .poly([back.x, back.y, right.x, right.y, frontPt.x, frontPt.y, left.x, left.y])
        .fill({ color: 0xff3366, alpha: 0.35 })
        .stroke({ width: 1, color: 0xff3366 });
      this.app.render();
    };

    let loggedFirstMove = false;
    const onMove = (e: FederatedPointerEvent) => {
      const local = e.getLocalPosition(container);
      const { u, v } = screenToGrid(local.x, local.y);
      if (!loggedFirstMove) {
        loggedFirstMove = true;
        console.log(`[adminPreview] placement hover fired — local (${local.x},${local.y}) -> tile (${Math.floor(u)},${Math.floor(v)})`);
      }
      drawAt(Math.floor(u), Math.floor(v));
    };
    const onClick = (e: FederatedPointerEvent) => {
      const local = e.getLocalPosition(container);
      const { u, v } = screenToGrid(local.x, local.y);
      console.log(`[adminPreview] placement click — local (${local.x},${local.y}) -> tile (${Math.floor(u)},${Math.floor(v)})`);
      onTileClick(Math.floor(u), Math.floor(v));
    };

    container.eventMode = "static";
    container.on("pointermove", onMove);
    container.on("pointertap", onClick);
    // Stashed on the container itself so disablePlacement can remove the
    // exact same listener instances (Pixi's .off needs the same function
    // reference, not just the event name).
    (container as Container & { _placementHandlers?: unknown })._placementHandlers = { onMove, onClick };
  }

  public disablePlacement(): void {
    if (this.hoverDiamond) {
      this.hoverDiamond.destroy();
      this.hoverDiamond = null;
    }
    if (this.placingGhost) {
      this.placingGhost.destroy({ children: true });
      this.placingGhost = null;
    }
    if (this.placingObjectId) {
      const entry = objectContainersFor(this).get(this.placingObjectId);
      if (entry) entry.container.alpha = 1;
      this.placingObjectId = null;
    }
    const container = this.placingRoomContainer as (Container & { _placementHandlers?: { onMove: (e: FederatedPointerEvent) => void; onClick: (e: FederatedPointerEvent) => void } }) | null;
    if (container?._placementHandlers) {
      container.off("pointermove", container._placementHandlers.onMove);
      container.off("pointertap", container._placementHandlers.onClick);
      delete container._placementHandlers;
    }
    this.placingRoomContainer = null;
    this.app.render();
  }
}

import { Container, FederatedPointerEvent, Graphics, Polygon } from "pixi.js";
import { gridToScreen, ObjectDef, RoomDef, screenToGrid } from "./rooms";
import { SceneRenderer } from "./renderer";

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
const objectContainersByRenderer = new WeakMap<AdminPreviewRenderer, Map<string, Container>>();
function objectContainersFor(renderer: AdminPreviewRenderer): Map<string, Container> {
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

  constructor(
    app: ConstructorParameters<typeof SceneRenderer>[0],
    onRoomChange: (roomName: string) => void,
    private onObjectClick: (roomId: string, objectId: string) => void,
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

  protected attachObjectInteraction(container: Container, roomId: string, obj: ObjectDef) {
    objectContainersFor(this).set(obj.id, container);
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

  /** Moves one object's own sprite directly — no scene rebuild, so this never blips. Only valid for an already-built object (same type/size as when the scene was last built). */
  public moveObject(objectId: string, x: number, y: number): void {
    const container = objectContainersFor(this).get(objectId);
    if (!container) {
      console.warn(
        `[adminPreview] instance #${this.instanceId} moveObject("${objectId}") — no container registered for this id. Known ids:`,
        [...objectContainersFor(this).keys()],
      );
      return;
    }
    console.log(`[adminPreview] instance #${this.instanceId} moveObject("${objectId}") (${container.position.x},${container.position.y}) -> (${x},${y})`);
    container.position.set(x, y);
    // Forces an immediate repaint rather than waiting for the next
    // autoStart ticker frame — harmless if the ticker was already going
    // to pick this up on its own next frame regardless.
    this.app.render();
  }

  /**
   * Starts tile-placement mode on whichever room is currently viewed: a
   * diamond follows the pointer, snapped to the tile grid, and a click
   * reports that tile's (u, v) back to onTileClick. Call disablePlacement()
   * when done (committing or cancelling) — it does not auto-disable itself
   * on click, since the caller may want to keep placing more objects.
   */
  public enablePlacement(onTileClick: (u: number, v: number) => void): void {
    this.disablePlacement();

    const container = this.roomContainers.get(this.viewedRoomId);
    if (!container) {
      console.warn(`[adminPreview] instance #${this.instanceId} enablePlacement — no room container for viewedRoomId "${this.viewedRoomId}"`);
      return;
    }
    console.log(`[adminPreview] instance #${this.instanceId} enablePlacement on room "${this.viewedRoomId}"`);
    this.placingRoomContainer = container;

    const diamond = new Graphics();
    this.hoverDiamond = diamond;
    container.addChild(diamond);

    const drawAt = (u: number, v: number) => {
      const back = gridToScreen(u, v);
      const right = gridToScreen(u + 1, v);
      const frontPt = gridToScreen(u + 1, v + 1);
      const left = gridToScreen(u, v + 1);
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
    const container = this.placingRoomContainer as (Container & { _placementHandlers?: { onMove: (e: FederatedPointerEvent) => void; onClick: (e: FederatedPointerEvent) => void } }) | null;
    if (container?._placementHandlers) {
      container.off("pointermove", container._placementHandlers.onMove);
      container.off("pointertap", container._placementHandlers.onClick);
      delete container._placementHandlers;
    }
    this.placingRoomContainer = null;
  }
}

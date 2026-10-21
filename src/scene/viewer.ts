import { SceneRenderer } from "./renderer";
import { findRoomForActivityLabel } from "./rooms";

export { preloadRoomAssets } from "./renderer";

/** Read-only house view for the public status page — no click handling at all (inherits the base renderer's no-op hooks). */
export class HouseViewer extends SceneRenderer {
  /** Highlights whichever activity is currently running and follows its room. */
  public showActivity(current: { label: string } | null) {
    this.updateActiveOverlays(current);
    if (current) {
      const roomId = findRoomForActivityLabel(current.label);
      if (roomId) this.setViewedRoom(roomId);
    }
  }
}

import { rooms } from "../scene/rooms";
import { FLOORS } from "../scene/floors";

function levelOfRoomName(roomName: string): number {
  return rooms.find((r) => r.name === roomName)?.level ?? 0;
}

/**
 * Builds the floor-switcher buttons from the live `FLOORS` registry (see
 * scene/floors.ts) — each floor's own `level` is its own thing (not every
 * room has to match it exactly, several rooms can share one floor, e.g.
 * office/entrance/living room are all level 0), so the active button is
 * whichever floor's own level matches the current room's level, not
 * whichever floor's base room is an exact id match. Shared by the desktop
 * app and the viewer (identical layout, just a different goToRoom).
 *
 * `goToRoom` isn't known yet at call time — both callers construct the
 * House/HouseViewer (which needs its own onRoomChange callback already
 * wired) only after this runs, since that's what goToRoom is derived
 * from. Buttons close over a reassignable `goToRoom` reference (a no-op
 * until `bindGoToRoom` is called) instead of requiring the caller to
 * figure out construction order itself.
 */
export function setupFloorButtons(): {
  bindGoToRoom(goToRoom: (roomId: number) => void): void;
  onRoomChange(currentRoomName: string): void;
} {
  const container = document.createElement("div");
  container.id = "floor-buttons";

  let goToRoom: (roomId: number) => void = () => {};

  const buttons = FLOORS.map(({ level, label, baseRoomId }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => goToRoom(baseRoomId);
    container.appendChild(btn);
    return { level, el: btn };
  });

  document.body.appendChild(container);

  return {
    bindGoToRoom(fn) {
      goToRoom = fn;
    },
    onRoomChange(currentRoomName) {
      const currentLevel = levelOfRoomName(currentRoomName);
      for (const { level, el } of buttons) {
        el.classList.toggle("active", level === currentLevel);
      }
    },
  };
}

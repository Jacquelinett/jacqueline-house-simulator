import { rooms } from "../scene/rooms";

const FLOORS: { label: string; roomId: string }[] = [
  { label: "2F", roomId: "bedroom" },
  { label: "1F", roomId: "office" },
  { label: "B", roomId: "basement" },
];

function levelOfRoomName(roomName: string): number {
  return rooms.find((r) => r.name === roomName)?.level ?? 0;
}

/**
 * Builds the floor-switcher buttons and returns a function to call on every
 * room change so whichever floor you're currently viewing stays
 * highlighted. "Floor" here means `RoomDef.level` — several rooms can share
 * one floor (e.g. office/entrance/living room are all level 0), so the
 * active button is whichever floor's own room shares the current room's
 * level, not whichever room is an exact id match. Shared by the desktop
 * app and the viewer (identical layout, just a different goToRoom).
 */
export function setupFloorButtons(goToRoom: (roomId: string) => void): (currentRoomName: string) => void {
  const container = document.createElement("div");
  container.id = "floor-buttons";

  const buttons = FLOORS.map(({ label, roomId }) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => goToRoom(roomId);
    container.appendChild(btn);
    return { level: rooms.find((r) => r.id === roomId)?.level ?? 0, el: btn };
  });

  document.body.appendChild(container);

  return (currentRoomName: string) => {
    const currentLevel = levelOfRoomName(currentRoomName);
    for (const { level, el } of buttons) {
      el.classList.toggle("active", level === currentLevel);
    }
  };
}

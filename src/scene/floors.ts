// A floor is just "a level, plus which room is its base" — formalizing
// what floorButtons.ts (desktop app + viewer) used to hardcode directly:
// clicking "1F"/"2F"/"B" always meant "go to this specific room." The base
// room is meant to be the one nothing else points at (the root of that
// floor's own connection chain — see rooms.ts's ConnectedToEntry) — the
// admin tool's own pickers enforce this both ways (a used room can't be
// picked as a base room; an existing base room can't be picked as a
// connection target — see admin-main.ts's pickableBaseRooms/
// pickableRooms), but nothing below the admin UI does: no DB constraint,
// and the plain REST API (PATCH /api/admin/rooms|floors) writes whatever
// it's given with no cross-check, so this is only as solid as "never
// skip the admin tool's own forms to edit this directly."
export interface Floor {
  level: number;
  label: string;
  baseRoomId: number;
}

/**
 * One-time seed source for the `floors` SQLite table (see
 * server/floors.ts) — NOT the runtime source of truth afterward. `FLOORS`
 * below is a mutable `let` main.ts/viewer-main.ts overwrite with
 * server-fetched data right after connecting (setFloors), same
 * live-binding pattern as rooms.ts's `rooms`/`objectTypes`. Mirrors
 * exactly what floorButtons.ts used to hardcode as its own FLOORS const.
 *
 * baseRoomId values here match STATIC_ROOM_SPECS's own explicit numeric
 * ids (rooms.ts) — bedroom=5, office=1, basement=6.
 */
export const STATIC_FLOORS: Floor[] = [
  { level: 1, label: "2F", baseRoomId: 5 },
  { level: 0, label: "1F", baseRoomId: 1 },
  { level: -1, label: "B", baseRoomId: 6 },
];

export let FLOORS: Floor[] = STATIC_FLOORS;

/** Swaps in server-fetched floors — see this file's top comment. */
export function setFloors(floors: Floor[]): void {
  FLOORS = floors;
}

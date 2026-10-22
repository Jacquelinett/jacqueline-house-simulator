// A floor is just "a level, plus which room is its base" — formalizing
// what floorButtons.ts (desktop app + viewer) used to hardcode directly:
// clicking "1F"/"2F"/"B" always meant "go to this specific room." Not
// programmatically enforced, but the base room is meant to be the one
// nothing else points at (the root of that floor's own connection chain —
// see rooms.ts's ConnectedToEntry) — same "hand-coordinated convention,
// not a validated invariant" spirit as the rest of the room system.
export interface Floor {
  level: number;
  label: string;
  baseRoomId: string;
}

/**
 * One-time seed source for the `floors` SQLite table (see
 * server/floors.ts) — NOT the runtime source of truth afterward. `FLOORS`
 * below is a mutable `let` main.ts/viewer-main.ts overwrite with
 * server-fetched data right after connecting (setFloors), same
 * live-binding pattern as rooms.ts's `rooms`/`objectTypes`. Mirrors
 * exactly what floorButtons.ts used to hardcode as its own FLOORS const.
 */
export const STATIC_FLOORS: Floor[] = [
  { level: 1, label: "2F", baseRoomId: "bedroom" },
  { level: 0, label: "1F", baseRoomId: "office" },
  { level: -1, label: "B", baseRoomId: "basement" },
];

export let FLOORS: Floor[] = STATIC_FLOORS;

/** Swaps in server-fetched floors — see this file's top comment. */
export function setFloors(floors: Floor[]): void {
  FLOORS = floors;
}

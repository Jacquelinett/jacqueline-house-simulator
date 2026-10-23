/**
 * Per-character overlay sprite resolution — pure path logic, no Pixi
 * dependency, same "declarative data, not rendering" split tileset.ts
 * already uses for floor/wall tiles (the renderer is the only thing that
 * actually loads/builds anything from what this resolves to).
 *
 * Convention: a sprite-keyed `SpriteLayer` (see that interface's own
 * comment in rooms.ts) resolves to "/characters/<spriteName>_<spriteKey>.png"
 * for whichever character is currently attributed to it — e.g. spriteName
 * "jacqueline" + key "playPiano" -> "/characters/jacqueline_playPiano.png".
 * Falls back to the layer's own plain `texture` (the shared default,
 * e.g. today's single playing_piano.png) when the character has no
 * spriteName set, or no file matching this exact convention exists —
 * resolving existence is the renderer's job (actually attempting
 * Assets.load and catching a 404), not this module's.
 */
export function characterSpritePath(spriteName: string, spriteKey: string): string {
  return `/characters/${spriteName}_${spriteKey}.png`;
}

/**
 * The universal fallback character whose own art doubles as a sprite-keyed
 * overlay's "shared default" — tried when the actually-attributed
 * character has no spriteName set, or no file matching their own name, so
 * there's no longer a separate admin-authored fallback texture to
 * maintain per overlay. Also reused by the admin tool's object-type
 * preview as its stand-in attributed character (there's no real "who's
 * doing this" in a static authoring preview), since both are really the
 * same question: "whose art do we show when there's no better answer."
 */
export const DEFAULT_SPRITE_CHARACTER = "jacqueline";

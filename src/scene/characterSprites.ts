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

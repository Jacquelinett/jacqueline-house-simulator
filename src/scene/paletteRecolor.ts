import { Texture } from "pixi.js";

interface PaletteMatch {
  anchorColor: number;
  tolerancePercent: number;
}

export interface PaletteRecolorGroup {
  match: PaletteMatch;
  color: number; // the CURRENT target color for this group — callers cycling a PaletteDef pass whichever of its `colors` is active right now
}

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Euclidean distance over the 0-255 RGB cube, normalized to 0-100 so
// tolerancePercent reads as a plain percentage rather than an opaque
// magic number — the maximum possible distance (pure black to pure
// white) is sqrt(3 * 255^2).
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);
function colorDistancePercent(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const d = Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  return (d / MAX_RGB_DISTANCE) * 100;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[paletteRecolor] failed to load ${url}`));
    img.src = url;
  });
}

// Cached by URL — a cycling PaletteDef rebuilds its texture every time
// its current color changes (see renderer.ts's tick()), which would
// otherwise mean re-fetching/re-decoding the same source image over and
// over for an object that's actively cycling.
const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImageCached(url: string): Promise<HTMLImageElement> {
  let cached = imageCache.get(url);
  if (!cached) {
    cached = loadImage(url);
    imageCache.set(url, cached);
  }
  return cached;
}

/**
 * Builds one recolored variant of a below-layer texture — the first
 * place this codebase reads/writes raw pixel data off a texture
 * (confirmed no precedent existed before this). `url` is loaded fresh
 * via a plain Canvas2D round-trip (simpler and more portable than
 * trying to read pixels back off whatever backend Pixi's own GPU
 * texture happens to be using) rather than reusing the already-loaded
 * Pixi Texture — caller should pass an already-resolved URL
 * (assetUrl(layer.texture)), same convention Assets.load() calls
 * elsewhere already follow. The underlying image is cached (see above),
 * so repeated calls for the same URL (a palette cycling through colors)
 * only pay the network/decode cost once.
 *
 * Takes every PaletteDef on the same object at once (one combined
 * texture covers all of them in a single pass, rather than each one
 * racing to overwrite the same sprite's texture independently). Each
 * pixel is tested against each group's own `match` in order; the first
 * group it falls within `tolerancePercent` of wins (a pixel matching
 * more than one group's anchor color is the rare/unexpected case —
 * first-match-wins is a reasonable tiebreak, not worth more machinery
 * for). A matching pixel's hue/saturation swaps toward that group's
 * CURRENT `color` while PRESERVING the pixel's own HSL lightness — a
 * palette swap, not a flat repaint, so shading/anti-aliasing survives.
 * Fully transparent pixels and non-matching pixels are left byte-for-
 * byte untouched.
 */
export interface PaletteRecolorResult {
  texture: Texture;
  // One count per input group, same order — lets a caller (the admin
  // preview) warn when a group matched zero pixels, since that's
  // otherwise a silent no-op: the texture comes back looking byte-for-
  // byte identical to the original, with no error anywhere.
  matchedPixelCounts: number[];
}

export async function buildPaletteTexture(url: string, groups: PaletteRecolorGroup[]): Promise<PaletteRecolorResult> {
  const img = await loadImageCached(url);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const resolvedGroups = groups.map((g) => ({
    anchor: hexToRgb(g.match.anchorColor),
    tolerancePercent: g.match.tolerancePercent,
    targetHs: rgbToHsl(...hexToRgb(g.color)).slice(0, 2) as [number, number],
  }));
  const matchedPixelCounts = groups.map(() => 0);

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    for (let groupIndex = 0; groupIndex < resolvedGroups.length; groupIndex++) {
      const group = resolvedGroups[groupIndex];
      const [ar, ag, ab] = group.anchor;
      if (colorDistancePercent(r, g, b, ar, ag, ab) > group.tolerancePercent) continue;
      matchedPixelCounts[groupIndex]++;
      const [, , l] = rgbToHsl(r, g, b);
      const [nr, ng, nb] = hslToRgb(group.targetHs[0], group.targetHs[1], l);
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
      break;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  const texture = Texture.from(canvas);
  texture.source.scaleMode = "nearest"; // keep pixel art crisp, same as every other texture this app loads
  return { texture, matchedPixelCounts };
}

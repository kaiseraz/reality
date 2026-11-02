/** Reality's figure palette: wine red, plum, dark purple, graphite black and white. */
export const FIGURE_TONES = {
  wine: '#7a1f35',
  plum: '#5b2448',
  purple: '#3f2557',
  black: '#1b1b20',
  white: '#ececee',
} as const;

/** Hue (0..1), saturation and lightness of a hex colour. */
function hsl(hex: string): { h: number; s: number; l: number } {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}

/**
 * Any bot colour, mapped onto the palette, so bots made with older colours fit too: light
 * colours become white, dark or grey ones black, reds wine, oranges and yellows plum,
 * greens and cyans black, blues and violets purple.
 */
export function muted(hex: string): string {
  const own = Object.values(FIGURE_TONES).find((t) => t === hex.toLowerCase());
  if (own) return own;
  const { h, s, l } = hsl(hex);
  if (l > 0.8 || (s < 0.15 && l > 0.5)) return FIGURE_TONES.white;
  if (l < 0.12 || s < 0.15) return FIGURE_TONES.black;
  if (h < 0.05 || h >= 0.88) return FIGURE_TONES.wine;
  if (h < 0.17) return FIGURE_TONES.plum;
  if (h < 0.5) return FIGURE_TONES.black;
  return FIGURE_TONES.purple;
}

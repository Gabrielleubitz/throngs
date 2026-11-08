/**
 * "Hands up" variant of a front-facing standing frame — used when a character needs the user
 * (jumping for attention) or is celebrating. Built from the character's own sprite: the arms hanging
 * at its sides are erased and redrawn raised beside the head in its own sleeve and skin colours, so it
 * works for every palette and hue shift. Assumes the bundled 16×32 Metro City body layout (arms at
 * columns 1-3 / 12-14, rows 21-24).
 */
import type { SpriteData } from '../types.js';

const cache = new WeakMap<SpriteData, SpriteData>();

export function getHandsUpSprite(standing: SpriteData): SpriteData {
  const hit = cache.get(standing);
  if (hit) return hit;
  const out = standing.map((row) => [...row]);
  const px = (r: number, c: number) => standing[r]?.[c] ?? '';
  const outline = px(21, 1) || px(22, 1) || px(18, 4);
  const sleeve = px(21, 2) || px(20, 4) || outline;
  const hand = px(22, 2) || px(14, 6) || sleeve;
  const handShade = px(23, 2) || hand;

  // 1) erase the arms hanging at the sides
  for (let r = 21; r <= 24; r++) {
    for (const c of [0, 1, 2, 3, 12, 13, 14, 15]) out[r][c] = '';
  }
  // 2) raised arms: diagonal sleeves from the shoulders up beside the head, hands on top
  const paint = (r: number, c: number, color: string) => {
    if (r >= 0 && r < out.length && c >= 0 && c < out[r].length && color) out[r][c] = color;
  };
  for (let r = 14; r <= 20; r++) {
    // left arm (viewer's left)
    paint(r, 1, outline);
    paint(r, 2, sleeve);
    paint(r, 3, r >= 18 ? sleeve : out[r][3]);
    // right arm
    paint(r, 14, outline);
    paint(r, 13, sleeve);
    paint(r, 12, r >= 18 ? sleeve : out[r][12]);
  }
  // hands
  for (const [r, cs] of [[11, [0, 1, 2]], [12, [0, 1, 2]], [13, [1, 2]]] as Array<[number, number[]]>) {
    for (const c of cs) paint(r, c, r === 13 ? handShade : hand);
    for (const c of cs) paint(r, 15 - c, r === 13 ? handShade : hand);
  }
  cache.set(standing, out);
  return out;
}

import { useEffect, useRef } from 'react';

import {
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  MUGSHOT_DISPLAY_PX,
  MUGSHOT_RENDER_ZOOM,
} from '../constants.js';
import { type Look, lookKey } from '../office/sprites/layers.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites, type LookTune } from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';

interface CharacterMugShotProps {
  palette: number;
  hueShift: number;
  tune?: LookTune;
  look?: Look;
  /** Show the whole front sprite (head to feet) instead of just the head. */
  body?: boolean;
  /** On-screen side length in CSS px. Defaults to MUGSHOT_DISPLAY_PX. */
  size?: number;
}

/**
 * A square "mug shot" — the head region of an agent's front-facing sprite,
 * scaled up crisply. Used as the terminal tab's identity in place of a label.
 *
 * Reuses the office sprite cache: the full front sprite is rendered once per
 * palette:hueShift, and we blit just the head square out of it.
 */
export function CharacterMugShot({
  palette,
  hueShift,
  tune,
  look,
  body,
  size = MUGSHOT_DISPLAY_PX,
}: CharacterMugShotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lk = lookKey(look);
  const { s: tuneS, b: tuneB, c: tuneC } = tune ?? { s: 0, b: 0, c: 0 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const front = getCharacterSprites(palette, hueShift, { s: tuneS, b: tuneB, c: tuneC }, JSON.parse(lk || "{}") as Look).walk[Direction.DOWN][0];
    const full = getCachedSprite(front, MUGSHOT_RENDER_ZOOM);

    if (body) {
      canvas.width = full.width;
      canvas.height = full.height;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, full.width, full.height);
      ctx.drawImage(full, 0, 0);
      return;
    }
    const side = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
    canvas.width = side;
    canvas.height = side;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(
      full,
      MUGSHOT_CROP_LEFT_COL * MUGSHOT_RENDER_ZOOM,
      MUGSHOT_CROP_TOP_ROW * MUGSHOT_RENDER_ZOOM,
      side,
      side,
      0,
      0,
      side,
      side,
    );
  }, [palette, hueShift, tuneS, tuneB, tuneC, lk, body]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      height={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      style={body ? { height: size, imageRendering: 'pixelated' } : { width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}

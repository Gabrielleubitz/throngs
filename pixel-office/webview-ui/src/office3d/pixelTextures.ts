/** Canvas helpers that bake the 2D pixel assets (sprites, floor tiles, walls) into nearest-neighbour three.js textures. */
import * as THREE from 'three';

import { getColorizedFloorSprite, hasFloorSprites } from '../office/floorTiles.js';
import type { OfficeLayout, SpriteData } from '../office/types.js';
import { COL, css, FLOOR_FALLBACK, FLOOR_SEAM, FLOOR_SPECK_DARK, FLOOR_SPECK_LIGHT, TILE_PX } from './constants3d.js';
import { hash01 } from './voxel3d.js';

/** Crisp pixels: no smoothing, no mipmaps, no anisotropic blur. */
export function pixelTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

export function paintSprite(g: CanvasRenderingContext2D, sprite: SpriteData, ox = 0, oy = 0): void {
  for (let y = 0; y < sprite.length; y++) {
    const row = sprite[y]!;
    for (let x = 0; x < row.length; x++) {
      const px = row[x];
      if (!px) continue;
      g.fillStyle = px;
      g.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

export function spriteCanvas(sprite: SpriteData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, sprite[0]?.length ?? 1);
  c.height = Math.max(1, sprite.length);
  paintSprite(c.getContext('2d')!, sprite);
  return c;
}

/** One 16px block per tile, using the same colourised floor patterns as the 2D renderer. */
export function floorCanvas(cols: number, rows: number, tiles: number[], tileColors: OfficeLayout['tileColors']): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = cols * TILE_PX; c.height = rows * TILE_PX;
  const g = c.getContext('2d')!;
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const i = r * cols + q;
    const t = tiles[i];
    if (t === undefined || t === 0 || t === 255) continue;
    if (hasFloorSprites()) {
      paintSprite(g, getColorizedFloorSprite(t, tileColors?.[i] ?? { h: 0, s: 0, b: 0, c: 0 }), q * TILE_PX, r * TILE_PX);
    } else {
      g.fillStyle = css(FLOOR_FALLBACK); g.fillRect(q * TILE_PX, r * TILE_PX, TILE_PX, TILE_PX);
    }
    // Block detail: a dark seam on two edges of every tile and a few speckles, like stone-brick flooring.
    g.fillStyle = FLOOR_SEAM;
    g.fillRect(q * TILE_PX, r * TILE_PX, TILE_PX, 1); g.fillRect(q * TILE_PX, r * TILE_PX, 1, TILE_PX);
    for (let k = 0; k < 6; k++) {
      g.fillStyle = hash01(`f${i}`, k * 3) > 0.5 ? FLOOR_SPECK_LIGHT : FLOOR_SPECK_DARK;
      g.fillRect(q * TILE_PX + 1 + Math.floor(hash01(`f${i}`, k * 3 + 1) * 14), r * TILE_PX + 1 + Math.floor(hash01(`f${i}`, k * 3 + 2) * 14), 1, 1);
    }
  }
  return c;
}

/** A 16x32 wall face in the 2D wall colour: lit top cap, brick seams, dark skirting. */
export function wallCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TILE_PX; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = css(COL.wallPx); g.fillRect(0, 0, 16, 32);
  g.fillStyle = css(COL.wallPxLo);
  for (let y = 4; y < 28; y += 4) {
    g.fillRect(0, y, 16, 1);
    const off = (y / 4) % 2 ? 0 : 8;
    for (let y2 = y - 4; y2 < y; y2++) g.fillRect(off, y2, 1, 1);
  }
  for (let y = 0; y < 28; y++) for (let x = 0; x < 16; x++) {
    const n = hash01('wall', y * 16 + x);
    if (n < 0.14) { g.fillStyle = css(COL.wallPxHi); g.fillRect(x, y, 1, 1); } else if (n > 0.92) { g.fillStyle = css(COL.wallPxLo); g.fillRect(x, y, 1, 1); }
  }
  g.fillStyle = css(COL.wallPxHi); g.fillRect(0, 0, 16, 2);
  g.fillStyle = css(COL.ink); g.fillRect(0, 28, 16, 4);
  g.fillStyle = css(COL.border); g.fillRect(0, 28, 16, 1);
  return c;
}

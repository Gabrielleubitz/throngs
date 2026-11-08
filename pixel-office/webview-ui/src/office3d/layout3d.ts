/**
 * Pure conversion of the 2D office layout into 3D world data (no three.js, unit-tested).
 * World units are metres: one tile = TILE_M, x = east, z = south, y = up. A 2D pixel (px, py) maps to
 * world (px / TILE_SIZE * TILE_M, py / TILE_SIZE * TILE_M).
 */
import { TILE_SIZE } from '../constants.js';
import type { OfficeLayout, SpriteData } from '../office/types.js';
import { css, FALLBACK_COLOR } from './constants3d.js';

export const TILE_M = 1;
export const WALL_HEIGHT = 2.8;
export const EYE_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.28;

/** What the converter needs to know about a furniture type (a subset of the catalog entry). */
export interface FurnitureInfo {
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  category?: string;
  canPlaceOnSurfaces?: boolean;
  canPlaceOnWalls?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  sprite?: SpriteData;
}

export interface Box3 {
  /** Footprint in world metres (min corner + size). */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Bottom and height above the floor. */
  y: number;
  h: number;
  color: string;
  kind: 'desk' | 'chair' | 'storage' | 'electronics' | 'decor' | 'wall-art' | 'misc';
  uid: string;
  type: string;
  orientation?: string;
  /** The 2D sprite, drawn on the box's sides so props look like the pixel office. */
  sprite?: SpriteData;
  /** Wall art: the wall tile row it hangs on (the BOTTOM row of its footprint — the top rows rise above the wall in 2D). */
  wallRow?: number;
}

export interface World3D {
  cols: number;
  rows: number;
  /** tile → true when it has a floor (anything but WALL/VOID). */
  floor: boolean[];
  wall: boolean[];
  boxes: Box3[];
  /** Tiles the player cannot walk on: walls, void, and tiles under solid furniture. */
  blocked: boolean[];
  /** Raw tile types and per-tile colours from the 2D layout, for the pixel floor/wall textures. */
  tiles: number[];
  tileColors?: OfficeLayout['tileColors'];
}

const HEIGHTS: Record<string, number> = {
  desks: 0.75,
  chairs: 0.55,
  storage: 1.6,
  electronics: 0.4,
  decor: 0.9,
  misc: 0.8,
};

export function pixelToWorld(px: number, py: number): { x: number; z: number } {
  return { x: (px / TILE_SIZE) * TILE_M, z: (py / TILE_SIZE) * TILE_M };
}

export function tileCenter(col: number, row: number): { x: number; z: number } {
  return { x: (col + 0.5) * TILE_M, z: (row + 0.5) * TILE_M };
}

/** Average opaque colour of a sprite as '#rrggbb' (falls back to a neutral grey). */
export function averageColor(sprite: SpriteData | undefined): string {
  if (!sprite) return css(FALLBACK_COLOR);
  let r = 0, g = 0, b = 0, n = 0;
  for (const row of sprite) {
    for (const px of row) {
      if (!px || px.length < 7) continue;
      if (px.length === 9 && parseInt(px.slice(7, 9), 16) < 128) continue;
      r += parseInt(px.slice(1, 3), 16);
      g += parseInt(px.slice(3, 5), 16);
      b += parseInt(px.slice(5, 7), 16);
      n++;
    }
  }
  if (!n) return css(FALLBACK_COLOR);
  const h = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function kindOf(info: FurnitureInfo): Box3['kind'] {
  if (info.canPlaceOnWalls || info.category === 'wall') return 'wall-art';
  if (info.isDesk) return 'desk';
  switch (info.category) {
    case 'chairs': return 'chair';
    case 'storage': return 'storage';
    case 'electronics': return 'electronics';
    case 'decor': return 'decor';
    default: return 'misc';
  }
}

/** Whether a piece stops the player (chairs, small desk items and wall art do not). */
export function isSolid(kind: Box3['kind']): boolean {
  return kind === 'desk' || kind === 'storage' || kind === 'misc' || kind === 'decor';
}

export function buildWorld(layout: OfficeLayout, lookup: (type: string) => FurnitureInfo | undefined): World3D {
  const { cols, rows } = layout;
  const wall = new Array<boolean>(cols * rows).fill(false);
  const floor = new Array<boolean>(cols * rows).fill(false);
  const blocked = new Array<boolean>(cols * rows).fill(false);
  for (let i = 0; i < cols * rows; i++) {
    const t = layout.tiles[i];
    wall[i] = t === 0;
    floor[i] = t !== undefined && t !== 0 && t !== 255;
    blocked[i] = !floor[i];
  }
  // Desks first so surface items can sit on top of them.
  const desks: Box3[] = [];
  const boxes: Box3[] = [];
  for (const item of layout.furniture) {
    const info = lookup(item.type);
    if (!info) continue;
    const kind = kindOf(info);
    const w = info.footprintW * TILE_M;
    const d = info.footprintH * TILE_M;
    const base: Box3 = {
      x: item.col * TILE_M, z: item.row * TILE_M, w, d, y: 0,
      h: HEIGHTS[info.category ?? 'misc'] ?? 0.8,
      color: averageColor(info.sprite), kind, uid: item.uid, type: item.type, orientation: info.orientation, sprite: info.sprite,
    };
    if (kind === 'desk') desks.push(base);
    if (kind === 'wall-art') { base.wallRow = item.row + info.footprintH - 1; base.y = 1.3; base.h = Math.max(0.5, d * 0.8); base.d = 0.08; }
    else if (info.canPlaceOnSurfaces) { base.y = HEIGHTS['desks']!; base.h = Math.min(base.h, 0.45); }
    boxes.push(base);
  }
  for (const b of boxes) {
    if (!isSolid(b.kind) || b.y > 0) continue;
    // Only the foot of a tall sprite blocks; backgroundTiles rows are walk-through, matching 2D.
    const info = lookup(b.type);
    const skip = info?.backgroundTiles ?? 0;
    const c0 = Math.round(b.x / TILE_M), r0 = Math.round(b.z / TILE_M);
    for (let r = r0 + skip; r < r0 + Math.round(b.d / TILE_M); r++)
      for (let c = c0; c < c0 + Math.round(b.w / TILE_M); c++)
        if (c >= 0 && r >= 0 && c < cols && r < rows) blocked[r * cols + c] = true;
  }
  return { cols, rows, floor, wall, boxes, blocked, tiles: layout.tiles.slice(0, cols * rows) as number[], tileColors: layout.tileColors };
}

export function isBlockedAt(world: Pick<World3D, 'cols' | 'rows' | 'blocked'>, x: number, z: number): boolean {
  const c = Math.floor(x / TILE_M), r = Math.floor(z / TILE_M);
  if (c < 0 || r < 0 || c >= world.cols || r >= world.rows) return true;
  return world.blocked[r * world.cols + c] === true;
}

/** True if a circle of `radius` at (x, z) overlaps any blocked tile. */
export function collides(world: Pick<World3D, 'cols' | 'rows' | 'blocked'>, x: number, z: number, radius = PLAYER_RADIUS): boolean {
  return (
    isBlockedAt(world, x - radius, z - radius) || isBlockedAt(world, x + radius, z - radius) ||
    isBlockedAt(world, x - radius, z + radius) || isBlockedAt(world, x + radius, z + radius)
  );
}

/** Move by (dx, dz), sliding along obstacles by resolving each axis separately. */
export function moveWithCollision(
  world: Pick<World3D, 'cols' | 'rows' | 'blocked'>,
  x: number,
  z: number,
  dx: number,
  dz: number,
  radius = PLAYER_RADIUS,
): { x: number; z: number } {
  let nx = x, nz = z;
  if (!collides(world, x + dx, z, radius)) nx = x + dx;
  if (!collides(world, nx, z + dz, radius)) nz = z + dz;
  return { x: nx, z: nz };
}

/** Nearest walkable spot to (x, z), searching outward in tile rings; null if none. */
export function nearestFree(world: Pick<World3D, 'cols' | 'rows' | 'blocked'>, x: number, z: number): { x: number; z: number } | null {
  if (!collides(world, x, z)) return { x, z };
  const c0 = Math.floor(x / TILE_M), r0 = Math.floor(z / TILE_M);
  for (let ring = 1; ring < Math.max(world.cols, world.rows); ring++) {
    for (let r = r0 - ring; r <= r0 + ring; r++)
      for (let c = c0 - ring; c <= c0 + ring; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
        const p = tileCenter(c, r);
        if (!collides(world, p.x, p.z)) return p;
      }
  }
  return null;
}

const SPAWN_SCAN_TILES = 4;
const SPAWN_YAW_STEPS = 16;
const SPAWN_RAY_STEP = 0.25;
const SPAWN_RAY_MAX = 12;

/** A default walk start: the roomiest free tile near the centre, facing the longest clear line of sight (never a wall slit). */
export function openSpawn(world: Pick<World3D, 'cols' | 'rows' | 'blocked'>): { x: number; z: number; yaw: number } {
  const cx = world.cols / 2, cz = world.rows / 2;
  let best = { x: cx, z: cz }, bestScore = -Infinity;
  for (let r = 0; r < world.rows; r++) for (let c = 0; c < world.cols; c++) {
    const p = tileCenter(c, r);
    if (collides(world, p.x, p.z)) continue;
    let clear = SPAWN_SCAN_TILES;
    for (let k = 1; k <= SPAWN_SCAN_TILES && clear === SPAWN_SCAN_TILES; k++)
      for (let dr = -k; dr <= k && clear === SPAWN_SCAN_TILES; dr++) for (let dc = -k; dc <= k; dc++)
        if (Math.max(Math.abs(dr), Math.abs(dc)) === k && isBlockedAt(world, p.x + dc * TILE_M, p.z + dr * TILE_M)) { clear = k - 1; break; }
    const score = clear * 100 - Math.hypot(p.x - cx, p.z - cz);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  const spot = nearestFree(world, best.x, best.z) ?? best;
  let yaw = 0, bestLen = -1;
  for (let i = 0; i < SPAWN_YAW_STEPS; i++) {
    const a = (i / SPAWN_YAW_STEPS) * Math.PI * 2;
    let len = 0;
    while (len < SPAWN_RAY_MAX && !collides(world, spot.x - Math.sin(a) * len, spot.z - Math.cos(a) * len)) len += SPAWN_RAY_STEP;
    if (len > bestLen) { bestLen = len; yaw = a; }
  }
  return { ...spot, yaw };
}

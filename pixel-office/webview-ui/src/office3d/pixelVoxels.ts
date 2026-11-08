/**
 * Pixel voxels: the 2D pixel art turned into tiny cubes — one cube per sprite pixel — so the 3D office is the
 * same pixel office, Minecraft-style. Pure (no three.js): it returns position/colour arrays, unit-tested.
 *
 * Modes:
 * - upright: the sprite stands up (row 0 at the top), each opaque pixel extruded `depth` along z.
 *   Characters, chairs, plants, shelves, wall art, desk items.
 * - fold: for 3/4-view desks/tables, whose sprite shows the top surface above the front face. The bottom
 *   `frontRows` rows stand up as the front (extruded through the depth); the rows above lie flat on top,
 *   receding to the back.
 *
 * Coordinates: x centred on 0, y from 0 (floor) up, z centred on 0 with +z = the side facing the viewer
 * (the 2D art is drawn as seen from the south, so +z is "south"). Faces hidden by a neighbouring cube are
 * skipped, and each face carries a fixed shade (lit top, darker sides) for the blocky look.
 */
import type { SpriteData } from '../office/types.js';

export const FACE_SHADE = { top: 1, front: 0.84, back: 0.7, side: 0.68, bottom: 0.5 };

export interface UprightOpts { mode: 'upright'; px: number; depth: number }
export interface FoldOpts { mode: 'fold'; px: number; depth: number; frontRows: number }
export type VoxelOpts = UprightOpts | FoldOpts;

export interface VoxelArrays {
  positions: Float32Array;
  colors: Float32Array;
  /** Number of opaque pixels turned into cubes. */
  cubes: number;
  /** Size of the model: width (x), height (y), depth (z). */
  size: { w: number; h: number; d: number };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** '#rrggbb' / '#rrggbbaa' → linear RGB, or null when transparent (empty, or alpha < 50%). */
export function pixelColor(px: string | undefined): [number, number, number] | null {
  if (!px || px[0] !== '#' || px.length < 7) return null;
  if (px.length >= 9 && parseInt(px.slice(7, 9), 16) < 128) return null;
  return [toLinear(parseInt(px.slice(1, 3), 16) / 255), toLinear(parseInt(px.slice(3, 5), 16) / 255), toLinear(parseInt(px.slice(5, 7), 16) / 255)];
}

class Builder {
  pos: number[] = [];
  col: number[] = [];
  /** One quad (two triangles) with corners a,b,c,d counter-clockwise seen from outside. */
  quad(a: number[], b: number[], c: number[], d: number[], rgb: [number, number, number], shade: number): void {
    const [r, g, bl] = rgb;
    for (const v of [a, b, c, a, c, d]) { this.pos.push(v[0]!, v[1]!, v[2]!); this.col.push(r * shade, g * shade, bl * shade); }
  }
  /** An axis-aligned box [x0,x1]×[y0,y1]×[z0,z1]; `open` says which faces are visible. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, rgb: [number, number, number],
    open: { top: boolean; bottom: boolean; left: boolean; right: boolean; front: boolean; back: boolean }): void {
    if (open.front) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], rgb, FACE_SHADE.front);
    if (open.back) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], rgb, FACE_SHADE.back);
    if (open.top) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], rgb, FACE_SHADE.top);
    if (open.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], rgb, FACE_SHADE.bottom);
    if (open.left) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], rgb, FACE_SHADE.side);
    if (open.right) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rgb, FACE_SHADE.side);
  }
}

export function buildVoxels(sprite: SpriteData, opts: VoxelOpts): VoxelArrays {
  const H = sprite.length;
  const W = sprite.reduce((m, row) => Math.max(m, row.length), 0);
  const solid = (c: number, r: number) => r >= 0 && r < H && c >= 0 && c < W && pixelColor(sprite[r]![c]) !== null;
  const b = new Builder();
  const s = opts.px;
  const x0 = (-W * s) / 2;
  let cubes = 0;
  const front = opts.mode === 'fold' ? Math.max(0, Math.min(H, opts.frontRows)) : H;
  const topRows = H - front; // fold: rows 0..topRows-1 lie flat
  const z0 = -opts.depth / 2, z1 = opts.depth / 2;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const rgb = pixelColor(sprite[r]![c]);
      if (!rgb) continue;
      cubes++;
      const xa = x0 + c * s, xb = xa + s;
      if (r >= topRows) {
        // upright part: row r → height counted from the bottom row
        const ya = (H - 1 - r) * s, yb = ya + s;
        // (in fold mode the flat top layer sits right on the top front row, so a solid pixel above hides it too)
        b.box(xa, xb, ya, yb, z0, z1, rgb, {
          top: !solid(c, r - 1),
          bottom: !solid(c, r + 1),
          left: !solid(c - 1, r),
          right: !solid(c + 1, r),
          front: true,
          back: true,
        });
      } else {
        // fold: flat top layer one cube thick, row topRows-1 at the front edge, row 0 at the back
        const ya = front * s, yb = ya + s;
        const dz = opts.depth / topRows;
        const za = z1 - (topRows - r) * dz, zb = za + dz;
        b.box(xa, xb, ya, yb, za, zb, rgb, {
          top: true,
          bottom: front === 0,
          left: !solid(c - 1, r),
          right: !solid(c + 1, r),
          front: r === topRows - 1 || !solid(c, r + 1),
          back: r === 0 || !solid(c, r - 1),
        });
      }
    }
  }
  const height = opts.mode === 'fold' ? (front + (topRows > 0 ? 1 : 0)) * s : H * s;
  return { positions: new Float32Array(b.pos), colors: new Float32Array(b.col), cubes, size: { w: W * s, h: height, d: opts.depth } };
}

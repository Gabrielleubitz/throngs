/**
 * Real 3D pixel models for the office — every object is a little voxel sculpture you can walk around, coloured
 * with the exact colours of its 2D sprite (one voxel = one sprite pixel = 1/16 of a tile).
 *
 * - People: carved from their four 2D drawings (front, back, side) — a voxel is kept where the front, back and
 *   side silhouettes all agree, and each face takes its colour from the drawing that looks at it.
 * - Round things (bin, cup, plants, cactus, pot): spun around their axis like a lathe; off-axis bits (a cup
 *   handle) stay as a thin piece.
 * - Furniture (desks, tables, sofas, chairs, benches, PCs, shelves, whiteboards): built from parts (tops, legs,
 *   seats, backrests, arms, monitor, keyboard, cabinet), coloured from the sprite's own palette; flat faces that
 *   carry a picture (screen, books, board) show the sprite itself.
 *
 * Pure — returns position/colour arrays. Model frame: x centred, y up from 0, z centred, +z = the front.
 */
import type { SpriteData } from '../office/types.js';
import { FACE_SHADE, pixelColor } from './pixelVoxels.js';

export type RGB = [number, number, number];
type Face = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';

/** A W×H×D grid of coloured voxels. */
export class Grid {
  readonly cells: Array<RGB | null>;
  /** Optional per-face colouring (people: each side shows its own drawing). */
  faceColor?: (x: number, y: number, z: number, face: Face) => RGB | null;
  readonly W: number;
  readonly H: number;
  readonly D: number;
  constructor(W: number, H: number, D: number) {
    this.W = W; this.H = H; this.D = D;
    this.cells = new Array<RGB | null>(Math.max(0, W * H * D)).fill(null);
  }
  private i(x: number, y: number, z: number) { return (y * this.D + z) * this.W + x; }
  in(x: number, y: number, z: number) { return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D; }
  get(x: number, y: number, z: number): RGB | null { return this.in(x, y, z) ? this.cells[this.i(x, y, z)]! : null; }
  set(x: number, y: number, z: number, c: RGB | null): void { if (this.in(x, y, z)) this.cells[this.i(x, y, z)] = c; }
  /** Fill [x0,x1)×[y0,y1)×[z0,z1) with a colour, or a colour function. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB | ((x: number, y: number, z: number) => RGB | null)): void {
    for (let y = Math.max(0, y0); y < Math.min(this.H, y1); y++)
      for (let z = Math.max(0, z0); z < Math.min(this.D, z1); z++)
        for (let x = Math.max(0, x0); x < Math.min(this.W, x1); x++) this.set(x, y, z, typeof c === 'function' ? c(x, y, z) : c);
  }
  count(): number { return this.cells.reduce((n, c) => n + (c ? 1 : 0), 0); }
}

/** Small stable noise so flat colours read as Minecraft-like blocks. */
function grain(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return 0.93 + (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000 * 0.07;
}

export interface MeshArrays { positions: Float32Array; colors: Float32Array; voxels: number }

/** Grid → triangles: one quad per visible voxel face, shaded per face, centred on x/z, standing on y = 0. */
export function meshGrid(g: Grid, px: number): MeshArrays {
  const pos: number[] = [], col: number[] = [];
  const ox = -g.W / 2, oz = -g.D / 2;
  const quad = (a: number[], b: number[], c: number[], d: number[], rgb: RGB, k: number) => {
    for (const v of [a, b, c, a, c, d]) { pos.push(v[0]! * px, v[1]! * px, v[2]! * px); col.push(rgb[0] * k, rgb[1] * k, rgb[2] * k); }
  };
  let voxels = 0;
  for (let y = 0; y < g.H; y++) for (let z = 0; z < g.D; z++) for (let x = 0; x < g.W; x++) {
    const base = g.get(x, y, z);
    if (!base) continue;
    voxels++;
    const n = grain(x, y, z);
    const x0 = x + ox, x1 = x0 + 1, y0 = y, y1 = y + 1, z0 = z + oz, z1 = z0 + 1;
    const face = (f: Face, shade: number, a: number[], b: number[], c: number[], d: number[]) => {
      const rgb = g.faceColor?.(x, y, z, f) ?? base;
      quad(a, b, c, d, rgb, shade * n);
    };
    if (!g.get(x, y, z + 1)) face('front', FACE_SHADE.front, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    if (!g.get(x, y, z - 1)) face('back', FACE_SHADE.back, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
    if (!g.get(x, y + 1, z)) face('top', FACE_SHADE.top, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    if (!g.get(x, y - 1, z)) face('bottom', FACE_SHADE.bottom, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (!g.get(x - 1, y, z)) face('left', FACE_SHADE.side, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    if (!g.get(x + 1, y, z)) face('right', FACE_SHADE.side, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), voxels };
}

// ── sprite helpers ───────────────────────────────────────────────────────────

const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const at = (s: SpriteData, x: number, y: number): RGB | null => pixelColor(s[y]?.[x]);
const spriteW = (s: SpriteData) => s.reduce((m, r) => Math.max(m, r.length), 0);

/** Most common opaque colour in a band of rows (fractions of the height). */
export function dominant(s: SpriteData, from = 0, to = 1, skipDark = true): RGB {
  const counts = new Map<string, { c: RGB; n: number }>();
  const H = s.length;
  for (let y = Math.floor(from * H); y < Math.max(Math.floor(from * H) + 1, Math.ceil(to * H)); y++)
    for (let x = 0; x < (s[y]?.length ?? 0); x++) {
      const c = at(s, x, y);
      if (!c || (skipDark && lum(c) < 0.02)) continue; // outlines are not the material
      const k = c.join(',');
      const e = counts.get(k);
      if (e) e.n++; else counts.set(k, { c, n: 1 });
    }
  let best: { c: RGB; n: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best?.c ?? (skipDark ? dominant(s, from, to, false) : [0.3, 0.3, 0.3]);
}
export function darkest(s: SpriteData): RGB {
  let best: RGB = [0.05, 0.05, 0.05], bl = Infinity;
  for (let y = 0; y < s.length; y++) for (let x = 0; x < (s[y]?.length ?? 0); x++) { const c = at(s, x, y); if (c && lum(c) < bl) { bl = lum(c); best = c; } }
  return best;
}
const shade = (c: RGB, k: number): RGB => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

/** Opaque bounding box of a sprite. */
export function bbox(s: SpriteData): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  for (let y = 0; y < s.length; y++) for (let x = 0; x < (s[y]?.length ?? 0); x++) if (at(s, x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, x1, y0, y1 };
}

/** Colour of the sprite picture mapped onto a rectangle (u,v in 0..1, v = 0 at the top). Nearest opaque pixel. */
function sample(s: SpriteData, u: number, v: number, b = bbox(s)): RGB | null {
  if (!b) return null;
  const x = Math.min(b.x1, Math.max(b.x0, Math.floor(b.x0 + u * (b.x1 - b.x0 + 1))));
  const y = Math.min(b.y1, Math.max(b.y0, Math.floor(b.y0 + v * (b.y1 - b.y0 + 1))));
  return at(s, x, y) ?? at(s, x, Math.min(b.y1, y + 1)) ?? at(s, Math.min(b.x1, x + 1), y);
}

// ── shapes ──────────────────────────────────────────────────────────────────

/** Lathe: each sprite row becomes a disc around the sprite's vertical axis; off-axis pixels stay as a thin fin. */
export function lathe(s: SpriteData): Grid {
  const H = s.length, W = spriteW(s);
  const b = bbox(s);
  const g = new Grid(W, H, W);
  if (!b) return g;
  // axis = the median row centre, so a handle on a few rows can't drag it sideways (and fatten the whole cup)
  const centres: number[] = [];
  for (let r = 0; r < H; r++) {
    let a = -1, e = -1;
    for (let x = 0; x < W; x++) if (at(s, x, r)) { if (a < 0) a = x; e = x + 1; }
    if (a >= 0) centres.push((a + e) / 2);
  }
  centres.sort((p, q) => p - q);
  const cx = centres[Math.floor(centres.length / 2)] ?? (b.x0 + b.x1 + 1) / 2, cz = W / 2;
  for (let r = 0; r < H; r++) {
    const cols: number[] = [];
    for (let x = 0; x < W; x++) if (at(s, x, r)) cols.push(x);
    if (!cols.length) continue;
    const a = cols[0]!, e = cols[cols.length - 1]! + 1;
    const R = Math.max(0.5, Math.min(cx - a, e - cx));
    const y = H - 1 - r;
    for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      if (dx * dx + dz * dz > R * R) continue;
      g.set(x, y, z, at(s, x, r) ?? at(s, Math.round(cx), r) ?? at(s, cols[Math.floor(cols.length / 2)]!, r));
    }
    for (const x of cols) if (Math.abs(x + 0.5 - cx) > R) for (const z of [Math.floor(cz) - 1, Math.floor(cz)]) g.set(x, y, z, at(s, x, r));
  }
  return g;
}

/** People: carve from the front, back and (right) side drawings; every face shows the drawing that looks at it. */
export function hull(front: SpriteData, back: SpriteData, side: SpriteData): Grid {
  const H = Math.max(front.length, side.length), W = spriteW(front), D = spriteW(side);
  const g = new Grid(W, H, D);
  const row = (y: number) => H - 1 - y;
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const f = at(front, x, row(y)), sd = at(side, z, row(y)), bk = at(back, W - 1 - x, row(y));
    if (f && sd && (bk || !back.length)) g.set(x, y, z, f);
  }
  g.faceColor = (x, y, z, face) => {
    const r = row(y);
    switch (face) {
      case 'front': return at(front, x, r);
      case 'back': return at(back, W - 1 - x, r) ?? at(front, x, r);
      case 'left': case 'right': return at(side, z, r);
      default: return z >= D / 2 ? at(front, x, r) : at(back, W - 1 - x, r) ?? at(front, x, r);
    }
  };
  return g;
}

export type ModelKind = 'desk' | 'table' | 'coffee-table' | 'sofa' | 'cushioned-chair' | 'wooden-chair' | 'bench' | 'pc' | 'shelf' | 'board' | 'round';

/** Which model an office furniture type gets (by its catalog id). null = no model (fall back to the flat method). */
export function modelKindFor(type: string): ModelKind | null {
  const t = type.split(':')[0]!.toUpperCase();
  if (/^(BIN|COFFEE|PLANT|PLANT_2|LARGE_PLANT|CACTUS|POT)$/.test(t)) return 'round';
  if (t.startsWith('DESK')) return 'desk';
  if (t.startsWith('COFFEE_TABLE')) return 'coffee-table';
  if (t.startsWith('TABLE') || t.startsWith('SMALL_TABLE')) return 'table';
  if (t.startsWith('SOFA')) return 'sofa';
  if (t.startsWith('CUSHIONED_CHAIR')) return 'cushioned-chair';
  if (t.startsWith('WOODEN_CHAIR')) return 'wooden-chair';
  if (t.includes('BENCH')) return 'bench';
  if (t.startsWith('PC')) return 'pc';
  if (t.includes('BOOKSHELF')) return 'shelf';
  if (t.startsWith('WHITEBOARD')) return 'board';
  return null;
}

/**
 * A furniture model for a footprint of `w`×`d` voxels (already turned so `w` is the width it faces with).
 * `h` = its height in voxels.
 */
export function furniture(kind: Exclude<ModelKind, 'round'>, s: SpriteData, w: number, d: number, h: number): Grid {
  const top = dominant(s, 0, 0.5), low = dominant(s, 0.5, 1), dark = darkest(s);
  const legC = shade(dark, 1.6);
  const leg = (g: Grid, x0: number, z0: number, x1: number, z1: number, y1: number) => {
    for (const [x, z] of [[x0, z0], [x1 - 2, z0], [x0, z1 - 2], [x1 - 2, z1 - 2]] as const) g.box(x, x + 2, 0, y1, z, z + 2, legC);
  };
  switch (kind) {
    case 'desk': case 'table': case 'coffee-table': {
      const H = kind === 'coffee-table' ? 7 : 12;
      const g = new Grid(w, H, d);
      g.box(0, w, H - 2, H, 0, d, top); // the top, two voxels thick
      g.box(0, w, H - 3, H - 2, 0, 1, shade(low, 0.9)); g.box(0, w, H - 3, H - 2, d - 1, d, low); // apron front/back
      leg(g, 1, 1, w - 1, d - 1, H - 2);
      if (kind === 'desk') g.box(2, w - 2, 3, H - 3, 1, 2, shade(low, 0.8)); // modesty panel at the back
      return g;
    }
    case 'sofa': {
      const g = new Grid(w, 13, d);
      const body = low, cushion = top, base = shade(dark, 1.4);
      g.box(0, w, 0, 2, 1, d - 1, base); // plinth
      g.box(0, w, 2, 6, 0, d, body); // seat base
      g.box(3, w - 3, 6, 8, 4, d - 1, cushion); // seat cushions
      g.box(0, w, 2, 13, 0, 4, body); // backrest
      g.box(3, w - 3, 8, 12, 3, 4, cushion); // back cushions
      g.box(0, 3, 2, 10, 0, d, body); g.box(w - 3, w, 2, 10, 0, d, body); // arms
      return g;
    }
    case 'cushioned-chair': {
      const g = new Grid(w, 15, d);
      leg(g, 3, 3, w - 3, d - 3, 4);
      g.box(2, w - 2, 4, 7, 2, d - 2, low); // seat
      g.box(3, w - 3, 7, 8, 4, d - 3, top); // cushion
      g.box(2, w - 2, 4, 15, 2, 5, low); // back
      g.box(3, w - 3, 8, 14, 5, 6, top); // back cushion
      return g;
    }
    case 'wooden-chair': {
      const g = new Grid(w, 15, d);
      const wood = dominant(s, 0, 1);
      leg(g, 3, 3, w - 3, d - 3, 7);
      g.box(3, w - 3, 7, 8, 3, d - 3, wood); // seat
      for (const x of [3, w - 5]) g.box(x, x + 2, 8, 15, 3, 5, shade(wood, 0.9)); // back posts
      g.box(3, w - 3, 12, 14, 3, 4, wood); // back rail
      return g;
    }
    case 'bench': {
      const g = new Grid(w, 8, d);
      leg(g, 1, Math.max(1, Math.floor(d / 2) - 4), w - 1, Math.min(d - 1, Math.floor(d / 2) + 4), 5);
      g.box(0, w, 5, 7, Math.max(0, Math.floor(d / 2) - 5), Math.min(d, Math.floor(d / 2) + 5), low);
      g.box(1, w - 1, 7, 8, Math.max(0, Math.floor(d / 2) - 4), Math.min(d, Math.floor(d / 2) + 4), top);
      return g;
    }
    case 'pc': {
      // a chunky CRT on a stand, keyboard in front; the screen shows the sprite's own picture
      const MW = Math.min(w - 2, 12), MH = 10, MD = Math.min(d - 4, 9);
      const g = new Grid(w, MH + 3, d);
      const x0 = Math.floor((w - MW) / 2), z0 = 1;
      const body = dominant(s, 0, 1);
      g.box(x0 + 3, x0 + MW - 3, 0, 1, z0 + 2, z0 + MD - 2, shade(body, 0.8)); // foot
      g.box(x0 + 5, x0 + MW - 5, 1, 3, z0 + 3, z0 + MD - 3, shade(body, 0.8)); // neck
      g.box(x0, x0 + MW, 3, 3 + MH, z0, z0 + MD, body); // monitor body
      const b = bbox(s);
      g.box(x0 + 1, x0 + MW - 1, 4, 2 + MH, z0 + MD - 1, z0 + MD, (x, y) => sample(s, (x - x0 - 1) / (MW - 2), 1 - (y - 4) / (MH - 2), b) ?? body); // screen
      if (d - (z0 + MD) >= 3) g.box(x0 + 1, x0 + MW - 1, 0, 1, z0 + MD + 1, z0 + MD + 3, shade(dark, 2.2)); // keyboard
      return g;
    }
    case 'shelf': {
      const D = Math.min(d, 7);
      const g = new Grid(w, h, d);
      const frame = dominant(s, 0, 1);
      const z0 = 0;
      g.box(0, w, 0, h, z0, z0 + D, frame);
      const b = bbox(s);
      // the front face is the sprite (books, shelves), recessed one voxel inside the frame
      g.box(1, w - 1, 1, h - 1, z0 + D - 1, z0 + D, (x, y) => sample(s, (x - 1) / (w - 2), 1 - (y - 1) / (h - 2), b) ?? frame);
      return g;
    }
    case 'board': {
      const g = new Grid(w, h, d);
      const b = bbox(s);
      const zc = Math.floor(d / 2);
      for (const x of [1, w - 3]) g.box(x, x + 2, 0, Math.floor(h * 0.4), zc - 1, zc + 1, legC); // legs
      g.box(0, w, Math.floor(h * 0.35), h, zc, zc + 1, (x, y) => sample(s, x / w, 1 - (y - Math.floor(h * 0.35)) / (h - Math.floor(h * 0.35)), b) ?? top);
      return g;
    }
  }
}

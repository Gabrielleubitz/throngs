import { describe, expect, it } from 'vitest';

import type { OfficeLayout } from '../src/office/types.js';
import { buildWorld } from '../src/office3d/layout3d.js';
import { furniture, Grid, hull, lathe, meshGrid, modelKindFor } from '../src/office3d/models3d.js';

const C = `#${'888888'}`;
const K = `#${'222222'}`;
/** A sprite of `w`×`h` with a filled rectangle [x0,x1)×[y0,y1). */
const rect = (w: number, h: number, x0: number, x1: number, y0: number, y1: number, c = C) =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? c : '')));

/** Extent of the filled voxels along one axis. */
function extent(g: Grid, axis: 'x' | 'z'): number {
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < g.H; y++) for (let z = 0; z < g.D; z++) for (let x = 0; x < g.W; x++)
    if (g.get(x, y, z)) { const v = axis === 'x' ? x : z; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return hi - lo + 1;
}

describe('3D pixel models (walk round them)', () => {
  it('a bin is spun into a real round object: as deep as it is wide', () => {
    const bin = lathe(rect(16, 16, 4, 12, 2, 14));
    expect(extent(bin, 'x')).toBe(8);
    expect(extent(bin, 'z')).toBe(8);
  });

  it('a cup keeps its handle as a thin piece instead of fattening the whole cup', () => {
    // body cols 9-14, handle col 7 on two rows
    const s = rect(16, 8, 9, 15, 0, 7);
    s[3]![7] = C; s[4]![7] = C;
    const g = lathe(s);
    expect(extent(g, 'z')).toBe(6); // the body stays body-sized in depth
    let handle = 0;
    for (let z = 0; z < g.D; z++) if (g.get(7, 8 - 1 - 3, z)) handle++;
    expect(handle).toBe(2);
  });

  it('a person is carved from front, back and side: real depth, each side showing its own drawing', () => {
    const front = rect(16, 32, 4, 12, 0, 32);
    const side = rect(16, 32, 6, 10, 0, 32, K);
    const g = hull(front, front, side);
    expect(extent(g, 'x')).toBe(8);
    expect(extent(g, 'z')).toBe(4);
    expect(g.faceColor?.(6, 5, 7, 'left')).toEqual(g.faceColor?.(6, 5, 7, 'right'));
    expect(g.faceColor?.(6, 5, 7, 'front')).not.toEqual(g.faceColor?.(6, 5, 7, 'left'));
  });

  it('every furniture type in the office gets a model', () => {
    for (const t of ['DESK_FRONT', 'SOFA_FRONT', 'SOFA_SIDE:left', 'PC_FRONT_OFF', 'CUSHIONED_CHAIR_BACK', 'WOODEN_CHAIR_SIDE', 'CUSHIONED_BENCH', 'BOOKSHELF', 'DOUBLE_BOOKSHELF', 'COFFEE_TABLE', 'SMALL_TABLE_FRONT', 'TABLE_FRONT', 'WHITEBOARD', 'BIN', 'COFFEE', 'PLANT', 'LARGE_PLANT', 'CACTUS'])
      expect(modelKindFor(t), t).not.toBeNull();
    expect(modelKindFor('CLOCK')).toBeNull(); // wall art stays a flat piece on the wall
  });

  it('furniture models are solid 3D (a sofa has a backrest taller than its seat) and mesh into faces', () => {
    const sofa = furniture('sofa', rect(32, 16, 0, 32, 0, 16), 32, 16, 9);
    expect(sofa.get(16, 11, 1)).not.toBeNull(); // backrest at the back
    expect(sofa.get(16, 11, 14)).toBeNull(); // nothing that high at the front
    const m = meshGrid(sofa, 1 / 16);
    expect(m.voxels).toBe(sofa.count());
    expect(m.positions.length).toBeGreaterThan(0);
  });

  it('wall art hangs on the wall tile at the BOTTOM row of its footprint (not floating in the hallway)', () => {
    const layout = { version: 1, cols: 3, rows: 4, tiles: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], furniture: [{ uid: 'p', type: 'LARGE_PAINTING', col: 0, row: 0 }] } as unknown as OfficeLayout;
    const w = buildWorld(layout, () => ({ footprintW: 2, footprintH: 2, isDesk: false, canPlaceOnWalls: true, category: 'wall' }));
    expect(w.boxes[0]!.wallRow).toBe(1);
  });
});

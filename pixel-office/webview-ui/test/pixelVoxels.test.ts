import { describe, expect, it } from 'vitest';

import { buildVoxels, FACE_SHADE, pixelColor } from '../src/office3d/pixelVoxels.js';

const R = `#${'ff0000'}`;
const G = `#${'00ff00'}`;
const SEMI = `#${'0000ff40'}`; // alpha 25% → transparent
const faces = (n: number) => n / 18; // 6 vertices × 3 floats per face

describe('pixel voxels: one tiny cube per sprite pixel', () => {
  it('reads colours and treats empty / mostly-transparent pixels as holes', () => {
    expect(pixelColor('')).toBeNull();
    expect(pixelColor(SEMI)).toBeNull();
    expect(pixelColor(R)).toEqual([1, 0, 0]);
  });

  it('a single pixel is a full cube: 6 faces, sized by px and depth, standing on the floor', () => {
    const v = buildVoxels([[R]], { mode: 'upright', px: 0.1, depth: 0.3 });
    expect(v.cubes).toBe(1);
    expect(faces(v.positions.length)).toBe(6);
    expect(v.size).toEqual({ w: 0.1, h: 0.1, d: 0.3 });
    const ys = [...v.positions].filter((_, i) => i % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(0.1);
  });

  it('hides faces between neighbouring cubes and skips transparent pixels', () => {
    // two pixels side by side + one hole: 2 cubes, the shared left/right faces are dropped
    const v = buildVoxels([[R, G, '']], { mode: 'upright', px: 1, depth: 1 });
    expect(v.cubes).toBe(2);
    expect(faces(v.positions.length)).toBe(10);
  });

  it('row 0 is the top of the sprite (upright), and faces carry the blocky shade', () => {
    const v = buildVoxels([[R], [G]], { mode: 'upright', px: 1, depth: 1 });
    expect(v.size.h).toBe(2);
    // the top face (shade 1) of the red pixel is at y = 2
    let foundTopRed = false;
    for (let i = 0; i < v.positions.length; i += 3) {
      if (v.positions[i + 1] === 2 && v.colors[i] === FACE_SHADE.top && v.colors[i + 1] === 0) foundTopRed = true;
    }
    expect(foundTopRed).toBe(true);
  });

  it('fold mode lays the upper rows flat as a table top over the standing front rows', () => {
    // 4 rows: rows 2-3 stand as the front face, rows 0-1 lie flat on top
    const sprite = [[R], [R], [G], [G]];
    const v = buildVoxels(sprite, { mode: 'fold', px: 0.25, depth: 1, frontRows: 2 });
    expect(v.cubes).toBe(4);
    expect(v.size.h).toBeCloseTo(0.75); // 2 front rows + one flat layer
    const zs = [...v.positions].filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(-0.5);
    expect(Math.max(...zs)).toBeCloseTo(0.5);
  });
});

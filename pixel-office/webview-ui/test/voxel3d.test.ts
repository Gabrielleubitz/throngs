import { describe, expect, it } from 'vitest';

import { figureColors, hash01, lookColor, tint } from '../src/office3d/voxel3d.js';

describe('voxel3d helpers', () => {
  it('hash01 is deterministic and in range', () => {
    expect(hash01('a', 3)).toBe(hash01('a', 3));
    for (let i = 0; i < 50; i++) { const v = hash01('x', i); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
  });
  it('tint darkens and lightens', () => {
    expect(tint(0x808080, 0.5)).toBe(0x404040);
    expect(tint(0x000000, 2)).toBe(0xffffff);
  });
  it('resolves swatch ids and hex, with fallback', () => {
    expect(lookColor('red', 0)).toBe(0xd94a4a);
    expect(lookColor('112233', 0)).toBe(0x112233);
    expect(lookColor(undefined, 7)).toBe(7);
  });
  it('keeps the crown and glasses from the look', () => {
    const c = figureColors(1, { hat: 'crown', accessory: 'glasses' });
    expect(c.crown).toBe(true); expect(c.glasses).toBe(true); expect(c.hatColor).toBeNull();
    expect(figureColors(2, { hat: 'cap' }).hatColor).not.toBeNull();
  });
});

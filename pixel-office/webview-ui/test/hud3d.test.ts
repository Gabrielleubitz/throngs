import { describe, expect, it } from 'vitest';

describe('3D HUD rules', () => {
  it('shrinks then drops far bubbles', async () => {
    const { bubbleScale } = await import('../src/office3d/hud3d.js');
    expect([bubbleScale(3), bubbleScale(10), bubbleScale(20)]).toEqual([1, 0.75, 0]);
  });
  it('holds the controls hint, then fades it out', async () => {
    const { hintOpacity, HINT_HOLD_MS, HINT_FADE_MS } = await import('../src/office3d/hud3d.js');
    expect(hintOpacity(0)).toBe(1);
    expect(hintOpacity(HINT_HOLD_MS + HINT_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(hintOpacity(HINT_HOLD_MS + HINT_FADE_MS * 2)).toBe(0);
  });
  it('projects NDC to pixels and rejects behind-camera points', async () => {
    const { ndcToScreen, reportsLabel } = await import('../src/office3d/hud3d.js');
    expect(ndcToScreen(0, 0, 0.5, 200, 100)).toEqual({ x: 100, y: 50 });
    expect(ndcToScreen(0, 0, 1.2, 200, 100)).toBeNull();
    expect(ndcToScreen(2, 0, 0.5, 200, 100)).toBeNull();
    expect(reportsLabel(0)).toBe('REPORTS');
    expect(reportsLabel(2)).toBe('2 NEW REPORTS!');
  });
});

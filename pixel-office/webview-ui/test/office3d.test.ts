import { describe, expect, it } from 'vitest';

import type { OfficeLayout } from '../src/office/types.js';
import { pickTalkTarget, screenKey, wrapText } from '../src/office3d/agents3d.js';
import {
  averageColor, buildWorld, collides, moveWithCollision, nearestFree, openSpawn, pixelToWorld, tileCenter,
} from '../src/office3d/layout3d.js';
import { spriteDirFor } from '../src/office3d/scene3d.js';

const RED = `#${'ff0000'}`;
// 5x4: wall border, floor inside; a 1x1 desk at (2,1).
const tiles = [
  0, 0, 0, 0, 0,
  0, 1, 1, 1, 0,
  0, 1, 1, 1, 0,
  0, 0, 0, 0, 0,
];
const layout = {
  version: 1, cols: 5, rows: 4, tiles,
  furniture: [{ uid: 'd1', type: 'DESK', col: 2, row: 1 }, { uid: 'c1', type: 'CHAIR', col: 1, row: 2 }],
} as unknown as OfficeLayout;
const world = buildWorld(layout, (t) =>
  t === 'DESK'
    ? { footprintW: 1, footprintH: 1, isDesk: true, category: 'desks', sprite: [[RED]] }
    : { footprintW: 1, footprintH: 1, isDesk: false, category: 'chairs' });

describe('layout conversion', () => {
  it('maps pixels and tiles to metres', () => {
    expect(pixelToWorld(16, 32)).toEqual({ x: 1, z: 2 });
    expect(tileCenter(2, 1)).toEqual({ x: 2.5, z: 1.5 });
  });
  it('blocks walls and desks but not chairs', () => {
    expect(world.blocked[0]).toBe(true);
    expect(world.blocked[1 * 5 + 2]).toBe(true);
    expect(world.blocked[2 * 5 + 1]).toBe(false);
    expect(world.boxes.map((b) => b.kind).sort()).toEqual(['chair', 'desk']);
  });
  it('averages sprite colour', () => {
    expect(averageColor([[RED, '']])).toBe(RED);
    expect(averageColor(undefined)).toBe(`#${'8a8a96'}`);
  });
});

describe('collision', () => {
  it('detects walls, desks and out-of-bounds', () => {
    expect(collides(world, 1.5, 1.5)).toBe(false);
    expect(collides(world, 0.5, 1.5)).toBe(true);
    expect(collides(world, 2.5, 1.5)).toBe(true);
    expect(collides(world, -3, 1.5)).toBe(true);
  });
  it('slides along a wall instead of stopping', () => {
    const p = moveWithCollision(world, 1.4, 2.5, -1, -0.2);
    expect(p.x).toBeCloseTo(1.4); // blocked on x by the west wall
    expect(p.z).toBeLessThan(2.5); // free on z
  });
  it('finds the nearest free spot', () => {
    const p = nearestFree(world, 0.5, 0.5)!;
    expect(collides(world, p.x, p.z)).toBe(false);
  });
});

describe('default spawn', () => {
  it('starts on a free tile facing open space', () => {
    const s = openSpawn(world);
    expect(collides(world, s.x, s.z)).toBe(false);
    const ahead = { x: s.x - Math.sin(s.yaw) * 0.4, z: s.z - Math.cos(s.yaw) * 0.4 };
    expect(collides(world, ahead.x, ahead.z)).toBe(false);
  });
});

describe('agents helpers', () => {
  it('wraps and truncates text', () => {
    expect(wrapText('aaa bbb ccc', 7, 5)).toEqual(['aaa bbb', 'ccc']);
    const l = wrapText('one two three four five six', 8, 2);
    expect(l).toHaveLength(2);
    expect(l[1]!.endsWith('…')).toBe(true);
  });
  it('screen key changes with the task', () => {
    const a = { name: 'A', state: 'IDLE' as const, task: '', lastAction: null };
    expect(screenKey(a)).not.toBe(screenKey({ ...a, task: 'x' }));
  });
  it('picks the agent in front within range', () => {
    const front = { x: 0, z: -1 }, behind = { x: 0, z: 1 }, far = { x: 0, z: -9 };
    expect(pickTalkTarget(0, 0, 0, [behind, far, front])).toBe(front);
    expect(pickTalkTarget(0, 0, 0, [behind, far])).toBeNull();
  });
});

describe('spriteDirFor', () => {
  it('shows the front when the agent faces the viewer and the back when turned away', () => {
    expect(spriteDirFor(0, 0, 3)).toBe(0);
    expect(spriteDirFor(0, 0, -3)).toBe(3);
  });
  it('shows the side sprite matching what the viewer sees', () => {
    expect(spriteDirFor(2, 0, 3)).toBe(2);
    expect(spriteDirFor(1, 0, 3)).toBe(1);
  });
});

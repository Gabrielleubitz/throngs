import { describe, expect, it } from 'vitest';

import type { StaffRecord } from '../src/sm/crew.js';
import { setCrew } from '../src/sm/crew.js';
import { throngVoice } from '../src/sm/throngVoice.js';

const staff = (n: number): StaffRecord[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, agentId: 9000000 + i, name: `M${i}`, title: 't', kind: 'engineer', room: 'r', palette: 0, hueShift: 0, brief: '' }));

describe('throngVoice', () => {
  it('gives each of 24 crew members their own personality and pitch', () => {
    setCrew(staff(24));
    const vs = Array.from({ length: 24 }, (_, i) => throngVoice(`m${i}`));
    expect(new Set(vs.map((v) => v.trait)).size).toBe(24);
    expect(new Set(vs.map((v) => v.catchphrase)).size).toBe(24);
    expect(new Set(vs.map((v) => v.rate.toFixed(4))).size).toBe(24);
  });
  it('is stable for the same member', () => {
    setCrew(staff(5));
    expect(throngVoice('m3')).toEqual(throngVoice('m3'));
  });
});

import { describe, expect, it, vi } from 'vitest';

import { setCrew } from '../src/sm/crew.js';
import type { StaffRecord } from '../src/sm/crew.js';
import { CHORDS, FORMATIONS, FORMATION_BARS, formationIndex, formationSpots, isMusicOn, studioPool, rateOf, semitones, setMusicOn, songBar, studioSpots, subscribeMusic } from '../src/sm/throngStudio.js';
import { throngVoice } from '../src/sm/throngVoice.js';

const staff = (n: number): StaffRecord[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, agentId: 9000000 + i, name: `M${i}`, title: 't', kind: 'engineer', room: 'r', palette: 0, hueShift: 0, brief: '' }));

/** A 6×8 grid: a Studio area in cols 1-4 rows 1-6, everything else another room. */
const grid = () => {
  const cols = 6, rows = 8;
  return { cols, area: Array.from({ length: cols * rows }, (_, i) => { const c = i % cols, r = Math.floor(i / cols); return c >= 1 && c <= 4 && r >= 1 && r <= 6 ? 'Studio' : 'Other'; }) };
};

describe('studio dance floor', () => {
  it('only free Studio tiles, never two dancers side by side, away from the stage row', () => {
    const { cols, area } = grid();
    const spots = studioSpots(cols, area, (c, r) => !(c === 2 && r === 4));
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      expect(area[s.row * cols + s.col]).toBe('Studio');
      expect((s.col + s.row) % 2).toBe(0);
      expect(s.row).toBeGreaterThanOrEqual(4);
      expect(s).not.toEqual({ col: 2, row: 4 });
    }
    expect(new Set(spots.map((s) => `${s.col},${s.row}`)).size).toBe(spots.length);
  });
  it('no Studio in the layout = nowhere to dance', () => {
    expect(studioSpots(3, ['Lounge', 'Lounge', null], () => true)).toEqual([]);
    expect(studioSpots(3, undefined, () => true)).toEqual([]);
  });
});

describe('studio song', () => {
  it('keeps a beat with no singers', () => {
    const notes = songBar(0, []);
    expect(notes.filter((n) => n.kind === 'kick').length).toBeGreaterThan(0);
    expect(notes.some((n) => 'clip' in n)).toBe(false);
  });
  it('each verse bar one throng leads with its own part and catchphrase, the next one answers', () => {
    setCrew(staff(3));
    const ids = ['m0', 'm1', 'm2'];
    const leads = [0, 1, 2, 4].map((b) => songBar(b, ids).filter((n) => n.kind === 'sing'));
    for (const l of leads) expect(l).toHaveLength(1);
    expect(new Set(leads.slice(0, 3).map((l) => ('id' in l[0] ? l[0].id : '')))).toEqual(new Set(ids));
    const first = leads[0][0];
    if (!('clip' in first) || !first.id) throw new Error('no lead');
    const v = throngVoice(first.id);
    expect(first.clip).toBe(v.sing);
    expect(first.lyric).toContain(v.catchphrase);
    expect(first.shift).toBe(semitones(v.rate) + CHORDS[0]);
    expect(songBar(0, ids).some((n) => n.kind === 'purr')).toBe(true);
  });
  it('every 4th bar is a chorus: everyone sings together over the group choir', () => {
    setCrew(staff(5));
    const ids = ['m0', 'm1', 'm2', 'm3', 'm4'];
    const bar = songBar(3, ids);
    expect(bar.filter((n) => n.kind === 'sing').map((n) => ('id' in n ? n.id : null)).sort()).toEqual(ids);
    expect(bar.some((n) => n.kind === 'group')).toBe(true);
  });
  it('voices snap to whole semitones', () => {
    expect(semitones(rateOf(-5))).toBe(-5);
    expect(rateOf(12)).toBeCloseTo(2);
  });
});

describe('music switch', () => {
  it('notifies on change only', () => {
    let n = 0;
    const off = subscribeMusic(() => n++);
    setMusicOn(true); setMusicOn(true);
    expect(isMusicOn()).toBe(true);
    setMusicOn(false);
    off();
    expect(n).toBe(2);
  });
});

/** The real Studio: cols 46-57, rows 9-21 of a 60×24 office. */
const realPool = () => {
  const cols = 60, area = Array.from({ length: cols * 24 }, (_, i) => { const c = i % cols, r = Math.floor(i / cols); return c >= 46 && c <= 57 && r >= 9 && r <= 21 ? 'Studio' : null; });
  return studioPool(cols, area, () => true);
};
const key = (t: { col: number; row: number }) => `${t.col},${t.row}`;

describe('dance formations', () => {
  const pool = realPool();
  it('the real Studio has room for 16 dancers', () => expect(pool.length).toBeGreaterThanOrEqual(30));
  for (const f of FORMATIONS.map((x, i) => [x.name, i] as const)) {
    for (const n of [1, 2, 7, 16]) {
      it(`${f[0]} with ${n}: one free Studio tile each, nobody shares`, () => {
        const spots = formationSpots(pool, n, f[1]);
        expect(spots).toHaveLength(n);
        expect(new Set(spots.map(key)).size).toBe(n);
        for (const s of spots) expect(pool.some((p) => p.col === s.col && p.row === s.row)).toBe(true);
      });
    }
  }
  it('a pool smaller than the crowd wraps instead of crashing', () => {
    const small = pool.slice(0, 3);
    const spots = formationSpots(small, 7, 0);
    expect(spots).toHaveLength(7);
    for (const s of spots) expect(small.some((p) => p.col === s.col && p.row === s.row)).toBe(true);
  });
  it('empty pool or no dancers gives nothing', () => {
    expect(formationSpots([], 5, 0)).toEqual([]);
    expect(formationSpots(pool, 0, 0)).toEqual([]);
  });
  it('8 dancers: every pattern is a different arrangement', () => {
    const shapes = FORMATIONS.map((_, i) => formationSpots(pool, 8, i).map(key).sort().join('|'));
    expect(new Set(shapes).size).toBe(FORMATIONS.length);
  });
  it('circle: every dancer about the same distance from the middle', () => {
    const spots = formationSpots(pool, 8, 0);
    const cx = spots.reduce((a, s) => a + s.col, 0) / 8, cy = spots.reduce((a, s) => a + s.row, 0) / 8;
    const d = spots.map((s) => Math.hypot((s.col - cx) / 1, (s.row - cy) / 1));
    expect(Math.max(...d) / Math.min(...d)).toBeLessThan(1.8);
  });
  it('line: two tidy rows for a big crowd, V: ends higher than the point', () => {
    const rows = new Set(formationSpots(pool, 8, 1).map((s) => s.row));
    expect(rows.size).toBeLessThanOrEqual(3);
    const v = formationSpots(pool, 7, 3);
    expect(v[0].row).toBeLessThan(v[3].row);
    expect(v[6].row).toBeLessThan(v[3].row);
  });
  it('pattern changes after FORMATION_BARS bars of music, cycling through all of them', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      setMusicOn(true);
      const barMs = (60 / 104) * 4 * 1000;
      expect(formationIndex()).toBe(0);
      expect(formationIndex(Date.now() + barMs * (FORMATION_BARS - 0.5))).toBe(0);
      expect(formationIndex(Date.now() + barMs * FORMATION_BARS + 1)).toBe(1);
      expect(formationIndex(Date.now() + barMs * FORMATION_BARS * FORMATIONS.length + 1)).toBe(0);
      setMusicOn(false);
      expect(formationIndex()).toBe(0);
    } finally { vi.useRealTimers(); setMusicOn(false); }
  });
  it('the chorus keeps total singer gain bounded', () => {
    const notes = songBar(3, Array.from({ length: 16 }, (_, i) => `m${i}`)).filter((n) => n.kind === 'sing');
    expect(notes.length).toBeLessThanOrEqual(8);
    expect(notes.length * (0.8 / Math.sqrt(notes.length))).toBeLessThan(2.5);
  });
});

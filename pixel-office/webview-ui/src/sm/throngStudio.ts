/**
 * The Studio: press 🎵 MUSIC (top-left) and every idle throng walks to the Studio room (office-layout/generate.js),
 * dances on its floor and sings in its own voice. The song is stitched from their own clips: a beat
 * (kick / snare / hats + bass, synthesised), a chord loop, one throng singing its part each bar, purrs answering
 * on the off-beat and a group chorus every 4th bar. Audio follows the 🔊 switch; the dancing does not.
 */
import { SM_DANCE_BPM } from '../constants.js';
import type { CrewId } from './crew.js';
import { isSmSoundEnabled } from './smSounds.js';
import { playClipAt, preloadClip, PRRR, throngAudio, throngVoice } from './throngVoice.js';

export const STUDIO = 'Studio';

// ── music switch ──
let musicOn = false;
const subs = new Set<() => void>();
export const isMusicOn = (): boolean => musicOn;
let musicStart = 0;
export const setMusicOn = (on: boolean): void => {
  if (musicOn === on) return;
  musicOn = on;
  if (on) { musicStart = Date.now(); if (isSmSoundEnabled()) try { throngAudio(); void preloadSong(); } catch { /* audio unavailable */ } } // inside the click: audio may start, clips are ready
  for (const f of subs) f();
};
export const subscribeMusic = (f: () => void): (() => void) => { subs.add(f); return () => { subs.delete(f); }; };

// ── dance floor ──
/**
 * Where dancers stand: free Studio tiles on a checkerboard (nobody stands on anyone), front rows first and
 * the middle first so a small crowd gathers in front of the stage. Skips the row right under the stage.
 */
export function studioSpots(cols: number, areaTiles: ReadonlyArray<string | null> | undefined, free: (col: number, row: number) => boolean): Array<{ col: number; row: number }> {
  if (!areaTiles) return [];
  const tiles: Array<{ col: number; row: number }> = [];
  areaTiles.forEach((label, i) => { if (label === STUDIO) tiles.push({ col: i % cols, row: Math.floor(i / cols) }); });
  if (!tiles.length) return [];
  const minR = Math.min(...tiles.map((t) => t.row)), maxR = Math.max(...tiles.map((t) => t.row));
  const minC = Math.min(...tiles.map((t) => t.col)), maxC = Math.max(...tiles.map((t) => t.col));
  const midC = (minC + maxC) / 2, midR = (minR + maxR) / 2 + 1;
  return tiles
    .filter((t) => t.row >= minR + 3 && t.row < maxR && t.col > minC && t.col < maxC && (t.col + t.row) % 2 === 0 && free(t.col, t.row))
    .sort((a, b) => (Math.abs(a.col - midC) + Math.abs(a.row - midR)) - (Math.abs(b.col - midC) + Math.abs(b.row - midR)) || a.row - b.row || a.col - b.col);
}

/** Every free Studio tile a dancer may stand on (no checkerboard: formations need fine placement). */
export function studioPool(cols: number, areaTiles: ReadonlyArray<string | null> | undefined, free: (col: number, row: number) => boolean): Array<{ col: number; row: number }> {
  if (!areaTiles) return [];
  const tiles: Array<{ col: number; row: number }> = [];
  areaTiles.forEach((label, i) => { if (label === STUDIO) tiles.push({ col: i % cols, row: Math.floor(i / cols) }); });
  if (!tiles.length) return [];
  const minR = Math.min(...tiles.map((t) => t.row)), maxR = Math.max(...tiles.map((t) => t.row));
  const minC = Math.min(...tiles.map((t) => t.col)), maxC = Math.max(...tiles.map((t) => t.col));
  return tiles.filter((t) => t.row >= minR + 3 && t.row < maxR && t.col > minC && t.col < maxC && free(t.col, t.row));
}

/** Choreography: each pattern maps dancer i of n to a point in -1..1 on both axes (x right, y toward the audience). */
export const FORMATIONS: Array<{ name: string; at: (i: number, n: number) => [number, number] }> = [
  { name: 'circle', at: (i, n) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)] },
  { name: 'line', at: (i, n) => { const rows = n > 6 ? 2 : 1, per = Math.ceil(n / rows), r = Math.floor(i / per), c = i % per; return [per === 1 ? 0 : (c / (per - 1)) * 2 - 1, rows === 1 ? 0.3 : r * 0.7 - 0.1]; } },
  { name: 'rings', at: (i, n) => { const inner = Math.max(1, Math.floor(n / 3)); const o = i >= inner, k = o ? i - inner : i, m = o ? n - inner : inner, rad = o ? 1 : 0.45; return [rad * Math.cos((2 * Math.PI * k) / m), rad * Math.sin((2 * Math.PI * k) / m)]; } },
  { name: 'V', at: (i, n) => { const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; return [t, 1 - Math.abs(t) * 1.6]; } },
  { name: 'diamond', at: (i, n) => { const a = (2 * Math.PI * i) / n, c = Math.cos(a), s = Math.sin(a), d = Math.abs(c) + Math.abs(s); return [c / d, s / d]; } },
  { name: 'spiral', at: (i, n) => { const a = i * 2.4, r = 0.25 + 0.75 * (i / Math.max(1, n - 1)); return [r * Math.cos(a), r * Math.sin(a)]; } },
  { name: 'columns', at: (i, n) => { const cols = n > 8 ? 4 : n > 3 ? 3 : n, per = Math.ceil(n / cols), c = i % cols, r = Math.floor(i / cols); return [cols === 1 ? 0 : (c / (cols - 1)) * 2 - 1, per === 1 ? 0 : (r / (per - 1)) * 2 - 1]; } },
];
/** Bars each pattern is held (the walk between two patterns takes a couple of bars). */
export const FORMATION_BARS = 8;
/** Which pattern is on now, by the music clock (0 when the music is off). */
export const formationIndex = (now = Date.now()): number => {
  if (!musicOn) return 0;
  const barMs = (60 / SM_DANCE_BPM) * 4 * 1000;
  return Math.floor((now - musicStart) / (barMs * FORMATION_BARS)) % FORMATIONS.length;
};

/**
 * Dancer i's tile for pattern `index` among n dancers: the pool tile nearest to the pattern's ideal point
 * (scaled to the floor, mirrored round its centre). Nobody shares a tile unless the floor is smaller than the crowd.
 */
export function formationSpots(pool: ReadonlyArray<{ col: number; row: number }>, n: number, index: number): Array<{ col: number; row: number }> {
  if (!pool.length || n <= 0) return [];
  const minC = Math.min(...pool.map((t) => t.col)), maxC = Math.max(...pool.map((t) => t.col));
  const minR = Math.min(...pool.map((t) => t.row)), maxR = Math.max(...pool.map((t) => t.row));
  const cx = (minC + maxC) / 2, cy = (minR + maxR) / 2, rx = Math.max(0.5, (maxC - minC) / 2), ry = Math.max(0.5, (maxR - minR) / 2);
  const f = FORMATIONS[((index % FORMATIONS.length) + FORMATIONS.length) % FORMATIONS.length];
  const left = pool.slice();
  const out: Array<{ col: number; row: number }> = [];
  for (let i = 0; i < n; i++) {
    if (!left.length) { out.push(out[i % pool.length]); continue; }
    const [x, y] = f.at(i, n);
    const px = cx + x * rx, py = cy + y * ry;
    let best = 0, bd = Infinity;
    left.forEach((t, k) => { const d = (t.col - px) ** 2 + ((t.row - py) * 1.2) ** 2; if (d < bd) { bd = d; best = k; } });
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

// ── the song ──
/** I–V–vi–IV, as semitone shifts from each throng's own pitch (voices go down, never squeak). */
export const CHORDS = [0, -5, -3, -7];
const BASS_HZ = [65.41, 49.0, 55.0, 43.65]; // C2 G1 A1 F1
export const BARS = 16;
const GROUP = ['01', '02', '03', '04'].map((n) => `vo_throng_sing_group_small_${n}`);

export type SongNote =
  | { beat: number; kind: 'kick' | 'snare' | 'hat' }
  | { beat: number; kind: 'bass'; hz: number }
  | { beat: number; kind: 'sing' | 'purr' | 'group'; id: CrewId | null; clip: string; shift: number; lyric?: string };

/** Nearest whole semitone of a playback rate, so every voice sits on the song's scale. */
export const semitones = (rate: number): number => Math.round(12 * Math.log2(rate));
export const rateOf = (semis: number): number => 2 ** (semis / 12);

/** Everything that plays in one bar (beats 0..4), given the throngs on the dance floor. Pure, so it is testable. */
export function songBar(bar: number, singers: CrewId[]): SongNote[] {
  const b = ((bar % BARS) + BARS) % BARS;
  const chord = CHORDS[b % CHORDS.length];
  const out: SongNote[] = [];
  for (let i = 0; i < 8; i++) out.push({ beat: i / 2, kind: 'hat' });
  out.push({ beat: 0, kind: 'kick' }, { beat: 2, kind: 'kick' }, { beat: 2.5, kind: 'kick' }, { beat: 1, kind: 'snare' }, { beat: 3, kind: 'snare' });
  const hz = BASS_HZ[b % BASS_HZ.length];
  out.push({ beat: 0, kind: 'bass', hz }, { beat: 1.5, kind: 'bass', hz }, { beat: 2, kind: 'bass', hz: hz * 1.5 }, { beat: 3, kind: 'bass', hz });
  if (!singers.length) return out;
  if (b % 4 === 3) {
    // chorus: everyone sings their own part together, a tiny bit apart, over the group choir
    singers.slice(0, 8).forEach((id, i) => {
      const v = throngVoice(id);
      out.push({ beat: (i % 4) * 0.25, kind: 'sing', id, clip: v.sing, shift: semitones(v.rate) + chord, lyric: '♪ la la la ♪' });
    });
    out.push({ beat: 0, kind: 'group', id: null, clip: GROUP[Math.floor(b / 4) % GROUP.length], shift: chord });
    return out;
  }
  // verse: one throng takes the lead each bar (their catchphrase is the lyric); the next one answers with a purr
  const lead = singers[(b - Math.floor(b / 4)) % singers.length];
  const v = throngVoice(lead);
  out.push({ beat: 0, kind: 'sing', id: lead, clip: v.sing, shift: semitones(v.rate) + chord, lyric: `♪ ${v.catchphrase} ♪` });
  if (singers.length > 1) {
    const back = singers[(b + 1) % singers.length];
    const bv = throngVoice(back);
    out.push({ beat: 2.5, kind: 'purr', id: back, clip: bv.prrr || PRRR[0], shift: semitones(bv.rate) + chord });
  }
  return out;
}

// ── playback (Web Audio, scheduled a little ahead so it keeps time) ──
let timer: ReturnType<typeof setInterval> | null = null;
let bus: GainNode | null = null;
let noise: AudioBuffer | null = null;
let nextBarAt = 0;
let bar = 0;

function drum(c: AudioContext, out: AudioNode, kind: 'kick' | 'snare' | 'hat', at: number): void {
  if (kind === 'kick') {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(140, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
    g.gain.setValueAtTime(0.35, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
    o.connect(g).connect(out); o.start(at); o.stop(at + 0.25);
    return;
  }
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate * 0.3, c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = noise;
  f.type = 'highpass'; f.frequency.value = kind === 'hat' ? 7000 : 1500;
  const len = kind === 'hat' ? 0.04 : 0.15;
  g.gain.setValueAtTime(kind === 'hat' ? 0.08 : 0.25, at); g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(f).connect(g).connect(out); src.start(at); src.stop(at + len + 0.02);
}

function bass(c: AudioContext, out: AudioNode, hz: number, at: number, dur: number): void {
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle'; o.frequency.value = hz;
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.22, at + 0.02); g.gain.exponentialRampToValueAtTime(0.001, at + dur);
  o.connect(g).connect(out); o.start(at); o.stop(at + dur + 0.02);
}

/** Fetch + decode every clip the song uses, so the first bars are not silent while files load. */
export async function preloadSong(ids: CrewId[] = []): Promise<void> {
  const names = new Set<string>([...GROUP, ...PRRR.slice(0, 1)]);
  for (let i = 1; i <= 6; i++) names.add(`vo_thronglet_sing_0${i}`);
  for (const id of ids) { const v = throngVoice(id); names.add(v.sing); names.add(v.prrr); }
  await Promise.all([...names].map((n) => preloadClip(n)));
}

/**
 * Start the song. `singers()` is asked every bar (throngs who reached the dance floor); `onSing` fires when a
 * throng's line starts, for its speech bubble. Calling again while playing does nothing.
 */
export function startSong(singers: () => CrewId[], onSing: (id: CrewId, lyric: string) => void): void {
  if (timer) return;
  const beatSec = 60 / SM_DANCE_BPM;
  const barSec = beatSec * 4;
  bar = 0;
  nextBarAt = 0;
  const tick = () => {
    if (!isSmSoundEnabled()) { // silent: keep the bars (and bubbles) going on the wall clock
      const now = performance.now() / 1000;
      if (nextBarAt === 0 || nextBarAt > now + 60) nextBarAt = now;
      if (now < nextBarAt) return;
      for (const n of songBar(bar, singers())) if ('lyric' in n && n.lyric && n.id) { onSing(n.id, n.lyric); break; }
      bar++; nextBarAt += barSec;
      return;
    }
    const c = throngAudio();
    if (!bus) { // a compressor keeps the 8-voice chorus + drums from clipping
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.2;
      comp.connect(c.destination);
      bus = c.createGain(); bus.gain.value = 0.7; bus.connect(comp);
    }
    if (nextBarAt < c.currentTime) nextBarAt = c.currentTime + 0.1;
    while (nextBarAt < c.currentTime + 0.35) {
      const at0 = nextBarAt;
      const notes = songBar(bar, singers());
      let shown = false;
      const voices = notes.filter((n) => n.kind === 'sing').length;
      const singGain = 0.8 / Math.sqrt(Math.max(1, voices)); // sung parts sit on top of the drums; 8 voices stay under the compressor // more singers → each a bit quieter
      for (const n of notes) {
        const at = at0 + n.beat * beatSec;
        if ('hz' in n) bass(c, bus, n.hz, at, beatSec * 0.9);
        else if (!('clip' in n)) drum(c, bus, n.kind, at);
        else {
          void playClipAt(n.clip, rateOf(n.shift), n.kind === 'group' ? 0.6 : n.kind === 'purr' ? 0.5 : singGain, at, bus);
          if (n.kind === 'sing' && n.id && n.lyric && !shown) {
            shown = true;
            const id = n.id, lyric = n.lyric;
            setTimeout(() => { if (timer) onSing(id, lyric); }, Math.max(0, (at - c.currentTime) * 1000));
          }
        }
      }
      bar++;
      nextBarAt += barSec;
    }
  };
  timer = setInterval(tick, 100);
  tick();
}

/** Stop the song at once (fades the mix out so nothing clicks). */
export function stopSong(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (bus) {
    const b = bus, c = b.context;
    bus = null;
    try { b.gain.setTargetAtTime(0, c.currentTime, 0.05); setTimeout(() => b.disconnect(), 400); } catch { /* audio unavailable */ }
  }
}

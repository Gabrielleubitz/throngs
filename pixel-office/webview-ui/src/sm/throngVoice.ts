/**
 * Thronglet voices: every crew member is a throng with their own voice and personality.
 * Clips come from the Thronglets game (public/assets/throng). A member's voice = a fixed pitch,
 * a favourite sing part and a personality derived from their id, so it never changes between visits.
 */
import type { CrewId } from './crew.js';
import { CREW } from './crew.js';
import { isSmSoundEnabled } from './smSounds.js';

const BASE = './assets/throng/';
export const PRRR = Array.from({ length: 13 }, (_, i) => `vo_thronglet_prrr_${String(i + 1).padStart(2, '0')}`);
const UPSET = ['04', '06', '09', '11'].map((n) => `vo_thronglet_upset_${n}`);
const SING = ['04', '03', '06', '05', '02', '01'].map((n) => `vo_thronglet_sing_${n}`); // parts A–F

export interface Personality { trait: string; quirk: string; catchphrase: string; sing: string }
const T = (trait: string, quirk: string, catchphrase: string): Personality => ({ trait, quirk, catchphrase, sing: '' });
/** 24 different personalities; each crew member gets their own by roster position (see throngVoice). */
const TRAITS: Personality[] = [
  T('Cheerful', 'Prrrs at every small win', 'Prrr! That went well!'),
  T('Grumpy', 'Sighs first, then does it perfectly', 'Fine. I will do it.'),
  T('Curious', 'Pokes at everything to see how it works', 'Ooh, what does this do?'),
  T('Dramatic', 'Every bug is the end of the world', 'This changes EVERYTHING!'),
  T('Sleepy', 'Naps between jobs, wakes up sharp', 'Five more minutes... ok, done.'),
  T('Show-off', 'Announces every finished task', 'Look what I made!'),
  T('Nervous', 'Double-checks everything twice', 'Are we sure? Let me check again.'),
  T('Foodie', 'Thinks about apples while typing', 'Apple break after this one.'),
  T('Bossy', 'Rearranges everyone\'s to-do list', 'Okay team, new plan!'),
  T('Shy', 'Hides behind the monitor when praised', '...thank you. Quietly.'),
  T('Hyper', 'Types three things at once', 'Done done done next next next!'),
  T('Philosopher', 'Asks why before every task', 'But what IS a deadline?'),
  T('Prankster', 'Hides a tiny emoji in every report', 'Hehe. Did you see it?'),
  T('Perfectionist', 'Straightens every pixel', 'One more tiny tweak.'),
  T('Lazy', 'Finds the shortest path to everything', 'There must be an easier way.'),
  T('Brave', 'Volunteers for the scary bugs', 'I will go in first!'),
  T('Gossip', 'Knows what every other throng is doing', 'Psst, did you hear?'),
  T('Poet', 'Describes commits in rhyme', 'A fix at dawn, the tests are green.'),
  T('Detective', 'Follows every error back to its source', 'The logs never lie.'),
  T('Optimist', 'Sees a feature in every bug', 'It is not broken, it is surprising!'),
  T('Pessimist', 'Expects the worst, ships the best', 'This will never work. ...it worked.'),
  T('Sporty', 'Does squats between builds', 'Sprint time! Hup hup!'),
  T('Cozy', 'Brings a tiny blanket to the desk', 'Everything is better warm.'),
  T('Chatty', 'Narrates every keystroke', 'And now I am typing the next line!'),
];

const hash = (s: string): number => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

export interface ThrongVoice extends Personality { rate: number; prrr: string; upset: string }
const cache = new Map<string, ThrongVoice>();
const SLOTS = TRAITS.length;
/** Roster position (hires append, so it is stable); an unknown id falls back to a hash. */
const slotOf = (id: CrewId): number => {
  const i = CREW.findIndex((c) => c.id === id);
  return i >= 0 ? i : hash(id);
};
export function throngVoice(id: CrewId): ThrongVoice {
  const slot = slotOf(id);
  const key = `${id}#${slot}`;
  let v = cache.get(key);
  if (!v) {
    const n = slot % SLOTS;
    const round = Math.floor(slot / SLOTS); // only past 24 crew: same personality, shifted voice
    const p = TRAITS[n];
    // 7 is coprime with 24, so every slot lands on its own pitch; prrr/upset/sing rotate with it.
    v = { ...p, sing: SING[n % SING.length], rate: 0.72 + (((n * 7 + round * 3) % SLOTS) / SLOTS) * 0.75, prrr: PRRR[(n + round) % PRRR.length], upset: UPSET[(n >> 1) % UPSET.length] };
    cache.set(key, v);
  }
  return v;
}

const buffers = new Map<string, Promise<AudioBuffer | null>>();
let ctx: AudioContext | null = null;
let lastAt = 0;
function load(name: string): Promise<AudioBuffer | null> {
  let p = buffers.get(name);
  if (!p) {
    ctx ||= new AudioContext();
    const c = ctx;
    p = fetch(`${BASE}${name}.wav`).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b)).catch(() => null);
    buffers.set(name, p);
  }
  return p;
}

/** Load a clip ahead of time (no sound). */
export const preloadClip = (name: string): Promise<AudioBuffer | null> => load(name);

/** The shared audio context (made on first use). */
export function throngAudio(): AudioContext {
  ctx ||= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Play a clip at an absolute audio-context time (the studio song schedules ahead with this). Returns the source so it can be stopped. */
export async function playClipAt(name: string, rate: number, vol: number, at: number, out?: AudioNode): Promise<AudioBufferSourceNode | null> {
  if (!isSmSoundEnabled()) return null;
  try {
    const buf = await load(name);
    if (!buf || !ctx) return null;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    g.gain.value = vol;
    src.connect(g).connect(out ?? ctx.destination);
    src.start(Math.max(at, ctx.currentTime));
    return src;
  } catch { return null; /* audio unavailable */ }
}

async function play(name: string, rate: number, vol = 0.35, delay = 0): Promise<void> {
  if (!isSmSoundEnabled()) return;
  try { const c = throngAudio(); await playClipAt(name, rate, vol, c.currentTime + delay); } catch { /* audio unavailable */ }
}

export type ThrongMood = 'talk' | 'happy' | 'upset' | 'sing';
/** Make this throng vocalise in its own voice. Global 250ms spacing so a burst of events never piles up. */
export function throngSay(id: CrewId, mood: ThrongMood = 'talk'): void {
  const now = Date.now();
  if (now - lastAt < 250) return;
  lastAt = now;
  const v = throngVoice(id);
  if (mood === 'upset') void play(v.upset, v.rate * 0.95);
  else if (mood === 'happy') void play(v.prrr, v.rate);
  else if (mood === 'sing') void play(v.sing, v.rate, 0.3);
  else void play(PRRR[(hash(id + Date.now() % 7) % PRRR.length)], v.rate, 0.3);
}

/** A random noise from an idle throng (sound on only): a chirp, a purr, a hum of its song part or a little emote. */
export function throngIdleNoise(id: CrewId, rand: () => number = Math.random): 'emote' | ThrongMood {
  const r = rand();
  const kind = r < 0.3 ? 'emote' : r < 0.6 ? 'talk' : r < 0.85 ? 'happy' : 'sing';
  if (kind === 'emote') throngEmote(id); else throngSay(id, kind);
  return kind;
}

/** Whole crew sings together (mission complete): each throng sings its own part, pitched to its voice. */
export function throngChoir(ids: CrewId[]): void {
  ids.slice(0, 6).forEach((id, i) => { const v = throngVoice(id); void play(v.sing, v.rate, 0.22, i * 0.12); });
}

/** Pick the mood a bubble kind sounds like. */
export const moodForBubble = (kind: string): ThrongMood => (/block|fail|error|gave|help|ask|question|access/i.test(kind) ? 'upset' : /done|pass|ready|closed|ship/i.test(kind) ? 'happy' : 'talk');

const STAT_KEY = 'sm.throng.apples';
export const applesFed = (): number => { try { return Number(localStorage.getItem(STAT_KEY)) || 0; } catch { return 0; } };
/** Thronglets game: feed a throng an apple. It chomps, then purrs happily in its own voice. Returns the running total. */
export function throngFeed(id: CrewId): number {
  const v = throngVoice(id);
  void play('apple_chomps', 1, 0.4);
  void play(v.prrr, v.rate, 0.35, 0.7);
  const n = applesFed() + 1;
  try { localStorage.setItem(STAT_KEY, String(n)); } catch { /* private mode */ }
  return n;
}
/** Thronglets game: a new throng splits off (a hire) with the mitosis pop and a welcome chirp. */
export function throngMitosis(id: CrewId): void {
  void play('egg_crack', 1, 0.4);
  void play('egg_hatch', 1, 0.4, 0.5);
  void play('mitosis_small_pop', 1, 0.45, 1);
  void play(throngVoice(id).prrr, throngVoice(id).rate, 0.3, 1.4);
}
/** Thronglets game: a little emoji blip, used when a throng says its catchphrase unprompted. */
export function throngEmote(id: CrewId): void {
  void play('sfx_thronglet_emoji_01', throngVoice(id).rate, 0.35);
}

const countKey = (k: string) => `sm.throng.${k}`;
const bump = (k: string): number => { try { const n = (Number(localStorage.getItem(countKey(k))) || 0) + 1; localStorage.setItem(countKey(k), String(n)); return n; } catch { return 1; } };
/** Thronglets game: bathe a throng (splash, scrub, then a happy purr). Returns the running bath count. */
export function throngBath(id: CrewId): number {
  const v = throngVoice(id);
  void play('sfx_water_splash_01', 1, 0.45);
  void play('thronglet_scrub_a', 1, 0.4, 0.3);
  void play(v.prrr, v.rate, 0.35, 1.1);
  return bump('baths');
}
/** Thronglets tool: bonk a throng with the hammer; it yelps in its upset voice. Returns the running bonk count. */
export function throngBonk(id: CrewId): number {
  const v = throngVoice(id);
  void play('sfx_hammer_hit_01', 1, 0.5);
  void play(v.upset, v.rate, 0.35, 0.15);
  return bump('bonks');
}
/** Thronglets game: something is on fire (a task gave up or failed). */
export function throngFire(): void {
  void play('sfx_fire_start_01', 1, 0.35);
}

/** Tiny Web Audio cues for the Success Manager crew (respects the office's sound setting via unlock). */
let ctx: AudioContext | null = null;
const SOUND_KEY = 'sm.sound';
/** The office's sound switch (🔊 button, top-left): off = no throng noises, chirps, song or cues. Remembered across visits. */
let enabled = ((): boolean => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();
const soundSubs = new Set<() => void>();
export const setSmSoundEnabled = (on: boolean) => {
  enabled = on;
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  for (const f of soundSubs) f();
};
export const isSmSoundEnabled = (): boolean => enabled;
export const subscribeSmSound = (f: () => void): (() => void) => { soundSubs.add(f); return () => { soundSubs.delete(f); }; };

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', vol = 0.035) {
  if (!enabled) return;
  try {
    ctx ||= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}

const clips = new Map<string, Promise<AudioBuffer | null>>();
/** Play a real Thronglets game clip (public/assets/throng); runs `fallback` (a synth cue) when it can't load. */
function sfx(name: string, vol: number, fallback: () => void) {
  if (!enabled) return;
  try {
    ctx ||= new AudioContext();
    const c = ctx;
    if (c.state === 'suspended') void c.resume();
    let p = clips.get(name);
    if (!p) { p = fetch(`./assets/throng/${name}.wav`).then((r) => { if (!r.ok) throw new Error(); return r.arrayBuffer(); }).then((b) => c.decodeAudioData(b)).catch(() => null); clips.set(name, p); }
    void p.then((buf) => {
      if (!buf) { fallback(); return; }
      const src = c.createBufferSource();
      const g = c.createGain();
      src.buffer = buf;
      g.gain.value = vol;
      src.connect(g).connect(c.destination);
      src.start();
    });
  } catch { fallback(); }
}

/** Speech bubble pop (the game's text-bubble open). */
export const playPop = () => sfx('sfx_text_bubble_open', 0.5, () => { tone(880, 0, 0.06, 'triangle', 0.025); tone(1320, 0.05, 0.05, 'triangle', 0.02); });
/** "Hey, over here!" (the game's tool-unavailable blip). */
export const playHelp = () => sfx('ui_tool_unavailable', 0.5, () => { tone(660, 0, 0.09); tone(990, 0.12, 0.12); });
/** Mission complete (the game's egg-hatch success stinger). */
export const playCelebration = () => sfx('hatch_success_stinger', 0.5, () => {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.18, 'square', 0.04));
  tone(1047, 0.5, 0.45, 'triangle', 0.04);
});
/** Conference-room phone (the game's device notification). */
export const playRing = () => sfx('sfx_device_notification_popUp', 0.6, () => { for (let i = 0; i < 12; i++) tone(i % 2 ? 1180 : 940, (i < 6 ? 0 : 0.2) + i * 0.07, 0.06, 'square', 0.03); });

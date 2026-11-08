/**
 * Crew voice (ElevenLabs via /sm/voice/speak): speaks ARES's bubbles and meeting lines aloud, one clip at a time.
 * Off until the server has ELEVENLABS_API_KEY; the owner can mute it (remembered in localStorage).
 */
import { smClient } from './smClient.js';

const MUTE_KEY = 'sm-voice-muted';
const MAX_QUEUE = 2;
let enabled: boolean | null = null; // null = not asked yet
let muted = (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })();
const queue: string[] = [];
let playing = false;
let current: HTMLAudioElement | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function onVoiceChange(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function voiceAvailable(): boolean { return enabled === true; }
export function voiceMuted(): boolean { return muted; }

export async function initVoiceOut(): Promise<void> {
  if (enabled !== null) return;
  try { enabled = (await smClient.voice()).enabled; } catch { enabled = false; }
  notify();
}

export function setVoiceMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* private mode */ }
  if (m) stopSpeaking();
  notify();
}

export function stopSpeaking(): void {
  queue.length = 0;
  current?.pause();
  current = null;
  playing = false;
}

async function pump(): Promise<void> {
  if (playing) return;
  const text = queue.shift();
  if (!text) return;
  playing = true;
  try {
    const url = URL.createObjectURL(await smClient.speak(text));
    const a = new Audio(url);
    current = a;
    await new Promise<void>((done) => { a.onended = () => done(); a.onerror = () => done(); void a.play().catch(() => done()); });
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[voice]', (e as Error).message);
    if (/401/.test((e as Error).message)) { enabled = false; notify(); }
  }
  current = null;
  playing = false;
  void pump();
}

/** Say it aloud (no-op when voice is off or muted). Old waiting lines are dropped so speech never lags the screen. */
export function speak(text: string): void {
  if (!enabled || muted || !text.trim()) return;
  queue.push(text);
  while (queue.length > MAX_QUEUE) queue.shift();
  void pump();
}

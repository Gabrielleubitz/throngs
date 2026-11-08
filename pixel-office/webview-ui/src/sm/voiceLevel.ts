/** Shared "owner is speaking" state: the mic hook writes it, the office renderer/FSM read it every frame. */
let level = 0; // 0..1 smoothed loudness
let listening = false;

export function setVoice(l: number, on: boolean): void { level = l; listening = on; }
/** True while the owner is talking (loud enough): everybody turns to face the camera. */
export function isVoiceActive(): boolean { return listening && level > 0.04; }
export function voiceLevel(): number { return isVoiceActive() ? level : 0; }
/** Pixel offset (before zoom) to shake a character by; different phase per character id. */
export function trembleOffset(id: number, now: number): { dx: number; dy: number } {
  const l = voiceLevel();
  if (l === 0) return { dx: 0, dy: 0 };
  const amp = 0.4 + l * 1.4;
  return { dx: Math.sin(now / 17 + id * 7) * amp, dy: Math.cos(now / 23 + id * 3) * amp * 0.5 };
}

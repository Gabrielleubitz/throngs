/**
 * "Stop clicking on him": agents the owner switched off in the office. A locked agent can't be hit by
 * clicks/taps on the canvas (nothing is closed or deleted); the Agents page turns it back on.
 * Persisted per browser, keyed by agent id.
 */
const KEY = 'sm.lockedAgents';
const listeners = new Set<() => void>();
const locked = new Set<number>(
  (() => { try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[]).filter((n) => Number.isFinite(n)); } catch { return []; } })(),
);

export const isClickLocked = (id: number): boolean => locked.has(id);

export function setClickLocked(id: number, on: boolean): void {
  if (on === locked.has(id)) return;
  if (on) locked.add(id); else locked.delete(id);
  try { localStorage.setItem(KEY, JSON.stringify([...locked])); } catch { /* private mode */ }
  listeners.forEach((l) => l());
}

export function subscribeClickLock(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

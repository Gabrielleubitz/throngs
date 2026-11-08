/**
 * Owner drag-and-drop of crew: click-hold-drag lifts someone (they shake in fear), letting go drops them
 * (they fall over, lie a beat, then get back up). Shared by the canvas (input), the FSM (freeze) and the renderer (pose).
 */
const FALL_MS = 420;
const LIE_MS = 450;
const GETUP_MS = 650;

interface Drag { held: boolean; since: number; }
const drags = new Map<number, Drag>();

export function startDrag(id: number, now: number): void { drags.set(id, { held: true, since: now }); }
export function dropDrag(id: number, now: number): void {
  const d = drags.get(id);
  if (d && d.held) { d.held = false; d.since = now; }
}
export function isHeld(id: number): boolean { return drags.get(id)?.held === true; }
/** True from pick-up until the character is back on their feet: the FSM leaves them alone. */
export function isDragged(id: number, now: number = performance.now()): boolean {
  const d = drags.get(id);
  if (!d) return false;
  if (d.held) return true;
  if (now - d.since < FALL_MS + LIE_MS + GETUP_MS) return true;
  drags.delete(id);
  return false;
}

export interface DragPose { dx: number; dy: number; rot: number; }
const ease = (t: number): number => t * t;

/** Offset in sprite pixels (dy negative = up) and tilt in radians (positive = tipped onto their side). */
export function dragPose(id: number, now: number): DragPose | null {
  const d = drags.get(id);
  if (!d) return null;
  const LIFT = 7;
  if (d.held) {
    const lift = Math.min(1, (now - d.since) / 120);
    return {
      dx: Math.sin(now / 21 + id * 5) * 1.3,
      dy: -LIFT * lift + Math.cos(now / 17 + id * 3) * 0.8,
      rot: Math.sin(now / 45 + id) * 0.09,
    };
  }
  const t = now - d.since;
  if (t < FALL_MS) { // drop: plummet, tip over, small bounce at the end
    const p = t / FALL_MS;
    const bounce = p > 0.8 ? Math.sin(((p - 0.8) / 0.2) * Math.PI) * 1.5 : 0;
    return { dx: 0, dy: -LIFT * (1 - ease(Math.min(1, p / 0.8))) - bounce, rot: ease(p) * (Math.PI / 2) };
  }
  if (t < FALL_MS + LIE_MS) return { dx: Math.sin(t / 30) * 0.4, dy: 0, rot: Math.PI / 2 }; // lying dazed
  const p = (t - FALL_MS - LIE_MS) / GETUP_MS; // get up in two pushes
  const rot = (Math.PI / 2) * (1 - (p < 0.5 ? p * 0.5 : 0.25 + (p - 0.5) * 1.5));
  return { dx: 0, dy: 0, rot: Math.max(0, rot) };
}

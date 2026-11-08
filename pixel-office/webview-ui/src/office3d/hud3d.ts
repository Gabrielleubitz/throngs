/** Pure rules for the 3D HUD (world-anchored bubbles, fading controls hint, Reports pill). DOM-free so they are Node-tested. */

/** One speech bubble pinned over a character in the 3D office. */
export interface Bubble3D {
  /** Character id (matches Agent3D.id). */
  agentId: number;
  name: string;
  text: string;
  /** 'help' = the pulsing "Need your help!" callout, 'say' = an ordinary mission-event line. */
  kind: 'help' | 'say';
}

/** What the 2D Success Manager layer hands the 3D HUD (no 2D projection, just data + the existing click handlers). */
export interface Hud3DData {
  getBubbles: () => Bubble3D[];
  unreadReports: number;
  onOpenReports: () => void;
  onCrewClick: (agentId: number) => void;
}

/** Metres from the camera beyond which a bubble is dropped, and the step where it shrinks. */
export const BUBBLE_FAR_M = 16;
export const BUBBLE_SMALL_M = 8;
/** Bubble anchor: above the character's name label. */
export const BUBBLE_ANCHOR_Y = 2.3;
/** The controls hint stays this long after the first interaction, then fades over HINT_FADE_MS. */
export const HINT_HOLD_MS = 6000;
export const HINT_FADE_MS = 1200;

/** 0 = hidden, 1 = full size, 0.75 = far-away size. Discrete steps keep pixel text crisp. */
export function bubbleScale(distM: number): number {
  if (distM > BUBBLE_FAR_M) return 0;
  return distM > BUBBLE_SMALL_M ? 0.75 : 1;
}

/** Opacity of the controls hint: 1 until `HINT_HOLD_MS` after it started counting, then a linear fade to 0. */
export function hintOpacity(elapsedMs: number): number {
  if (elapsedMs <= HINT_HOLD_MS) return 1;
  return Math.max(0, 1 - (elapsedMs - HINT_HOLD_MS) / HINT_FADE_MS);
}

/** Normalised device coords (-1..1, y up) → CSS pixels in a w×h box; null when behind the camera / off-screen. */
export function ndcToScreen(x: number, y: number, z: number, w: number, h: number, margin = 0): { x: number; y: number } | null {
  if (z > 1) return null;
  const sx = ((x + 1) / 2) * w;
  const sy = ((1 - y) / 2) * h;
  if (sx < -margin || sx > w + margin || sy < -margin || sy > h + margin) return null;
  return { x: sx, y: sy };
}

export function reportsLabel(unread: number): string {
  return unread > 0 ? `${unread} NEW REPORT${unread > 1 ? 'S' : ''}!` : 'REPORTS';
}

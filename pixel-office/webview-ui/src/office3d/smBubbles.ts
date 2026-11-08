/** Success Manager bubbles → the 3D HUD's world-anchored bubbles. Same rules as the 2D SmOverlay: a helping character always shows one. */
import type { Character } from '../office/types.js';
import { CREW } from '../sm/crew.js';
import type { Bubble } from '../sm/useSuccessManager.js';
import type { Bubble3D } from './hud3d.js';

export function buildBubbles3D(characters: ReadonlyMap<number, Character>, bubbles: Bubble[], now: number): Bubble3D[] {
  const out: Bubble3D[] = [];
  for (const c of CREW) {
    const ch = characters.get(c.agentId);
    if (!ch || ch.matrixEffect) continue;
    const helping = ch.smPose === 'help';
    const bubble = bubbles.find((b) => b.crewId === c.id && b.until > now);
    if (!helping && !bubble) continue;
    const text = helping ? (bubble?.text && bubble.kind === 'help' ? bubble.text : 'Need your help!') : bubble!.text;
    out.push({ agentId: c.agentId, name: c.name, text, kind: helping ? 'help' : 'say' });
  }
  return out;
}

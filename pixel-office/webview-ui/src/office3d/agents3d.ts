/** Pure helpers that merge the 2D characters with Success Manager data into 3D agents and screen text. */
import { TILE_SIZE } from '../constants.js';
import type { Character, Pet } from '../office/types.js';
import type { StaffRecord } from '../sm/crew.js';
import type { SmAgent } from '../sm/smClient.js';

export interface Agent3D {
  id: number;
  /** Crew id when this is a Success Manager crew member (chat works only for these). */
  crewId: string | null;
  name: string;
  role: string;
  /** World metres. */
  x: number;
  z: number;
  palette: number;
  hueShift: number;
  /** 2D facing (office Direction: 0 down, 1 left, 2 right, 3 up). */
  dir: number;
  tune?: Character['smTune'];
  look?: Character['smLook'];
  state: 'WORKING' | 'IDLE' | 'BLOCKED';
  task: string;
  lastAction: string | null;
  seated: boolean;
}

export interface Pet3D {
  id: string;
  name: string;
  /** Index into the zoo animals. */
  kind: number;
  /** World metres. */
  x: number;
  z: number;
}

const ZOO_ID = /^sm-zoo-(\d+)$/;

/** The Zoo animals as 3D pets (other pets are not shown in 3D). */
export function buildPets3D(pets: Pet[], names: string[], tileM = 1): Pet3D[] {
  const out: Pet3D[] = [];
  for (const p of pets) {
    const m = ZOO_ID.exec(p.id);
    if (!m) continue;
    const kind = Number(m[1]);
    out.push({ id: p.id, name: names[kind] ?? p.name, kind, x: (p.x / TILE_SIZE) * tileM, z: (p.y / TILE_SIZE) * tileM });
  }
  return out;
}

export function buildAgents3D(characters: Character[], staff: StaffRecord[], smAgents: SmAgent[], tileM = 1): Agent3D[] {
  const byAgentId = new Map(staff.map((s) => [s.agentId, s]));
  const byCrew = new Map(smAgents.map((a) => [a.id, a]));
  const out: Agent3D[] = [];
  for (const ch of characters) {
    if (ch.id < 0) continue; // sub-agents
    const s = byAgentId.get(ch.id);
    const a = s ? byCrew.get(s.id) : undefined;
    const typing = ch.state === 'type';
    out.push({
      id: ch.id,
      crewId: s?.id ?? null,
      name: s?.name ?? `Agent ${ch.id}`,
      role: s?.title ?? 'Claude agent',
      x: (ch.x / TILE_SIZE) * tileM,
      z: (ch.y / TILE_SIZE) * tileM,
      palette: ch.palette,
      hueShift: ch.hueShift,
      dir: ch.dir,
      tune: ch.smTune,
      look: ch.smLook,
      state: a?.state ?? (typing ? 'WORKING' : 'IDLE'),
      task: a?.task || (typing ? (ch.currentTool ?? 'Working') : ''),
      lastAction: a?.live?.lastAction ?? null,
      seated: typing,
    });
  }
  return out;
}

/** Wrap text to `max` characters per line, at most `maxLines` lines (last one gets an ellipsis). */
export function wrapText(text: string, max: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let w of words) {
    while (w.length > max) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ` ${w}`;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    const last = cut[maxLines - 1]!;
    cut[maxLines - 1] = `${last.slice(0, Math.max(0, max - 1))}…`;
    return cut;
  }
  return lines;
}

/** A stable signature of what a screen shows, so textures only repaint on real change. */
export function screenKey(a: Pick<Agent3D, 'name' | 'state' | 'task' | 'lastAction'>): string {
  return `${a.name}|${a.state}|${a.task}|${a.lastAction ?? ''}`;
}

/** The agent whose desk-area the player stands nearest, within `range` metres and in front (dot > cosFov). */
export function pickTalkTarget<T extends { x: number; z: number }>(
  px: number, pz: number, yaw: number, agents: T[], range = 2.2, minDot = 0.35,
): T | null {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best: T | null = null;
  let bestScore = Infinity;
  for (const a of agents) {
    const dx = a.x - px, dz = a.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist > range) continue;
    const dot = dist < 0.01 ? 1 : (dx * fx + dz * fz) / dist;
    if (dot < minDot) continue;
    const score = dist * (2 - dot);
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best;
}

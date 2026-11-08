/**
 * The Success Manager crew — persistent characters that live in the office alongside real Claude
 * sessions. The roster is data (office/staff.json via /sm/state): founding team + anyone you hire.
 * Their agent ids sit far above anything the server allocates, so they never collide.
 */
import type { Look } from '../office/sprites/layers.js';

export type CrewId = string;
export type CrewState = 'WORKING' | 'IDLE' | 'BLOCKED';
export type CrewKind = 'manager' | 'planner' | 'ideas' | 'watcher' | 'engineer' | 'reviewer';

export interface CrewMember {
  id: CrewId;
  agentId: number;
  name: string;
  /** Job title, e.g. "Head of Content & Marketing". */
  role: string;
  kind: CrewKind;
  room: string;
  palette: number;
  hueShift: number;
  tune: { s: number; b: number; c: number };
  /** Layered extras (hair, outfit, hat, accessory + colours); empty = the sprite as drawn. */
  look: Look;
  /** Tool name fed to the engine so the right animation plays: Read = reading, Edit = typing. */
  tool: 'Read' | 'Edit';
  reviewer: boolean;
  /** Management crew — the only ones allowed in the Control Room and the owner's office. */
  management: boolean;
  bio: string;
}

export interface StaffRecord {
  id: string;
  agentId: number;
  name: string;
  title: string;
  kind: CrewKind;
  room: string;
  palette: number;
  hueShift: number;
  /** Fine tuning (saturation / brightness / contrast, each -100..100); absent = none. */
  sat?: number;
  bright?: number;
  contrast?: number;
  look?: Look;
  brief: string;
  core?: boolean;
  /** Cannot be fired: the office needs them. */
  locked?: boolean;
  /** Management role: may enter/sit in restricted rooms (Control Room, owner's office). */
  management?: boolean;
}
export interface RoomRecord {
  id: string;
  label: string;
  department: string;
  prompt: string;
  hire: boolean;
  /** Management-only room. */
  restricted?: boolean;
}

export const isManagement = (s: { kind: CrewKind; management?: boolean }): boolean => s.management ?? ['manager', 'planner', 'ideas'].includes(s.kind);

export const CREW_BASE_ID = 990_000;
const BIO: Record<CrewKind, string> = {
  manager: 'Give them a task — they split it into jobs, hand them to the right desks, check the work against the real code and tests, and leave the report on your desk.',
  planner: 'Sits in the Control Room. Rewrites every prompt you give ARES into a clear brief and a step-by-step plan; ARES approves it before anyone starts.',
  ideas: 'Sits in the Control Room. Always keeps 5 ideas for improving the office — give one to the Planner or add your thoughts.',
  watcher: 'No AI. Watches your Claude accounts, shows the live 5h / 7d usage and switches accounts before one runs out. The only thing that switches them.',
  engineer: 'May change code. Works one job at a time per app folder; every time they stop, a test script — not an AI — decides if it is really done.',
  reviewer: 'Read-only specialist. Investigates and hands back written findings; never edits files.',
};

export let CREW: CrewMember[] = [];
export const CREW_BY_AGENT = new Map<number, CrewMember>();
export const CREW_BY_ID = new Map<CrewId, CrewMember>();

/** Replace the live roster (called on every state poll). Returns true when membership changed. */
export function setCrew(staff: StaffRecord[]): boolean {
  const next = staff.map<CrewMember>((s) => ({
    id: s.id, agentId: s.agentId, name: s.name, role: s.title, kind: s.kind, room: s.room,
    palette: s.palette, hueShift: s.hueShift, tune: { s: s.sat ?? 0, b: s.bright ?? 0, c: s.contrast ?? 0 }, look: s.look ?? {}, tool: s.kind === 'reviewer' || s.kind === 'watcher' ? 'Read' : 'Edit',
    reviewer: s.kind === 'reviewer', management: isManagement(s), bio: BIO[s.kind],
  }));
  const changed = next.length !== CREW.length || next.some((c, i) => CREW[i]?.agentId !== c.agentId);
  CREW = next;
  CREW_BY_AGENT.clear();
  CREW_BY_ID.clear();
  for (const c of next) { CREW_BY_AGENT.set(c.agentId, c); CREW_BY_ID.set(c.id, c); }
  return changed;
}

export const isCrewAgent = (agentId: number): boolean => agentId > CREW_BASE_ID || CREW_BY_AGENT.has(agentId);

/** Log tag (sm-api.js) → crew member. */
export function crewForLogTag(tag: string): CrewMember | undefined {
  if (tag === 'BUILDER') return CREW_BY_ID.get('builder');
  if (tag === 'ORCHESTRATOR' || tag === 'QA') return CREW.find((c) => c.kind === 'manager');
  const id = tag.replace(/ AGENT$/, '').toLowerCase();
  return CREW_BY_ID.get(id);
}

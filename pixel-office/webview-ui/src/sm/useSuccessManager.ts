/**
 * Polls the Success Manager bridge and drives the crew characters through the same ServerMessages
 * real agents use (agentCreated / agentToolStart / agentToolsClear), so the office engine animates
 * them with zero special cases:
 *   WORKING → walks to their own desk and types/reads, task text in the status label
 *   BLOCKED → stands up and jumps with hands up (smPose 'help') until you answer
 *   IDLE    → wanders the office
 * Mission events become speech bubbles; a finished mission triggers a celebration.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ServerMessage } from '../../../core/src/messages.js';
import { SM_BUBBLE_MS, SM_CELEBRATION_MS } from '../constants.js';
import { isDancingNow } from '../office/engine/characters.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isWalkable } from '../office/layout/tileMap.js';
import { transport } from '../transport/index.js';
import { CREW, CREW_BY_ID, type CrewId, type CrewState, setCrew } from './crew.js';
import { type Player, syncPlayers } from './games.js';
import { liveMeeting, meetingSeats } from './meeting.js';
import { smClient, type SmProject, type SmState } from './smClient.js';
import { isSmSoundEnabled, playCelebration, playHelp, playPop } from './smSounds.js';
import { formationIndex, formationSpots, isMusicOn, startSong, stopSong, STUDIO, studioPool, subscribeMusic } from './throngStudio.js';
import { moodForBubble, throngChoir, throngFire, throngIdleNoise, throngMitosis, throngSay, throngVoice } from './throngVoice.js';
import { initVoiceOut, speak } from './voiceOut.js';

const POLL_MS = 2500;
const SM_BUILD_POLL_MS = 4000;
/** The build lands on disk a few seconds before the server restarts onto it — give the restart time to finish. */
const SM_BUILD_SETTLE_MS = 10_000;
const PROJECT_KEY = 'sm.project';

type Deliverable = { deliver?: (m: ServerMessage) => void };
const deliver = (m: Record<string, unknown>) => (transport as unknown as Deliverable).deliver?.(m as unknown as ServerMessage);

export interface Override {
  mode: 'work' | 'lounge';
  until: number;
}
export interface Bubble {
  key: string;
  crewId: CrewId;
  text: string;
  kind: string;
  until: number;
}

/** The seat a crew member should use, or null. */
function pickSeat(os: OfficeState, id: string, agentId: number, room: string, label?: string): string | null {
  const own = `sm-seat-${id}`;
  if (os.seats.has(own)) return own;
  const mine = [...os.seats.values()].find((x) => x.uid.startsWith('sm-seat-') && os.characters.get(agentId)?.seatId === x.uid);
  if (mine && mine.uid.startsWith(`sm-seat-hire-${room}`)) return mine.uid;
  const spare = [...os.seats.values()].find((x) => x.uid.startsWith(`sm-seat-hire-${room}`) && !x.assigned);
  if (spare) return spare.uid;
  if (!label) return null;
  const layout = os.getLayout();
  const inRoom = [...os.seats.values()].find((x) => !x.assigned && !x.uid.startsWith('sm-seat-') && layout.areaTiles?.[x.seatRow * layout.cols + x.seatCol] === label);
  return inRoom?.uid ?? null;
}

export function useSuccessManager(getOfficeState: () => OfficeState, layoutReady: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [projects, setProjects] = useState<SmProject[]>([]);
  const [project, setProjectRaw] = useState<string | null>(() => {
    try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
  });
  const [state, setState] = useState<SmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [celebrating, setCelebrating] = useState<{ until: number; headline: string } | null>(null);
  const created = useRef(new Set<number>()); // agentIds already in the office
  const shown = useRef(new Map<CrewId, string>()); // crewId → last applied "state|task"
  const overrides = useRef(new Map<CrewId, Override>());
  const seenEvents = useRef<Set<string> | null>(null); // null until the first load (don't replay history)
  const cheerUntil = useRef(0);
  const toolSeq = useRef(0);
  const lastState = useRef<SmState | null>(null);
  const idleIds = useRef<CrewId[]>([]); // crew not working right now (they make the random noises)

  useEffect(() => {
    let alive = true;
    smClient.enabled().then((ok) => { if (alive) setEnabled(ok); });
    return () => { alive = false; };
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const list = await smClient.projects();
      setProjects(list);
      setProjectRaw((cur) => (cur && list.some((p) => p.name === cur) ? cur : (list[0]?.name ?? null)));
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void loadProjects();
    const t = setInterval(loadProjects, 15_000);
    return () => clearInterval(t);
  }, [enabled, loadProjects]);

  const switchLocal = useCallback((name: string) => {
    setProjectRaw(name);
    setState(null);
    shown.current.clear();
    overrides.current.clear();
    seenEvents.current = null;
    try { localStorage.setItem(PROJECT_KEY, name); } catch { /* private mode */ }
  }, []);
  // The owner picked a folder here: tell the server, so IVY (Telegram/phone) knows where the office is working.
  const setProject = useCallback((name: string) => { switchLocal(name); smClient.setFocus(name).catch(() => {}); }, [switchLocal]);
  // Follow the shared focus: IVY can move the office to another folder ("open atlas-app" on Telegram).
  const focusSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const check = async () => {
      try {
        const f = await smClient.focus();
        if (focusSeen.current === null) { focusSeen.current = f.at ?? ''; return; } // what was already there when the office opened (maybe nothing)
        if (!f.project || !f.at || f.at === focusSeen.current) return;
        focusSeen.current = f.at;
        if (f.by !== 'owner') { await loadProjects(); switchLocal(f.project); }
      } catch { /* server without focus */ }
    };
    void check();
    const t = setInterval(() => void check(), 4000);
    return () => clearInterval(t);
  }, [enabled, loadProjects, switchLocal]);

  /** Celebrate: everyone cheers, confetti, fanfare. */
  const celebrate = useCallback((headline: string) => {
    const until = Date.now() + SM_CELEBRATION_MS;
    cheerUntil.current = until;
    setCelebrating({ until, headline });
    playCelebration();
    throngChoir(CREW.map((c) => c.id));
    shown.current.clear(); // re-apply looks once the party is over
  }, []);

  /** Push one crew member's look into the engine — only when it actually changed. */
  const apply = useCallback((s: SmState) => {
    lastState.current = s;
    const os = getOfficeState();
    // Roster → characters: hire = new character (with the spawn effect), let go = removed.
    const before = CREW.length;
    setCrew(s.staff.staff);
    // Thronglets mitosis: a new hire splits off with a pop (not on first load).
    if (before > 0 && CREW.length > before) throngMitosis(CREW[CREW.length - 1].id);
    const prevSelected = os.selectedAgentId;
    for (const c of CREW) {
      if (created.current.has(c.agentId)) continue;
      deliver({ type: 'agentCreated', id: c.agentId, palette: c.palette, hueShift: c.hueShift });
      created.current.add(c.agentId);
      shown.current.delete(c.id);
    }
    for (const id of [...created.current]) {
      if (CREW.some((c) => c.agentId === id)) continue;
      deliver({ type: 'agentClosed', id });
      created.current.delete(id);
    }
    os.selectedAgentId = prevSelected; // agentCreated auto-selects; don't steal focus
    const roomLabel = new Map(s.staff.rooms.map((r) => [r.id, r.label]));
    const now = Date.now();
    const cheering = cheerUntil.current > now;
    const players: Player[] = [];
    // A meeting (a finished video) pulls everyone into the conference room to sit round the table.
    const meeting = liveMeeting(s.meetings);
    const confSeats = meeting ? meetingSeats(meeting, CREW.map((c) => c.id), (uid) => os.seats.has(uid)) : new Map<string, string>();
    // 🎵 Music: every idle throng gathers on the Studio dance floor (no Studio in the layout = no dancing).
    const layout = os.getLayout();
    const pool = isMusicOn() ? studioPool(layout.cols, layout.areaTiles, (col, row) => isWalkable(col, row, os.tileMap, os.blockedTiles)) : [];
    // Everyone dances one choreography: circle, lines, rings… (changes every few bars, see FORMATIONS).
    const crowd = s.agents.filter((a) => a.state === 'IDLE' && !confSeats.has(a.id)).length;
    const spots = formationSpots(pool, crowd, formationIndex());
    let dancers = 0;
    const idle: CrewId[] = [];
    for (const c of CREW) {
      const ch = os.characters.get(c.agentId);
      if (!ch) continue;
      ch.agentName = c.name;
      ch.smMgmt = c.management;
      if (ch.palette !== c.palette || ch.hueShift !== c.hueShift) { ch.palette = c.palette; ch.hueShift = c.hueShift; } // appearance edits show live
      ch.smTune = c.tune;
      ch.smLook = c.look;
      // Each crew member has a desk in their own room: founders have named chairs, hires take a spare
      // desk (sm-seat-hire-<room>-n) or any free seat inside their room.
      const restricted = s.staff.rooms.find((r) => r.id === c.room)?.restricted;
      const inMeeting = c.id === 'secretary' ? undefined : confSeats.get(c.id); // IVY never joins the conference table
      const seatId = inMeeting ?? (restricted && !c.management ? null : pickSeat(os, c.id, c.agentId, c.room, roomLabel.get(c.room)));
      const seat = seatId ? os.seats.get(seatId) : undefined;
      if (seat && seatId && ch.seatId !== seatId) {
        if (seat.assigned) {
          // A visiting Claude session grabbed a crew desk — move it to any free non-crew seat.
          const squatter = [...os.characters.values()].find((x) => x.seatId === seatId && x.id !== c.agentId);
          if (squatter) {
            const free = [...os.seats.values()].find((x) => !x.assigned && !x.uid.startsWith('sm-seat-'));
            if (free) os.reassignSeat(squatter.id, free.uid);
            else { seat.assigned = false; squatter.seatId = null; }
          } else seat.assigned = false;
        }
        os.reassignSeat(c.agentId, seatId);
      }

      const a = s.agents.find((x) => x.id === c.id);
      if (!a) continue;
      let look: CrewState = a.state;
      if (!inMeeting && a.state !== 'WORKING' && c.id !== 'secretary') idle.push(c.id);
      if (inMeeting) {
        ch.smDanceSpot = null; // sit down at the table (active = walks to the seat and stays there)
        const key = `MEETING|${meeting?.id}`;
        if (ch.smPose) ch.smPose = null;
        if (shown.current.get(c.id) === key) continue;
        shown.current.set(c.id, key);
        deliver({ type: 'agentToolsClear', id: c.agentId });
        deliver({ type: 'agentToolStart', id: c.agentId, toolId: `sm-${c.id}-${++toolSeq.current}`, status: c.id === meeting?.host ? `Running the meeting: ${meeting?.title}` : 'In the meeting', toolName: 'Read' });
        deliver({ type: 'agentStatus', id: c.agentId, status: 'active' });
        continue;
      }
      const o = overrides.current.get(c.id);
      if (o && o.until > now) look = o.mode === 'lounge' ? 'IDLE' : a.state === 'IDLE' ? 'WORKING' : a.state;
      else overrides.current.delete(c.id);
      // IVY never leaves her desk: whatever the crew is doing (idle, blocked, lounge override, cheering) she stays seated at Reception
      let task = a.task;
      const atDesk = c.id === 'secretary';
      if (atDesk) { look = 'WORKING'; if (a.state !== 'WORKING') task = 'At the front desk — minding the phone'; }
      const cheer = cheering && !atDesk;

      // Poses: cheer beats everything; needing help makes them jump with hands up; music makes the idle dance.
      const dancing = !cheer && look === 'IDLE' && spots.length > 0;
      ch.smDanceSpot = dancing ? spots[dancers++ % spots.length] : null;
      const pose = cheer ? 'cheer' : look === 'BLOCKED' ? 'help' : dancing ? 'dance' : null;
      if (ch.smPose !== pose) {
        if (pose === 'help' && ch.smPose !== 'help') playHelp();
        ch.smPose = pose;
      }

      if (look === 'IDLE' && !cheer && !dancing && !c.management) players.push({ id: c.id, name: c.name });
      const key = `${cheer ? 'CHEER' : look}|${task}`;
      if (shown.current.get(c.id) === key) continue;
      shown.current.set(c.id, key);
      deliver({ type: 'agentToolsClear', id: c.agentId });
      if (cheer || look !== 'WORKING') {
        os.setAgentActive(c.agentId, false);
        continue;
      }
      const toolId = `sm-${c.id}-${++toolSeq.current}`;
      deliver({ type: 'agentToolStart', id: c.agentId, toolId, status: task, toolName: c.tool });
      deliver({ type: 'agentStatus', id: c.agentId, status: 'active' });
    }
    syncPlayers(players); // idle crew play in the Game Room
    idleIds.current = idle;
  }, [getOfficeState]);

  /** Mission events → speech bubbles (and celebrations). History is not replayed on load. */
  const ingestEvents = useCallback((s: SmState) => {
    const keys = s.events.map((e) => `${e.missionId}|${e.ts}|${e.who}|${e.text}`);
    if (seenEvents.current === null) { seenEvents.current = new Set(keys); return; }
    const fresh: Bubble[] = [];
    s.events.forEach((e, i) => {
      if (seenEvents.current!.has(keys[i])) return;
      seenEvents.current!.add(keys[i]);
      if (e.kind === 'celebrate') {
        const m = s.missions.find((x) => x.id === e.missionId);
        celebrate(m?.report?.headline || 'Mission complete!');
        return;
      }
      const who = (e.who === 'all' ? 'orchestrator' : e.who) as CrewId;
      if (!CREW_BY_ID.has(who)) return;
      fresh.push({ key: keys[i], crewId: who, text: e.text, kind: e.kind, until: Date.now() + SM_BUBBLE_MS + Math.min(4000, e.text.length * 40) });
    });
    if (fresh.length) {
      const last = fresh[fresh.length - 1];
      if (CREW_BY_ID.has(last.crewId)) { throngSay(last.crewId, moodForBubble(last.kind)); if (/gave|fail|error/i.test(last.kind)) throngFire(); } else playPop();
      const ares = fresh.filter((f) => f.crewId === ('orchestrator' as CrewId)).pop();
      if (ares) speak(ares.text);
      // one bubble per crew member at a time: newest wins
      setBubbles((prev) => {
        const next = prev.filter((b) => b.until > Date.now() && !fresh.some((f) => f.crewId === b.crewId));
        const latest = new Map(fresh.map((f) => [f.crewId, f]));
        return [...next, ...latest.values()];
      });
    }
  }, [celebrate]);

  useEffect(() => { if (enabled) void initVoiceOut(); }, [enabled]);

  /** Ambient throng noises: now and then a throng that is NOT working makes a random noise in its own voice
   *  (sound on only — the 🔊 switch; the clips stay silent when it is off). Dancers are busy singing. */
  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout>;
    const next = () => { t = setTimeout(tick, 6_000 + Math.random() * 12_000); };
    const tick = () => {
      next();
      if (document.hidden || isMusicOn() || !isSmSoundEnabled()) return;
      const ids = idleIds.current.filter((id) => CREW_BY_ID.has(id));
      if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      if (throngIdleNoise(id) === 'emote') {
        // Thronglets-style emote: an emoji blip and the throng's own catchphrase in a speech bubble.
        const text = throngVoice(id).catchphrase;
        setBubbles((prev) => (prev.some((b) => b.crewId === id) ? prev : [...prev, { key: `chat-${Date.now()}`, crewId: id, text, kind: 'say', until: Date.now() + SM_BUBBLE_MS }]));
      }
    };
    next();
    return () => clearTimeout(t);
  }, [enabled]);

  // Read-only debug hook so a reviewer can see where the crew stands: window.__smCrew() → [name, tile, state, pose, spot, dancing].
  useEffect(() => {
    (window as unknown as { __smCrew?: () => unknown }).__smCrew = () => CREW.map((c) => {
      const ch = getOfficeState().characters.get(c.agentId);
      return ch ? [c.name, `${ch.tileCol},${ch.tileRow}`, ch.state, ch.smPose ?? null, ch.smDanceSpot ? `${ch.smDanceSpot.col},${ch.smDanceSpot.row}` : null, isDancingNow(ch)] : [c.name];
    });
  }, [getOfficeState]);

  /** 🎵 Music: the idle throngs go to the Studio (re-apply now, not at the next poll) and the song starts;
   *  each throng's line shows as a speech bubble over it. Only throngs that reached the dance floor sing. */
  const [music, setMusic] = useState(isMusicOn);
  useEffect(() => subscribeMusic(() => {
    setMusic(isMusicOn());
    shown.current.clear();
    if (lastState.current) apply(lastState.current);
  }), [apply]);
  useEffect(() => {
    if (!enabled || !music) return;
    const singers = (): CrewId[] => {
      const os = getOfficeState();
      const layout = os.getLayout();
      return CREW.filter((c) => {
        const ch = os.characters.get(c.agentId);
        return ch ? isDancingNow(ch) || (ch.smPose === 'dance' && layout.areaTiles?.[ch.tileRow * layout.cols + ch.tileCol] === STUDIO) : false; // sing only once on the floor
      }).map((c) => c.id);
    };
    startSong(singers, (id, lyric) => {
      setBubbles((prev) => [...prev.filter((b) => b.crewId !== id), { key: `song-${Date.now()}-${id}`, crewId: id, text: lyric, kind: 'sing', until: Date.now() + 2600 }]);
    });
    // new pattern: re-apply so the dancers walk to their next marks
    let last = formationIndex();
    const dance = setInterval(() => {
      const f = formationIndex();
      if (f === last) return;
      last = f;
      shown.current.clear();
      if (lastState.current) apply(lastState.current);
    }, 500);
    return () => { stopSong(); clearInterval(dance); };
  }, [enabled, music, getOfficeState, apply]);

  const refresh = useCallback(async () => {
    if (!enabled || !project || !layoutReady) return;
    try {
      const s = await smClient.state(project);
      setState(s);
      setError(null);
      ingestEvents(s);
      apply(s);
    } catch (e) { setError((e as Error).message); }
  }, [enabled, project, layoutReady, apply, ingestEvents]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Ship-to-screen: when a mission rebuilds the office, this tab reloads itself onto the new build, so the
  // owner sees the change without doing anything. It waits while they are typing so nothing is lost.
  useEffect(() => {
    if (!enabled) return;
    let first: string | null = null;
    let seenAt = 0;
    const typing = () => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type=text], input:not([type]), textarea')].some((el) => el.value.trim() !== '');
    const t = setInterval(async () => {
      try {
        const { id, busy } = await smClient.build();
        if (!id || busy) return; // mid-mission test builds don't count — only the finished version
        if (first === null) { first = id; return; }
        if (id === first) return;
        if (!seenAt) seenAt = Date.now();
        if (Date.now() - seenAt >= SM_BUILD_SETTLE_MS && !typing()) { // seenAt counts from when the mission finished
          await smClient.build(); // the (restarted) server answers again
          try { sessionStorage.setItem('sm-updated-at', String(Date.now())); } catch { /* private mode */ }
          window.location.reload();
        }
      } catch { /* server restarting — try again next tick */ }
    }, SM_BUILD_POLL_MS);
    return () => clearInterval(t);
  }, [enabled]);

  // expire bubbles + end the party
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setBubbles((prev) => (prev.some((b) => b.until <= now) ? prev.filter((b) => b.until > now) : prev));
      setCelebrating((c) => {
        if (c && c.until <= now) { shown.current.clear(); if (state) apply(state); return null; }
        return c;
      });
    }, 500);
    return () => clearInterval(t);
  }, [apply, state]);

  const override = useCallback((id: CrewId, mode: Override['mode'], ms = 60_000) => {
    overrides.current.set(id, { mode, until: Date.now() + ms });
    shown.current.delete(id);
    if (state) apply(state);
  }, [state, apply]);

  /** A local bubble (e.g. the manager acknowledging your request instantly). */
  const say = useCallback((crewId: CrewId, text: string) => {
    if (crewId === ('orchestrator' as CrewId)) speak(text);
    setBubbles((prev) => [...prev.filter((b) => b.crewId !== crewId), { key: `local-${Date.now()}`, crewId, text, kind: 'say', until: Date.now() + SM_BUBBLE_MS }]);
  }, []);

  // Just reloaded onto a new build? Let ARES say so, once.
  useEffect(() => {
    if (!state) return;
    let at = 0;
    try { at = Number(sessionStorage.getItem('sm-updated-at') || 0); sessionStorage.removeItem('sm-updated-at'); } catch { /* private mode */ }
    if (at && Date.now() - at < 60_000) say('orchestrator' as CrewId, 'Office updated — the new changes are live!');
  }, [Boolean(state)]); // eslint-disable-line react-hooks/exhaustive-deps

  return { enabled, projects, project, setProject, reloadProjects: loadProjects, state, error, refresh, override, bubbles, celebrating, celebrate, say };
}

export type SuccessManager = ReturnType<typeof useSuccessManager>;

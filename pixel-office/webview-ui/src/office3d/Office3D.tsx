/**
 * <Office3D/> — the walkable first-person office. Built from the same OfficeLayout and agents as the
 * 2D office; chat goes through the existing Success Manager path (a mission "For NAME (role): …").
 * Start it from a 2D camera position with the ref's start(), or via the `start` prop.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { TILE_SIZE } from '../constants.js';
import { getCatalogEntry } from '../office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../office/types.js';
import { smClient } from '../sm/smClient.js';
import type { Agent3D, Pet3D } from './agents3d.js';
import { hintOpacity, type Hud3DData, reportsLabel } from './hud3d.js';
import { buildWorld, type FurnitureInfo, openSpawn, pixelToWorld } from './layout3d.js';
import { OfficeScene, type ScenePick, type StartPose } from './scene3d.js';
import { WorldBubbles } from './WorldBubbles.js';

const AGENT_POLL_MS = 400;
const MINIMAP_PX = 160;

export interface Office3DProps {
  layout: OfficeLayout;
  /** Called every ~400 ms for the current agents (build them with buildAgents3D). */
  getAgents: () => Agent3D[];
  /** Zoo animals (build them with buildPets3D). */
  getPets?: () => Pet3D[];
  /** Success Manager project that chat messages are filed under. */
  project: string;
  /** Where to start (world metres). Defaults to the first free spot near the layout centre. */
  start?: StartPose;
  onExit: () => void;
  onReady?: () => void;
  /** Success Manager data for the Reports pill and the speech bubbles over characters. */
  hud?: Hud3DData;
}

export interface Office3DHandle {
  /** Restart the walk from a 2D camera position (pixel coords of the 2D map). */
  startFromPixels: (px: number, py: number, yaw?: number) => void;
  /** Current pose in 2D pixel coordinates (for animating back to 2D). */
  getPixelPose: () => { px: number; py: number; yaw: number } | null;
}

interface ChatLine { from: 'me' | 'sys'; text: string }

export const Office3D = forwardRef<Office3DHandle, Office3DProps>(function Office3D(
  { layout, getAgents, getPets, project, start, onExit, onReady, hud },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OfficeScene | null>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const getAgentsRef = useRef(getAgents);
  getAgentsRef.current = getAgents;
  const getPetsRef = useRef(getPets);
  getPetsRef.current = getPets;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const pickRef = useRef<(p: ScenePick) => void>(() => undefined);
  const [target, setTarget] = useState<Agent3D | null>(null);
  const [locked, setLocked] = useState(false);
  const [chatWith, setChatWith] = useState<Agent3D | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [prompting, setPrompting] = useState(false);
  const [free, setFree] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hintAlpha, setHintAlpha] = useState(1);
  const [room, setRoom] = useState('');
  const lockedAt = useRef<number | null>(null);

  const world = useMemo(
    () => buildWorld(layout, (t): FurnitureInfo | undefined => getCatalogEntry(t)),
    [layout],
  );

  useImperativeHandle(ref, () => ({
    startFromPixels: (px, py, yaw) => { const w = pixelToWorld(px, py); scene.current?.start({ ...w, yaw }); },
    getPixelPose: () => {
      const p = scene.current?.getPose();
      return p ? { px: (p.x) * TILE_SIZE, py: p.z * TILE_SIZE, yaw: p.yaw } : null;
    },
  }), []);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const s = new OfficeScene(el, world, {
      onTalkTarget: setTarget,
      onExit: () => exitRef.current(),
      onLockChange: setLocked,
      onFreeChange: setFree,
      onPick: (p) => pickRef.current(p),
    });
    if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
    window.__pixelAgentsTestHooks.office3d = s; // visual checks can fly the camera (see testHooks.ts)
    scene.current = s;
    s.setMinimap(map.current);
    s.setAgents(getAgentsRef.current());
    s.setPets(getPetsRef.current?.() ?? []);
    s.start(start ?? openSpawn(world), true);
    onReady?.();
    const poll = window.setInterval(() => { s.setAgents(getAgentsRef.current()); s.setPets(getPetsRef.current?.() ?? []); }, AGENT_POLL_MS);
    // "You are in: <room>" chip: 3D has no wall signs, so name the room the player stands in.
    const where = window.setInterval(() => {
      const p = s.getPose();
      const col = Math.floor(p.x), row = Math.floor(p.z);
      const inside = col >= 0 && row >= 0 && col < world.cols && row < world.rows;
      setRoom((inside ? layoutRef.current.areaTiles?.[row * world.cols + col] : '') ?? '');
    }, 300);
    return () => { window.clearInterval(poll); window.clearInterval(where); s.dispose(); scene.current = null; };
    // The scene is rebuilt only when the layout changes; start/onReady are read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // The controls hint stays until you have been looking around for a few seconds, then fades; it returns when the mouse is released.
  useEffect(() => {
    lockedAt.current = locked ? performance.now() : null;
    if (!locked) { setHintAlpha(1); return; }
    const t = window.setInterval(() => setHintAlpha(hintOpacity(performance.now() - (lockedAt.current ?? 0))), 150);
    return () => window.clearInterval(t);
  }, [locked]);

  const openChat = useCallback((a: Agent3D) => {
    setChatWith(a); setLines([]); setText('');
    scene.current?.setPaused(true);
  }, []);
  const closeChat = useCallback(() => {
    setChatWith(null); setPrompting(false);
    scene.current?.setPaused(false);
    scene.current?.requestLock();
  }, []);
  const openPrompt = useCallback(() => {
    setPrompting(true); setLines([]); setText('');
    scene.current?.setPaused(true);
  }, []);
  const say = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);
  pickRef.current = (p) => {
    if (chatWith || prompting) return;
    if (p.kind === 'agent') {
      const a = getAgentsRef.current().find((x) => x.id === p.id);
      if (!a) return;
      if (a.crewId) openChat(a);
      else say(`${a.name} · ${a.role}${a.task ? ` — ${a.task}` : ''}`);
    } else if (p.kind === 'pet') {
      const pet = getPetsRef.current?.().find((x) => x.id === p.id);
      say(pet ? pet.name : 'A Zoo animal');
    } else {
      say(getCatalogEntry(p.type)?.label ?? p.type.replace(/_/g, ' ').toLowerCase());
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyE' && !chatWith && !prompting && target) { e.preventDefault(); openChat(target); }
      else if ((e.code === 'Enter' || e.code === 'KeyT') && !chatWith && !prompting) { e.preventDefault(); openPrompt(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatWith, prompting, target, openChat, openPrompt]);

  const send = useCallback(async () => {
    if ((!chatWith && !prompting) || !text.trim() || busy) return;
    const msg = text.trim();
    setBusy(true); setLines((l) => [...l, { from: 'me', text: msg }]); setText('');
    try {
      if (chatWith) {
        await smClient.mission.create(project, `For ${chatWith.name} (${chatWith.role}): ${msg}`);
        setLines((l) => [...l, { from: 'sys', text: `Sent to ${chatWith.name}. Their answer shows up in the Missions panel.` }]);
      } else {
        await smClient.mission.create(project, msg);
        setLines((l) => [...l, { from: 'sys', text: 'Sent to ARES. It is planning it — watch the office.' }]);
      }
    } catch (e) {
      setLines((l) => [...l, { from: 'sys', text: `Could not send: ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  }, [chatWith, prompting, text, busy, project]);

  return (
    <div className="absolute inset-0 bg-bg-dark select-none" style={{ zIndex: 40 }}>
      <div ref={host} className="absolute inset-0" />
      <div className="absolute left-1/2 top-1/2 w-[6px] h-[6px] -translate-x-1/2 -translate-y-1/2 border-2 border-white opacity-70 pointer-events-none" style={{ display: free ? 'none' : undefined }} />
      {hud && !chatWith && !prompting && <WorldBubbles scene={scene} getAgents={() => getAgentsRef.current()} hud={hud} />}

      {/* Top-left: pixel Back to 2D control */}
      <div className="absolute left-10 top-10 flex gap-6 items-start" style={{ zIndex: 5 }}>
        <button
          onClick={onExit}
          title="Back to the 2D office (Esc)"
          className="flex items-center gap-6 bg-btn-bg hover:bg-btn-hover text-text text-sm border-2 border-border shadow-pixel px-8 h-32 cursor-pointer"
        >
          <span aria-hidden>◀</span> 2D <span className="text-2xs text-text-muted">ESC</span>
        </button>
        <button
          onClick={() => { const sc = scene.current; if (sc) sc.setHover(!sc.isHovering()); }}
          title="Hover over the office for an overview (H)"
          className="flex items-center gap-6 bg-btn-bg hover:bg-btn-hover text-text text-sm border-2 border-border shadow-pixel px-8 h-32 cursor-pointer"
        >
          <span aria-hidden>▲</span> HOVER <span className="text-2xs text-text-muted">H</span>
        </button>
        {hud && (
          <button
            onClick={hud.onOpenReports}
            title="Reports from the Floor Manager"
            className="flex items-center gap-6 border-2 shadow-pixel px-8 h-32 text-sm cursor-pointer"
            style={{
              background: hud.unreadReports ? 'var(--color-sm-gold)' : 'var(--color-btn-bg)',
              color: hud.unreadReports ? 'var(--color-sm-bubble-text)' : 'var(--color-text)',
              borderColor: hud.unreadReports ? 'var(--color-sm-bubble-text)' : 'var(--color-border)',
            }}
          >
            <span aria-hidden>▤</span> {reportsLabel(hud.unreadReports)}
          </button>
        )}
      </div>
      {room && (
        <div className="absolute left-10 top-[52px] bg-bg-dark border-2 border-border shadow-pixel text-2xs text-text px-8 py-3 pointer-events-none" style={{ zIndex: 5 }}>
          <span className="text-text-muted">IN</span> {room.toUpperCase()}
        </div>
      )}

      {/* Top-right: minimap in a pixel frame */}
      <div className="absolute right-10 top-10 bg-bg-dark border-2 border-border shadow-pixel p-4 pointer-events-none" style={{ zIndex: 5 }}>
        <div className="text-2xs text-text-muted leading-none pb-2">MAP</div>
        <canvas ref={map} width={MINIMAP_PX} height={Math.max(1, Math.round((MINIMAP_PX * world.rows) / world.cols))} className="block border-2 border-border" style={{ imageRendering: 'pixelated' }} />
      </div>

      {/* Bottom: controls hint, fades once you are walking around */}
      <div
        className="absolute left-1/2 bottom-10 -translate-x-1/2 max-w-[calc(100%-300px)] flex flex-wrap justify-center gap-x-10 gap-y-4 bg-bg-dark border-2 border-border shadow-pixel text-2xs text-text px-8 py-4 pointer-events-none"
        style={{ opacity: hintAlpha, transition: 'opacity 150ms linear', zIndex: 5 }}
      >
        {!locked && !free && <span className="text-accent-bright">CLICK OR DRAG TO LOOK</span>}
        {free && <span className="text-accent-bright">MOUSE FREE · CLICK THINGS</span>}
        <span><b>WASD</b> WALK</span><span><b>SHIFT</b> RUN</span><span><b>E</b> TALK</span><span><b>ENTER</b> PROMPT</span><span><b>TAB</b> MOUSE</span><span><b>CLICK</b> USE</span><span><b>H</b> HOVER</span><span><b>F</b> FLY · <b>SPACE</b>/<b>C</b></span><span><b>ESC</b> BACK</span>
      </div>

      {target && !chatWith && (
        <div className="absolute left-1/2 bottom-[18%] -translate-x-1/2 bg-bg-dark border-2 border-accent shadow-pixel text-text text-sm px-12 py-6 pointer-events-none">
          Press <b>E</b> to talk to {target.name}
        </div>
      )}
      {toast && !chatWith && !prompting && (
        <div className="absolute left-1/2 bottom-[26%] -translate-x-1/2 bg-bg-dark border-2 border-border shadow-pixel text-text text-sm px-12 py-6 pointer-events-none" style={{ zIndex: 6 }}>{toast}</div>
      )}
      {!chatWith && !prompting && (
        <button
          onClick={openPrompt}
          title="Tell ARES what you need (Enter)"
          className="absolute left-10 bottom-10 flex items-center gap-6 bg-btn-bg hover:bg-btn-hover text-text text-sm border-2 border-border shadow-pixel px-8 h-32 cursor-pointer"
          style={{ zIndex: 5 }}
        >
          <span aria-hidden>✎</span> PROMPT <span className="text-2xs text-text-muted">ENTER</span>
        </button>
      )}
      {(chatWith || prompting) && (
        <div className="absolute right-10 bottom-10 w-[360px] max-w-[90%] bg-bg-dark border-2 border-border text-text flex flex-col gap-6 p-8">
          <div className="flex items-center justify-between text-sm">
            <span><b>{chatWith ? chatWith.name : 'ARES'}</b> <span className="text-text-muted">· {chatWith ? chatWith.role : 'Floor Manager'}</span></span>
            <button className="px-6 border-2 border-border" onClick={closeChat} title="Close (Esc)">✕</button>
          </div>
          <div className="text-2xs text-text-muted">{chatWith ? `Now: ${chatWith.task || chatWith.state.toLowerCase()}` : `Files a mission in ${project || 'the chosen project'}`}</div>
          <div className="flex flex-col gap-4 max-h-[180px] overflow-y-auto text-2xs">
            {lines.map((l, i) => (
              <div key={i} className={l.from === 'me' ? 'self-end bg-border px-6 py-2' : 'text-text-muted'}>{l.text}</div>
            ))}
          </div>
          <form className="flex gap-6" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <input
              autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={chatWith ? `Message ${chatWith.name}…` : 'Tell ARES what you need…'}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') closeChat(); }}
              className="flex-1 bg-bg border-2 border-border text-text text-sm px-6 py-4 outline-none"
            />
            <button type="submit" disabled={busy || !text.trim()} className="px-8 border-2 border-border">Send</button>
          </form>
        </div>
      )}
    </div>
  );
});

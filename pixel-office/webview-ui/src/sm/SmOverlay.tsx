/**
 * DOM layer over the office canvas for the Success Manager:
 *  - speech bubbles above crew (mission events), and a pulsing "Need your help!" over anyone jumping
 *  - the report tray on YOUR desk (Your Office) with an unread badge
 *  - confetti + banner when a mission completes
 * Positions use the same projection as Pixel Agents' ToolOverlay so they stick to the sprites.
 */
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import { SM_CONFETTI_COLORS } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isZooPet } from '../office/engine/petEntity.js';
import { overlayProjection } from '../office/projection.js';
import { TILE_SIZE } from '../office/types.js';
import { CREW, CREW_BY_ID } from './crew.js';
import { readReports } from './reportsStore.js';
import type { IvyTab } from './SmSecretary.js';
import type { SuccessManager } from './useSuccessManager.js';

/** Your desk = the first desk inside the "Your Office" area of the current layout. */
function findYourDesk(os: OfficeState): { x: number; y: number } | null {
  const layout = os.getLayout();
  const area = layout.areaTiles;
  if (!area) return null;
  for (const f of layout.furniture) {
    if (!f.type.startsWith('DESK') && !f.type.startsWith('TABLE')) continue;
    if (area[f.row * layout.cols + f.col] === 'Your Office' || area[(f.row + 1) * layout.cols + f.col] === 'Your Office') {
      return { x: (f.col + 1.5) * TILE_SIZE, y: f.row * TILE_SIZE + 6 };
    }
  }
  return null;
}

/** What each department does — shown on the sign over its door. Keyed by Area label. */
const DEPARTMENTS: Record<string, string> = {
  'Your Office': 'Reports land on your desk',
  'Control Room': 'Floor Manager · plans & reviews',
  Engineering: 'Builds, tests & secures the code',
  'Design Lab': 'UI & user experience',
  'QA Lab': 'Logic, edge cases & testing',
  Marketing: 'Copy, onboarding & launch',
  Lounge: 'Break room',
  'Game Room': 'Click to watch live games',
  Reception: 'IVY · phone & front desk',
};

/** IVY's clickable spots in Reception, hung on furniture by uid (office-layout/generate.js), so they follow it if moved. */
// `dy` = tiles below the item's top row to hang the spot (wall items hang it just inside the room, under the wall).
const IVY_SPOTS: Array<{ uid: string; icon: string; label: string; tab: IvyTab; dx: number; dy: number }> = [
  { uid: 'sm-rec-desk', icon: '☎', label: 'Calls', tab: 'calls', dx: -0.3, dy: 1 },
  { uid: 'sm-rec-board', icon: '📝', label: 'Give Ivy a task', tab: 'tasks', dx: 1, dy: 2.6 },
  { uid: 'sm-rec-files', icon: '🗂', label: 'While you were away', tab: 'away', dx: 0.5, dy: 2.4 },
  { uid: 'sm-rec-shelf', icon: '📇', label: 'What she knows', tab: 'know', dx: 1, dy: 1.6 },
  { uid: 'sm-rec-desk', icon: '📅', label: 'Your calendar', tab: 'calendar', dx: 1.1, dy: 1 },
];

/** One sign per named Area (room), centred on the room's back wall. */
function roomSigns(os: OfficeState): Array<{ label: string; color: string; x: number; y: number }> {
  const layout = os.getLayout();
  const tiles = layout.areaTiles;
  if (!tiles || !layout.areas?.length) return [];
  return layout.areas.map((a) => {
    let minC = Infinity, maxC = -1, minR = Infinity;
    tiles.forEach((label, i) => {
      if (label !== a.label) return;
      const c = i % layout.cols, r = Math.floor(i / layout.cols);
      minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r);
    });
    if (maxC < 0) return null;
    // the wall face is drawn in the 16 px above the room's first floor row
    return { label: a.label, color: a.color, x: ((minC + maxC + 1) / 2) * TILE_SIZE, y: minR * TILE_SIZE - TILE_SIZE / 2 };
  }).filter((p): p is { label: string; color: string; x: number; y: number } => p !== null);
}

function Confetti({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !active) return;
    const c = canvas.getContext('2d');
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    const parts = Array.from({ length: 180 }, () => ({
      x: Math.random() * w, y: -Math.random() * h * 0.6, vx: (Math.random() - 0.5) * 3 * dpr, vy: (2 + Math.random() * 3) * dpr,
      s: (4 + Math.random() * 5) * dpr, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
      color: SM_CONFETTI_COLORS[Math.floor(Math.random() * SM_CONFETTI_COLORS.length)],
    }));
    let raf = 0;
    const step = () => {
      c.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vy += 0.03 * dpr;
        if (p.y > h + 20) { p.y = -20; p.x = Math.random() * w; p.vy = (2 + Math.random() * 3) * dpr; }
        c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.color;
        c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); // chunky pixel strips
        c.restore();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); c.clearRect(0, 0, w, h); };
  }, [active]);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 46, display: active ? 'block' : 'none' }} />;
}

export function SmOverlay({ sm, officeState, containerRef, zoom, panRef, onOpenReports, onCrewClick, onOpenRoom, onOpenIvy }: {
  sm: SuccessManager;
  officeState: OfficeState;
  containerRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: RefObject<{ x: number; y: number }>;
  onOpenReports: () => void;
  onCrewClick: (agentId: number) => void;
  onOpenRoom: (label: string) => void;
  onOpenIvy: (tab: IvyTab) => void;
}) {
  // The animation clock lives in state (render must stay pure).
  const [clock, setClock] = useState({ now: 0, t: 0 });
  useEffect(() => {
    let raf = 0;
    const tick = () => { setClock({ now: Date.now(), t: performance.now() / 1000 }); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const layout = officeState.getLayout();
  const desk = useMemo(() => findYourDesk(officeState), [officeState, layout]);
  const signs = useMemo(() => roomSigns(officeState), [officeState, layout]);
  const ivySpots = useMemo(() => IVY_SPOTS.flatMap((sp) => {
    const f = layout.furniture.find((x) => x.uid === sp.uid);
    return f ? [{ ...sp, x: (f.col + sp.dx) * TILE_SIZE, y: (f.row + sp.dy) * TILE_SIZE }] : [];
  }), [layout]);
  const ivy = CREW_BY_ID.get('secretary');
  const unread = (sm.state?.reports ?? []).filter((r) => !readReports().has(r.id)).length;

  const el = containerRef.current;
  if (!sm.enabled || !el || !panRef.current) return null;
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(layout, el.getBoundingClientRect(), zoom, panRef.current, dpr);
  const { now, t } = clock;

  return (
    <>
      {/* Department signs on each room's back wall */}
      {signs.map((p) => (
        <button key={p.label} onClick={() => onOpenRoom(p.label)} title={p.label === 'Game Room' ? 'Game Room — watch the live games' : p.label === 'Reception' ? "Reception — IVY's desk" : `${p.label} — room settings: department brief, staff, hiring`}
          className="absolute cursor-pointer border-2 shadow-pixel bg-bg-dark text-center whitespace-nowrap px-6 py-1 hover:brightness-125"
          style={{ left: project.toScreenX(p.x), top: project.toScreenY(p.y), transform: 'translate(-50%, -50%)', borderColor: p.color, zIndex: 5 }}>
          <div className="text-2xs leading-none pt-2" style={{ color: p.color }}>{p.label.toUpperCase()}</div>
          {DEPARTMENTS[p.label] && zoom >= 3 && <div className="text-2xs leading-tight text-text-muted">{DEPARTMENTS[p.label]}</div>}
        </button>
      ))}

      {/* IVY's clickable spots in Reception (desk, board, files, shelf) */}
      {ivySpots.map((sp) => (
        <button key={sp.uid} onClick={() => onOpenIvy(sp.tab)} title={`IVY — ${sp.label}`}
          className="absolute cursor-pointer border-2 shadow-pixel bg-bg-dark whitespace-nowrap text-2xs leading-none px-3 py-2 hover:brightness-125"
          style={{ left: project.toScreenX(sp.x), top: project.toScreenY(sp.y) - Math.abs(Math.sin(t * 2 + sp.x)) * 2, transform: 'translate(-50%, -100%)', borderColor: 'var(--color-accent-bright)', zIndex: 6 }}>
          {sp.icon}{zoom >= 3 ? ` ${sp.label}` : ''}
        </button>
      ))}

      {/* Clickable chips on IVY herself: her phone and her task list */}
      {ivy && (() => {
        const ch = officeState.characters.get(ivy.agentId);
        if (!ch || ch.matrixEffect || sm.bubbles.some((b) => b.crewId === ivy.id && b.until > now)) return null;
        return (
          <div className="absolute flex gap-2" style={{ left: project.toScreenX(ch.x), top: project.toScreenY(ch.y - 34), transform: 'translate(-50%, -100%)', zIndex: 43 }}>
            {([['☎', 'calls', 'IVY — calls'], ['📝', 'tasks', 'IVY — tell her what you need (she passes it to ARES)']] as const).map(([icon, tab, title]) => (
              <button key={tab} onClick={() => onOpenIvy(tab)} title={title}
                className="cursor-pointer border-2 shadow-pixel bg-bg-dark text-2xs leading-none px-3 py-2 hover:brightness-125" style={{ borderColor: 'var(--color-accent-bright)' }}>{icon}</button>
            ))}
          </div>
        );
      })()}

      {/* Zoo animal name tags (zoomed in enough to read) */}
      {zoom >= 1.5 && officeState.pets.filter((pt) => isZooPet(pt.id)).map((pt) => (
        <div key={pt.id} className="absolute pointer-events-none whitespace-nowrap text-2xs leading-none px-3 py-1 bg-bg-dark border border-border text-text"
          style={{ left: project.toScreenX(pt.x), top: project.toScreenY(pt.y - 18), transform: 'translate(-50%, -100%)', zIndex: 5 }}>{pt.name}</div>
      ))}

      {/* Speech bubbles + help callouts */}
      {CREW.map((c) => {
        const ch = officeState.characters.get(c.agentId);
        if (!ch || ch.matrixEffect) return null;
        const helping = ch.smPose === 'help';
        const bubble = sm.bubbles.find((b) => b.crewId === c.id && b.until > now);
        if (!helping && !bubble) return null;
        const hop = helping ? Math.abs(Math.sin(t * 9 + ch.id)) * 4 : 0;
        const x = project.toScreenX(ch.x);
        const y = project.toScreenY(ch.y - 36 - hop);
        const text = helping ? (bubble?.text && bubble.kind === 'help' ? bubble.text : 'Need your help!') : bubble!.text;
        return (
          <button
            key={c.id}
            onClick={() => onCrewClick(c.agentId)}
            className="absolute border-2 shadow-pixel px-6 py-2 text-2xs leading-tight cursor-pointer whitespace-pre-wrap text-center"
            style={{
              left: x, top: y, transform: 'translate(-50%, -100%)', zIndex: helping ? 45 : 44, maxWidth: 220,
              background: helping ? 'var(--color-sm-help)' : 'var(--color-sm-bubble-bg)',
              color: helping ? 'var(--color-text)' : 'var(--color-sm-bubble-text)',
              borderColor: helping ? 'var(--color-sm-bubble-text)' : 'var(--color-border)',
            }}
            title={helping ? `${c.name} needs you — click to answer` : c.name}
          >
            <span className="block text-2xs opacity-70">{c.name}</span>
            {text}
            {helping && <span className="block text-2xs">▼ click me</span>}
          </button>
        );
      })}

      {/* Report tray on your desk */}
      {desk && (
        <button
          onClick={onOpenReports}
          className="absolute border-2 shadow-pixel cursor-pointer px-6 py-2 text-2xs"
          style={{
            left: project.toScreenX(desk.x), top: project.toScreenY(desk.y) - (unread ? Math.abs(Math.sin(t * 4)) * 6 : 0),
            transform: 'translate(-50%, -100%)', zIndex: 40,
            background: unread ? 'var(--color-sm-gold)' : 'var(--color-btn-bg)',
            color: unread ? 'var(--color-sm-bubble-text)' : 'var(--color-text)',
            borderColor: unread ? 'var(--color-sm-bubble-text)' : 'var(--color-border)',
          }}
          title="Reports from the Floor Manager"
        >
          📋 {unread ? `${unread} new report${unread > 1 ? 's' : ''}!` : 'Reports'}
        </button>
      )}

      <Confetti active={Boolean(sm.celebrating)} />
      {sm.celebrating && (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 border-2 shadow-pixel px-16 py-8 text-center pointer-events-none"
          style={{ zIndex: 47, background: 'var(--color-sm-gold)', color: 'var(--color-sm-bubble-text)', borderColor: 'var(--color-sm-bubble-text)' }}>
          <div className="text-xl">MISSION COMPLETE!</div>
          <div className="text-sm">{sm.celebrating.headline}</div>
          <div className="text-2xs">Your report is on your desk 📋</div>
        </div>
      )}
      {!desk && CREW_BY_ID.size > 0 && (sm.state?.reports.length ?? 0) > 0 && (
        <button onClick={onOpenReports} className="absolute right-60 top-8 border-2 border-border bg-btn-bg text-text text-2xs px-6 py-2 shadow-pixel cursor-pointer" style={{ zIndex: 40 }}>
          📋 Reports{unread ? ` (${unread} new)` : ''}
        </button>
      )}
    </>
  );
}

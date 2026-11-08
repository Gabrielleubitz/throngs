/**
 * Speech bubbles pinned to characters in the 3D scene. Each frame the character's head position is projected
 * through the scene's own camera, so a bubble sits over its character, shrinks with distance and disappears
 * behind you or out of range. Pixel styled: hard border, stepped tail, no rounded corners.
 */
import { type RefObject, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import type { Agent3D } from './agents3d.js';
import { BUBBLE_ANCHOR_Y, type Bubble3D, bubbleScale, type Hud3DData, ndcToScreen } from './hud3d.js';
import type { OfficeScene } from './scene3d.js';

const REFRESH_MS = 250;
const FOLLOW = 12; // exp smoothing per second, so a bubble glides with the 400 ms agent polls
const TAIL_STEPS = [12, 8, 4];

/** The scene's camera. Read through a narrow cast; the integrator may expose a public accessor later. */
function cameraOf(scene: OfficeScene | null): THREE.PerspectiveCamera | null {
  const s = scene as unknown as { getCamera?: () => THREE.PerspectiveCamera; camera?: THREE.PerspectiveCamera } | null;
  return s?.getCamera?.() ?? s?.camera ?? null;
}

export function WorldBubbles({ scene, getAgents, hud }: {
  scene: RefObject<OfficeScene | null>;
  getAgents: () => Agent3D[];
  hud: Hud3DData;
}) {
  const [items, setItems] = useState<Bubble3D[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const hudRef = useRef(hud);
  hudRef.current = hud;
  const getAgentsRef = useRef(getAgents);
  getAgentsRef.current = getAgents;

  useEffect(() => {
    const read = () => setItems(hudRef.current.getBubbles());
    read();
    const t = window.setInterval(read, REFRESH_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const smooth = new Map<number, { x: number; z: number }>();
    const v = new THREE.Vector3();
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const el = root.current;
      const cam = cameraOf(scene.current);
      if (!el || !cam) return;
      const w = el.clientWidth, h = el.clientHeight;
      const agents = new Map(getAgentsRef.current().map((a) => [a.id, a]));
      const k = 1 - Math.exp(-FOLLOW * dt);
      for (const node of Array.from(el.children) as HTMLElement[]) {
        const id = Number(node.dataset['agent']);
        const a = agents.get(id);
        if (!a) { node.style.visibility = 'hidden'; continue; }
        const p = smooth.get(id) ?? { x: a.x, z: a.z };
        p.x += (a.x - p.x) * k; p.z += (a.z - p.z) * k;
        smooth.set(id, p);
        const bob = node.dataset['kind'] === 'help' ? Math.abs(Math.sin(now / 1000 * 9 + id)) * 0.12 : 0;
        v.set(p.x, BUBBLE_ANCHOR_Y + bob, p.z);
        const dist = v.distanceTo(cam.position);
        v.project(cam);
        const pt = ndcToScreen(v.x, v.y, v.z, w, h, 80);
        const scale = bubbleScale(dist);
        if (!pt || scale === 0) { node.style.visibility = 'hidden'; continue; }
        node.style.visibility = 'visible';
        node.style.transform = `translate(${Math.round(pt.x)}px, ${Math.round(pt.y)}px) translate(-50%, -100%) scale(${scale})`;
        node.style.zIndex = String(Math.round(1000 - dist * 10));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene]);

  return (
    <div ref={root} className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 3 }}>
      {items.map((b) => {
        const help = b.kind === 'help';
        const fill = help ? 'var(--color-sm-help)' : 'var(--color-sm-bubble-bg)';
        const edge = help ? 'var(--color-sm-bubble-text)' : 'var(--color-border)';
        const ink = help ? 'var(--color-text)' : 'var(--color-sm-bubble-text)';
        return (
          <div key={b.agentId} data-agent={b.agentId} data-kind={b.kind} className="absolute left-0 top-0 flex flex-col items-center" style={{ visibility: 'hidden', transformOrigin: '50% 100%', willChange: 'transform' }}>
            <button
              onClick={() => hudRef.current.onCrewClick(b.agentId)}
              title={help ? `${b.name} needs you — click to answer` : b.name}
              className="pointer-events-auto shadow-pixel cursor-pointer text-2xs leading-tight text-center whitespace-pre-wrap px-6 py-2"
              style={{ maxWidth: 200, background: fill, color: ink, border: `2px solid ${edge}`, borderRadius: 0 }}
            >
              <span className="block opacity-70">{b.name}</span>
              {b.text}
              {help && <span className="block">▼ CLICK ME</span>}
            </button>
            {TAIL_STEPS.map((wd, i) => (
              <div key={wd} style={{ width: wd, height: 2, background: fill, boxShadow: `-2px 0 0 ${edge}, 2px 0 0 ${edge}${i === TAIL_STEPS.length - 1 ? `, 0 2px 0 ${edge}` : ''}` }} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

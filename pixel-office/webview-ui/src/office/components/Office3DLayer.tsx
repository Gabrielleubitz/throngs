/**
 * The 2D↔3D switch: a "3D" button beside the zoom controls, the lazily loaded first-person office, and the
 * cross-fade between the two. The 2D canvas keeps its place underneath (so zoom/pan/selection survive the
 * round trip) and its render loop is paused while the 3D view fully covers it.
 */
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { OFFICE3D_BUTTON_LEFT_PX, OFFICE3D_TRANSITION_MS } from '../../constants.js';
import type { Hud3DData } from '../../office3d/hud3d.js';
import type { Agent3D, Pet3D } from '../../office3d/index.js';
import type { Office3DHandle } from '../../office3d/index.js';
import type { OfficeState } from '../engine/officeState.js';

// A tab opened before the office was rebuilt asks for the OLD 3D chunk, which no longer exists: reload once onto
// the new build instead of showing a blank screen (sessionStorage guards against a reload loop).
const Office3D = lazy(() =>
  import('../../office3d/index.js').then((m) => {
    try { sessionStorage.removeItem('sm-3d-chunk-reload'); } catch { /* private mode */ }
    return { default: m.Office3D };
  }).catch((err: unknown) => {
    let retried = false;
    try { retried = sessionStorage.getItem('sm-3d-chunk-reload') === '1'; sessionStorage.setItem('sm-3d-chunk-reload', '1'); } catch { /* private mode */ }
    if (!retried) window.location.reload();
    throw err;
  }),
);

type Phase = '2d' | 'to3d' | '3d' | 'to2d';

interface Office3DLayerProps {
  officeState: OfficeState;
  getAgents: () => Agent3D[];
  getPets?: () => Pet3D[];
  project: string;
  /** Success Manager data for the 3D HUD (Reports pill, bubbles over characters). */
  hud?: Hud3DData;
  /** The 2D canvas; rendered underneath and faded/zoomed during the transition. */
  children: (paused: boolean) => ReactNode;
  /** Hide the button (mobile, debug view). */
  showButton: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

export function Office3DLayer({
  officeState,
  getAgents,
  getPets,
  project,
  hud,
  children,
  showButton,
}: Office3DLayerProps) {
  const [phase, setPhase] = useState<Phase>('2d');
  const [shown, setShown] = useState(false); // drives the opacity transition
  const handle = useRef<Office3DHandle>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const duration = useRef(OFFICE3D_TRANSITION_MS);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const enter = useCallback(() => {
    if (phase !== '2d') return;
    duration.current = prefersReducedMotion() ? 0 : OFFICE3D_TRANSITION_MS;
    setPhase('to3d');
    // Next frame so the 3D layer mounts at opacity 0 before it transitions in.
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    timer.current = setTimeout(() => setPhase('3d'), duration.current);
  }, [phase]);

  const exit = useCallback(() => {
    if (phase === '2d' || phase === 'to2d') return;
    if (timer.current) clearTimeout(timer.current);
    duration.current = prefersReducedMotion() ? 0 : OFFICE3D_TRANSITION_MS;
    setPhase('to2d');
    setShown(false);
    timer.current = setTimeout(() => setPhase('2d'), duration.current);
  }, [phase]);

  // Start the walk where the 2D camera is looking (the followed/selected character), if there is one.
  const onReady = useCallback(() => {
    const id = officeState.cameraFollowId ?? officeState.selectedAgentId;
    const ch = id === null ? undefined : officeState.getCharacters().find((c) => c.id === id);
    if (ch) handle.current?.startFromPixels(ch.x, ch.y);
  }, [officeState]);

  const in3d = phase !== '2d';
  const paused = phase === '3d';
  const ms = duration.current;
  return (
    <>
      <div
        className="absolute inset-0"
        style={{
          opacity: in3d && shown ? 0 : 1,
          transform: in3d && shown ? 'scale(1.12)' : 'none',
          transition: `opacity ${ms}ms ease-in-out, transform ${ms}ms ease-in-out`,
          pointerEvents: in3d ? 'none' : undefined,
        }}
        aria-hidden={in3d}
      >
        {children(paused)}
      </div>

      {showButton && !in3d && (
        <div className="absolute z-10" style={{ top: 8, left: OFFICE3D_BUTTON_LEFT_PX }}>
          <Button
            size="icon_lg"
            onClick={enter}
            className="border-border! shadow-pixel text-sm"
            title="Walk through the office in 3D"
            aria-label="Enter 3D office"
          >
            3D
          </Button>
        </div>
      )}

      {in3d && (
        <div
          className="absolute inset-0"
          style={{ opacity: shown ? 1 : 0, transition: `opacity ${ms}ms ease-in-out`, zIndex: 58 }}
        >
          <Suspense fallback={<div className="absolute inset-0 bg-bg-dark" />}>
            <Office3D
              ref={handle}
              layout={officeState.getLayout()}
              getAgents={getAgents}
              getPets={getPets}
              project={project}
              onExit={exit}
              onReady={onReady}
              hud={hud}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

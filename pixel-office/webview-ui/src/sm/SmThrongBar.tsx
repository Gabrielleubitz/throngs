/**
 * Throng controls, top-left next to the 3D button:
 *  🍎  drag the apple onto a throng to feed it (chomp + purr in its own voice, a "nom" bubble)
 *  🔊  sound on/off for the throngs (random idle noises, chirps, the studio song); remembered
 *  🎵  MUSIC: every idle throng walks to the Studio, dances and sings (see throngStudio.ts)
 */
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { SM_THRONG_BAR_LEFT_PX } from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { CREW } from './crew.js';
import { isSmSoundEnabled, setSmSoundEnabled, subscribeSmSound } from './smSounds.js';
import { isMusicOn, setMusicOn, subscribeMusic } from './throngStudio.js';
import { throngBath, throngBonk, throngFeed } from './throngVoice.js';
import type { SuccessManager } from './useSuccessManager.js';

type Tool = 'apple' | 'bath' | 'hammer';
const TOOLS: Record<Tool, { icon: string; verb: string; hint: string }> = {
  apple: { icon: '🍎', verb: 'Feed', hint: 'Drag the apple onto a throng to feed it' },
  bath: { icon: '🛁', verb: 'Bathe', hint: 'Drag the bathtub onto a throng to give it a bath' },
  hammer: { icon: '🔨', verb: 'Bonk', hint: 'Drag the hammer onto a throng to bonk it (it yelps)' },
};

export function SmThrongBar({ sm, officeState, containerRef, zoom, panRef }: {
  sm: SuccessManager;
  officeState: OfficeState;
  containerRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: RefObject<{ x: number; y: number }>;
}) {
  const [sound, setSound] = useState(isSmSoundEnabled);
  const [music, setMusic] = useState(isMusicOn);
  const [drag, setDrag] = useState<{ x: number; y: number; over: string | null; tool: Tool } | null>(null);
  useEffect(() => subscribeSmSound(() => setSound(isSmSoundEnabled())), []);
  useEffect(() => subscribeMusic(() => setMusic(isMusicOn())), []);

  /** The throng under a viewport point, if any. */
  const throngAt = (clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el || !panRef.current) return null;
    const rect = el.getBoundingClientRect();
    const p = overlayProjection(officeState.getLayout(), rect, zoom, panRef.current, window.devicePixelRatio || 1);
    const id = officeState.getCharacterAt(p.toWorldX(clientX - rect.left), p.toWorldY(clientY - rect.top));
    return id === null ? null : CREW.find((c) => c.agentId === id) ?? null;
  };

  const onToolDown = (tool: Tool) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, y: e.clientY, over: null, tool });
  };
  const onToolMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, over: throngAt(e.clientX, e.clientY)?.name ?? null });
  };
  const onToolUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const tool = drag.tool;
    setDrag(null);
    const c = throngAt(e.clientX, e.clientY);
    if (!c) return;
    if (tool === 'bath') { const n = throngBath(c.id); sm.say(c.id, `Squeaky clean! 🛁 (${n} bath${n === 1 ? '' : 's'} given)`); return; }
    if (tool === 'hammer') { const n = throngBonk(c.id); sm.say(c.id, `Ow! 🔨 Why?! (${n} bonk${n === 1 ? '' : 's'})`); return; }
    const total = throngFeed(c.id);
    sm.say(c.id, `Nom nom! 🍎 Thank you! (${total} apple${total === 1 ? '' : 's'} fed)`);
  };

  if (!sm.enabled) return null;
  return (
    <>
      <div className="absolute z-10 flex gap-4" style={{ top: 8, left: SM_THRONG_BAR_LEFT_PX }}>
        {(Object.keys(TOOLS) as Tool[]).map((t) => (
          <Button
            key={t}
            size="icon_lg"
            className="border-border! shadow-pixel text-xl cursor-grab touch-none select-none"
            title={TOOLS[t].hint}
            aria-label={`${t}: ${TOOLS[t].hint}`}
            onPointerDown={onToolDown(t)}
            onPointerMove={onToolMove}
            onPointerUp={onToolUp}
            onPointerCancel={() => setDrag(null)}
          >
            <span style={{ opacity: drag?.tool === t ? 0.35 : 1 }}>{TOOLS[t].icon}</span>
          </Button>
        ))}
        <Button
          size="icon_lg"
          variant={sound ? 'default' : 'active'}
          className="border-border! shadow-pixel text-xl"
          title={sound ? 'Throng sounds are ON — click to mute' : 'Throng sounds are OFF — click to turn them on'}
          aria-label={sound ? 'Sound on' : 'Sound off'}
          aria-pressed={sound}
          onClick={() => setSmSoundEnabled(!sound)}
        >
          {sound ? '🔊' : '🔇'}
        </Button>
        <Button
          size="md"
          variant={music ? 'accent' : 'default'}
          className="border-border! shadow-pixel text-sm h-40"
          title={music ? 'Stop the music — everyone goes back to normal' : 'Music: every idle throng goes to the Studio to dance and sing'}
          aria-pressed={music}
          onClick={() => setMusicOn(!music)}
        >
          {music ? '⏹ STOP MUSIC' : '🎵 MUSIC'}
        </Button>
      </div>
      {drag && (
        <div className="fixed pointer-events-none text-2xl" style={{ left: drag.x, top: drag.y, transform: 'translate(-50%, -50%)', zIndex: 70 }}>
          {TOOLS[drag.tool].icon}
          {drag.over && <div className="absolute left-1/2 top-full -translate-x-1/2 whitespace-nowrap text-2xs px-6 py-1 border-2 border-border bg-bg-dark text-text">{TOOLS[drag.tool].verb} {drag.over}</div>}
        </div>
      )}
    </>
  );
}

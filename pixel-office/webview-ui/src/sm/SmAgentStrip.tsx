/** Always-visible vertical strip of crew faces on the screen's right edge (outside the dock). */
import { useState } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { CREW, type CrewState } from './crew.js';
import type { SmState } from './smClient.js';

const STATE_DOT: Record<CrewState, string> = {
  WORKING: 'var(--color-status-active)',
  BLOCKED: 'var(--color-status-permission)',
  IDLE: 'var(--color-border)',
};

export function SmAgentStrip({ s, onSelect }: { s: SmState | null; onSelect: (crewId: string) => void }) {
  const [hover, setHover] = useState<{ id: string; top: number } | null>(null);
  if (!CREW.length) return null;
  return (
    <>
    <div data-testid="sm-agent-strip" className="h-full shrink-0 flex flex-col items-center gap-4 py-6 bg-bg border-l-2 border-border overflow-y-auto overflow-x-hidden" style={{ width: 48 }}>
      {CREW.map((c) => {
        const a = s?.agents.find((x) => x.id === c.id);
        const state: CrewState = a?.state ?? 'IDLE';
        return (
          <button key={c.id} data-testid={`sm-strip-${c.id}`} onClick={() => onSelect(c.id)}
            aria-label={`${c.name} · ${c.role} — ${state}${a?.task ? `: ${a.task}` : ''}`}
            onMouseEnter={(e) => setHover({ id: c.id, top: e.currentTarget.getBoundingClientRect().top + 16 })}
            onMouseLeave={() => setHover(null)}
            className="relative shrink-0 bg-transparent border-2 cursor-pointer p-0" style={{ borderColor: STATE_DOT[state], opacity: state === 'IDLE' ? 0.7 : 1 }}>
            <CharacterMugShot palette={c.palette} hueShift={c.hueShift} size={32} />
            {state !== 'IDLE' && <span className="absolute" style={{ right: -3, bottom: -3, width: 8, height: 8, background: STATE_DOT[state], border: '1px solid var(--color-bg)' }} />}
          </button>
        );
      })}
    </div>
    {hover && (() => {
      const c = CREW.find((x) => x.id === hover.id);
      const a = s?.agents.find((x) => x.id === hover.id);
      if (!c) return null;
      return (
        <div data-testid="sm-strip-tip" className="fixed z-50 pointer-events-none bg-bg-dark border-2 border-border text-text px-8 py-4 text-2xs whitespace-nowrap" style={{ right: 56, top: hover.top, transform: 'translateY(-50%)' }}>
          <b>{c.name}</b> · {c.role} — {a?.state ?? 'IDLE'}{a?.task ? `: ${a.task}` : ''}
        </div>
      );
    })()}
    </>
  );
}

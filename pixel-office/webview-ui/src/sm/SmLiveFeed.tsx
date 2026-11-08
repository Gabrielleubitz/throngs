/**
 * Claude Code / Replit-style live monitor: what an agent is reading, running, editing and thinking,
 * streamed from its mission job (missions/<id>.<job>.stream.jsonl). Polls while open.
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { smClient, type SmStreamLine } from './smClient.js';

const LOOK: Record<SmStreamLine['kind'], { icon: string; color: string }> = {
  think: { icon: '∴', color: 'var(--color-text-muted)' },
  say: { icon: '●', color: 'var(--color-text)' },
  tool: { icon: '⏺', color: 'var(--color-status-active)' },
  run: { icon: '$', color: 'var(--color-warning)' },
  done: { icon: '✎', color: 'var(--color-accent-bright)' },
  error: { icon: '✗', color: 'var(--color-danger)' },
  finish: { icon: '✓', color: 'var(--color-status-success)' },
};

export function SmLiveFeed({ project, missionId, subtaskId, title, active }: { project: string; missionId: string; subtaskId: string; title: string; active: boolean }) {
  const [lines, setLines] = useState<SmStreamLine[]>([]);
  const [showThinking, setShowThinking] = useState(true);
  const [follow, setFollow] = useState(true);
  const next = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    next.current = 0;
    setLines([]);
    let alive = true;
    const poll = async () => {
      try {
        const r = await smClient.mission.stream(project, missionId, subtaskId, next.current);
        if (!alive) return;
        if (r.lines.length) { next.current = r.next; setLines((prev) => [...prev, ...r.lines].slice(-800)); }
      } catch { /* keep trying */ }
    };
    void poll();
    const t = setInterval(poll, active ? 1200 : 5000);
    return () => { alive = false; clearInterval(t); };
  }, [project, missionId, subtaskId, active]);

  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow]);

  const shown = showThinking ? lines : lines.filter((l) => l.kind !== 'think');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-6">
        <span className="text-2xs" style={{ color: active ? 'var(--color-status-success)' : 'var(--color-text-muted)' }}>{active ? '● LIVE' : '○ finished'}</span>
        <span className="text-2xs text-text-muted truncate flex-1">{title}</span>
        <Button size="sm" variant={showThinking ? 'active' : 'default'} onClick={() => setShowThinking((v) => !v)} title="Show the agent's thinking">∴</Button>
        <Button size="sm" variant={follow ? 'active' : 'default'} onClick={() => setFollow((v) => !v)} title="Auto-scroll">↓</Button>
      </div>
      <div ref={box} className="max-h-[320px] min-h-[140px] overflow-y-auto bg-bg-dark border-2 border-border p-6">
        {shown.length ? shown.map((l, i) => (
          <div key={i} className="text-2xs leading-snug mb-2 flex gap-6" style={{ color: LOOK[l.kind]?.color }}>
            <span className="w-[12px] shrink-0 text-center">{LOOK[l.kind]?.icon ?? '·'}</span>
            <span className={`whitespace-pre-wrap break-words ${l.kind === 'think' ? 'italic' : ''}`}>{l.text}</span>
          </div>
        )) : <div className="text-2xs text-text-muted">{active ? 'Starting up…' : 'No activity was recorded for this job.'}</div>}
        {active && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>▍</div>}
      </div>
    </div>
  );
}

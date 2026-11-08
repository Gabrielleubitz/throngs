/** Top-of-screen readout from the cswap watcher (no AI): active Claude account, 5h / 7d usage, and when it last switched. */
import { useEffect, useState } from 'react';

import { type SmAccounts, smClient } from './smClient.js';

const colorFor = (pct: number) => (pct >= 95 ? 'var(--color-danger)' : pct >= 80 ? 'var(--color-warning)' : 'var(--color-status-success)');

export function SmAccountBar() {
  const [a, setA] = useState<SmAccounts | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => smClient.accounts().then((r) => { if (live) setA(r); }).catch(() => { /* keep last numbers */ });
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!a?.available || !a.active) return null;
  const { active } = a;
  const win = (label: string, w: { pct: number; countdown: string | null }) => (
    <span title={w.countdown ? `resets in ${w.countdown}` : undefined}>
      {label} <span style={{ color: colorFor(w.pct) }}>{Math.round(w.pct)}%</span>
    </span>
  );
  const title = a.accounts.map((x) => `${x.active ? '▶' : ' '} #${x.number} ${x.email}: 5h ${Math.round(x.fiveHour.pct)}% · 7d ${Math.round(x.sevenDay.pct)}%`).join('\n');
  return (
    <div
      className="absolute left-1/2 top-6 -translate-x-1/2 z-50 flex items-center gap-8 px-8 py-4 text-2xs border-2 border-border bg-bg-dark"
      title={title}
      aria-label="Claude account usage"
    >
      <span>#{active.number} {active.email.split('@')[0]}</span>
      {win('5h', active.fiveHour)}
      {win('7d', active.sevenDay)}
      {a.waitingUntil && <span style={{ color: 'var(--color-danger)' }}>all out · resets {new Date(a.waitingUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      {a.lastSwitch && <span className="text-text-muted" title={`switched at ${new Date(a.lastSwitch.at).toLocaleTimeString()}`}>switched {a.lastSwitch.from ?? '?'}→{a.lastSwitch.to}</span>}
    </div>
  );
}

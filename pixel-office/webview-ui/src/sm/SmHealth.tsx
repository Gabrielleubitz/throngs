/** HEALTH tab — one card per project, most-needs-attention first (rank comes from bin/health.js). */
import { useEffect, useState } from 'react';

import { smClient, type SmError, type SmHealth, type SmLesson, type SmWatch } from './smClient.js';

const QA_COLOR = { pass: 'var(--color-status-success)', fail: 'var(--color-danger)', unknown: 'var(--color-text-muted)' } as const;
const QA_MARK = { pass: '✓ QA PASS', fail: '✗ QA FAIL', unknown: '? QA UNKNOWN' } as const;

function ago(iso: string | null): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'never';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function HealthCard({ h, onPick }: { h: SmHealth; onPick: (name: string) => void }) {
  const accent = h.gaveUp ? 'var(--color-danger)' : QA_COLOR[h.lastQa];
  return (
    <div className="border-2 p-6 mb-6" style={{ borderColor: accent, background: 'var(--color-bg-dark)' }}>
      <div className="flex items-center gap-6 mb-4">
        <button onClick={() => onPick(h.name)} className="border-0 bg-transparent cursor-pointer text-xs p-0" style={{ color: 'var(--color-text)' }} title="Open this project">
          {h.name}
        </button>
        <span className="flex-1" />
        {h.gaveUp && <span className="text-2xs px-4" style={{ background: 'var(--color-danger)', color: 'var(--color-text)' }}>GAVE UP</span>}
        <span className="text-2xs" style={{ color: QA_COLOR[h.lastQa] }} title={h.qaFailing.length ? `Failing: ${h.qaFailing.join(', ')}` : undefined}>{QA_MARK[h.lastQa]}</span>
      </div>
      <div className="flex gap-6 text-2xs mb-2" aria-label="Open tasks by priority">
        {h.openTasks.map((n, p) => (
          <span key={p} style={{ color: n === 0 ? 'var(--color-text-muted)' : p <= 1 ? 'var(--color-danger)' : 'var(--color-text)' }}>P{p}·{n}</span>
        ))}
        <span className="flex-1" />
        <span className="text-text-muted">{h.openTotal} open</span>
      </div>
      <div className="text-2xs text-text-muted">
        Last run {ago(h.lastRun)}{h.verdict ? ` · ${h.verdict}` : ''}
      </div>
    </div>
  );
}

const SEV = {
  critical: { mark: '●', color: 'var(--color-danger)' },
  warn: { mark: '●', color: 'var(--color-warning)' },
  info: { mark: '○', color: 'var(--color-text-muted)' },
} as const;

/** ARES's watch: what the floor manager's health checks found, newest run first. */
function WatchPanel() {
  const [w, setW] = useState<SmWatch | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => smClient.watch().then((r) => { if (live) setW(r); }).catch(() => { /* old server */ });
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const now = async () => { setBusy(true); try { setW(await smClient.watchNow()); } catch { /* keep last */ } finally { setBusy(false); } };
  const items = w?.findings ?? [];
  return (
    <div className="border-2 p-6 mb-8" style={{ borderColor: items.some((f) => f.severity === 'critical') ? 'var(--color-danger)' : 'var(--color-border)', background: 'var(--color-bg-dark)' }}>
      <div className="flex items-center gap-6 mb-4">
        <span className="text-xs">ARES · office watch</span>
        <span className="flex-1 text-2xs text-text-muted">{w?.at ? `checked ${ago(w.at)}` : 'not run yet'}</span>
        <button disabled={busy} onClick={() => void now()} className="text-2xs border-2 border-border bg-transparent cursor-pointer px-4" style={{ color: 'var(--color-text)' }} title="Run ARES's checks now (safe fixes on)">{busy ? 'Checking…' : 'Check now'}</button>
      </div>
      {!items.length ? <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>✓ Everything looks healthy.</div> : items.map((f) => (
        <div key={f.id} className="text-2xs mb-4 flex gap-6">
          <span style={{ color: SEV[f.severity].color }}>{SEV[f.severity].mark}</span>
          <span className="flex-1"><span style={{ color: 'var(--color-text)' }}>{f.title}</span>
            <span className="block text-text-muted">{f.detail}</span>
            {f.fix && <span className="block" style={{ color: 'var(--color-accent-bright)' }}>→ {f.fix}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

const btn = 'text-2xs border-2 border-border bg-transparent cursor-pointer px-4';

/** TRACE's error log: new errors wait here until the owner approves; approving hands the error to ARES to fix. */
function ErrorPanel() {
  const [errs, setErrs] = useState<SmError[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => smClient.errors().then(setErrs).catch(() => { /* old server */ });
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10000); return () => clearInterval(t); }, []);
  const act = async (fn: () => Promise<unknown>) => { setMsg(null); try { await fn(); await load(); } catch (e) { setMsg((e as Error).message); } };
  const shown = errs.filter((e) => e.status !== 'dismissed').slice(0, 12);
  const open = shown.filter((e) => e.status === 'open').length;
  return (
    <div className="border-2 p-6 mb-8" style={{ borderColor: open ? 'var(--color-danger)' : 'var(--color-border)', background: 'var(--color-bg-dark)' }}>
      <div className="flex items-center gap-6 mb-4">
        <span className="text-xs">TRACE · error log</span>
        <span className="flex-1 text-2xs text-text-muted">{open ? `${open} waiting for your OK` : 'no open errors'}</span>
      </div>
      {msg && <div className="text-2xs mb-4" style={{ color: 'var(--color-danger)' }}>{msg}</div>}
      {!shown.length ? <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>✓ No errors logged.</div> : shown.map((e) => (
        <div key={e.id} className="text-2xs mb-4">
          <div className="flex gap-6 items-start">
            <span style={{ color: e.status === 'open' ? 'var(--color-danger)' : e.status === 'fixed' ? 'var(--color-status-success)' : 'var(--color-warning)' }}>●</span>
            <span className="flex-1">{e.title}
              <span className="block text-text-muted">{e.source} · {e.count}× · {ago(e.last)} · {e.status === 'approved' ? 'ARES is fixing it' : e.status === 'fixed' ? 'fixed' : 'ARES knows — waiting for you'}</span>
            </span>
            {e.status === 'open' && <>
              <button className={btn} style={{ color: 'var(--color-status-success)' }} onClick={() => void act(() => smClient.approveError(e.id))} title="Let ARES start the fix">Approve fix</button>
              <button className={btn} style={{ color: 'var(--color-text-muted)' }} onClick={() => void act(() => smClient.dismissError(e.id))}>Dismiss</button>
            </>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The learning box: lessons every teammate reads before each job. */
function LearningPanel() {
  const [ls, setLs] = useState<SmLesson[]>([]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => smClient.learnings().then(setLs).catch(() => { /* old server */ });
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, []);
  const add = async () => { if (!text.trim()) return; setMsg(null); try { await smClient.addLearning(text); setText(''); await load(); } catch (e) { setMsg((e as Error).message); } };
  const del = async (id: string) => { try { await smClient.removeLearning(id); await load(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="border-2 border-border p-6 mb-8" style={{ background: 'var(--color-bg-dark)' }}>
      <div className="flex items-center gap-6 mb-4">
        <span className="text-xs">LEARNING · what the office remembers</span>
        <span className="flex-1 text-2xs text-text-muted">{ls.length} lesson{ls.length === 1 ? '' : 's'}</span>
      </div>
      <div className="flex gap-6 mb-4">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} maxLength={500} placeholder="Teach the office something to use next time…" className="flex-1 text-2xs bg-transparent border-2 border-border px-4 py-2" style={{ color: 'var(--color-text)' }} />
        <button className={btn} style={{ color: 'var(--color-text)' }} onClick={() => void add()}>Teach</button>
      </div>
      {msg && <div className="text-2xs mb-4" style={{ color: 'var(--color-danger)' }}>{msg}</div>}
      {!ls.length ? <div className="text-2xs text-text-muted">Nothing yet. Lessons from errors and from your notes land here.</div> : ls.slice(0, 15).map((l) => (
        <div key={l.id} className="text-2xs mb-2 flex gap-6">
          <span className="text-text-muted">[{l.kind}]</span>
          <span className="flex-1">{l.text}</span>
          <button className={btn} style={{ color: 'var(--color-text-muted)' }} onClick={() => void del(l.id)} title="Forget this lesson">✕</button>
        </div>
      ))}
    </div>
  );
}

export function SmHealthBoard({ onPick }: { onPick: (name: string) => void }) {
  const [rows, setRows] = useState<SmHealth[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => smClient.health().then((r) => { if (live) { setRows(r); setErr(null); } }).catch((e: Error) => { if (live) setErr(e.message); });
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <WatchPanel />
      <ErrorPanel />
      <LearningPanel />
      {err && <div className="text-2xs mb-6" style={{ color: 'var(--color-danger)' }}>{err}</div>}
      {!rows ? <div className="text-2xs text-text-muted">Loading…</div> : rows.length === 0 ? <div className="text-2xs text-text-muted">No projects yet.</div> : rows.map((h) => <HealthCard key={h.name} h={h} onPick={onPick} />)}
    </div>
  );
}

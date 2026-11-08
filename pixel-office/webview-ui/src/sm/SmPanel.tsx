/**
 * Success Manager dock — collapsible right panel in Pixel Agents' own visual language.
 * Tabs: TASKS (what needs you first, explained like you're 5) and TERMINAL (live crew log).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { CREW, CREW_BY_ID, crewForLogTag } from './crew.js';
import { SmAgents } from './SmAgents.js';
import { SmAgentStrip } from './SmAgentStrip.js';
import { smClient, type SmLog, type SmTask } from './smClient.js';
import { SmHealthBoard } from './SmHealth.js';
import { MissionCard, MissionComposer, MissionQueue, QuestionCard } from './SmMissions.js';
import { SmSecretaryDesk } from './SmSecretary.js';
import type { SuccessManager } from './useSuccessManager.js';

const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: 'var(--color-status-active)',
  AWAITING_HUMAN_INPUT: 'var(--color-status-permission)',
  PRODUCTION_READY: 'var(--color-status-success)',
};
const LEVEL_COLOR: Record<SmLog['level'], string> = {
  INFO: 'var(--color-text-muted)',
  WARN: 'var(--color-warning)',
  ERROR: 'var(--color-danger)',
};
const COLLAPSE_KEY = 'sm.panelOpen';

const hhmmss = (ts: string | null) => {
  const d = ts ? new Date(ts) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 19) : '--:--:--';
};
const sourceOf = (t: SmTask) => t.labels.find((l) => l.startsWith('src:'))?.slice(4) ?? 'manual';
const reviewerOf = (t: SmTask) => {
  const s = sourceOf(t);
  return s.startsWith('audit-') ? CREW_BY_ID.get(s.slice(6) as never) : undefined;
};

function useClock(running: string | null) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  if (!running || now === null) return '--:--:--';
  const s = Math.max(0, Math.floor((now - new Date(running).getTime()) / 1000));
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':');
}

function Section({ title, color, count, children, defaultOpen = true }: { title: string; color: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-10">
      <button className="w-full flex items-center gap-6 py-4 bg-transparent border-0 cursor-pointer text-left" onClick={() => setOpen((o) => !o)}>
        <span className="text-xs" style={{ color }}>{open ? '▾' : '▸'} {title}</span>
        <span className="ml-auto text-2xs text-text-muted">{count}</span>
      </button>
      {open && (count ? <div className="flex flex-col gap-6">{children}</div> : <div className="text-2xs text-text-muted border-2 border-dashed border-border p-8 text-center">All clear</div>)}
    </section>
  );
}

/** Fix button for a task a reviewer filed (never human tasks, never closed ones). */
function FixButton({ t, project, fixingId, busyElsewhere, onDone }: { t: SmTask; project: string; fixingId: string | null; busyElsewhere: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const running = fixingId === t.id || t.status === 'in_progress';
  const go = async () => {
    setBusy(true); setMsg(null);
    try { await smClient.fix(project, t.id); onDone(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-6 flex items-center gap-6">
      <Button size="sm" variant={running ? 'active' : 'accent'} disabled={busy || running || busyElsewhere} onClick={go}
        title="Send a worker to fix just this task">
        {running ? 'Fixing…' : busy ? 'Starting…' : 'Fix'}
      </Button>
      {msg && <span className="text-2xs" style={{ color: 'var(--color-danger)' }}>{msg}</span>}
    </div>
  );
}

function TaskCard({ t, accent, extra }: { t: SmTask; accent: string; extra?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const rv = reviewerOf(t);
  return (
    <div className="bg-bg-dark border-2 border-border" style={{ borderLeftColor: accent }}>
      <button className="w-full flex items-start gap-8 p-8 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <span className="text-2xs px-4 border-2 shrink-0" style={{ borderColor: accent, color: accent }}>P{t.priority}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-2xs leading-tight">{t.title}</span>
          <span className="block text-2xs text-text-muted mt-2">
            {t.id}{rv ? ` · by ${rv.name}` : ` · from ${sourceOf(t)}`}{t.status === 'in_progress' ? ' · working…' : ''}
          </span>
        </span>
      </button>
      {open && (
        <div className="px-8 pb-8 border-t-2 border-border">
          {t.description && <pre className="whitespace-pre-wrap text-2xs text-text-muted mt-6 max-h-[220px] overflow-auto font-pixel">{t.description}</pre>}
          {t.reason && <div className="text-2xs mt-6" style={{ color: 'var(--color-status-success)' }}>Done: {t.reason}</div>}
          {extra}
        </div>
      )}
    </div>
  );
}

/** A human task, explained like you're 5. */
export function NeedsYouCard({ t, project, onDone, defaultOpen = false }: { t: SmTask; project: string; onDone: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ask = t.ask;
  const send = async (mode: 'note' | 'resolve' | 'handBack') => {
    if (!text.trim()) { setMsg('Type your answer first.'); return; }
    setBusy(true); setMsg(null);
    try {
      await smClient.human(project, t.id, text.trim(), mode);
      setText('');
      setMsg(mode === 'handBack' ? 'Sent! The builder picks it up next run.' : mode === 'resolve' ? 'Marked done.' : 'Note saved.');
      onDone();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="bg-bg-dark border-2" style={{ borderColor: 'var(--color-status-permission)' }}>
      <button className="w-full p-8 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <span className="block text-2xs" style={{ color: 'var(--color-status-permission)' }}>
          {open ? '▾' : '▸'} P{t.priority} · {t.id}
        </span>
        <span className="block text-xs leading-tight mt-2">{ask?.what ?? t.title}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 flex flex-col gap-6 border-t-2 border-border pt-6">
          {!ask && <div className="text-2xs text-text-muted">No plain-language explanation yet — ask Claude to add one with `sm ask`. Original task: {t.title}</div>}
          {ask?.why && (<div><div className="text-2xs text-text-muted">Why only you?</div><div className="text-2xs">{ask.why}</div></div>)}
          {!!ask?.steps?.length && (
            <div>
              <div className="text-2xs text-text-muted">Do this:</div>
              <ol className="m-0 pl-24 text-2xs leading-snug list-decimal">
                {ask.steps.map((s, i) => <li key={i} className="mb-2">{s}</li>)}
              </ol>
            </div>
          )}
          {ask?.doneWhen && (<div><div className="text-2xs text-text-muted">You're done when:</div><div className="text-2xs">{ask.doneWhen}</div></div>)}
          {ask?.reply && (<div><div className="text-2xs text-text-muted">Then tell me:</div><div className="text-2xs">{ask.reply}</div></div>)}
          <textarea
            className="w-full min-h-[70px] bg-bg border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent"
            placeholder="Your answer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="text-2xs text-text-muted">Never paste passwords or API keys here — say where you put them instead.</div>
          <div className="flex flex-wrap gap-6">
            <Button size="sm" variant="accent" disabled={busy} onClick={() => send('handBack')} title="Your answer goes to the builder and it continues the work">Send to builder</Button>
            <Button size="sm" disabled={busy} onClick={() => send('resolve')} title="You did it yourself — close the task">I did it</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => send('note')}>Just a note</Button>
          </div>
          {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}

function Terminal({ logs }: { logs: SmLog[] }) {
  const [levels, setLevels] = useState<Set<SmLog['level']>>(new Set(['INFO', 'WARN', 'ERROR']));
  const [who, setWho] = useState('ALL');
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const tags = useMemo(() => ['ALL', ...new Set(logs.map((l) => l.agent))], [logs]);
  const rows = logs.filter((l) => levels.has(l.level) && (who === 'ALL' || l.agent === who));
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [rows.length, follow]);
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex flex-wrap items-center gap-4 p-6 border-b-2 border-border">
        {(['INFO', 'WARN', 'ERROR'] as const).map((lv) => (
          <Button key={lv} size="sm" variant={levels.has(lv) ? 'active' : 'default'} onClick={() => setLevels((s) => { const n = new Set(s); if (n.has(lv)) n.delete(lv); else n.add(lv); return n; })}>
            <span style={{ color: LEVEL_COLOR[lv] }}>{lv}</span>
          </Button>
        ))}
        <select className="ml-auto bg-btn-bg text-text border-2 border-border text-2xs p-2 font-pixel" value={who} onChange={(e) => setWho(e.target.value)}>
          {tags.map((t) => <option key={t} value={t}>{t === 'ALL' ? 'everyone' : (crewForLogTag(t)?.name ?? t)}</option>)}
        </select>
        <Button size="sm" variant={follow ? 'active' : 'default'} onClick={() => setFollow((f) => !f)} title="Auto-scroll">↓</Button>
      </div>
      <div ref={ref} className="flex-1 min-h-0 overflow-y-auto p-8 bg-bg-dark">
        {rows.map((l, i) => {
          const c = crewForLogTag(l.agent);
          return (
            <div key={i} className="text-2xs leading-snug mb-2 break-words">
              <span className="text-text-muted">[{hhmmss(l.ts)}] </span>
              <span style={{ color: 'var(--color-accent-bright)' }}>{c?.name ?? l.agent}</span>
              <span style={{ color: LEVEL_COLOR[l.level] }}>{l.level === 'INFO' ? '' : ` ${l.level}`}</span>
              <span className="text-text">: {l.msg}</span>
            </div>
          );
        })}
        {!rows.length && <div className="text-2xs text-text-muted">Nothing yet.</div>}
      </div>
    </div>
  );
}

export function SmPanel({ sm, onOpenReport, onWatch }: { sm: SuccessManager; onOpenReport: (id: string | 'list') => void; onWatch?: (crewId: string) => void }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) !== '0'; } catch { return true; } });
  const [tab, setTab] = useState<'missions' | 'agents' | 'tasks' | 'health' | 'desk' | 'term'>('missions');
  const [armed, setArmed] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const s = sm.state;
  const timer = useClock(s?.runStartedAt ?? s?.auditing?.startedAt ?? null);
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, open ? '1' : '0'); } catch { /* ignore */ } }, [open]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  if (!sm.enabled) return null;
  const strip = <SmAgentStrip s={s ?? null} onSelect={(id) => onWatch?.(id)} />;
  const humanCount = (s?.tasks.human.length ?? 0) + (s?.questions.length ?? 0);

  if (!open) {
    return (
      <>
      <div className="h-full shrink-0 flex flex-col items-center gap-8 pt-12 bg-bg border-l-2 border-border" style={{ width: 44 }}>
        <Button size="icon" onClick={() => setOpen(true)} title="Open Throngs">{'<'}</Button>
        <div className="text-2xs text-text-muted" style={{ writingMode: 'vertical-rl' }}>THRONGS</div>
        {humanCount > 0 && (
          <button onClick={() => { setOpen(true); setTab('tasks'); }} className="border-2 cursor-pointer text-2xs px-2 bg-transparent" style={{ borderColor: 'var(--color-status-permission)', color: 'var(--color-status-permission)' }} title={`${humanCount} thing(s) need you`}>
            {humanCount}!
          </button>
        )}
      </div>
      {strip}
      </>
    );
  }

  const trigger = async () => {
    if (!s) return;
    if (Date.now() - armed > 4000) { setArmed(Date.now()); return; }
    setArmed(0);
    try { const r = await smClient.audit(s.project); setToast(`Sent ${r.agents.length} reviewers to work`); void sm.refresh(); }
    catch (e) { setToast((e as Error).message); }
  };
  const qaOk = s?.qa.every((q) => q.ok);
  const critical = s ? [...s.tasks.critical, ...s.tasks.required.filter((t) => t.priority <= 1)] : [];
  const queue = s ? s.tasks.required.filter((t) => t.priority > 1) : [];
  const fixBtn = (t: SmTask) => s && sourceOf(t).startsWith('audit-') && t.status !== 'closed'
    ? <FixButton t={t} project={s.project} fixingId={s.fixing?.id ?? null} busyElsewhere={s.running} onDone={() => void sm.refresh()} />
    : undefined;

  return (
    <>
    <div className="h-full shrink-0 flex flex-col bg-bg border-l-2 border-border text-text" style={{ width: 'min(420px, calc(100vw - 44px))' }}>
      {/* Header */}
      <div className="p-8 border-b-2 border-border flex flex-col gap-6">
        <div className="flex items-center gap-6">
          <span className="text-sm" style={{ color: 'var(--color-accent-bright)' }}>THRONGS</span>
          {s && (
            <Button className="ml-auto" size="sm" variant={s.fullAccess ? 'active' : 'default'}
              title={s.fullAccess ? 'Team has FULL access: any command, no permission prompts. Click to switch to safe commands only.' : 'Team uses a safe command list. Click to give FULL access (any command, no prompts).'}
              onClick={async () => {
                const grant = !s.fullAccess;
                if (grant && !window.confirm(`Give the team full access in "${s.project}"?\n\nThey can run any command, install packages and change files without asking. The guard still protects your uncommitted work, the QA rules and git push.`)) return;
                await smClient.setAccess(s.project, grant); void sm.refresh();
              }}>
              {s.fullAccess ? '🔓 Full access' : s.fullAccess === false ? '🔒 Safe' : '🔒 Ask'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenReport('list')} title="Reports on your desk">📋{s?.reports.length ? ` ${s.reports.length}` : ''}</Button>
          <Button size="icon" variant="ghost" onClick={() => setOpen(false)} title="Collapse">{'>'}</Button>
        </div>
        <div className="flex items-center gap-6">
          <select className="flex-1 min-w-0 bg-btn-bg text-text border-2 border-border text-2xs p-4 font-pixel" value={sm.project ?? ''} onChange={(e) => sm.setProject(e.target.value)}>
            {sm.projects.map((p) => <option key={p.name} value={p.name}>{p.name}{p.running ? ' ▶' : ''}</option>)}
          </select>
          {s && <span className="text-2xs px-4 border-2 whitespace-nowrap" style={{ borderColor: STATUS_COLOR[s.status], color: STATUS_COLOR[s.status] }}>{s.status.replace(/_/g, ' ')}</span>}
        </div>
        {s && (
          <div className="grid grid-cols-4 gap-4 text-2xs">
            <div className="bg-bg-dark border-2 border-border p-4"><div className="text-text-muted">QA</div><div style={{ color: qaOk ? 'var(--color-status-success)' : 'var(--color-danger)' }}>{qaOk ? 'green' : 'red'}</div></div>
            <div className="bg-bg-dark border-2 border-border p-4"><div className="text-text-muted">COST</div><div>${s.cost.total.toFixed(2)}</div></div>
            <div className="bg-bg-dark border-2 border-border p-4" title="Spent by missions started today"><div className="text-text-muted">TODAY</div><div>${s.cost.today.toFixed(2)}</div></div>
            <div className="bg-bg-dark border-2 border-border p-4"><div className="text-text-muted">TIMER</div><div>{timer}</div></div>
          </div>
        )}
        <Button size="sm" variant={armed ? 'accent' : 'default'} disabled={!s || Boolean(s?.auditing)} onClick={trigger}>
          {s?.auditing ? 'Reviewers are working…' : armed ? `Click again to start (~$${(s?.cost.last ?? 1).toFixed(2)})` : 'Send reviewers'}
        </Button>
        {toast && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{toast}</div>}
        {sm.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{sm.error}</div>}
      </div>

      {/* Tabs */}
      <div className="flex border-b-2 border-border">
        {(['missions', 'agents', 'tasks', 'health', 'desk', 'term'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className="flex-1 py-6 border-0 cursor-pointer text-2xs"
            style={{ background: tab === k ? 'var(--color-active-bg)' : 'transparent', color: tab === k ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
            {k === 'missions' ? `MISSIONS${s?.questions.length ? ` · ${s.questions.length}!` : ''}` : k === 'agents' ? `AGENTS · ${CREW.length}` : k === 'tasks' ? `TASKS${humanCount ? ` · ${humanCount}!` : ''}` : k === 'health' ? 'HEALTH' : k === 'desk' ? 'IVY' : `LOG · ${s?.logs.length ?? 0}`}
          </button>
        ))}
      </div>

      {tab === 'health' ? (
        <SmHealthBoard onPick={(n) => { sm.setProject(n); setTab('tasks'); }} />
      ) : tab === 'desk' ? (
        <SmSecretaryDesk project={sm.project} />
      ) : !s ? (
        <div className="p-12 text-2xs text-text-muted">{sm.project ? 'Loading…' : 'No projects yet — run `sm add <path> --beads`.'}</div>
      ) : tab === 'missions' ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-8">
          <div className="mb-10">
            <div className="text-xs mb-4" style={{ color: 'var(--color-accent-bright)' }}>TALK TO THE FLOOR MANAGER</div>
            <MissionComposer sm={sm} />
          </div>
          {s.questions.length > 0 && (
            <Section title="THE TEAM NEEDS YOU" color="var(--color-sm-help)" count={s.questions.length}>
              {s.questions.map((q) => <QuestionCard key={`${q.missionId}-${q.subtaskId}`} sm={sm} q={q} />)}
            </Section>
          )}
          {s.missions.some((m) => m.queuePos) && (
            <Section title="UP NEXT" color="var(--color-text-muted)" count={s.missions.filter((m) => m.queuePos).length}>
              <MissionQueue sm={sm} missions={s.missions} onOpenReport={onOpenReport} onWatch={onWatch} />
            </Section>
          )}
          <Section title="MISSIONS" color="var(--color-status-active)" count={s.missions.filter((m) => !m.queuePos).length}>
            {s.missions.filter((m) => !m.queuePos).map((m) => <MissionCard key={m.id} sm={sm} m={m} onOpenReport={onOpenReport} onWatch={onWatch} />)}
          </Section>
          {s.reports.length > 0 && <Button size="sm" onClick={() => onOpenReport('list')}>📋 All reports on your desk ({s.reports.length})</Button>}
        </div>
      ) : tab === 'agents' ? (
        <SmAgents sm={sm} s={s} onWatch={onWatch} />
      ) : tab === 'tasks' ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-8">
          <Section title="NEEDS YOU" color="var(--color-status-permission)" count={s.tasks.human.length + s.questions.length}>
            {s.questions.map((q) => <QuestionCard key={`${q.missionId}-${q.subtaskId}`} sm={sm} q={q} />)}
            {s.tasks.human.map((t) => <NeedsYouCard key={t.id} t={t} project={s.project} onDone={() => void sm.refresh()} />)}
          </Section>
          <Section title="FIX FIRST" color="var(--color-danger)" count={critical.length}>
            {critical.map((t) => <TaskCard key={t.id} t={t} accent="var(--color-danger)" extra={fixBtn(t)} />)}
          </Section>
          <Section title="BUILDER QUEUE" color="var(--color-status-active)" count={queue.length}>
            {queue.map((t) => <TaskCard key={t.id} t={t} accent="var(--color-status-active)" extra={fixBtn(t)} />)}
          </Section>
          <Section title="OPTIONAL" color="var(--color-text-muted)" count={s.tasks.suggestions.length} defaultOpen={false}>
            {s.tasks.suggestions.map((t) => <TaskCard key={t.id} t={t} accent="var(--color-border)" extra={fixBtn(t)} />)}
          </Section>
          <Section title="DONE" color="var(--color-status-success)" count={s.tasks.done.length} defaultOpen={false}>
            {s.tasks.done.map((t) => <TaskCard key={t.id} t={t} accent="var(--color-status-success)" />)}
          </Section>
        </div>
      ) : (
        <Terminal logs={s.logs} />
      )}
    </div>
    {strip}
    </>
  );
}

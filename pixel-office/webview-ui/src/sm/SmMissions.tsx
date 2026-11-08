/** Floor Manager UI pieces: talk to the manager, follow missions, answer the crew, read reports. */
import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { SM_REPLY_MAX_CHARS } from '../constants.js';
import { CREW_BY_ID, type CrewId } from './crew.js';
import { withImages } from './imageAttach.js';
import { ImageStrip } from './ImageStrip.js';
import { markReportRead, readReports } from './reportsStore.js';
import { type SmAsk, smClient, type SmMission, type SmQuestion, type SmReply, type SmReport, type SmSubtask } from './smClient.js';
import { useImageAttach } from './useImageAttach.js';
import type { SuccessManager } from './useSuccessManager.js';

const nameOf = (id: string) => CREW_BY_ID.get(id as CrewId)?.name ?? id;
const MISSION_STATUS: Record<SmMission['status'], { label: string; color: string }> = {
  queued: { label: 'starting', color: 'var(--color-text-muted)' },
  planning: { label: 'planning', color: 'var(--color-status-active)' },
  working: { label: 'working', color: 'var(--color-status-active)' },
  checking: { label: 'QA & security', color: 'var(--color-status-permission)' },
  paused: { label: 'paused · usage limit', color: 'var(--color-warning)' },
  waiting_human: { label: 'needs you', color: 'var(--color-sm-help)' },
  reviewing: { label: 'reviewing', color: 'var(--color-status-permission)' },
  done: { label: 'done', color: 'var(--color-status-success)' },
  failed: { label: 'failed', color: 'var(--color-danger)' },
  cancelled: { label: 'cancelled', color: 'var(--color-text-muted)' },
  stalled: { label: 'stalled', color: 'var(--color-warning)' },
};
const SUB_ICON: Record<string, string> = { queued: '·', working: '▶', waiting_human: '!', answered: '▶', triaging: '?', done: '✓', failed: '✗', skipped: '–', cancelled: '–' };
/** A finished hand-off check that rejected the work shows as "sent back", not as a green tick. */
const subIcon = (s: SmSubtask) => (s.kind === 'gate' && s.status === 'done' && s.gate && !s.gate.pass ? '↺' : SUB_ICON[s.status]);
const subColor = (s: SmSubtask) => (s.kind === 'gate' && s.status === 'done' && s.gate && !s.gate.pass ? 'var(--color-warning)'
  : s.status === 'done' ? 'var(--color-status-success)' : s.status === 'waiting_human' ? 'var(--color-sm-help)' : s.status === 'failed' ? 'var(--color-danger)' : 'var(--color-text-muted)');

/** "Tell the floor manager…" */
export function MissionComposer({ sm, compact = false, onSent }: { sm: SuccessManager; compact?: boolean; onSent?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const att = useImageAttach();
  const send = async () => {
    if (!sm.project || !text.trim() || att.uploading > 0) return;
    setBusy(true); setMsg(null);
    try {
      await smClient.mission.create(sm.project, withImages(text, att.paths));
      sm.say('orchestrator', 'Got it! Let me break this down…');
      setText(''); att.clear();
      setMsg('ARES is on it. Watch the office!');
      void sm.refresh();
      onSent?.();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <textarea
        className={`w-full ${compact ? 'min-h-[60px]' : 'min-h-[90px]'} bg-bg-dark border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent`}
        placeholder='Tell the floor manager what you need, e.g. "Add a dark mode toggle to settings". Start with "quick:" for tiny changes, "question:" to just ask, "team:" for big jobs; add "use opus" or "use haiku" to pick the model.'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={att.onPaste} onDrop={att.onDrop} onDragOver={att.onDragOver}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
      />
      <ImageStrip images={att.images} onRemove={att.remove} />
      {att.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{att.error}</div>}
      <div className="flex items-center gap-6">
        <Button size="sm" variant="accent" disabled={busy || att.uploading > 0 || !text.trim()} onClick={send}>Give to ARES</Button>
        <span className="text-2xs text-text-muted">⌘↵ to send</span>
      </div>
      {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
    </div>
  );
}

/** ELI5 ask + answer box, shared by mission questions and the crew inspector. */
export function AskView({ ask, fallback }: { ask?: SmAsk | null; fallback: string }) {
  if (!ask?.what) return <div className="text-2xs">{fallback}</div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs leading-tight">{ask.what}</div>
      {ask.why && <div><div className="text-2xs text-text-muted">Why only you?</div><div className="text-2xs">{ask.why}</div></div>}
      {!!ask.steps?.length && (
        <div><div className="text-2xs text-text-muted">Do this:</div>
          <ol className="m-0 pl-24 text-2xs leading-snug list-decimal">{ask.steps.map((s, i) => <li key={i} className="mb-2">{s}</li>)}</ol>
        </div>
      )}
      {ask.doneWhen && <div><div className="text-2xs text-text-muted">You're done when:</div><div className="text-2xs">{ask.doneWhen}</div></div>}
      {ask.reply && <div><div className="text-2xs text-text-muted">Then tell me:</div><div className="text-2xs">{ask.reply}</div></div>}
    </div>
  );
}

export function AnswerBox({ sm, missionId, subtaskId, onDone }: { sm: SuccessManager; missionId: string; subtaskId: string; onDone?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const att = useImageAttach();
  if (subtaskId === '__access') {
    const answer = async (yes: boolean) => {
      if (!sm.project) return;
      setBusy(true);
      try {
        await smClient.mission.answer(sm.project, missionId, '__access', yes ? 'yes' : 'no');
        setMsg(yes ? 'Full access granted — the team is starting.' : 'OK — the team will stick to safe commands.');
        void sm.refresh(); onDone?.();
      } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
    };
    return (
      <div className="flex flex-col gap-4">
        <div className="flex gap-6">
          <Button size="sm" variant="accent" disabled={busy} onClick={() => answer(true)}>Yes — full access</Button>
          <Button size="sm" disabled={busy} onClick={() => answer(false)}>No — safe commands only</Button>
        </div>
        {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      </div>
    );
  }
  const send = async () => {
    if (!sm.project || !text.trim()) { setMsg('Type your answer first.'); return; }
    if (att.uploading > 0) return;
    setBusy(true);
    try {
      await smClient.mission.answer(sm.project, missionId, subtaskId, withImages(text, att.paths));
      setText(''); att.clear(); setMsg('Thanks! They\'re back to work.');
      void sm.refresh(); onDone?.();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-4">
      <textarea className="w-full min-h-[60px] bg-bg border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent"
        placeholder="Your answer…" value={text} onChange={(e) => setText(e.target.value)}
        onPaste={att.onPaste} onDrop={att.onDrop} onDragOver={att.onDragOver} />
      <ImageStrip images={att.images} onRemove={att.remove} />
      {att.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{att.error}</div>}
      <div className="text-2xs text-text-muted">Never paste passwords or API keys — say where you put them instead.</div>
      <Button size="sm" variant="accent" disabled={busy} onClick={send}>Send answer</Button>
      {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
    </div>
  );
}

export function QuestionCard({ sm, q }: { sm: SuccessManager; q: SmQuestion }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-bg-dark border-2" style={{ borderColor: 'var(--color-sm-help)' }}>
      <button className="w-full p-8 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <span className="block text-2xs" style={{ color: 'var(--color-sm-help)' }}>{open ? '▾' : '▸'} {nameOf(q.who)} is asking · mission job</span>
        <span className="block text-xs leading-tight mt-2">{q.ask?.what ?? q.title}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 flex flex-col gap-6 border-t-2 border-border pt-6">
          <div className="text-2xs text-text-muted">For: “{q.prompt.slice(0, 120)}” → {q.title}</div>
          <AskView ask={q.ask} fallback={q.title} />
          <AnswerBox sm={sm} missionId={q.missionId} subtaskId={q.subtaskId} />
        </div>
      )}
    </div>
  );
}

export function MissionCard({ sm, m, onOpenReport, onWatch }: { sm: SuccessManager; m: SmMission; onOpenReport: (id: string) => void; onWatch?: (crewId: string) => void }) {
  const [open, setOpen] = useState(['planning', 'working', 'checking', 'paused', 'waiting_human', 'reviewing', 'queued', 'stalled'].includes(m.status));
  const st = m.preempting ? { label: 'paused · other one first', color: 'var(--color-warning)' }
    : m.queuePos ? { label: `queued · #${m.queuePos}`, color: 'var(--color-text-muted)' } : MISSION_STATUS[m.status];
  const done = m.subtasks.filter((s) => s.status === 'done').length;
  return (
    <div className="bg-bg-dark border-2 border-border" style={{ borderLeftColor: st.color }}>
      <button className="w-full p-8 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <span className="flex items-center gap-6 text-2xs">
          <span className="border-2 px-4" style={{ borderColor: st.color, color: st.color }}>{st.label}</span>
          <span className="text-text-muted">{m.subtasks.length ? `${done}/${m.subtasks.length} jobs` : ''} · ${(m.cost || 0).toFixed(2)}</span>
          {m.route && <span className="text-text-muted" title={m.route.reason}>· {m.route.funnel} · {m.route.model}</span>}
        </span>
        <span className="block text-2xs leading-tight mt-4">{m.prompt}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 border-t-2 border-border pt-6 flex flex-col gap-6">
          {m.planner && (
            <div className="text-2xs bg-bg-dark border-2 border-border p-6 flex flex-col gap-2">
              <div style={{ color: 'var(--color-accent-bright)' }}>{m.planner.name}'s plan</div>
              <div className="text-text-muted">{m.planner.rewrittenPrompt}</div>
              <ol className="m-0 pl-12">{m.planner.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              {m.planner.risks && <div className="text-text-muted">Risks: {m.planner.risks}</div>}
              <div style={{ color: m.approval ? 'var(--color-status-success)' : 'var(--color-status-active)' }}>
                {m.approval ? `✓ ARES ${m.approval.status}${m.approval.note ? ` — ${m.approval.note}` : ''}` : 'Waiting for ARES to approve…'}
              </div>
            </div>
          )}
          {m.plan?.summary && <div className="text-2xs text-text-muted">Plan: {m.plan.summary}</div>}
          {m.subtasks.map((s) => (
            <div key={s.id} className="text-2xs flex gap-6">
              <span className="w-[18px] shrink-0" style={{ color: subColor(s) }}>{subIcon(s)}</span>
              <span className="flex-1"><span style={{ color: 'var(--color-accent-bright)' }}>{nameOf(s.assignee)}</span> {s.title}
                {(s as { lastAction?: string }).lastAction && ['working', 'answered'].includes(s.status) && <span className="block" style={{ color: 'var(--color-status-active)' }}>⏺ {(s as { lastAction?: string }).lastAction}</span>}
                {onWatch && s.status !== 'queued' && <button className="ml-6 bg-transparent border-0 cursor-pointer text-2xs" style={{ color: 'var(--color-status-active)' }} onClick={() => onWatch(s.assignee)}>watch ›</button>}
                {s.result?.summary && <span className="block text-text-muted">{s.result.summary}</span>}
                {s.status === 'triaging' && <span className="block" style={{ color: 'var(--color-status-active)' }}>Asked a question — ARES is answering it</span>}
                {s.answers?.some((a) => a.by) && <span className="block text-text-muted">ARES answered: {s.answers.filter((a) => a.by).slice(-1)[0].text.slice(0, 160)}</span>}
                {s.kind === 'gate' && s.gate && !s.gate.pass && <span className="block" style={{ color: 'var(--color-warning)' }}>Sent back: {s.gate.issues.map((i) => i.title).join(' · ')}</span>}
                {!!s.retries && s.status !== 'failed' && <span className="block text-text-muted">retry {s.retries}</span>}
                {s.error && <span className="block" style={{ color: 'var(--color-danger)' }}>{s.error}</span>}
              </span>
            </div>
          ))}
          {m.loop && m.loop.stage !== 'build' && m.subtasks.some((s) => s.kind === 'gate') && (
            <div className="text-2xs text-text-muted">
              Hand-offs: build → QA → security{m.loop.round ? ` · ${m.loop.round} fix round${m.loop.round > 1 ? 's' : ''}` : ''}
              {m.loop.stage === 'passed' && <span style={{ color: 'var(--color-status-success)' }}> · all passed</span>}
            </div>
          )}
          {m.preempting && <div className="text-2xs" style={{ color: 'var(--color-warning)' }}>Paused so “{m.preempting.prompt.slice(0, 60)}” could go first — it carries on by itself after that one.</div>}
          {m.status === 'paused' && m.limitUntil && <div className="text-2xs" style={{ color: 'var(--color-warning)' }}>Your usage limit was reached — the team carries on by itself at {new Date(m.limitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>}
          {m.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{m.error}</div>}
          <div className="flex flex-wrap gap-6">
            {m.report && <Button size="sm" variant="accent" onClick={() => onOpenReport(m.id)}>Open report</Button>}
            {['planning', 'working', 'checking', 'paused', 'waiting_human', 'queued'].includes(m.status) && (
              <Button size="sm" variant="ghost" onClick={() => sm.project && smClient.mission.cancel(sm.project, m.id).then(() => sm.refresh())}>Cancel</Button>
            )}
            {m.status === 'stalled' && <Button size="sm" onClick={() => sm.project && smClient.mission.resume(sm.project, m.id).then(() => sm.refresh())}>Resume</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

function Sec({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div><div className="text-2xs text-text-muted mb-2">{t}</div>{children}</div>
  );
}

const STATUS_WORD: Record<string, string> = { A: 'added', M: 'changed', D: 'deleted', R: 'renamed' };

/** Exactly what the mission changed (before/after snapshot), with the full diff on demand. */
function ChangesView({ sm, missionId, r }: { sm: SuccessManager; missionId: string; r: SmReport }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const files = r.changedFiles ?? [];
  const load = async () => {
    if (!sm.project) return;
    if (diff !== null) { setDiff(null); return; }
    setBusy(true);
    try { setDiff((await smClient.mission.diff(sm.project, missionId)).diff || '(no changes recorded)'); }
    catch (e) { setDiff(`Could not load the diff: ${(e as Error).message}`); } finally { setBusy(false); }
  };
  return (
    <div className="border-2 border-border p-6 flex flex-col gap-4">
      <div className="text-2xs" style={{ color: 'var(--color-accent-bright)' }}>
        WHAT ACTUALLY CHANGED{r.office ? ' (in the office itself)' : ''} {r.diffStat ? `· ${r.diffStat}` : ''}
      </div>
      {files.length ? files.map((l) => {
        const [st, ...rest] = l.split('\t');
        return <div key={l} className="text-2xs"><span className="text-text-muted">{STATUS_WORD[st[0]] ?? st}</span> {rest.join(' → ')}</div>;
      }) : <div className="text-2xs text-text-muted">{r.hasDiff ? 'See the diff below.' : 'No file changes were recorded.'}</div>}
      {(r.hasDiff || files.length > 0) && (
        <Button size="sm" disabled={busy} onClick={load}>{diff !== null ? 'Hide the code changes' : busy ? 'Loading…' : 'See the code changes'}</Button>
      )}
      {diff !== null && (
        <pre className="max-h-[360px] overflow-auto bg-bg-dark border-2 border-border p-6 text-2xs font-pixel whitespace-pre">
          {diff.split('\n').map((l, i) => (
            <div key={i} style={{ color: l.startsWith('+') && !l.startsWith('+++') ? 'var(--color-status-success)' : l.startsWith('-') && !l.startsWith('---') ? 'var(--color-danger)' : l.startsWith('@@') ? 'var(--color-status-active)' : l.startsWith('diff ') ? 'var(--color-accent-bright)' : 'var(--color-text-muted)' }}>{l || ' '}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

function ReportView({ r }: { r: SmReport }) {
  const verdictColor = r.verdict === 'success' ? 'var(--color-status-success)' : r.verdict === 'partial' ? 'var(--color-status-permission)' : 'var(--color-danger)';
  return (
    <div className="flex flex-col gap-8 text-text">
      <div className="flex items-center gap-6">
        <span className="border-2 px-4 text-2xs" style={{ borderColor: verdictColor, color: verdictColor }}>{r.verdict.toUpperCase()}</span>
        <span className="text-sm">{r.headline}</span>
      </div>
      <div className="text-2xs">{r.summary}</div>
      <div className="border-2 p-6" style={{ borderColor: 'var(--color-sm-gold)' }}>
        <div className="text-2xs" style={{ color: 'var(--color-sm-gold)' }}>What you need to do</div>
        <div className="text-2xs">{r.for_you}</div>
      </div>
      <Sec t="Who did what">{r.completed.map((c, i) => <div key={i} className="text-2xs mb-2"><span style={{ color: 'var(--color-accent-bright)' }}>{c.by}</span> — {c.job}: <span className="text-text-muted">{c.result}</span></div>)}</Sec>
      {!!r.changes.length && <Sec t="Changes">{r.changes.map((c, i) => <div key={i} className="text-2xs mb-2"><span className="text-text-muted">{c.file}</span> — {c.what}</div>)}</Sec>}
      <Sec t="Checks">
        <div className="text-2xs" style={{ color: r.checks.qa_passed ? 'var(--color-status-success)' : 'var(--color-danger)' }}>
          QA {r.checks.qa_passed ? 'passed' : 'FAILED'}{r.qa?.length ? ` (${r.qa.map((q) => `${q.name} ${q.ok ? '✓' : '✗'}`).join(', ')})` : ''}
        </div>
        {r.checks.notes && <div className="text-2xs">{r.checks.notes}</div>}
      </Sec>
      {!!r.concerns.length && <Sec t="Concerns">{r.concerns.map((c, i) => <div key={i} className="text-2xs mb-2" style={{ color: 'var(--color-status-permission)' }}>• {c}</div>)}</Sec>}
      {!!r.next_steps.length && <Sec t="Next steps">{r.next_steps.map((c, i) => <div key={i} className="text-2xs mb-2">• {c}</div>)}</Sec>}
      {!!r.commits?.length && <Sec t="Commits">{r.commits.map((c) => <div key={c} className="text-2xs text-text-muted">{c}</div>)}</Sec>}
      <div className="text-2xs text-text-muted">{r.diffStat} {r.cost ? `· cost $${r.cost.toFixed(2)}` : ''} · {new Date(r.at).toLocaleString()}</div>
    </div>
  );
}

/** Talk back to a report: the thread with ARES, a reply box, and a link to any follow-up mission. */
function ReplyThread({ sm, m, onSelect }: { sm: SuccessManager; m: SmMission; onSelect: (id: string) => void }) {
  const [text, setText] = useState('');
  const [answerOnly, setAnswerOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const replies: SmReply[] = m.replies ?? [];
  const pending = Boolean(m.replyPending);
  const att = useImageAttach();
  const full = withImages(text, att.paths);
  const tooLong = full.length > SM_REPLY_MAX_CHARS;
  const send = async () => {
    if (!sm.project || !text.trim() || tooLong || att.uploading > 0) return;
    setBusy(true); setErr(null);
    try {
      await smClient.mission.reply(sm.project, m.id, full, answerOnly);
      setText(''); att.clear();
      void sm.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-8 pt-8 border-t-2 border-border flex flex-col gap-6">
      <div className="text-2xs text-text-muted">Reply to ARES</div>
      {replies.map((r) => (
        <div key={r.id} className="text-2xs">
          <span style={{ color: r.from === 'owner' ? 'var(--color-sm-gold)' : 'var(--color-accent-bright)' }}>{r.from === 'owner' ? 'You' : nameOf('orchestrator')}</span>
          <span className="text-text-muted"> · {new Date(r.at).toLocaleString()}{r.answerOnly ? ' · answer only' : ''}</span>
          <div className="whitespace-pre-wrap" style={r.error ? { color: 'var(--color-danger)' } : undefined}>{r.text}</div>
          {r.followUpId && <Button size="sm" className="mt-2" onClick={() => onSelect(r.followUpId!)}>Follow-up mission →</Button>}
        </div>
      ))}
      {pending && <div className="text-2xs text-text-muted">{nameOf('orchestrator')} is reading your reply…</div>}
      <textarea
        className="w-full min-h-[60px] bg-bg-dark border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent"
        placeholder='Ask a question, or ask for more work (e.g. "Also add it to the mobile menu")'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={att.onPaste} onDrop={att.onDrop} onDragOver={att.onDragOver}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
      />
      <ImageStrip images={att.images} onRemove={att.remove} />
      {att.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{att.error}</div>}
      <label className="flex items-center gap-4 text-2xs text-text-muted cursor-pointer">
        <input type="checkbox" checked={answerOnly} onChange={(e) => setAnswerOnly(e.target.checked)} />
        Just answer — don't start new work
      </label>
      <div className="flex items-center gap-6">
        <Button size="sm" variant="accent" disabled={busy || pending || att.uploading > 0 || !text.trim() || tooLong} onClick={send}>{busy ? 'Sending…' : 'Send'}</Button>
        <span className="text-2xs text-text-muted">{tooLong ? `Keep it under ${SM_REPLY_MAX_CHARS} characters.` : '⌘↵ to send'}</span>
      </div>
      {err && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{err}</div>}
    </div>
  );
}

/** Your inbox: every report the Floor Manager left on your desk. */
export function ReportsModal({ sm, openId, onClose, onSelect }: { sm: SuccessManager; openId: string | 'list' | null; onClose: () => void; onSelect: (id: string | 'list') => void }) {
  if (!openId || !sm.state) return null;
  const read = readReports();
  const mission = openId !== 'list' ? sm.state.missions.find((m) => m.id === openId) : undefined;
  if (mission?.report) markReportRead(mission.id);
  const parent = mission?.parentId ? sm.state.missions.find((m) => m.id === mission.parentId) : undefined;
  return (
    <Modal isOpen onClose={onClose} title={mission ? (mission.report ? 'Report' : 'Mission') : 'Reports on your desk'} zIndex={62} className="w-[640px]">
      <div className="px-10 pb-8">
        {mission && parent && (
          <button onClick={() => onSelect(parent.id)} className="block mb-6 bg-transparent border-0 p-0 cursor-pointer text-left text-2xs" style={{ color: 'var(--color-accent-bright)' }}>
            ← Follow-up to: “{parent.prompt.slice(0, 100)}”
          </button>
        )}
        {mission?.report ? (
          <>
            <div className="text-2xs text-text-muted mb-6">Mission: “{mission.prompt}”</div>
            <ReportView r={mission.report} />
            <div className="mt-8"><ChangesView sm={sm} missionId={mission.id} r={mission.report} /></div>
            <ReplyThread sm={sm} m={mission} onSelect={onSelect} />
            <div className="mt-8"><Button size="sm" onClick={() => onSelect('list')}>← All reports</Button></div>
          </>
        ) : mission ? (
          <>
            <MissionCard sm={sm} m={mission} onOpenReport={onSelect} />
            <div className="text-2xs text-text-muted mt-6">The report lands here when the team finishes.</div>
            <div className="mt-8"><Button size="sm" onClick={() => onSelect('list')}>← All reports</Button></div>
          </>
        ) : sm.state.reports.length ? (
          <div className="flex flex-col gap-6">
            {sm.state.reports.map((r) => (
              <button key={r.id} onClick={() => onSelect(r.id)} className="text-left bg-bg-dark border-2 border-border p-8 cursor-pointer text-text hover:bg-btn-hover">
                <span className="block text-2xs" style={{ color: r.verdict === 'success' ? 'var(--color-status-success)' : 'var(--color-status-permission)' }}>
                  {read.has(r.id) ? '' : '● NEW · '}{r.verdict.toUpperCase()} · {new Date(r.at).toLocaleString()}
                </span>
                <span className="block text-xs">{r.headline}</span>
                <span className="block text-2xs text-text-muted">“{r.prompt.slice(0, 120)}”</span>
                {(r.replies > 0 || r.followUpId || r.parentId) && (
                  <span className="block text-2xs text-text-muted">
                    {[r.parentId && 'follow-up', r.replies > 0 && `${r.replies} in thread`, r.replyPending && `${nameOf('orchestrator')} is replying…`, r.followUpId && 'follow-up started'].filter(Boolean).join(' · ')}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-2xs text-text-muted">No reports yet. Give ARES (the Floor Manager) a task — when the team finishes, the report lands here.</div>
        )}
      </div>
    </Modal>
  );
}

/** Missions waiting their turn: drag (or ▲▼) to change which goes next; "Send now" pauses the running one. */
export function MissionQueue({ sm, missions, onOpenReport, onWatch }: { sm: SuccessManager; missions: SmMission[]; onOpenReport: (id: string) => void; onWatch?: (crewId: string) => void }) {
  const server = missions.filter((m) => m.queuePos).sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0));
  const serverIds = server.map((m) => m.id).join(',');
  const [local, setLocal] = useState<string[] | null>(null); // the owner's order until the server shows it
  const [dragId, setDragId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (local && local.join(',') === serverIds) setLocal(null); }, [serverIds, local]);
  const ids = local ? [...local.filter((id) => server.some((m) => m.id === id)), ...server.map((m) => m.id).filter((id) => !local.includes(id))] : server.map((m) => m.id);
  const byId = new Map(server.map((m) => [m.id, m]));
  if (!ids.length) return null;
  const save = async (next: string[]) => {
    if (!sm.project) return;
    setLocal(next); setMsg(null);
    try { await smClient.mission.reorder(sm.project, next); void sm.refresh(); } catch (e) { setLocal(null); setMsg((e as Error).message); }
  };
  const move = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    if (next.join(',') !== ids.join(',')) void save(next);
  };
  const sendNow = async (id: string) => {
    if (!sm.project) return;
    setBusy(true); setMsg(null);
    try {
      const r = await smClient.mission.sendNow(sm.project, id);
      setLocal([id, ...ids.filter((x) => x !== id)]);
      setMsg(r.paused.length ? 'Pausing the current mission — this one goes now, then the paused one carries on.' : 'Nothing else is running — this one starts now.');
      void sm.refresh();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="text-2xs text-text-muted">Drag to change the order — the top one goes next.</div>
      {ids.map((id, i) => {
        const m = byId.get(id);
        if (!m) return null;
        return (
          <div key={id} draggable data-queue-id={id}
            className="flex flex-col gap-2" style={{ opacity: dragId === id ? 0.5 : 1 }}
            onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== id) move(dragId, i); setDragId(null); }}>
            <div className="flex items-center gap-6 text-2xs">
              <span className="cursor-grab text-text-muted" title="Drag to reorder">⠿ #{i + 1}</span>
              <Button size="sm" variant="ghost" disabled={i === 0} title="Move up" aria-label="Move up" onClick={() => move(id, i - 1)}>▲</Button>
              <Button size="sm" variant="ghost" disabled={i === ids.length - 1} title="Move down" aria-label="Move down" onClick={() => move(id, i + 1)}>▼</Button>
              <Button size="sm" variant="accent" disabled={busy} title="Pause what is running, do this now, then go back to it" onClick={() => sendNow(id)}>Send now</Button>
            </div>
            <MissionCard sm={sm} m={m} onOpenReport={onOpenReport} onWatch={onWatch} />
          </div>
        );
      })}
      {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
    </div>
  );
}

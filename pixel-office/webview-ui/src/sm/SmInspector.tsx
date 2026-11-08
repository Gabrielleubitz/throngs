/** Click a crew character → who they are, what they're doing, and three actions. */
import { useEffect, useState } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { CREW_BY_AGENT, crewForLogTag } from './crew.js';
import { withImages } from './imageAttach.js';
import { ImageStrip } from './ImageStrip.js';
import { smClient } from './smClient.js';
import { SmLiveFeed } from './SmLiveFeed.js';
import { AnswerBox, AskView, MissionComposer } from './SmMissions.js';
import { NeedsYouCard } from './SmPanel.js';
import type { IvyTab } from './SmSecretary.js';
import { applesFed, throngFeed, throngSay, throngVoice } from './throngVoice.js';
import { useImageAttach } from './useImageAttach.js';
import type { SuccessManager } from './useSuccessManager.js';

const STATE_COLOR = { WORKING: 'var(--color-status-success)', IDLE: 'var(--color-text-muted)', BLOCKED: 'var(--color-status-permission)' };

function ThrongCard({ id }: { id: string }) {
  const v = throngVoice(id);
  const [apples, setApples] = useState(applesFed);
  return (
    <div className="bg-bg-dark border-2 border-border p-6 flex items-start justify-between gap-6">
      <div className="text-2xs">
        <div><b>{v.trait}</b> throng · <span className="text-text-muted">{v.quirk}</span></div>
        <div className="text-text-muted">“{v.catchphrase}”</div>
      </div>
      <div className="flex gap-4 shrink-0">
        <button className="border-2 border-border px-4 text-2xs" title="Hear their voice" onClick={() => throngSay(id, 'happy')}>▶ voice</button>
        <button className="border-2 border-border px-4 text-2xs" title="Hear them sing" onClick={() => throngSay(id, 'sing')}>♪</button>
        <button className="border-2 border-border px-4 text-2xs" title={`Feed an apple (${apples} fed so far)`} onClick={() => setApples(throngFeed(id))}>🍎 {apples}</button>
      </div>
    </div>
  );
}

export function SmInspector({ sm, agentId, onClose, onJump, onOpenReport, onOpenIvy }: { sm: SuccessManager; agentId: number | null; onClose: () => void; onJump?: (agentId: number) => void; onOpenReport?: (id: string | 'list') => void; onOpenIvy?: (tab: IvyTab) => void }) {
  const c = agentId !== null ? CREW_BY_AGENT.get(agentId) : undefined;
  const [extra, setExtra] = useState<React.ReactNode>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const att = useImageAttach();
  const [assigning, setAssigning] = useState(false);
  useEffect(() => { setExtra(null); setMsg(null); setTask(''); setAssigning(false); }, [agentId]);
  if (!c || !sm.state) return null;
  const s = sm.state;
  const a = s.agents.find((x) => x.id === c.id);
  const stream = s.logs.filter((l) => crewForLogTag(l.agent)?.id === c.id).slice(-12);
  const blocked = (a?.blockedOn ?? []).map((id) => s.tasks.human.find((t) => t.id === id)).filter(Boolean);

  const force = async () => {
    sm.override(c.id, 'work');
    if (!c.reviewer) { setMsg(`${c.name} walks back to the desk. (The real builder starts with: sm run ${s.project})`); return; }
    try { await smClient.audit(s.project, [c.id]); setMsg(`${c.name} is reviewing ${s.project} now (read-only).`); void sm.refresh(); }
    catch (e) { setMsg((e as Error).message); }
  };
  const lounge = () => { sm.override(c.id, 'lounge'); setMsg(`${c.name} takes a 1-minute break. (Just the character — no work is stopped.)`); };
  const inspect = async () => {
    if (c.reviewer) {
      const f = a?.findings ?? [];
      setExtra(f.length ? (
        <div className="flex flex-col gap-4">{f.map((x) => (
          <div key={x.id} className="bg-bg-dark border-2 border-border p-6 text-2xs">
            <div>{x.id} · P{x.priority} · {x.title}</div>
            <div className="text-text-muted mt-2">{x.file}</div>
            <div className="mt-2">{x.evidence}</div>
          </div>))}
        </div>) : <div className="text-2xs text-text-muted">Reviewers never write code — and {c.name} filed nothing new last sweep.</div>);
      return;
    }
    setExtra(<div className="text-2xs text-text-muted">Loading the latest commit…</div>);
    try {
      const { diff } = await smClient.diff(s.project);
      setExtra(
        <pre className="max-h-[300px] overflow-auto bg-bg-dark border-2 border-border p-6 text-2xs font-pixel whitespace-pre">
          {diff.split('\n').map((l, i) => (
            <div key={i} style={{ color: l.startsWith('+') && !l.startsWith('+++') ? 'var(--color-status-success)' : l.startsWith('-') && !l.startsWith('---') ? 'var(--color-danger)' : l.startsWith('@@') ? 'var(--color-status-active)' : 'var(--color-text-muted)' }}>{l || ' '}</div>
          ))}
        </pre>);
    } catch (e) { setExtra(<div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{(e as Error).message}</div>); }
  };

  // Jobs this agent has been given, newest first (mission subtasks carry the assignee).
  const jobs = s.missions.flatMap((m) => m.subtasks.filter((st) => st.assignee === c.id).map((st) => ({ m, st }))).reverse().slice(0, 6);
  const lastReport = s.missions.filter((m) => m.report && m.subtasks.some((st) => st.assignee === c.id)).slice(-1)[0];
  const assign = async () => {
    if (!task.trim() || att.uploading > 0) return;
    try {
      await smClient.mission.create(s.project, withImages(`For ${c.name} (${c.role}): ${task.trim()}`, att.paths));
      setTask(''); att.clear(); setAssigning(false); setMsg(`Sent to the Floor Manager, addressed to ${c.name}.`); void sm.refresh();
    } catch (e) { setMsg((e as Error).message); }
  };
  const needsYou = Boolean(a?.question) || blocked.length > 0;
  const details = (
    <>
      <div className="text-2xs text-text-muted">{c.bio}</div>
      <ThrongCard id={c.id} />
      {c.id === 'secretary' && onOpenIvy && (
        <div className="flex gap-4 flex-wrap">
          <Button size="sm" variant="accent" onClick={() => onOpenIvy('tasks')} title="She passes it on to ARES for development">📝 Tell Ivy what you need</Button>
          <Button size="sm" onClick={() => onOpenIvy('calendar')}>📅 Calendar</Button>
          <Button size="sm" onClick={() => onOpenIvy('calls')}>☎ Calls</Button>
          <Button size="sm" onClick={() => onOpenIvy('away')}>🗂 While you were away</Button>
          <Button size="sm" onClick={() => onOpenIvy('know')}>📇 What she knows</Button>
        </div>
      )}
      <div className="flex gap-6 text-2xs">
        <span className="border-2 px-4" style={{ borderColor: STATE_COLOR[a?.state ?? 'IDLE'], color: STATE_COLOR[a?.state ?? 'IDLE'] }}>{a?.state ?? 'IDLE'}</span>
        {c.reviewer && <span className="text-text-muted">filed {a?.filed ?? 0} · open {a?.open ?? 0} · last shift ${(a?.lastCost ?? 0).toFixed(2)}</span>}
        {c.id === 'builder' && <span className="text-text-muted">closed {a?.closed ?? 0} · queued {a?.open ?? 0}</span>}
      </div>
      {!needsYou && (
        <div className="bg-bg-dark border-2 border-border p-6">
          <div className="text-2xs text-text-muted">Doing now</div>
          <div className="text-2xs">{a?.task ?? '—'}</div>
        </div>
      )}
      <div>
        <div className="text-2xs text-text-muted mb-2">Live stream</div>
        <div className="max-h-[180px] overflow-y-auto bg-bg-dark border-2 border-border p-6">
          {stream.length ? stream.map((l, i) => <div key={i} className="text-2xs leading-snug mb-2">{l.msg}</div>) : <div className="text-2xs text-text-muted">Nothing yet.</div>}
        </div>
      </div>
      {assigning && (
        <div className="flex flex-col gap-4">
          <textarea className="w-full bg-bg-dark text-text border-2 border-border text-2xs p-4 font-pixel" rows={3} value={task} onChange={(e) => setTask(e.target.value)} onPaste={att.onPaste} onDrop={att.onDrop} onDragOver={att.onDragOver} placeholder={`What should ${c.name} do? (goes to the Floor Manager, who routes it)`} />
          <ImageStrip images={att.images} onRemove={att.remove} />
          {att.error && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{att.error}</div>}
          <Button size="sm" variant="accent" disabled={!task.trim() || att.uploading > 0} onClick={assign}>Send</Button>
        </div>
      )}
      {jobs.length > 0 && (
        <div>
          <div className="text-2xs text-text-muted mb-2">Recent jobs</div>
          <div className="flex flex-col gap-2">{jobs.map(({ m, st }) => (
            <div key={`${m.id}-${st.id}`} className="text-2xs bg-bg-dark border-2 border-border p-4 flex gap-6"><span className="flex-1 min-w-0 truncate" title={st.title}>{st.title}</span><span className="text-text-muted whitespace-nowrap">{st.status.replace(/_/g, ' ')}</span></div>
          ))}</div>
        </div>
      )}
      {extra}
      <div className="flex flex-wrap gap-6">
        <Button size="sm" variant="accent" onClick={force} title={c.reviewer ? 'Runs a real read-only review by this agent only' : 'Moves the character to its desk'}>Force task</Button>
        <Button size="sm" onClick={lounge}>Send to lounge</Button>
        {onJump && <Button size="sm" onClick={() => { onJump(c.agentId); onClose(); }} title="Close this card and move the office camera to them">Jump to agent</Button>}
        {onOpenReport && <Button size="sm" disabled={!lastReport} onClick={() => { onOpenReport(lastReport!.id); onClose(); }} title={lastReport ? lastReport.report!.headline : 'No report from a job they worked on yet'}>Latest report</Button>}
        <Button size="sm" onClick={() => setAssigning((v) => !v)}>Assign task</Button>
        <Button size="sm" onClick={inspect}>{c.reviewer ? 'Show findings' : 'Inspect code'}</Button>
      </div>
    </>
  );

  return (
    <Modal isOpen onClose={onClose} title={needsYou ? `${c.name} needs you` : `${c.name} · ${c.role}`} zIndex={60} className="w-[560px]">
      <div className="px-10 pb-8 flex flex-col gap-8 text-text">
        <div className="flex items-center gap-8 min-w-0">
          <CharacterMugShot palette={c.palette} hueShift={c.hueShift} size={48} />
          <div className="min-w-0 text-2xs"><div className="truncate">{c.name}</div><div className="text-text-muted truncate">{c.role} · {c.room}</div></div>
        </div>
        {/* What they need comes first — this is why you clicked. */}
        {/* Live monitor: what they are doing right now (Claude Code style) */}
        {a?.live && (
          <div className="border-2 p-6" style={{ borderColor: 'var(--color-status-active)' }}>
            <SmLiveFeed project={s.project} missionId={a.live.missionId} subtaskId={a.live.subtaskId} title={`Mission job: ${a.live.title}`}
              active={['working', 'answered'].includes(a.live.status)} />
          </div>
        )}
        {a?.question && (
          <div className="border-2 p-6 flex flex-col gap-6" style={{ borderColor: 'var(--color-sm-help)' }}>
            <div className="text-2xs" style={{ color: 'var(--color-sm-help)' }}>For the job: {a.question.title}</div>
            <AskView ask={a.question.ask} fallback={a.question.title} />
            <AnswerBox sm={sm} missionId={a.question.missionId} subtaskId={a.question.subtaskId} onDone={onClose} />
          </div>
        )}
        {blocked.map((t) => <NeedsYouCard key={t!.id} t={t!} project={s.project} onDone={() => void sm.refresh()} defaultOpen />)}

        {c.id === 'orchestrator' && (
          <div className="border-2 p-6" style={{ borderColor: 'var(--color-accent-bright)' }}>
            <div className="text-2xs mb-4" style={{ color: 'var(--color-accent-bright)' }}>Give me a task — I'll break it down in beads and hand it to the right desks.</div>
            <MissionComposer sm={sm} compact onSent={onClose} />
          </div>
        )}

        {needsYou ? (
          <details>
            <summary className="text-2xs text-text-muted cursor-pointer">More about {c.name} ({c.role})</summary>
            <div className="flex flex-col gap-8 mt-6">{details}</div>
          </details>
        ) : details}
        {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      </div>
    </Modal>
  );
}

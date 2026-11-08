/**
 * IVY tab — the secretary's desk: "while you were away" checklist (tickable) with callback queue, office tasks the
 * owner hands her, the call log, and the knowledge she answers calls from. TODAY: the morning brief, reminders that
 * fire, and the dev pulse (every repo + GitHub). Data: /sm/secretary (bin/secretary.js), /sm/pulse (bin/devpulse.js).
 */
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { SmCalendar } from './SmCalendar.js';
import { smClient, type SmGlance,type SmPulse, type SmSecCall, type SmSecItem, type SmSecretary, type SmWellbeing } from './smClient.js';

export type IvyTab = 'today' | 'calendar' | 'away' | 'tasks' | 'calls' | 'know';
type Sub = IvyTab;
const SUBS: { k: Sub; label: string }[] = [{ k: 'today', label: 'TODAY' }, { k: 'calendar', label: 'CALENDAR' }, { k: 'away', label: 'AWAY' }, { k: 'tasks', label: 'TASKS' }, { k: 'calls', label: 'CALLS' }, { k: 'know', label: 'KNOWS' }];
const KIND_COLOR: Record<string, string> = { 'needs-you': 'var(--color-danger)', failed: 'var(--color-danger)', call: 'var(--color-accent-bright)', callback: 'var(--color-warning)', finished: 'var(--color-status-success)', task: 'var(--color-text)' };
const OUTCOME_LABEL: Record<string, string> = { 'owner-chat': 'chat', 'request-filed': 'request', 'message-taken': 'message', silent: 'silent', 'hung-up-early': 'hung up', error: 'error', blocked: 'blocked' };
const OUTCOME_COLOR: Record<string, string> = { error: 'var(--color-danger)', blocked: 'var(--color-danger)', 'message-taken': 'var(--color-warning)', 'request-filed': 'var(--color-status-success)' };
const INPUT = 'flex-1 min-w-0 bg-bg border-2 border-border text-text text-2xs p-4 font-pixel outline-none focus:border-accent';

function ago(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function Row({ it, onTick }: { it: SmSecItem; onTick: (id: string, done: boolean) => void }) {
  return (
    <label className="flex gap-6 items-start bg-bg-dark border-2 border-border p-6 mb-4 cursor-pointer" style={{ opacity: it.done ? 0.5 : 1 }}>
      <input type="checkbox" checked={it.done} onChange={(e) => onTick(it.id, e.target.checked)} className="mt-2" />
      <span className="flex-1 min-w-0">
        <span className="block text-xs" style={{ color: KIND_COLOR[it.kind] ?? 'var(--color-text)', textDecoration: it.done ? 'line-through' : 'none' }}>{it.title}</span>
        {it.detail && <span className="block text-2xs text-text-muted">{it.detail}</span>}
      </span>
      {it.at && <span className="text-2xs text-text-muted">{ago(it.at)}</span>}
    </label>
  );
}

function CallRow({ c }: { c: SmSecCall }) {
  const who = c.isOwner ? 'You' : c.callerName || c.from || 'Unknown';
  return (
    <div className="bg-bg-dark border-2 border-border p-6 mb-4">
      <div className="flex gap-6 items-center">
        <span className="text-xs">{c.direction === 'out' ? '↗' : '↙'} {who}</span>
        <span className="text-2xs px-4" style={{ border: '1px solid currentColor', color: OUTCOME_COLOR[c.outcome] ?? 'var(--color-text-muted)' }}>{OUTCOME_LABEL[c.outcome] ?? c.outcome}</span>
        <span className="flex-1" />
        <span className="text-2xs text-text-muted">{c.durationSec ? `${c.durationSec}s · ` : ''}{ago(c.endedAt ?? c.at)}</span>
      </div>
      {c.summary && <div className="text-2xs text-text-muted mt-2">{c.summary}</div>}
      {(c.messages ?? []).map((m, i) => <div key={i} className="text-2xs mt-2" style={{ color: 'var(--color-warning)' }}>✉ {m}</div>)}
      {(c.requests ?? []).map((m, i) => <div key={i} className="text-2xs mt-2" style={{ color: 'var(--color-status-success)' }}>＋ {m}</div>)}
    </div>
  );
}

function AddLine({ placeholder, onAdd, extra }: { placeholder: string; onAdd: (v: string, v2: string) => Promise<void>; extra?: string }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const go = async () => { if (!a.trim()) return; await onAdd(a, b); setA(''); setB(''); };
  return (
    <div className="flex gap-4 mb-6">
      <input className={INPUT} placeholder={placeholder} value={a} onChange={(e) => setA(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
      {extra && <input className={INPUT} placeholder={extra} value={b} onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />}
      <Button size="sm" variant="accent" disabled={!a.trim()} onClick={() => void go()}>Add</Button>
    </div>
  );
}

const LEVEL_COLOR = ['var(--color-danger)', 'var(--color-warning)', 'var(--color-text)', 'var(--color-text-muted)'];

/** TODAY: the brief she sends each morning, reminders she will fire, and the developer view of every repo. */
function Today({ d, act }: { d: SmSecretary; act: (name: string, body?: Record<string, unknown>, done?: string) => Promise<void> }) {
  const [pulse, setPulse] = useState<SmPulse | null>(null);
  const [brief, setBrief] = useState<{ text: string; spoken: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [all, setAll] = useState(false);
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [call, setCall] = useState(false);
  const [wb, setWb] = useState<SmWellbeing | null>(null);
  const [gl, setGl] = useState<SmGlance | null>(null);
  const loadBrief = useCallback(() => smClient.secretary.act('previewBrief').then((b) => setBrief(b as { text: string; spoken: string })).catch(() => {}), []);
  useEffect(() => { void smClient.pulse().then(setPulse).catch(() => {}); void smClient.wellbeing.state().then(setWb).catch(() => {}); void smClient.glance().then(setGl).catch(() => {}); void loadBrief(); }, [loadBrief]);
  const rescan = async () => { setScanning(true); try { setPulse(await smClient.pulse(true)); await loadBrief(); } finally { setScanning(false); } };
  const add = async () => { if (!text.trim() || !when) return; await act('addReminder', { text, at: new Date(when).toISOString(), via: call ? 'call' : 'whatsapp' }, 'Reminder set.'); setText(''); setWhen(''); };
  const att = (pulse?.attention ?? []).filter((a) => all || a.level <= 2);
  const quiet = (pulse?.attention ?? []).filter((a) => a.level > 2).length;
  const shipped = (pulse?.repos ?? []).filter((r) => r.today.length);
  const b = d.brief;
  return (
    <div>
      <div className="text-2xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>MORNING BRIEF</div>
      <div className="bg-bg-dark border-2 border-border p-6 mb-4 text-2xs" style={{ whiteSpace: 'pre-wrap' }}>{brief ? brief.text.replace(/\*(.+?)\*/g, '$1').replace(/\n\n/g, '\n') : 'Putting it together…'}</div>
      <div className="flex gap-4 items-center flex-wrap mb-8 text-2xs text-text-muted">
        <label className="flex gap-4 items-center cursor-pointer"><input type="checkbox" checked={b?.briefOn ?? true} onChange={(e) => void act('briefSettings', { briefOn: e.target.checked })} />WhatsApp it daily at</label>
        <input type="time" className={INPUT} style={{ maxWidth: 110, flex: 'none' }} value={b?.briefTime ?? '08:30'} onChange={(e) => void act('briefSettings', { briefTime: e.target.value })} />
        <Button size="sm" onClick={() => void act('sendBrief', {}, 'Brief sent to your WhatsApp.')}>Send it now</Button>
        {b?.briefDate && <span>last sent {b.briefDate}</span>}
      </div>

      {gl && (gl.weather || gl.linked) && (
        <>
          <div className="text-2xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>GLANCE (ask Ivy: weather, convert, mail, packages)</div>
          <div className="mb-8 text-2xs text-text-muted">
            {gl.weather && <div>{gl.weather}</div>}
            {gl.mail && <div>{gl.mail.length ? `Mail today: ${gl.mail.slice(0, 3).map((m) => `${m.from || '?'} — ${m.subject}`).join(' · ')}` : 'No mail so far today'}</div>}
            {gl.packages !== null && <div>{gl.packages} package(s), {gl.flights} flight(s) tracked</div>}
          </div>
        </>
      )}
      <div className="text-2xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>WELLBEING (off until you switch it on, or ask Ivy)</div>
      <div className="flex gap-8 items-center flex-wrap mb-8 text-2xs text-text-muted">
        <Button size="sm" onClick={() => void smClient.wellbeing.awake(!wb?.awake.on).then(setWb)}>{wb?.awake.on ? `Mac awake until ${new Date(wb.awake.until ?? 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · turn off` : 'Keep my Mac awake (8h)'}</Button>
        <Button size="sm" onClick={() => void smClient.wellbeing.breaks({ on: !wb?.breaks.breaksOn }).then(setWb)}>{wb?.breaks.breaksOn ? `Break nudges ON · every ${wb.breaks.everyMin} min, ${wb.breaks.from}-${wb.breaks.to}h · turn off` : 'Turn on break nudges'}</Button>
      </div>

      <div className="text-2xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>REMINDERS (she texts you, or calls if you tick it)</div>
      <div className="flex gap-4 mb-4">
        <input className={INPUT} placeholder="e.g. Call Dana about the invoice" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <input type="datetime-local" className={INPUT} style={{ maxWidth: 190, flex: 'none' }} value={when} onChange={(e) => setWhen(e.target.value)} />
        <label className="flex gap-2 items-center text-2xs text-text-muted cursor-pointer"><input type="checkbox" checked={call} onChange={(e) => setCall(e.target.checked)} />call</label>
        <Button size="sm" variant="accent" disabled={!text.trim() || !when} onClick={() => void add()}>Add</Button>
      </div>
      {!(d.reminders ?? []).length && <div className="text-2xs text-text-muted mb-8">None. Or just tell Ivy on the phone: "remind me at 4 to call Dana".</div>}
      {(d.reminders ?? []).map((r) => (
        <div key={r.id} className="flex gap-6 text-2xs mb-2 items-center">
          <span style={{ color: 'var(--color-warning)' }}>{new Date(r.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span className="flex-1">{r.via === 'call' ? '📞 ' : ''}{r.text}</span>
          <Button size="sm" variant="ghost" onClick={() => void act('removeReminder', { id: r.id })} title="Cancel">✕</Button>
        </div>
      ))}

      <div className="flex items-center mt-8 mb-2">
        <span className="text-2xs flex-1" style={{ color: 'var(--color-accent-bright)' }}>YOUR CODE · {pulse ? `${pulse.repos.length} repos, ${(pulse.github.repos ?? []).length} on GitHub, scanned ${ago(pulse.at)}` : 'scanning…'}</span>
        <Button size="sm" variant="ghost" disabled={scanning} onClick={() => void rescan()}>{scanning ? 'Scanning…' : 'Rescan'}</Button>
      </div>
      {pulse?.github.error && <div className="text-2xs mb-2" style={{ color: 'var(--color-warning)' }}>{pulse.github.error}</div>}
      {pulse && !att.length && <div className="text-2xs mb-2" style={{ color: 'var(--color-status-success)' }}>All pushed, all green.</div>}
      {att.map((a, i) => <div key={i} className="text-2xs mb-2" style={{ color: LEVEL_COLOR[a.level] }}>{['●', '●', '○', '·'][a.level]} {a.text}</div>)}
      {quiet > 0 && <button className="text-2xs text-text-muted bg-transparent border-0 cursor-pointer p-0 mb-4" onClick={() => setAll(!all)}>{all ? 'Hide dormant repos' : `+${quiet} in dormant repos`}</button>}
      {shipped.length > 0 && <div className="text-2xs mt-6 mb-2" style={{ color: 'var(--color-accent-bright)' }}>LAST 24 HOURS</div>}
      {shipped.map((r) => <div key={r.name} className="text-2xs mb-2 text-text-muted">{r.name}: {r.today.length} commit{r.today.length > 1 ? 's' : ''} — {r.today[0]}</div>)}
    </div>
  );
}

/** Tell Ivy what you need: by default she passes it on to ARES as a mission for `project`. */
function HandOff({ project, onAdd }: { project: string | null; onAdd: (b: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [toAres, setToAres] = useState(true);
  const go = async () => { if (!title.trim()) return; await onAdd({ title, due, toAres, project }); setTitle(''); setDue(''); };
  return (
    <div className="bg-bg-dark border-2 border-border p-6 mb-6">
      <div className="flex gap-4 mb-4">
        <input className={INPUT} placeholder="Tell Ivy what you need done…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
        <input className={INPUT} style={{ maxWidth: 110 }} placeholder="Due (optional)" value={due} onChange={(e) => setDue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
        <Button size="sm" variant="accent" disabled={!title.trim()} onClick={() => void go()}>{toAres ? 'Send' : 'Add'}</Button>
      </div>
      <label className="flex gap-4 items-center text-2xs text-text-muted cursor-pointer">
        <input type="checkbox" checked={toAres} onChange={(e) => setToAres(e.target.checked)} />
        Pass it on to ARES for development ({project || 'success-manager'}) — untick to keep it as a reminder on her desk
      </label>
    </div>
  );
}

export function SmSecretaryDesk({ tab = 'today', project = null }: { tab?: IvyTab; project?: string | null } = {}) {
  const [d, setD] = useState<SmSecretary | null>(null);
  const [sub, setSub] = useState<Sub>(tab);
  useEffect(() => setSub(tab), [tab]);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => smClient.secretary.state().then(setD).catch((e: Error) => setMsg(e.message)), []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);
  const act = async (name: string, body: Record<string, unknown> = {}, done?: string) => {
    try { await smClient.secretary.act(name, body); if (done) setMsg(done); await load(); } catch (e) { setMsg((e as Error).message); }
  };
  if (!d) return <div className="p-12 text-2xs text-text-muted">{msg || 'Ivy is getting her desk ready…'}</div>;
  const away = [...d.callbacks, ...d.checklist];
  const open = away.filter((i) => !i.done).length;
  const k = d.knowledge;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <div className="bg-bg-dark border-2 border-border p-8 mb-8">
        <div className="text-xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>IVY · OFFICE SECRETARY</div>
        <div className="text-2xs text-text-muted">{d.briefing}</div>
        <div className="flex gap-4 mt-4 items-center flex-wrap">
          <Button size="sm" onClick={() => void act('sendDigest', {}, 'Digest sent to your phone.')} title="Texts the open items to your WhatsApp">Text me the digest</Button>
          <Button size="sm" disabled={!open} onClick={() => void act('tickAll')}>Tick all</Button>
          {d.digestAt && <span className="text-2xs text-text-muted">last digest {ago(d.digestAt)}</span>}
        </div>
        {msg && <div className="text-2xs mt-2" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      </div>
      <div className="flex mb-6">
        {SUBS.map(({ k: key, label }) => (
          <button key={key} onClick={() => setSub(key)} className="flex-1 py-4 border-0 cursor-pointer text-2xs"
            style={{ background: sub === key ? 'var(--color-active-bg)' : 'transparent', color: sub === key ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
            {key === 'away' ? `${label}${open ? ` · ${open}` : ''}` : key === 'tasks' ? `${label} · ${d.tasks.filter((t) => t.status === 'open').length}` : key === 'calls' ? `${label} · ${d.calls.length}` : label}
          </button>
        ))}
      </div>

      {sub === 'today' && <Today d={d} act={act} />}

      {sub === 'calendar' && <SmCalendar />}

      {sub === 'away' && (
        <div>
          {!away.length && <div className="text-2xs text-text-muted">Nothing missed. Calls, messages, finished or failed missions and things that need you land here.</div>}
          {away.map((it) => <Row key={it.id} it={it} onTick={(id, done) => void act('tick', { id, done })} />)}
        </div>
      )}

      {sub === 'tasks' && (
        <div>
          <HandOff project={project} onAdd={(b) => act('addTask', b, b.toAres ? 'Ivy passed it on to ARES — it is in MISSIONS now.' : 'On her desk.')} />
          {!d.tasks.length && <div className="text-2xs text-text-muted">No tasks. Ivy tracks what you hand her here and can answer about them on the phone.</div>}
          {d.tasks.map((t) => (
            <div key={t.id} className="flex gap-6 items-start bg-bg-dark border-2 border-border p-6 mb-4" style={{ opacity: t.status === 'done' ? 0.5 : 1 }}>
              <input type="checkbox" className="mt-2" checked={t.status === 'done'} onChange={(e) => void act('setTask', { id: t.id, done: e.target.checked })} />
              <span className="flex-1 min-w-0">
                <span className="block text-xs" style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</span>
                {(t.due || t.detail) && <span className="block text-2xs text-text-muted">{t.due ? `due ${t.due}` : ''}{t.due && t.detail ? ' · ' : ''}{t.detail}</span>}
                {t.mission && <span className="block text-2xs" style={{ color: 'var(--color-status-success)' }}>→ ARES · {t.mission.project} · {t.missionStatus ?? 'filed'}</span>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void act('removeTask', { id: t.id })} title="Remove">✕</Button>
            </div>
          ))}
        </div>
      )}

      {sub === 'calls' && (
        <div>
          {!d.calls.length && <div className="text-2xs text-text-muted">No calls yet. Every call Ivy takes or makes is logged here with how it ended.</div>}
          {d.calls.map((c) => <CallRow key={c.id} c={c} />)}
        </div>
      )}

      {sub === 'know' && (
        <div>
          <div className="text-2xs mb-2" style={{ color: 'var(--color-accent-bright)' }}>YOUR SCHEDULE</div>
          <AddLine placeholder="e.g. Tue 3pm dentist, away until 5" onAdd={(text) => act('addNote', { kind: 'schedule', text })} />
          {k.schedule.map((n) => <div key={n.id} className="flex gap-6 text-2xs mb-2"><span className="flex-1">{n.text}</span><Button size="sm" variant="ghost" onClick={() => void act('removeNote', { id: n.id })}>✕</Button></div>)}
          <div className="text-2xs mb-2 mt-6" style={{ color: 'var(--color-accent-bright)' }}>THINGS SHE SHOULD KNOW (she also reads your linked Google Calendar and Drive)</div>
          <AddLine placeholder="e.g. Office closed Friday" onAdd={(text) => act('addNote', { kind: 'fact', text })} />
          {k.facts.map((n) => <div key={n.id} className="flex gap-6 text-2xs mb-2"><span className="flex-1">{n.text}</span><Button size="sm" variant="ghost" onClick={() => void act('removeNote', { id: n.id })}>✕</Button></div>)}
          <div className="text-2xs mb-2 mt-6" style={{ color: 'var(--color-accent-bright)' }}>CONTACTS (she greets them by name)</div>
          <Button size="sm" variant="ghost" onClick={() => void act('importContacts', {})}>Import WhatsApp contacts</Button>
          <AddLine placeholder="Name" extra="+972…" onAdd={(name, number) => act('addContact', { name, number })} />
          {k.contacts.map((c) => <div key={c.id} className="flex gap-6 text-2xs mb-2"><span className="flex-1">{c.name} · {c.number}</span><Button size="sm" variant="ghost" onClick={() => void act('removeContact', { id: c.id })}>✕</Button></div>)}
          <div className="text-2xs mb-2 mt-6" style={{ color: 'var(--color-accent-bright)' }}>LIVE FROM THE OFFICE</div>
          {k.waitingOnOwner.map((q) => <div key={q.missionId + q.title} className="text-2xs mb-2" style={{ color: 'var(--color-danger)' }}>needs you: {q.title}</div>)}
          {k.activeMissions.map((m) => <div key={m.id} className="text-2xs mb-2 text-text-muted">{m.project}: {m.prompt} ({m.status})</div>)}
          {!k.waitingOnOwner.length && !k.activeMissions.length && <div className="text-2xs text-text-muted">No missions running.</div>}
        </div>
      )}
    </div>
  );
}

/** IVY's desk as a window: opened from her room's sign, her clickable desk spots, and her own character. */
export function SmSecretaryModal({ tab, project, onClose }: { tab: IvyTab | null; project: string | null; onClose: () => void }) {
  if (!tab) return null;
  return (
    <Modal isOpen onClose={onClose} title="Reception · IVY's desk" zIndex={63} className="w-[600px]">
      <SmSecretaryDesk tab={tab} project={project} />
    </Modal>
  );
}

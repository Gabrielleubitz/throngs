/**
 * Room Settings — opened from a department's wall sign. Shows the department brief every person in the
 * room works under, the people in it (real job titles + their personal brief), and lets you hire.
 * Everything here is the actual prompt the AI teammates receive (office/staff.json).
 */
import { useEffect, useState } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { isManagement, type RoomRecord, type StaffRecord } from './crew.js';
import { PixelLogo } from './PixelLogo.js';
import { smClient, type SmIntegration } from './smClient.js';
import { SmGameRoom } from './SmGameRoom.js';
import type { SuccessManager } from './useSuccessManager.js';

const KIND_LABEL = { manager: 'Floor Manager · management', planner: 'Planner · management', ideas: 'Future Ideas · management', watcher: 'Account Watcher · no AI', engineer: 'Engineer · can change code', reviewer: 'Specialist · read-only' } as const;
const field = 'w-full bg-bg-dark border-2 border-border text-text text-2xs p-6 font-pixel outline-none focus:border-accent';

function PersonCard({ sm, person, rooms, onSaved }: { sm: SuccessManager; person: StaffRecord; rooms: RoomRecord[]; onSaved: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(person.name);
  const [title, setTitle] = useState(person.title);
  const [brief, setBrief] = useState(person.brief);
  const [room, setRoom] = useState(person.room);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setName(person.name); setTitle(person.title); setBrief(person.brief); setRoom(person.room); }, [person]);
  const dirty = name !== person.name || title !== person.title || brief !== person.brief || room !== person.room;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await smClient.staff.update({ id: person.id, name, title, brief, room });
      onSaved(room !== person.room ? `${name} is moving to ${rooms.find((r) => r.id === room)?.label}.` : `${name}'s brief saved — it applies to their next job.`);
      void sm.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const letGo = async () => {
    if (!window.confirm(`Let ${person.name} go? Their desk frees up; their past work stays in the reports.`)) return;
    try { await smClient.staff.fire(person.id); onSaved(`${person.name} has left the company.`); void sm.refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="bg-bg-dark border-2 border-border">
      <button className="w-full flex items-center gap-8 p-6 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <CharacterMugShot palette={person.palette} hueShift={person.hueShift} size={36} />
        <span className="flex-1 min-w-0">
          <span className="block text-xs">{person.name}</span>
          <span className="block text-2xs text-text-muted">{person.title}</span>
        </span>
        <span className="text-2xs text-text-muted">{KIND_LABEL[person.kind]}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 pt-6 border-t-2 border-border flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-6">
            <label className="text-2xs text-text-muted">Name<input className={field} value={name} maxLength={16} onChange={(e) => setName(e.target.value.toUpperCase())} /></label>
            <label className="text-2xs text-text-muted">Job title<input className={field} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} /></label>
          </div>
          <label className="text-2xs text-text-muted">Their personal brief (what they focus on, how they work)
            <textarea className={`${field} min-h-[120px]`} value={brief} onChange={(e) => setBrief(e.target.value)} />
          </label>
          {!isManagement(person) && (
            <label className="text-2xs text-text-muted">Works in
              <select className={field} value={room} onChange={(e) => setRoom(e.target.value)}>
                {rooms.filter((r) => r.hire && !r.restricted).map((r) => <option key={r.id} value={r.id}>{r.label} — {r.department}</option>)}
              </select>
            </label>
          )}
          <div className="flex gap-6">
            <Button size="sm" variant="accent" disabled={!dirty || busy} onClick={save}>Save</Button>
            {!person.core && <Button size="sm" variant="ghost" onClick={letGo}>Let go</Button>}
          </div>
          {err && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{err}</div>}
        </div>
      )}
    </div>
  );
}

function HireForm({ sm, room, onHired }: { sm: SuccessManager; room: RoomRecord; onHired: (m: string) => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'engineer' | 'reviewer'>('reviewer');
  const [brief, setBrief] = useState('');
  const [palette, setPalette] = useState(0);
  const [hue, setHue] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hire = async () => {
    setBusy(true); setErr(null);
    try {
      const s = await smClient.staff.hire({ name, title, kind, room: room.id, brief, palette, hueShift: hue });
      onHired(`Welcome ${s.name}, our new ${s.title}! They're heading to their desk in ${room.label}.`);
      sm.say('orchestrator', `Welcome aboard, ${s.name}!`);
      setName(''); setTitle(''); setBrief('');
      void sm.refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="border-2 p-8 flex flex-col gap-6" style={{ borderColor: 'var(--color-accent-bright)' }}>
      <div className="text-xs" style={{ color: 'var(--color-accent-bright)' }}>HIRE INTO {room.label.toUpperCase()}</div>
      <div className="grid grid-cols-2 gap-6">
        <label className="text-2xs text-text-muted">Name<input className={field} value={name} maxLength={16} placeholder="e.g. PIXEL" onChange={(e) => setName(e.target.value.toUpperCase())} /></label>
        <label className="text-2xs text-text-muted">Job title<input className={field} value={title} maxLength={60} placeholder="e.g. Growth Marketer" onChange={(e) => setTitle(e.target.value)} /></label>
      </div>
      <label className="text-2xs text-text-muted">Type
        <select className={field} value={kind} onChange={(e) => setKind(e.target.value as 'engineer' | 'reviewer')}>
          <option value="reviewer">Specialist — read-only: investigates, writes, reviews</option>
          <option value="engineer">Engineer — may change code, runs tests, commits</option>
        </select>
      </label>
      <label className="text-2xs text-text-muted">Their brief (what they're great at, what to focus on)
        <textarea className={`${field} min-h-[90px]`} value={brief} placeholder="e.g. You write punchy App Store copy and A/B-test headlines. Keep it short and specific." onChange={(e) => setBrief(e.target.value)} />
      </label>
      <div className="text-2xs text-text-muted">Look</div>
      <div className="flex flex-wrap items-center gap-6">
        {[0, 1, 2, 3, 4, 5].map((p) => (
          <button key={p} onClick={() => setPalette(p)} className="border-2 cursor-pointer bg-transparent p-2" style={{ borderColor: p === palette ? 'var(--color-accent-bright)' : 'var(--color-border)' }}>
            <CharacterMugShot palette={p} hueShift={hue} size={32} />
          </button>
        ))}
        <label className="text-2xs text-text-muted flex items-center gap-4">colour
          <input type="range" min={0} max={359} value={hue} onChange={(e) => setHue(Number(e.target.value))} />
        </label>
      </div>
      <Button size="sm" variant="accent" disabled={busy || !name || !title} onClick={hire}>{busy ? 'Hiring…' : `Hire ${name || ''}`}</Button>
      {err && <div className="text-2xs" style={{ color: 'var(--color-danger)' }}>{err}</div>}
    </div>
  );
}

function IntegrationCard({ item, onSaved }: { item: SmIntegration; onSaved: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fixUrl, setFixUrl] = useState<string | null>(null); // where the owner fixes a one-time provider setting
  const dirty = Object.values(vals).some((v) => v.trim());
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(null);
    try { await fn(); setVals({}); onSaved(done); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // Click-to-sign-in: open the provider's consent page; the callback tab tells us when it is done.
  const signIn = async () => {
    setBusy(true); setErr(null); setFixUrl(null);
    // Open the tab inside the click (browsers block pop-ups opened after an await), then point it at the consent page.
    // If the browser blocks the pop-up anyway, sign in in this same tab and come back after.
    // The Mac app (AI Office.app) has no pop-ups: it hands real web links to the browser, so open the consent page itself.
    const inApp = /\bAIOffice\//.test(navigator.userAgent);
    const w = inApp ? null : window.open('about:blank', '_blank');
    try {
      const { url } = await smClient.integrations.oauthStart(item.id);
      if (inApp) window.open(url, '_blank');
      else if (w) w.location.href = url;
      else { sessionStorage.setItem('smReturn', window.location.href); window.location.href = url; }
      // The office app opens Google in your browser, where this page can't hear back: watch for the saved token instead.
      setBusy(false);
      setNote('Finish signing in on the Google page that opened (in your browser). This card updates by itself.');
      const done = (e: MessageEvent) => { if (e.data === 'sm-oauth') { window.removeEventListener('message', done); onSaved(`${item.name} signed in.`); } };
      window.addEventListener('message', done);
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = (await smClient.integrations.list()).find((x) => x.id === item.id);
        if (now?.oauth?.signedIn) { window.removeEventListener('message', done); setNote(null); onSaved(`${item.name} signed in.`); return; }
      }
      window.removeEventListener('message', done); setNote(null);
    } catch (e) { w?.close(); setNote(null); setErr((e as Error).message); setFixUrl((e as { fixUrl?: string }).fixUrl ?? null); } finally { setBusy(false); }
  };
  const redirect = `${window.location.origin}/sm/oauth/callback`;
  return (
    <div className="bg-bg-dark border-2 border-border">
      <button className="w-full flex items-center gap-8 p-6 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <PixelLogo id={item.id} size={28} />
        <span className="flex-1 min-w-0">
          <span className="block text-xs">{item.name}</span>
          <span className="block text-2xs text-text-muted">{item.service}</span>
        </span>
        <span className="text-2xs" style={{ color: item.linked ? 'var(--color-status-success)' : 'var(--color-text-muted)' }}>{item.linked ? 'LINKED' : 'NOT LINKED'}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 pt-6 border-t-2 border-border flex flex-col gap-6">
          <div className="text-2xs text-text-muted">{item.does}</div>
          {item.oauth && (
            <div className="flex flex-col gap-4 p-6 border-2 border-border">
              <Button size="sm" variant="accent" disabled={busy || !item.oauth.ready} onClick={signIn}>
                {item.oauth.signedIn ? `Sign in again with ${item.service.split(' ')[0]}` : `Sign in with ${item.service.split(' ')[0]}`}
              </Button>
              <div className="text-2xs text-text-muted">
                {item.oauth.viaFirebase
                  ? 'Uses the Google sign-in of your Firebase project. One click, no codes to paste.'
                  : item.oauth.ready
                  ? 'One click, no codes to paste.'
                  : <>One-time: create an OAuth app at {item.docs}, set its redirect URL to <b>{redirect}</b>, paste its client ID and secret below and Save. After that it is just a click.</>}
              </div>
            </div>
          )}
          {!item.oauth && <div className="text-2xs text-text-muted">This one has no sign-in button: get the keys at {item.docs}</div>}
          {!item.oauth?.viaFirebase && item.fields.map((x) => (
            <label key={x.key} className="text-2xs text-text-muted">{x.label}
              <input className={field} type={x.secret ? 'password' : 'text'} autoComplete="off" value={vals[x.key] ?? ''}
                placeholder={x.set ? (x.secret ? `${x.value} (saved — type to replace)` : x.value) : ''}
                onChange={(e) => setVals((v) => ({ ...v, [x.key]: e.target.value }))} />
            </label>
          ))}
          {note && <div className="text-2xs text-text-muted">{note}</div>}
          {err && <div className="text-2xs" style={{ color: 'var(--color-status-error)' }}>{err}</div>}
          {fixUrl && <a className="text-2xs" href={fixUrl} target="_blank" rel="noopener noreferrer">Open my Google app settings →</a>}
          {(!item.oauth?.viaFirebase || item.linked) && <div className="flex gap-6">
            <Button size="sm" disabled={busy || !dirty} onClick={() => run(() => smClient.integrations.save(item.id, vals), `${item.name} saved.`)}>Save</Button>
            {item.fields.some((x) => x.set) && <Button size="sm" disabled={busy} onClick={() => run(() => smClient.integrations.clear(item.id), `${item.name} unlinked.`)}>Unlink</Button>}
          </div>}
        </div>
      )}
    </div>
  );
}

/** Firebase backup of the linked animals' keys: paste the service-account key once, then back up / restore with a passphrase. */
function FirebaseCard({ onSaved }: { onSaved: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<{ linked: boolean; projectId: string | null } | null>(null);
  const [key, setKey] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => smClient.firebase.status().then(setSt).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr(null);
    try { await fn(); setKey(''); await load(); onSaved(done); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const passOk = pass.length >= 8;
  return (
    <div className="bg-bg-dark border-2 border-border">
      <button className="w-full flex items-center gap-8 p-6 bg-transparent border-0 cursor-pointer text-left text-text" onClick={() => setOpen((o) => !o)}>
        <span className="flex-1 min-w-0">
          <span className="block text-xs">Firebase backup</span>
          <span className="block text-2xs text-text-muted">Encrypted copy of your linked services, for a new machine or reinstall</span>
        </span>
        <span className="text-2xs" style={{ color: st?.linked ? 'var(--color-status-success)' : 'var(--color-text-muted)' }}>{st?.linked ? `LINKED · ${st.projectId}` : 'NOT LINKED'}</span>
      </button>
      {open && (
        <div className="px-8 pb-8 pt-6 border-t-2 border-border flex flex-col gap-6">
          {!st?.linked && (
            <label className="text-2xs text-text-muted">Service-account key (Firebase console, Project settings, Service accounts, Generate new private key: paste the file contents)
              <textarea className={field} rows={4} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
          )}
          {st?.linked && (
            <label className="text-2xs text-text-muted">Backup passphrase (8+ characters, remember it: it is never stored)
              <input className={field} type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
          )}
          {err && <div className="text-2xs" style={{ color: 'var(--color-status-error)' }}>{err}</div>}
          <div className="flex gap-6">
            {!st?.linked && <Button size="sm" disabled={busy || !key.trim()} onClick={() => run(() => smClient.firebase.link(key), 'Firebase linked.')}>Link</Button>}
            {st?.linked && <Button size="sm" variant="accent" disabled={busy || !passOk} onClick={() => run(() => smClient.firebase.push(pass), 'Backed up to Firebase.')}>Back up now</Button>}
            {st?.linked && <Button size="sm" disabled={busy || !passOk} onClick={() => run(() => smClient.firebase.pull(pass), 'Restored from Firebase.')}>Restore</Button>}
            {st?.linked && <Button size="sm" disabled={busy} onClick={() => run(() => smClient.firebase.unlink(), 'Firebase unlinked.')}>Unlink</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

export function ZooIntegrations({ onSaved }: { onSaved: (m: string) => void }) {
  const [items, setItems] = useState<SmIntegration[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const load = () => smClient.integrations.list().then(setItems).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);
  return (
    <div>
      <div className="text-xs mb-4" style={{ color: 'var(--color-accent-bright)' }}>THE ANIMALS ({items.length}) — {items.filter((i) => i.linked).length} linked</div>
      <div className="text-2xs text-text-muted mb-6">Each animal is one account the crew can use (not an AI). Link one and any worker can send a file, message or invite through it.</div>
      {err && <div className="text-2xs" style={{ color: 'var(--color-status-error)' }}>{err}</div>}
      <div className="flex flex-col gap-6">
        {items.map((i) => <IntegrationCard key={i.id} item={i} onSaved={(m) => { onSaved(m); void load(); }} />)}
        <FirebaseCard onSaved={(m) => { onSaved(m); void load(); }} />
      </div>
    </div>
  );
}

export function SmRoom({ sm, roomLabel, onClose }: { sm: SuccessManager; roomLabel: string | null; onClose: () => void }) {
  const rooms = sm.state?.staff.rooms ?? [];
  const room = rooms.find((r) => r.label === roomLabel);
  const [prompt, setPrompt] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setPrompt(room?.prompt ?? ''); setMsg(null); }, [room?.id, room?.prompt]);
  if (!room || !sm.state) return null;
  if (room.id === 'game') return <SmGameRoom onClose={onClose} />;
  const people = sm.state.staff.staff.filter((s) => s.room === room.id);
  const savePrompt = async () => {
    try { await smClient.staff.saveRoom(room.id, prompt); setMsg('Department brief saved — everyone here uses it from their next job.'); void sm.refresh(); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Modal isOpen onClose={onClose} title={room.label === room.department ? room.label : `${room.label} · ${room.department}`} zIndex={63} className="w-[640px]">
      <div className="px-10 pb-8 flex flex-col gap-10 text-text">
        <label className="text-2xs text-text-muted">Department brief — part of the prompt for everyone who works here
          <textarea className={`${field} min-h-[90px]`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <Button size="sm" disabled={prompt === room.prompt} onClick={savePrompt}>Save department brief</Button>

        <div>
          <div className="text-xs mb-4" style={{ color: 'var(--color-accent-bright)' }}>WHO WORKS HERE ({people.length})</div>
          <div className="flex flex-col gap-6">
            {people.length ? people.map((p) => <PersonCard key={p.id} sm={sm} person={p} rooms={rooms} onSaved={setMsg} />)
              : <div className="text-2xs text-text-muted">Nobody yet.</div>}
          </div>
        </div>

        {room.id === 'zoo' && <ZooIntegrations onSaved={setMsg} />}
        {room.hire && !room.restricted && <HireForm sm={sm} room={room} onHired={setMsg} />}
        {room.restricted && <div className="text-2xs text-text-muted">Management only — engineers and specialists can't be hired or moved in here.</div>}
        {msg && <div className="text-2xs" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      </div>
    </Modal>
  );
}

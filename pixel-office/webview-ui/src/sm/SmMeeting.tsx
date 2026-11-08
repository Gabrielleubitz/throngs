/**
 * Conference-room meetings. When a video is done the conference room calls the owner (ringing banner,
 * crew walk in and sit down — see meeting.ts). Clicking Join zooms into the meeting: the Floor Manager
 * explains what the team did (avatar + bubble), then the video plays on the 3D room's wall monitor (or flat) with
 * Start / Pause / Stop. The owner can leave Notes (held) or Questions (sent now); Eject ends the meeting and starts the notes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { Button } from '../components/ui/Button.js';
import { CREW_BY_ID } from './crew.js';
import { briefing, liveMeeting } from './meeting.js';
import { MeetingRoom3D } from './MeetingRoom3D.js';
import { smClient, type SmMeeting } from './smClient.js';
import { playRing } from './smSounds.js';
import type { SuccessManager } from './useSuccessManager.js';
import { initVoiceOut, speak, stopSpeaking } from './voiceOut.js';

const RING_EVERY_MS = 5000;
const MAX_RINGS = 12;
const LINE_MS = 4200;

const nameOf = (id: string | null) => (id && CREW_BY_ID.get(id)?.name) || (id ? id.toUpperCase() : 'The team');

function fmt(sec: number) { const s = Math.floor(sec || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

/** Video + transport. The <video> element is owned by the room so the 3D monitor can use it as a texture. */
function Controls({ video, ready }: { video: HTMLVideoElement | null; ready: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState({ t: 0, d: 0 });
  useEffect(() => {
    if (!video) return;
    const upd = () => setPos({ t: video.currentTime, d: video.duration || 0 });
    const on = () => setPlaying(true), off = () => setPlaying(false);
    video.addEventListener('timeupdate', upd); video.addEventListener('loadedmetadata', upd);
    video.addEventListener('play', on); video.addEventListener('pause', off); video.addEventListener('ended', off);
    upd();
    return () => { video.removeEventListener('timeupdate', upd); video.removeEventListener('loadedmetadata', upd); video.removeEventListener('play', on); video.removeEventListener('pause', off); video.removeEventListener('ended', off); };
  }, [video]);
  const stop = () => { if (!video) return; video.pause(); video.currentTime = 0; };
  const seek = (e: React.MouseEvent<HTMLDivElement>) => { if (!video || !pos.d) return; const r = e.currentTarget.getBoundingClientRect(); video.currentTime = ((e.clientX - r.left) / r.width) * pos.d; };
  return (
    <div className="flex flex-col gap-4">
      <div className="h-[10px] bg-bg-dark border border-border cursor-pointer" onClick={seek}>
        <div className="h-full" style={{ width: `${pos.d ? (pos.t / pos.d) * 100 : 0}%`, background: 'var(--color-accent-bright)' }} />
      </div>
      <div className="flex items-center gap-6">
        <Button variant="accent" disabled={!ready || playing} onClick={() => void video?.play()}>▶ Start</Button>
        <Button disabled={!ready || !playing} onClick={() => video?.pause()}>⏸ Pause</Button>
        <Button disabled={!ready} onClick={stop}>⏹ Stop</Button>
        <span className="text-xs text-text-muted ml-auto">{fmt(pos.t)} / {fmt(pos.d)}</span>
      </div>
    </div>
  );
}

const noteWord = { note: 'Note', question: 'Question' } as const;

/** Owner's comments: a clear Notes | Questions switch. Notes wait for Eject; questions go to ARES now. */
function Comments({ sm, meeting }: { sm: SuccessManager; meeting: SmMeeting }) {
  const [kind, setKind] = useState<'note' | 'question'>('note');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = meeting.notes ?? [];
  const held = list.filter((n) => n.kind === 'note' && !n.sent).length;
  const send = async () => {
    if (!sm.project || !text.trim() || busy) return;
    setBusy(true); setErr(null);
    try { await smClient.meeting.comment(sm.project, meeting.id, kind, text.trim()); setText(''); await sm.refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const tab = (k: 'note' | 'question', label: string) => (
    <button onClick={() => setKind(k)} data-testid={`sm-meeting-kind-${k}`} className="flex-1 cursor-pointer border-2 py-4 text-sm"
      style={{ borderColor: kind === k ? 'var(--color-accent-bright)' : 'var(--color-border)', background: kind === k ? 'var(--color-accent-bright)' : 'transparent', color: kind === k ? 'var(--color-bg)' : 'inherit' }}>{label}</button>
  );
  return (
    <div className="flex flex-col gap-4 border-2 border-border bg-bg-dark p-6" data-testid="sm-meeting-comments">
      <div className="flex gap-2">{tab('note', '📝 Notes for edits')}{tab('question', '❓ Ask a question')}</div>
      <div className="text-2xs text-text-muted">
        {kind === 'note' ? 'Held, nothing starts. ARES works through your list when you eject the video.' : 'Sent to ARES right now; he answers without changing anything.'}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} data-testid="sm-meeting-text"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
        placeholder={kind === 'note' ? 'e.g. cut the first 2 seconds, bigger logo…' : 'e.g. why is it only 5 seconds?'}
        className="bg-bg border-2 border-border p-4 text-sm text-text resize-y" />
      <Button variant="accent" disabled={!text.trim() || busy} onClick={() => void send()} data-testid="sm-meeting-add">
        {kind === 'note' ? 'Add to the list' : 'Ask ARES now'}
      </Button>
      {err && <div className="text-xs" style={{ color: 'var(--color-danger)' }}>{err}</div>}
      {list.length > 0 && (
        <div className="flex flex-col gap-2 max-h-[180px] overflow-y-auto" data-testid="sm-meeting-list">
          <div className="text-2xs text-text-muted">{held} held for eject · {list.length - held} sent</div>
          {list.map((n) => (
            <div key={n.id} className="flex gap-3 text-xs border border-border p-3 items-start">
              <span style={{ color: n.kind === 'note' ? 'var(--color-sm-gold)' : 'var(--color-accent-bright)' }}>{n.kind === 'note' ? '📝' : '❓'}</span>
              <span className="flex-1 break-words">{n.text}</span>
              <span className="text-2xs text-text-muted shrink-0">{n.sent ? (n.kind === 'question' ? 'sent' : 'started') : 'held'}</span>
              {!n.sent && sm.project && <button className="cursor-pointer bg-transparent border-0 text-text-muted" title={`Remove ${noteWord[n.kind]}`}
                onClick={() => void smClient.meeting.dropNote(sm.project as string, meeting.id, n.id).then(() => sm.refresh())}>✕</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MeetingRoom({ sm, meeting, onEnd }: { sm: SuccessManager; meeting: SmMeeting; onEnd: () => void }) {
  const lines = briefing(meeting, nameOf);
  const [shown, setShown] = useState(1);
  const done = shown >= lines.length;
  const [view, setView] = useState<'3d' | 'flat'>('3d');
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const project = sm.project;
  useEffect(() => { void initVoiceOut(); }, []);
  useEffect(() => { speak(lines[shown - 1] ?? ''); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => stopSpeaking, []);
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setShown((n) => n + 1), LINE_MS);
    return () => clearTimeout(t);
  }, [shown, done]);
  useEffect(() => {
    if ((!meeting.video && !meeting.pdf) || !project) return;
    let u: string | null = null;
    let alive = true;
    (meeting.video ? smClient.meeting.video : smClient.meeting.pdf)(project, meeting.id).then((x) => { u = x; if (alive) setUrl(x); else URL.revokeObjectURL(x); }).catch((e: Error) => alive && setErr(e.message));
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [project, meeting.id, meeting.video, meeting.pdf]);
  const crew = (sm.state?.staff.staff ?? []).filter((s) => s.id !== meeting.host);
  const all = useMemo(() => (sm.state?.staff.staff ?? []).map((s) => ({ id: s.id, name: s.name })), [sm.state?.staff.staff]);
  const host = CREW_BY_ID.get(meeting.host);
  const held = (meeting.notes ?? []).filter((n) => n.kind === 'note' && !n.sent).length;
  const reveal = () => { if (project) smClient.meeting.reveal(project, meeting.id).then((r) => setNote(r.opened ? 'Opened in Finder' : r.path)).catch((e: Error) => setNote(e.message)); };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-8 bg-black/80" data-testid="sm-meeting">
      <div className="sm-meeting-zoom pointer-events-auto bg-bg border-2 border-border shadow-pixel w-[min(1280px,100%)] h-[min(820px,100%)] flex flex-col">
        <div className="flex items-center gap-6 border-b-2 border-border px-8 py-5 bg-bg-dark">
          <span className="text-xl text-accent-bright truncate">📞 Conference Room · {meeting.title}</span>
          <div className="ml-auto flex items-center gap-4">
            {note && <span className="text-2xs text-text-muted max-w-[260px] truncate">{note}</span>}
            {(meeting.video || meeting.pdf) && <Button size="sm" onClick={reveal} data-testid="sm-meeting-reveal">📂 Show in folder</Button>}
            {meeting.video && <Button size="sm" onClick={() => setView(view === '3d' ? 'flat' : '3d')} data-testid="sm-meeting-view">{view === '3d' ? '🖥 Flat view' : '🏢 3D room'}</Button>}
            <Button onClick={onEnd} data-testid="sm-meeting-end" style={{ color: 'var(--color-danger)' }}>
              ⏏ Eject{held > 0 ? ` · start ${held} note${held > 1 ? 's' : ''}` : ''}
            </Button>
          </div>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 flex flex-col gap-5 p-6">
            <div className="flex-1 min-h-0 border-2 border-border bg-black relative overflow-hidden">
              {meeting.pdf && !meeting.video && (
                <iframe src={url ?? undefined} title={meeting.title} data-testid="sm-meeting-pdf" className="block w-full h-full bg-white border-0" />
              )}
              {view === '3d' && !(meeting.pdf && !meeting.video) && <MeetingRoom3D video={meeting.video ? el : null} crew={all} host={meeting.host} by={meeting.by} title={meeting.title} talking={!done} />}
              {meeting.video && (
                <video ref={setEl} src={url ?? undefined} data-testid="sm-meeting-video" playsInline loop={false}
                  className={view === 'flat' ? 'block w-full h-full object-contain' : 'absolute w-px h-px opacity-0 pointer-events-none'} />
              )}
              {view === '3d' && meeting.video && !url && !err && <span className="absolute bottom-3 left-4 text-xs text-text-muted">Loading the video…</span>}
              {err && <span className="absolute bottom-3 left-4 text-xs" style={{ color: 'var(--color-danger)' }}>Couldn&apos;t load the video: {err}</span>}
              <span className="absolute top-3 left-4 text-2xs text-text-muted">{crew.length + 1} in the room</span>
            </div>
            {meeting.video && <Controls video={el} ready={!!url} />}
          </div>
          <div className="w-[360px] shrink-0 border-l-2 border-border flex flex-col gap-5 p-6 overflow-y-auto">
            <div className="flex gap-4 items-start">
              <div className="border-2 shrink-0 bg-bg-dark" style={{ borderColor: 'var(--color-sm-gold)' }}>
                {host && <CharacterMugShot palette={host.palette} hueShift={host.hueShift} tune={host.tune} look={host.look} size={64} />}
              </div>
              <div className="flex flex-col gap-3 min-w-0 flex-1">
                <span className="text-sm" style={{ color: 'var(--color-sm-gold)' }}>{nameOf(meeting.host)} <span className="text-2xs text-text-muted">· running it</span></span>
                {lines.slice(0, shown).slice(-2).map((l, i, arr) => (
                  <div key={`${shown}-${i}`} className="relative border-2 border-border p-5 text-sm" style={{ background: 'var(--color-sm-bubble-bg)', color: 'var(--color-sm-bubble-text)', opacity: i === arr.length - 1 ? 1 : 0.55 }}>
                    {l}
                  </div>
                ))}
                {!done && <Button size="sm" variant="ghost" onClick={() => setShown(lines.length)}>{meeting.video ? 'Skip to the video ⏭' : meeting.pdf ? 'Skip ⏭' : 'Show all ⏭'}</Button>}
              </div>
            </div>
            <Comments sm={sm} meeting={meeting} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Ringing call banner + the meeting itself. Mounted once at the top level of the office. */
export function SmMeeting({ sm }: { sm: SuccessManager }) {
  const meeting = liveMeeting(sm.state?.meetings);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rings = useRef(new Map<string, number>());
  const open = meeting && openId === meeting.id ? meeting : null;

  useEffect(() => {
    if (!meeting || meeting.status !== 'calling' || open) return;
    const ring = () => {
      const n = rings.current.get(meeting.id) ?? 0;
      if (n >= MAX_RINGS) return;
      rings.current.set(meeting.id, n + 1);
      playRing();
    };
    ring();
    const t = setInterval(ring, RING_EVERY_MS);
    return () => clearInterval(t);
  }, [meeting?.id, meeting?.status, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!meeting || !sm.project) return null;
  const project = sm.project;
  const join = () => {
    setOpenId(meeting.id);
    if (meeting.status === 'calling') smClient.meeting.join(project, meeting.id).then(() => sm.refresh()).catch((e: Error) => setError(e.message));
  };
  const end = () => {
    smClient.meeting.end(project, meeting.id).then(() => { setOpenId(null); return sm.refresh(); }).catch((e: Error) => setError(e.message));
  };
  if (open) return <MeetingRoom sm={sm} meeting={open} onEnd={end} />;
  return (
    <div className="fixed top-10 left-1/2 -translate-x-1/2 z-[70] sm-meeting-ring" data-testid="sm-meeting-call">
      <button onClick={join} className="bg-bg border-2 border-border shadow-pixel px-10 py-6 text-left cursor-pointer flex flex-col gap-2">
        <span className="text-lg" style={{ color: 'var(--color-sm-gold)' }}>
          📞 {meeting.status === 'calling' ? 'The Conference Room is calling you' : 'Your meeting is still going'}
        </span>
        <span className="text-sm">{meeting.title} — the crew is sitting down. <u>Click to join</u></span>
        {error && <span className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
      </button>
    </div>
  );
}

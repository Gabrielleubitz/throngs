/**
 * The owner's Google Calendar inside the office (IVY's desk → CALENDAR, or the 📅 spot in Reception): a week agenda
 * across their calendars with Meet links, and a form for a new meeting (Google Meet link; Google emails the guests).
 * Data: /sm/calendar, /sm/calendar/meet (bin/google.js).
 */
import { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { type SmCalEvent,smClient } from './smClient.js';

const INPUT = 'flex-1 min-w-0 bg-bg border-2 border-border text-text text-2xs p-4 font-pixel outline-none focus:border-accent';
const DAY_MS = 86400000;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }; // Sunday-first (Israel)
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');

function NewMeeting({ onDone }: { onDone: (msg: string) => void }) {
  const [title, setTitle] = useState('');
  const [guests, setGuests] = useState('');
  const [date, setDate] = useState(() => { const t = new Date(Date.now() + DAY_MS); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; });
  const [time, setTime] = useState('10:00');
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await smClient.newMeeting({ title: title || 'Meeting', start: new Date(`${date}T${time}`).toISOString(), minutes, attendees: guests });
      onDone(guests.trim() ? `Invite sent with the Meet link${r.meet ? ` (${r.meet.replace('https://', '')})` : ''}.` : `On your calendar${r.meet ? ` with ${r.meet.replace('https://', '')}` : ''}.`);
      setTitle(''); setGuests('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="bg-bg-dark border-2 border-border p-6 mb-8">
      <div className="text-2xs mb-4" style={{ color: 'var(--color-accent-bright)' }}>NEW GOOGLE MEET</div>
      <div className="flex gap-4 mb-4"><input className={INPUT} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="flex gap-4 mb-4"><input className={INPUT} placeholder="Guests' emails (comma separated) — they get the invite" value={guests} onChange={(e) => setGuests(e.target.value)} /></div>
      <div className="flex gap-4 items-center">
        <input type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" className={INPUT} value={time} onChange={(e) => setTime(e.target.value)} />
        <select className={INPUT} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
        </select>
        <Button size="sm" variant="accent" disabled={busy || !date || !time} onClick={() => void go()}>{busy ? 'Creating…' : guests.trim() ? 'Send invite' : 'Add'}</Button>
      </div>
      {err && <div className="text-2xs mt-2" style={{ color: 'var(--color-danger)' }}>{err}</div>}
    </div>
  );
}

function EventRow({ e, now }: { e: SmCalEvent; now: number }) {
  const past = Date.parse(e.end || e.start) < now;
  return (
    <div className="flex gap-6 items-start bg-bg-dark border-2 border-border p-6 mb-4" style={{ opacity: past ? 0.5 : 1 }}>
      <span className="text-2xs" style={{ minWidth: 86, color: 'var(--color-text-muted)' }}>{e.allDay ? 'all day' : `${hm(e.start)}–${hm(e.end)}`}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-xs"><span style={{ color: e.color || 'var(--color-accent-bright)' }}>●</span> {e.title}</span>
        {(e.location || e.attendees.length > 0 || !e.primary) && (
          <span className="block text-2xs text-text-muted">
            {[!e.primary ? e.calendar : '', e.location, e.attendees.length ? `with ${e.attendees.slice(0, 3).map((a) => a.name || a.email).join(', ')}${e.attendees.length > 3 ? ` +${e.attendees.length - 3}` : ''}` : ''].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      {e.meet && !past && <Button size="sm" variant="accent" onClick={() => window.open(e.meet, '_blank')}>Join</Button>}
      {e.link && <Button size="sm" variant="ghost" onClick={() => window.open(e.link, '_blank')} title="Open in Google Calendar">↗</Button>}
    </div>
  );
}

export function SmCalendar() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [events, setEvents] = useState<SmCalEvent[] | null>(null);
  const [msg, setMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(0);
  const load = useCallback(() => {
    setEvents(null);
    setNow(Date.now());
    return smClient.calendar(week.toISOString(), new Date(week.getTime() + 7 * DAY_MS).toISOString()).then(setEvents).catch((e: Error) => { setEvents([]); setMsg(e.message); });
  }, [week]);
  useEffect(() => { void load(); }, [load]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(week.getTime() + i * DAY_MS));
  const today = dayKey(new Date());
  const byDay = (d: Date) => (events ?? []).filter((e) => dayKey(new Date(e.allDay ? `${e.start}T00:00` : e.start)) === dayKey(d));
  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Button size="sm" variant="ghost" onClick={() => setWeek(new Date(week.getTime() - 7 * DAY_MS))}>◀</Button>
        <span className="text-xs flex-1 text-center">{week.toLocaleDateString([], { day: 'numeric', month: 'short' })} – {new Date(week.getTime() + 6 * DAY_MS).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        <Button size="sm" variant="ghost" onClick={() => setWeek(new Date(week.getTime() + 7 * DAY_MS))}>▶</Button>
        <Button size="sm" onClick={() => setWeek(startOfWeek(new Date()))}>Today</Button>
        <Button size="sm" variant="accent" onClick={() => setAdding(!adding)}>{adding ? 'Close' : '+ Meet'}</Button>
      </div>
      {adding && <NewMeeting onDone={(m) => { setMsg(m); setAdding(false); void load(); }} />}
      {msg && <div className="text-2xs mb-6" style={{ color: 'var(--color-status-success)' }}>{msg}</div>}
      {events === null && <div className="text-2xs text-text-muted">Reading your calendar…</div>}
      {events !== null && days.map((d) => {
        const list = byDay(d);
        const isToday = dayKey(d) === today;
        return (
          <div key={dayKey(d)} className="mb-6">
            <div className="text-2xs mb-2" style={{ color: isToday ? 'var(--color-accent-bright)' : 'var(--color-text-muted)' }}>
              {d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }).toUpperCase()}{isToday ? ' · TODAY' : ''}
            </div>
            {list.length ? list.map((e) => <EventRow key={`${e.calendar}:${e.id}`} e={e} now={now} />) : <div className="text-2xs text-text-muted mb-2">—</div>}
          </div>
        );
      })}
      <div className="text-2xs text-text-muted mt-4">Ivy sees this too: ask her "what's on my calendar" or "send Dana a Meet link for Tuesday at 3".</div>
    </div>
  );
}

'use strict';
/**
 * IVY's hands in the owner's Google account (the Zoo's "google" integration; granted scopes: Gmail, Calendar,
 * Contacts, Drive). Read: calendar events across the owner's calendars, contacts search. Write: a meeting with a
 * Google Meet link on the primary calendar (Google emails the invitation to every guest), and plain emails via Gmail.
 * Nothing here decides to write on its own: IVY confirms every send with the owner first (bin/ares-chat.js).
 * The access token is cached in memory and never logged.
 */
const crypto = require('crypto');

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;

function createGoogle(integrations, { fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  let tok = null; // { value, until }
  const linked = () => { try { const g = integrations.get('google'); return !!(g && g.refresh_token && g.client_id); } catch { return false; } };
  async function token() {
    if (tok && tok.until > now() + 60000) return tok.value;
    const g = integrations.get('google'); if (!g?.refresh_token) throw bad('Google is not linked (Zoo → Google).', 503);
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, grant_type: 'refresh_token' }) });
    const j = await r.json(); if (!r.ok || !j.access_token) throw bad(`Google sign-in failed: ${j.error_description || j.error || r.status}`, 502);
    tok = { value: j.access_token, until: now() + (j.expires_in || 3000) * 1000 }; return tok.value;
  }
  async function call(url, { method = 'GET', body } = {}) {
    const r = await fetchFn(url, { method, headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw bad(`Google said ${r.status}: ${j.error?.message || 'error'}`, r.status === 401 || r.status === 403 ? 502 : 400);
    return j;
  }
  const CAL = 'https://www.googleapis.com/calendar/v3';

  /** Events between two times across the owner's calendars (owned/writer/reader), sorted. */
  async function events({ from, to, max = 250 } = {}) {
    const timeMin = new Date(from || now()).toISOString(); const timeMax = new Date(to || now() + 14 * 86400000).toISOString();
    const cals = ((await call(`${CAL}/users/me/calendarList?maxResults=50`)).items || []).filter((c) => !c.hidden && c.selected !== false && c.accessRole !== 'freeBusyReader');
    const lists = await Promise.all(cals.map(async (c) => {
      try {
        const j = await call(`${CAL}/calendars/${encodeURIComponent(c.id)}/events?singleEvents=true&orderBy=startTime&maxResults=${max}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`);
        return (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
          id: e.id, calendar: c.primary ? 'primary' : c.summary, color: c.backgroundColor || '', primary: !!c.primary,
          title: String(e.summary || '(no title)').slice(0, 140), start: e.start?.dateTime || e.start?.date || '', end: e.end?.dateTime || e.end?.date || '',
          allDay: !e.start?.dateTime, location: String(e.location || '').slice(0, 140), meet: e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || '',
          attendees: (e.attendees || []).filter((a) => !a.self).map((a) => ({ email: a.email, name: a.displayName || '', status: a.responseStatus })).slice(0, 20),
          link: e.htmlLink || '',
        }));
      } catch { return []; }
    }));
    return lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  /** Free/busy for the owner in a window: [{start,end}] busy blocks (to warn about clashes). */
  async function busy(from, to) {
    const j = await call(`${CAL}/freeBusy`, { method: 'POST', body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: 'primary' }] } });
    return j.calendars?.primary?.busy || [];
  }

  /**
   * A meeting with a Google Meet link on the primary calendar. Google emails the invitation (with the Meet link and
   * accept buttons) to every guest when notify is true. Returns { id, meet, link, start, end, attendees }.
   */
  async function createMeeting({ title, start, minutes = 30, attendees = [], description = '', notify = true }) {
    const t = String(title || '').trim() || 'Meeting'; const s = Date.parse(start);
    if (Number.isNaN(s)) throw bad('When should it be? Give a date and time.');
    if (s < now() - 5 * 60000) throw bad('That time has already passed.');
    const m = Math.max(5, Math.min(480, Number(minutes) || 30));
    const guests = [...new Set((attendees || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
    const badOnes = guests.filter((a) => !EMAIL.test(a)); if (badOnes.length) throw bad(`Not an email address: ${badOnes.join(', ')}`);
    const ev = await call(`${CAL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=${notify && guests.length ? 'all' : 'none'}`, { method: 'POST', body: {
      summary: t.slice(0, 200), description: String(description || '').slice(0, 2000),
      start: { dateTime: new Date(s).toISOString() }, end: { dateTime: new Date(s + m * 60000).toISOString() },
      attendees: guests.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      reminders: { useDefault: true },
    } });
    return { id: ev.id, meet: ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || '', link: ev.htmlLink || '', start: ev.start?.dateTime, end: ev.end?.dateTime, attendees: guests, title: ev.summary };
  }
  const deleteEvent = (id, { notify = false } = {}) => call(`${CAL}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${notify ? 'all' : 'none'}`, { method: 'DELETE' });

  /** A plain-text email from the owner's Gmail. */
  async function sendMail({ to, subject, text }) {
    const list = [].concat(to || []).map((x) => String(x).trim()).filter(Boolean);
    if (!list.length || list.some((x) => !EMAIL.test(x))) throw bad('Who should I send it to? I need an email address.');
    const enc = (s) => `=?UTF-8?B?${Buffer.from(String(s)).toString('base64')}?=`;
    const mime = [`To: ${list.join(', ')}`, `Subject: ${enc(subject || '(no subject)')}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(text || '')).toString('base64')].join('\r\n');
    const j = await call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw: Buffer.from(mime).toString('base64url') } });
    return { id: j.id, to: list };
  }

  /** Google Contacts (plus "other contacts" the owner emailed): [{ name, email }]. */
  async function findPeople(query) {
    const q = String(query || '').trim(); if (!q) return [];
    const pick = (j) => (j.results || []).map((x) => x.person).filter(Boolean).flatMap((p) => (p.emailAddresses || []).map((e) => ({ name: p.names?.[0]?.displayName || '', email: e.value })));
    const read = 'names,emailAddresses';
    const [a, b] = await Promise.all([
      call(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(q)}&readMask=${read}&pageSize=10`).then(pick).catch(() => []),
      call(`https://people.googleapis.com/v1/otherContacts:search?query=${encodeURIComponent(q)}&readMask=${read}&pageSize=10`).then(pick).catch(() => []),
    ]);
    const seen = new Set(); return [...a, ...b].filter((x) => x.email && !seen.has(x.email.toLowerCase()) && seen.add(x.email.toLowerCase())).slice(0, 8);
  }
  /** A bounce for this address since `sinceMs` (Gmail's "Address not found" from mailer-daemon)? */
  async function bounced(email, sinceMs) {
    const q = `from:mailer-daemon newer_than:1d "${String(email).replace(/"/g, '')}"`;
    const j = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=${encodeURIComponent(q)}`);
    for (const m of j.messages || []) { const x = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=minimal`); if (Number(x.internalDate) >= sinceMs - 60000) return true; }
    return false;
  }
  const me = async () => (await call('https://gmail.googleapis.com/gmail/v1/users/me/profile')).emailAddress;

  return { linked, events, busy, createMeeting, deleteEvent, sendMail, findPeople, bounced, me, EMAIL };
}

module.exports = { createGoogle, EMAIL };

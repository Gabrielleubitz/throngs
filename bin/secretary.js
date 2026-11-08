'use strict';
/**
 * The secretary's desk (IVY): assignable office tasks, a knowledge store she answers calls from, a "missed while you
 * were away" checklist, a callback queue, caller recognition and a call-summary digest. Data: office/secretary.json.
 * Live facts (calls, missions, owner questions) come in through `deps` so this module owns no engine state.
 * deps: { calls(): call records (bin/call-log.js shape, newest first), missions(): [{project,id,prompt,status,report,updatedAt}],
 *         questions(): [{missionId,title,ask}], sendText(text): Promise, handOff(project|null, prompt): {project,id} (files an
 *         ARES mission), now() }
 */
const fs = require('fs');
const path = require('path');

const e164 = (s) => { const d = String(s || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, ''); return d ? (d.startsWith('+') ? d : `+${d}`) : ''; };
const clip = (s, n) => String(s || '').trim().slice(0, n);
const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const WINDOW_MS = 7 * 86400000;
const NOTE_KINDS = ['schedule', 'fact'];
const OPEN_STATUS = ['queued', 'planning', 'working', 'reviewing', 'paused', 'waiting_human', 'stalled'];

function createSecretary(root, deps = {}) {
  const file = path.join(root, 'office', 'secretary.json');
  const now = deps.now || (() => Date.now());
  const empty = () => ({ tasks: [], notes: [], contacts: [], ticked: {}, awaySince: null, digestAt: null, reminders: [], briefTime: '08:30', briefOn: true, briefDate: null });
  const read = () => { try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return empty(); } };
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.tmp`; fs.writeFileSync(t, JSON.stringify(d, null, 2) + '\n'); fs.renameSync(t, file); return d; };
  const iso = () => new Date(now()).toISOString();

  // The HTTP routes pass the request body ({ id, done }); the CLI/tests pass (id, …). Accept both.
  const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

  // ---- office tasks the owner hands her ----
  // By default she passes the task on to ARES as a mission (toAres: false keeps it as a plain reminder on her desk).
  function addTask({ title, detail = '', due = '', project = null, toAres = true } = {}) {
    const t = clip(title, 160); if (!t) throw bad('Say what the task is.');
    const task = { id: uid('t'), title: t, detail: clip(detail, 600), due: clip(due, 40), status: 'open', createdAt: iso(), doneAt: null };
    if (toAres && deps.handOff) {
      const prompt = `For ARES (Floor Manager): the owner asked IVY (the secretary) to pass this on — ${t}${task.detail ? `\n\n${task.detail}` : ''}${task.due ? `\n\nDue: ${task.due}` : ''}`;
      const m = deps.handOff(project ? clip(project, 80) : null, prompt);
      task.mission = { project: m.project, id: m.id };
    }
    const d = read(); d.tasks.push(task); write(d); return task;
  }
  function setTask(id, { done } = {}) {
    if (id && typeof id === 'object') ({ id, done } = id);
    const d = read(); const t = d.tasks.find((x) => x.id === id); if (!t) throw bad('No such task.', 404);
    t.status = done ? 'done' : 'open'; t.doneAt = done ? iso() : null; write(d); return t;
  }
  function removeTask(id) { id = idOf(id); const d = read(); const n = d.tasks.length; d.tasks = d.tasks.filter((x) => x.id !== id); if (d.tasks.length === n) throw bad('No such task.', 404); write(d); return { ok: true }; }

  // ---- knowledge: owner schedule + facts, and contacts ----
  function addNote({ kind = 'fact', text } = {}) {
    const t = clip(text, 500); if (!t) throw bad('Write the note.');
    const d = read(); const note = { id: uid('n'), kind: NOTE_KINDS.includes(kind) ? kind : 'fact', text: t, at: iso() };
    d.notes.push(note); write(d); return note;
  }
  function removeNote(id) { id = idOf(id); const d = read(); d.notes = d.notes.filter((x) => x.id !== id); write(d); return { ok: true }; }
  function addContact({ name, number, note = '' } = {}) {
    const n = clip(name, 80), p = e164(number); if (!n || p.length < 6) throw bad('A contact needs a name and a phone number.');
    const d = read(); const i = d.contacts.findIndex((c) => c.number === p);
    const c = { id: i >= 0 ? d.contacts[i].id : uid('k'), name: n, number: p, note: clip(note, 200), ...(i >= 0 && d.contacts[i].email ? { email: d.contacts[i].email } : {}) };
    if (i >= 0) d.contacts[i] = c; else d.contacts.push(c);
    write(d); return c;
  }
  /** Bulk-add contacts from the WhatsApp assistant's contacts.json ([{fullName, phoneNumber, relationship, metadata.notes}]). Existing numbers keep their id; owner-added notes are kept. */
  function importContacts({ path: src } = {}) {
    const from = src || (deps.contactsFile ? deps.contactsFile() : path.join(root, '..', 'whatsapp-mcp-ai', 'data', 'contacts.json'));
    let list; try { list = JSON.parse(fs.readFileSync(from, 'utf8')); } catch { throw bad(`Could not read contacts from ${from}.`, 404); }
    if (!Array.isArray(list)) throw bad('That file is not a contact list.');
    const d = read(); let added = 0, updated = 0, skipped = 0;
    for (const x of list) {
      const name = clip(x.fullName || x.name, 80), p = e164(x.phoneNumber || x.number);
      if (!name || p.length < 6) { skipped++; continue; }
      const note = clip([x.relationship, x.metadata && x.metadata.notes].filter(Boolean).join(': '), 200);
      const i = d.contacts.findIndex((c) => c.number === p);
      if (i >= 0) { d.contacts[i] = { ...d.contacts[i], name, note: d.contacts[i].note || note }; updated++; } else { d.contacts.push({ id: uid('k'), name, number: p, note }); added++; }
    }
    write(d); return { ok: true, added, updated, skipped, total: d.contacts.length };
  }
  function removeContact(id) { id = idOf(id); const d = read(); d.contacts = d.contacts.filter((x) => x.id !== id); write(d); return { ok: true }; }
  // ---- phone settings: the owner's name, a PIN for calling from other phones (stored hashed), who may be put through ----
  const TRANSFER = ['contacts', 'urgent', 'never'];
  function phoneSettings(b) {
    const d = read(); d.phone = d.phone || {};
    if (b && typeof b === 'object') {
      if (b.ownerName !== undefined) { const n = clip(b.ownerName, 40); if (!n) throw bad('Give a name.'); d.phone.ownerName = n; }
      if (b.pin !== undefined) {
        if (b.pin === '' || b.pin === null) delete d.phone.pinHash;
        else { const p = String(b.pin).replace(/\D/g, ''); if (p.length < 4 || p.length > 8) throw bad('A PIN is 4-8 digits.'); d.phone.pinHash = require('crypto').createHash('sha256').update(`ivy-pin:${p}`).digest('hex'); }
      }
      if (b.voiceModel !== undefined) { if (!['haiku', 'sonnet', 'opus'].includes(b.voiceModel)) throw bad('model is haiku, sonnet or opus.'); d.phone.voiceModel = b.voiceModel; }
      if (b.off !== undefined) d.phone.off = !!b.off;
      if (b.transfer !== undefined) { if (!TRANSFER.includes(b.transfer)) throw bad(`transfer is one of ${TRANSFER.join(', ')}.`); d.phone.transfer = b.transfer; }
      write(d);
    }
    return { ownerName: d.phone.ownerName || '', pinSet: !!d.phone.pinHash, pinHash: d.phone.pinHash || '', transfer: d.phone.transfer || 'contacts', voiceModel: d.phone.voiceModel || 'haiku', off: !!d.phone.off };
  }

  // ---- reminders that actually fire (office server ticks `due()` and sends them) ----
  const VIA = ['whatsapp', 'call'];
  function addReminder({ text, at, via = 'whatsapp' } = {}) {
    const t = clip(text, 300); if (!t) throw bad('What should I remind you about?');
    const when = Date.parse(at || ''); if (Number.isNaN(when)) throw bad('When? Give a date and time.');
    if (when < now() - 60000) throw bad('That time has already passed.');
    const d = read(); const r = { id: uid('r'), text: t, at: new Date(when).toISOString(), via: VIA.includes(via) ? via : 'whatsapp', status: 'pending', createdAt: iso() };
    d.reminders.push(r); d.reminders = d.reminders.filter((x) => x.status === 'pending' || now() - Date.parse(x.at) < 7 * 86400000); write(d); return r;
  }
  const reminders = () => read().reminders.filter((r) => r.status === 'pending').sort((a, b) => a.at.localeCompare(b.at));
  const dueReminders = () => reminders().filter((r) => Date.parse(r.at) <= now());
  function markReminder(id, status = 'sent') { if (id && typeof id === 'object') ({ id, status = 'sent' } = id); const d = read(); const r = d.reminders.find((x) => x.id === id); if (!r) throw bad('No such reminder.', 404); r.status = status; r.doneAt = iso(); write(d); return r; }
  const removeReminder = (id) => markReminder(idOf(id), 'cancelled');

  // ---- the morning brief (WhatsApp, once a day at briefTime) ----
  function briefSettings(b) {
    const d = read();
    if (b && typeof b === 'object') {
      if (b.briefTime !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.briefTime))) throw bad('Use HH:MM, e.g. 08:30.'); d.briefTime = String(b.briefTime); }
      if (b.briefOn !== undefined) d.briefOn = !!b.briefOn;
      write(d);
    }
    return { briefTime: d.briefTime, briefOn: d.briefOn, briefDate: d.briefDate };
  }
  const localDay = (ms) => { const x = new Date(ms); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  /** True once per local day, from briefTime until noon, when the brief is on and not yet sent. */
  function briefDue() {
    const d = read(); if (!d.briefOn) return false;
    const x = new Date(now()); const [h, m] = String(d.briefTime || '08:30').split(':').map(Number);
    const mins = x.getHours() * 60 + x.getMinutes();
    return d.briefDate !== localDay(now()) && mins >= h * 60 + m && mins < 12 * 60;
  }
  const markBriefSent = () => { const d = read(); d.briefDate = localDay(now()); write(d); return { ok: true }; };
  const hhmm = (iso_) => { const x = new Date(iso_); return Number.isNaN(x.getTime()) ? '' : `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
  /**
   * The day at a glance, no AI: calendar today, what needs the owner, code (dev pulse), overnight missions, reminders.
   * extra = { events: [{when,title}], code: [text], yesterday: [{repo, commits}] }. Returns { text, spoken }.
   */
  function morningBrief(extra = {}) {
    const today = localDay(now());
    const x = new Date(now());
    const events = (extra.events || []).filter((e) => String(e.when).slice(0, 10) === today);
    const k = knowledge(); const items = checklist().filter((i) => !i.done);
    const lastDay = (i) => now() - Date.parse(i.at || 0) < 86400000;
    const fin = items.filter((i) => i.kind === 'finished' && lastDay(i)), fail = items.filter((i) => i.kind === 'failed' && lastDay(i));
    const rem = reminders().filter((r) => localDay(Date.parse(r.at)) === today);
    const code = (extra.code || []).slice(0, 5);
    const lines = [`Good morning. ${x.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}.`];
    const sec = (title, rows) => { if (rows.length) lines.push('', `*${title}*`, ...rows.map((r) => `- ${r}`)); };
    sec('Today', [...events.map((e) => `${e.when.length > 10 ? hhmm(e.when) + ' ' : ''}${e.title}`), ...rem.map((r) => `${hhmm(r.at)} reminder: ${r.text}`)]);
    sec('Needs you', k.waitingOnOwner.map((q) => `${q.title}${q.ask ? `: ${clip(q.ask, 100)}` : ''}`));
    sec('Code', code);
    sec('Overnight', [...fail.map((i) => i.title), ...fin.slice(0, 4).map((i) => i.title), ...(fin.length > 4 ? [`and ${fin.length - 4} more finished`] : [])]);
    if ((extra.yesterday || []).length) sec('You shipped yesterday', extra.yesterday.slice(0, 5).map((r) => `${r.repo}: ${clip(r.commits[0], 70)}${r.commits.length > 1 ? ` (+${r.commits.length - 1})` : ''}`));
    if (lines.length === 1) lines.push('', 'Nothing on the calendar, nothing waiting on you, all code pushed and green.');
    const n = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
    const said = [events.length ? `${n(events.length, 'thing')} on your calendar${events[0] ? `, first ${events[0].when.length > 10 ? `at ${hhmm(events[0].when)} ` : ''}${events[0].title}` : ''}` : 'Nothing on your calendar',
      k.waitingOnOwner.length ? `${n(k.waitingOnOwner.length, 'thing')} waiting on you` : '', code.length ? `in code, ${code[0].replace(/\s*\(.*?\)\s*$/, '')}` : '',
      fail.length ? `${n(fail.length, 'mission')} failed overnight` : ''].filter(Boolean);
    return { text: lines.join('\n').slice(0, 1500), spoken: `${said.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('. ')}.` };
  }

  /** People the owner emailed / invited through Ivy: name → email, so next time a name is enough. */
  function rememberEmail({ name, email } = {}) {
    const n = clip(name, 80); const e = String(email || '').trim().toLowerCase();
    if (!n || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return null;
    const d = read(); const key = n.toLowerCase();
    let c = d.contacts.find((x) => x.name.toLowerCase() === key) || d.contacts.find((x) => (x.email || '') === e);
    if (c) { c.email = e; if (!c.name) c.name = n; } else { c = { id: uid('k'), name: n, number: '', email: e, note: 'added by Ivy after an email/invite' }; d.contacts.push(c); }
    write(d); return c;
  }
  /** The address Ivy remembered for a name (full name, then first name). */
  function emailFor(name) {
    const q = String(name || '').trim().toLowerCase(); if (!q) return null;
    const cs = read().contacts.filter((x) => x.email);
    const c = cs.find((x) => x.name.toLowerCase() === q) || cs.find((x) => x.name.toLowerCase().split(' ')[0] === q.split(' ')[0]);
    return c ? { name: c.name, email: c.email } : null;
  }
  const forgetEmail = (email) => { const d = read(); const e = String(email || '').toLowerCase(); let n = 0; for (const c of d.contacts) if (c.email === e) { delete c.email; n++; } d.contacts = d.contacts.filter((c) => c.number || c.email); write(d); return n; };
  /** Who is this number? Used to greet callers by name. */
  function recognise(number) { const p = e164(number); if (!p) return null; const c = read().contacts.find((x) => x.number === p); return c ? { name: c.name, note: c.note } : null; }

  const callList = () => { try { return (deps.calls ? deps.calls({ limit: 200 }) : []) || []; } catch { return []; } };
  const missionList = () => { try { return (deps.missions ? deps.missions() : []) || []; } catch { return []; } };
  const questionList = () => { try { return (deps.questions ? deps.questions() : []) || []; } catch { return []; } };
  const recent = (iso_) => { const t = Date.parse(iso_ || ''); return !Number.isNaN(t) && now() - t < WINDOW_MS; };

  /** Call log view: records with a recognised contact name filled in. */
  function calls(limit = 50) {
    const d = read();
    return callList().slice(0, limit).map((c) => ({ ...c, callerName: c.callerName || d.contacts.find((x) => x.number === e164(c.from))?.name || '' }));
  }

  /** People waiting for a call back: strangers who left a message or hung up on silence, plus failed calls. */
  function callbacks() {
    const d = read();
    return callList().filter((c) => !c.isOwner && c.from && ['message-taken', 'silent', 'error', 'missed', 'voicemail-left'].includes(c.outcome) && recent(c.endedAt || c.at))
      .map((c) => ({ id: `cb:${c.callSid || c.id}`, kind: 'callback', title: `Call back ${d.contacts.find((x) => x.number === e164(c.from))?.name || c.callerName || c.from}`,
        detail: clip((c.messages && c.messages[0]) || c.summary || '', 200), number: c.from, at: c.endedAt || c.at, done: !!d.ticked[`cb:${c.callSid || c.id}`] }));
  }

  /** The "missed while you were away" checklist. Items come from live records; ticks persist. */
  function checklist() {
    const d = read(); const items = []; const tick = (id) => !!d.ticked[id];
    for (const c of callList()) {
      if (!recent(c.endedAt || c.at)) continue;
      const id = `call:${c.callSid || c.id}`;
      const who = d.contacts.find((x) => x.number === e164(c.from))?.name || c.callerName || (c.isOwner ? 'You' : c.from || 'Unknown caller');
      if (c.isOwner && ['no-answer', 'busy', 'voicemail', 'failed'].includes(c.outcome)) { items.push({ id, kind: 'call', title: c.outcome === 'voicemail' ? 'We reached your voicemail' : c.outcome === 'failed' ? 'A call to you failed' : c.outcome === 'busy' ? 'Your line was busy' : 'You missed our call', detail: clip(c.summary || '', 200), at: c.endedAt || c.at, done: tick(id) }); continue; }
      if (c.isOwner) { if (c.outcome === 'request-filed' || c.outcome === 'error') items.push({ id, kind: 'call', title: c.outcome === 'error' ? 'Your last call hit an error' : 'Request you phoned in', detail: clip(c.summary || (c.requests || []).join('; '), 200), at: c.endedAt || c.at, done: tick(id) }); continue; }
      if (c.outcome === 'blocked' || c.outcome === 'hung-up-early') continue;
      items.push({ id, kind: 'call', title: c.outcome === 'message-taken' ? `Message from ${who}` : c.outcome === 'voicemail-left' ? `Voicemail from ${who}` : c.outcome === 'missed' ? `Missed call from ${who}` : `Call from ${who}`, detail: clip((c.messages && c.messages[0]) || c.summary || '', 200), at: c.endedAt || c.at, done: tick(id) });
    }
    for (const m of missionList()) {
      if (m.status === 'done' || m.status === 'failed') {
        const at = m.report?.at || m.updatedAt; if (!recent(at)) continue;
        const id = `mission:${m.id}`;
        items.push({ id, kind: m.status === 'failed' || m.report?.verdict === 'failed' ? 'failed' : 'finished', title: `${m.status === 'failed' ? 'Failed' : 'Finished'}: ${clip(m.report?.headline || m.prompt, 90)}`, detail: m.project || '', at, done: tick(id) });
      }
    }
    for (const q of questionList()) { const id = `ask:${q.missionId}:${q.subtaskId || ''}`; items.push({ id, kind: 'needs-you', title: `Needs you: ${clip(q.title, 90)}`, detail: clip(q.ask, 200), at: null, done: tick(id) }); }
    for (const t of d.tasks) if (t.status === 'open' && t.due) { const id = `task:${t.id}`; items.push({ id, kind: 'task', title: `Due: ${t.title}`, detail: t.due, at: t.createdAt, done: tick(id) }); }
    const rank = { 'needs-you': 0, failed: 1, call: 2, finished: 3, task: 4 };
    return items.sort((a, b) => (a.done - b.done) || ((rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)) || String(b.at || '').localeCompare(String(a.at || '')));
  }
  function tick(id, done = true) {
    if (id && typeof id === 'object') ({ id, done = true } = id);
    const key = clip(id, 120); if (!key) throw bad('Which item?');
    const d = read(); if (done) d.ticked[key] = iso(); else delete d.ticked[key];
    const ids = new Set(); // forget ticks that no longer match anything, so the file stays small
    for (const x of checklist()) ids.add(x.id); for (const k of Object.keys(d.ticked)) if (!ids.has(k) && k !== key && !callbacks().some((c) => c.id === k)) delete d.ticked[k];
    write(d); return { ok: true };
  }
  const tickAll = () => { const d = read(); for (const x of checklist()) if (!x.done) d.ticked[x.id] = iso(); for (const c of callbacks()) d.ticked[c.id] = d.ticked[c.id] || iso(); write(d); return { ok: true }; };

  /** What she has ready to answer from: schedule, facts, contacts, open tasks, running work and what waits on the owner. */
  function knowledge() {
    const d = read(); const ms = missionList();
    return {
      schedule: d.notes.filter((n) => n.kind === 'schedule'), facts: d.notes.filter((n) => n.kind === 'fact'), contacts: d.contacts,
      tasks: d.tasks.filter((t) => t.status === 'open'),
      reminders: (d.reminders || []).filter((r) => r.status === 'pending').map((r) => ({ text: r.text, at: r.at, via: r.via })),
      activeMissions: ms.filter((m) => OPEN_STATUS.includes(m.status)).map((m) => ({ id: m.id, project: m.project, prompt: clip(m.prompt, 120), status: m.status })),
      waitingOnOwner: questionList().map((q) => ({ missionId: q.missionId, title: clip(q.title, 90), ask: clip(q.ask, 160) })),
    };
  }

  /** Short spoken/typed briefing for when the owner is back. */
  function briefing() {
    const k = knowledge(); const items = checklist().filter((i) => !i.done); const cbs = callbacks().filter((c) => !c.done);
    const parts = [];
    const n = (x, s) => `${x} ${s}${x === 1 ? '' : 's'}`;
    if (k.waitingOnOwner.length) parts.push(`${n(k.waitingOnOwner.length, 'thing')} need${k.waitingOnOwner.length === 1 ? 's' : ''} you: ${k.waitingOnOwner.slice(0, 3).map((q) => q.title).join('; ')}`);
    const fail = items.filter((i) => i.kind === 'failed'); if (fail.length) parts.push(`${n(fail.length, 'mission')} failed`);
    const fin = items.filter((i) => i.kind === 'finished'); if (fin.length) parts.push(`${n(fin.length, 'mission')} finished`);
    const cl = items.filter((i) => i.kind === 'call'); if (cl.length) parts.push(`${n(cl.length, 'call')} while you were away`);
    if (cbs.length) parts.push(`${n(cbs.length, 'callback')} to return`);
    if (k.tasks.length) parts.push(`${n(k.tasks.length, 'office task')} open`);
    if (k.activeMissions.length) parts.push(`${n(k.activeMissions.length, 'mission')} running`);
    if (k.schedule.length) parts.push(`next on your schedule: ${k.schedule[k.schedule.length - 1].text}`);
    return parts.length ? `Welcome back. ${parts.join('. ')}.` : 'Welcome back. Nothing is waiting on you.';
  }

  /** Text digest of the unticked checklist and callbacks (what the owner reads on their phone). */
  function digest() {
    const items = checklist().filter((i) => !i.done); const cbs = callbacks().filter((c) => !c.done);
    const lines = [briefing()];
    for (const i of items.slice(0, 12)) lines.push(`- ${i.title}${i.detail && i.kind !== 'finished' ? ` (${clip(i.detail, 80)})` : ''}`);
    for (const c of cbs.slice(0, 5)) lines.push(`- ${c.title} ${c.number}`);
    return lines.join('\n').slice(0, 1500);
  }
  async function sendDigest() {
    if (!deps.sendText) throw bad('No text channel is set up (WhatsApp in the SMS settings).', 503);
    const text = digest(); await deps.sendText(text);
    const d = read(); d.digestAt = iso(); write(d); return { ok: true, sent: text };
  }
  /** The owner is back: remember when, so "away" is measured from here. */
  const markReturn = () => { const d = read(); d.awaySince = iso(); write(d); return { ok: true }; };

  /** Everything the Secretary tab shows, in one read. */
  function state() {
    const d = read();
    const ms = missionList();
    const tasks = d.tasks.map((t) => (t.mission ? { ...t, missionStatus: ms.find((m) => m.id === t.mission.id && m.project === t.mission.project)?.status || null } : t));
    return { tasks, checklist: checklist(), callbacks: callbacks(), calls: calls(30), knowledge: knowledge(), briefing: briefing(), digestAt: d.digestAt, reminders: reminders(), brief: briefSettings() };
  }
  return { state, addTask, setTask, removeTask, addNote, removeNote, addContact, importContacts, removeContact, rememberEmail, emailFor, forgetEmail, phoneSettings, addReminder, reminders, dueReminders, markReminder, removeReminder, briefSettings, briefDue, markBriefSent, morningBrief, recognise, calls, callbacks, checklist, tick, tickAll, knowledge, briefing, digest, sendDigest, markReturn, file };
}

module.exports = { createSecretary, e164 };

'use strict';
/**
 * IVY's Telegram gateway: the owner's line to the office.
 * - Out: a mission finished or failed → a short report; an agent needs the owner → the question, with how to answer.
 * - In: a reply to a question message answers that agent; a reply to a report goes to ARES as a follow-up; anything
 *   else is a conversation with Ivy (same brain as the phone: she answers, files tasks, sets reminders, and can answer
 *   an agent's question when it's clear which one). /today /code /status /help are instant.
 * - Urgent: an agent's question nobody answered within `escalateMin` minutes → Ivy phones the owner once.
 * State (office/telegram.json, personal): sent message map, what was already notified, open escalations, settings.
 * deps: { tg, chat(text, opts), missions(), questions(), answer(project, mission, subtask, text), reply(project, mission, text),
 *         call(text), name(agentId), today(), code(), status(), now() }
 */
const fs = require('fs');
const path = require('path');

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// The button bar under the chat, what each button runs, and the "/" menu Telegram shows.
const BAR = [['📅 Today', '🙋 Waiting on me', '📊 Status'], ['💻 Code', '📂 Open folder', '📍 Where'], ['🔔 Urgent', '❓ Help']];
const BUTTON_CMD = { '📅 Today': 'today', '🙋 Waiting on me': 'waiting', '📊 Status': 'status', '💻 Code': 'code', '📂 Open folder': 'open', '📍 Where': 'where', '🔔 Urgent': 'urgent', '❓ Help': 'help' };
const COMMANDS = [['today', 'Your day: calendar, needs-you, code'], ['waiting', 'What the team needs from you'], ['status', "What's running in the office"],
  ['code', 'Your repos: failing checks, unpushed work'], ['open', 'Move the office to a folder'], ['where', 'Which folder the office is in'],
  ['urgent', 'When I call you'], ['menu', 'Show the quick buttons'], ['help', 'What I can do']];
const HELP = [`I'm Ivy, your line to the office. Tap a button below or just type: ask me anything, tell me what to get done, or say "remind me…".`,
  '', "I message you when a mission finishes or someone needs you, with buttons to answer. If it's urgent and you don't answer, I call.", '',
  ...COMMANDS.map(([c, d]) => `/${c} — ${d}`)].join('\n');
/** "A or B", "yes / no", "Option 1, Option 2, Option 3" → tap-able answers (2-4 short ones), else none. */
function options(reply) {
  const parts = String(reply || '').replace(/^["'(]|["').]$/g, '').split(/\s*(?:,|\/|\||\bor\b)\s*/i).map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return parts.length >= 2 && parts.length <= 4 && parts.every((x) => x.length <= 30) ? parts : [];
}
const qKey = (q) => `q:${q.project}/${q.missionId}/${q.subtaskId}`;
const askText = (a) => (a && typeof a === 'object' ? a.what || '' : String(a || ''));

function createIvyTelegram(root, deps) {
  const { tg } = deps;
  const now = deps.now || (() => Date.now());
  const file = path.join(root, 'office', 'telegram.json');
  const read = () => { let d = {}; try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ } return { sent: {}, notified: {}, pending: [], settings: {}, seeded: false, ...d }; };
  const write = (d) => { const cur = read(); d.offset = cur.offset; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 1)); fs.renameSync(`${file}.tmp`, file); };
  const settings = (b) => {
    const d = read();
    if (b && typeof b === 'object') {
      if (b.escalateMin !== undefined) { const n = Number(b.escalateMin); if (!(n >= 1 && n <= 240)) throw Object.assign(new Error('Escalate after 1-240 minutes.'), { status: 400 }); d.settings.escalateMin = n; }
      if (b.callOnUrgent !== undefined) d.settings.callOnUrgent = !!b.callOnUrgent;
      if (b.quiet !== undefined) { if (b.quiet && !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(b.quiet)) throw Object.assign(new Error('Quiet hours as HH:MM-HH:MM, or empty.'), { status: 400 }); d.settings.quiet = b.quiet || ''; }
      write(d);
    }
    return { escalateMin: d.settings.escalateMin ?? 10, callOnUrgent: d.settings.callOnUrgent ?? true, quiet: d.settings.quiet || '' };
  };
  const inQuiet = (q) => {
    if (!q) return false; const [a, b] = q.split('-').map((x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; });
    const x = new Date(now()); const t = x.getHours() * 60 + x.getMinutes();
    return a <= b ? t >= a && t < b : t >= a || t < b;
  };
  const safe = (f, dflt) => { try { return f() || dflt; } catch { return dflt; } };
  const remember = (d, messageId, ref) => { if (!messageId) return; d.sent[messageId] = { ...ref, at: new Date(now()).toISOString() }; const ids = Object.keys(d.sent); if (ids.length > 300) for (const k of ids.slice(0, ids.length - 300)) delete d.sent[k]; };

  /** Telegram text for an agent's question. */
  function questionText(q) {
    const a = q.ask || {}; const who = safe(() => deps.name(q.who), q.who || 'A teammate');
    return [`🙋 ${who} needs you (${q.project})`, askText(a) || q.title, a.why ? `Why: ${clip(a.why, 300)}` : '',
      ...(Array.isArray(a.steps) && a.steps.length ? ['Steps:', ...a.steps.slice(0, 6).map((s, i) => `${i + 1}. ${clip(s, 200)}`)] : []),
      a.reply ? `Reply with: ${clip(a.reply, 200)}` : '', '', '↩️ Tap an answer, or reply to this message.'].filter((x) => x !== '').join('\n').replace(/\n↩️/, '\n\n↩️');
  }
  function reportText(m) {
    const r = m.report || {}; const failed = m.status === 'failed' || r.verdict === 'failed';
    const forYou = r.for_you && !/^nothing\b/i.test(String(r.for_you).trim()) ? `For you: ${clip(r.for_you, 400)}` : '';
    return [`${failed ? '❌ Failed' : '✅ Done'} (${m.project}): ${clip(r.headline || m.prompt, 120)}`, r.summary ? clip(r.summary, 600) : '', forYou,
      '', '↩️ Reply (or tap Follow up) to ask ARES for more.'].filter((x, i, arr) => x !== '' || (i > 0 && arr[i - 1] !== '')).join('\n');
  }

  const inl = (rows) => (tg.inline ? tg.inline(rows) : { inline_keyboard: rows });
  const bar = () => (tg.keyboard ? tg.keyboard(BAR) : undefined);
  /** An agent's question with its answers as buttons (when the reply is a short choice) plus "Answer…". */
  async function sendQuestion(q) {
    const opts = options(q.ask?.reply);
    const rows = [...(opts.length ? [opts.map((o, i) => ({ text: o, data: `a:${i}` }))] : []), [{ text: '✍️ Answer…', data: 'w' }]];
    const r = await tg.send(questionText(q), { markup: inl(rows) });
    const d = read(); remember(d, r.messageId, { kind: 'question', project: q.project, missionId: q.missionId, subtaskId: q.subtaskId, who: q.who, options: opts }); write(d);
    return r;
  }
  const markAnswered = (ref) => { const d2 = read(); for (const p of d2.pending) if (p.key === `q:${ref.project}/${ref.missionId}/${ref.subtaskId}`) p.answered = true; write(d2); };
  /** A tap on a button under one of her messages. */
  async function onButton({ data, messageId, buttonId }) {
    const ack = (t) => (tg.answerButton ? tg.answerButton(buttonId, t) : null);
    const say = (t, o) => tg.send(t, o).then(() => t);
    const ref = read().sent[messageId] || null;
    const [k, arg] = [data.split(':')[0], data.slice(data.indexOf(':') + 1)];
    if (k === 'x') { ack('👍'); return ''; }
    if (k === 'gs' || k === 'gx') { // a phone draft's Send / Cancel
      ack(); const t = await deps.confirmDraft(arg, { yes: k === 'gs' });
      tg.editButtons?.(messageId, inl([[{ text: k === 'gs' ? '✅ Sent' : '✖ Cancelled', data: 'x' }]]));
      return say(t);
    }
    if (k === 'o') { ack(); try { const f = await deps.open(arg); return say(`Done, the office is working in ${f.project} now${f.added ? ' (added it to the office first)' : ''}.`); } catch (e) { return say(`I couldn't open that: ${e.message}`); } }
    if (k === 'c') { ack(); return onMessage({ text: `/${arg}`, kind: 'text' }); }
    if (!ref) { ack('That message is too old to answer here.'); return ''; }
    const who = safe(() => deps.name(ref.who), 'them');
    if (k === 'a' && ref.kind === 'question') {
      const choice = (ref.options || [])[Number(arg)]; if (!choice) { ack(); return ''; }
      deps.answer(ref.project, ref.missionId, ref.subtaskId, choice); markAnswered(ref);
      ack(`Sent: ${choice}`); tg.editButtons?.(messageId, inl([[{ text: `✅ Answered: ${choice}`, data: 'x' }]]));
      return say(`Got it, passed to ${who}: ${choice}.`);
    }
    if (k === 'w' || k === 'f') { // ask for a typed answer; the reply maps back to the same question/report
      ack();
      const r = await tg.send(k === 'w' ? `Your answer for ${who}:` : 'Your follow-up for ARES:', { markup: { force_reply: true, input_field_placeholder: k === 'w' ? 'Type your answer' : 'What else should ARES do?' } });
      const d = read(); remember(d, r.messageId, ref); write(d); return '';
    }
    ack(); return '';
  }

  /** One pass: new reports, new questions, escalation calls. Safe to call every 30s. */
  async function tick() {
    if (!tg.linked()) return { skipped: 'telegram not linked' };
    const d = read(); const out = { reports: 0, questions: 0, calls: 0 };
    const ms = safe(() => deps.missions(), []); const qs = safe(() => deps.questions(), []);
    const finished = ms.filter((m) => (m.status === 'done' || m.status === 'failed') && m.report);
    if (!d.seeded) { // first run: everything already there is old news
      for (const m of finished) d.notified[`m:${m.project}/${m.id}`] = 1;
      for (const q of qs) d.notified[qKey(q)] = 1;
      d.seeded = true; write(d); return { seeded: true };
    }
    const mark = (k) => { const x = read(); if (x.notified[k]) return false; x.notified[k] = 1; write(x); return true; }; // always on fresh state
    for (const m of finished) {
      const k = `m:${m.project}/${m.id}`; if (d.notified[k] || !mark(k)) continue;
      try { const r = await tg.send(reportText(m), { markup: inl([[{ text: '💬 Follow up', data: 'f' }, { text: '👍 Thanks', data: 'x' }]]) }); const d2 = read(); remember(d2, r.messageId, { kind: 'report', project: m.project, missionId: m.id }); write(d2); out.reports++; } catch { /* next tick won't retry: no spam loops */ }
    }
    for (const q of qs) {
      const k = qKey(q); if (d.notified[k] || !mark(k)) continue;
      try {
        const r = await sendQuestion(q); const d2 = read();
        d2.pending.push({ key: k, messageId: r.messageId, sentAt: now(), project: q.project, who: q.who, what: clip(askText(q.ask) || q.title, 200), called: false });
        write(d2); out.questions++;
      } catch { /* ignore */ }
    }
    // escalation: still open, not answered, past the wait → one call
    const s = settings(); const open = new Set(qs.map(qKey));
    const d3 = read(); d3.pending = d3.pending.filter((p) => open.has(p.key) && !p.answered); write(d3);
    for (const p of d3.pending) {
      if (p.called || !s.callOnUrgent || deps.phoneOff?.() || inQuiet(s.quiet) || now() - p.sentAt < s.escalateMin * 60000) continue;
      p.called = true; { const x = read(); for (const y of x.pending) if (y.key === p.key) y.called = true; write(x); }
      const who = safe(() => deps.name(p.who), 'One of the team');
      try {
        await deps.call(`Hi, it's Ivy. ${who} is stuck and needs you on ${p.project}: ${((w) => (/[.!?]$/.test(w) ? w : `${w}.`))(String(p.what).trim().replace(/([.!?])[.!?\s]*$/, '$1'))} The details are on Telegram, or just tell me the answer now.`);
        out.calls++; tg.send(`📞 I called you about this: ${p.what}`, { replyTo: p.messageId }).catch(() => {});
      } catch (e) { tg.send(`I tried to call you about "${p.what}" but the call failed (${clip(e.message, 80)}).`).catch(() => {}); }
    }
    return out;
  }

  /** The owner wrote to the bot. Returns what was sent back (for tests/logs). */
  async function onMessage({ text, replyTo, kind, data, messageId, buttonId }) {
    if (kind === 'button') return onButton({ data, messageId, buttonId });
    const say = (t, o) => tg.send(t, o).then(() => t);
    if (kind === 'voice') return say("I can't listen to voice notes yet. Type it, or call me.");
    let t = String(text || '').trim(); if (!t) return '';
    if (BUTTON_CMD[t]) t = `/${BUTTON_CMD[t]}`; // a tap on the button bar
    const cmd = t.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    if (cmd === 'start' || cmd === 'help' || cmd === 'menu') return say(cmd === 'menu' ? 'Here are your quick buttons 👇' : HELP, { markup: bar() });
    if (cmd === 'waiting') {
      const qs = safe(() => deps.questions(), []);
      if (!qs.length) return say("Nobody's waiting on you. 🎉");
      await say(`${qs.length} thing${qs.length > 1 ? 's' : ''} waiting on you:`);
      for (const q of qs.slice(0, 8)) await sendQuestion(q).catch(() => {});
      return `${qs.length} waiting`;
    }
    if (cmd === 'today') return say(safe(() => deps.today(), 'Nothing yet.'));
    if (cmd === 'where') return say(`The office is working in ${safe(() => deps.where(), 'success-manager (home)')}.`);
    if (cmd === 'open') {
      const q = t.replace(/^\/open(@\w+)?\s*/i, '');
      if (!q) { // a folder picker: the office's projects first, then the rest of the projects folder
        const fs_ = safe(() => deps.folders(), []).filter((n) => Buffer.byteLength(`o:${n}`) <= 64).slice(0, 30);
        if (!fs_.length) return say('Which folder? e.g. /open atlas-app');
        const rows = []; for (let i = 0; i < fs_.length; i += 3) rows.push(fs_.slice(i, i + 3).map((n) => ({ text: n, data: `o:${n}` })));
        return say(`Where should the office work? (now: ${safe(() => deps.where(), 'home')})`, { markup: inl(rows) });
      }
      try { const f = await deps.open(q); return say(`Done, the office is working in ${f.project} now${f.added ? ' (added it to the office first)' : ''}.`); } catch (e) { return say(`I couldn't open that: ${e.message}`); }
    }
    if (cmd === 'code') return say(safe(() => deps.code(), 'No scan yet.'));
    if (cmd === 'status') return say(safe(() => deps.status(), 'All quiet.'));
    if (cmd === 'urgent') { const s = settings(); return say(`If someone needs you and you don't answer here in ${s.escalateMin} min, I call you${s.quiet ? ` (not between ${s.quiet})` : ''}.${s.callOnUrgent ? '' : ' Calling is OFF.'}\nChange it: sm telegram --escalate <min> [--quiet 23:00-07:00] [--no-call]`); }
    const d = read(); const ref = replyTo ? d.sent[replyTo] : null;
    if (ref && ref.kind === 'question') {
      deps.answer(ref.project, ref.missionId, ref.subtaskId, t); markAnswered(ref);
      return say(`Got it, passed to ${safe(() => deps.name(ref.who), 'them')}.`);
    }
    if (ref && ref.kind === 'draft') { // a reply to a phone draft: a corrected address, or yes / no
      const yes = /^(yes|yep|yeah|send|send it|ok|okay|go ahead)\b/i.test(t); const no = /^(no|cancel|don'?t)\b/i.test(t);
      return say(await deps.confirmDraft(ref.id, yes ? { yes: true } : no ? { yes: false } : { address: t }));
    }
    if (ref && ref.kind === 'report') { deps.reply(ref.project, ref.missionId, t); return say('Passed to ARES. He\'ll answer in the report thread, and I\'ll tell you when there\'s news.'); }
    tg.typing();
    const r = await deps.chat(t, { onAnswered: (key) => { const d2 = read(); for (const p of d2.pending) if (p.key === key) p.answered = true; write(d2); } });
    return say(r || "Sorry, I couldn't get to that just now. Try me again in a moment.");
  }

  /** Start listening and the 30s notifier. */
  function start({ everyMs = 30000 } = {}) {
    if (tg.setCommands && tg.linked()) tg.setCommands(COMMANDS).catch(() => {}); // the "/" menu in the chat
    tg.start((m) => onMessage(m), { onError: deps.onError });
    const timer = setInterval(() => { tick().catch((e) => deps.onError?.(e)); }, everyMs); timer.unref?.();
    setTimeout(() => tick().catch(() => {}), 3000).unref?.();
    return () => { clearInterval(timer); tg.stop(); };
  }
  /** A Google send drafted on a call, shown here so the owner can check the exact address and tap Send / Cancel. */
  async function mirrorDraft(d) {
    const who = d.people.map((p) => `${p.name ? `${p.name} ` : ''}<${p.email}>`).join(', ');
    const what = d.kind === 'meet' ? `📅 Google Meet: ${d.title}\n${new Date(d.start).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${d.minutes} min` : `✉️ Email: ${d.subject}\n${d.body.slice(0, 600)}`;
    const r = await tg.send(`Check before I send (from our call):\n${what}\nTo: ${who}\n\n↩️ Reply with the right address to fix it.`, { markup: inl([[{ text: '✅ Send', data: `gs:${d.id}` }, { text: '✖ Cancel', data: `gx:${d.id}` }]]) });
    const x = read(); remember(x, r.messageId, { kind: 'draft', id: d.id }); write(x);
  }
  /** Send the button bar (e.g. right after setup). */
  const sendMenu = () => tg.send(HELP, { markup: bar() });
  return { tick, onMessage, start, settings, questionText, reportText, sendMenu, mirrorDraft, file };
}

module.exports = { createIvyTelegram, qKey, options, COMMANDS, BAR };

'use strict';
/**
 * Ivy's conversation brain (phone and WhatsApp). She is an assistant, not a narrator: short answers, and when the
 * owner asks for something to be done she files it for ARES herself (no magic phrase needed). Small talk and
 * "what did I miss" are answered instantly without an AI call. "add this to the list …" still files straight away.
 * Each AI turn returns { say, action: none|task|note, task, project, note, noteKind } (JSON schema).
 */
const { spawn } = require('child_process');

const ARM_TTL_MS = 10 * 60 * 1000;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const TRIGGER = /^\s*(?:(?:ares|ivy|hey ares|hey ivy|please|can you|could you|i want you to)[,\s]+)*(?:add|put|file|log|queue)\s+(?:this|that|it|these|the following)?\s*(?:to|on|onto|in|into)\s+(?:the|my|our)\s+(?:list|queue|backlog|to-?do(?:\s+list)?)\b[\s:,.\-–—]*/i;
const CANCEL = /^\s*(?:cancel|never\s*mind|forget it|stop|no thanks?)\b/i;
const strip = (t) => String(t || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GREET = /^(?:(?:hi|hey|hello|hiya|yo|good (?:morning|afternoon|evening))(?: there)?(?: (?:ivy|ares))?|(?:ivy|ares)|(?:can|do) you hear me|are you there|is this ivy|hello hello)$/;
const THANKS = /^(?:(?:ok(?:ay)?|great|perfect|cool|nice|awesome|alright|got it) )?(?:thanks?(?: you)?(?: so much| very much)?|thank you|cheers|ok(?:ay)?|great|perfect|cool|got it|alright)(?: ivy)?$/;
const TODAY = /^(?:(?:so|ok|okay|hey|alright) )?(?:what(?:'s| is| does)? (?:on )?(?:my )?(?:today|the day|my day(?: look like)?|on today|on for today|my schedule today|the plan today)|(?:give me |read me )?(?:my |the )?(?:morning )?brief(?:ing)?|how(?:'s| does) my day look(?:ing)?|plan for today)(?: ivy| please)?$/;
const CATCHUP = /^(?:(?:so|ok|okay|hey|alright|and) )?(?:what(?:'s| is| did i)? (?:new|up|going on|waiting|happening|miss(?:ed)?)|any (?:updates?|news)|catch me up|brief me|fill me in|what do you have for me|anything (?:new|for me|i need to know))(?: (?:ivy|today|so far|for me|then))?$/;

/** `{ kind: 'add', prompt }` (prompt may be '') when the owner asks to add to the list; else `{ kind: 'chat' }`. */
function classify(text) {
  const m = String(text || '').match(TRIGGER);
  if (!m) return { kind: 'chat' };
  return { kind: 'add', prompt: String(text).slice(m[0].length).trim() };
}

/** Instant replies that need no AI. Returns a string or null. `briefing` is the desk's briefing ('' if none). */
function quickReply(text, o = {}) { // o.briefing / o.today may be getters: read only when the words call for them
  const t = strip(text);
  if (!t) return null;
  if (GREET.test(t)) return 'Hi! What can I do for you?';
  if (THANKS.test(t)) return 'Sure thing.';
  if (TODAY.test(t)) { const today = o.today || ''; if (today) return today; }
  if (CATCHUP.test(t)) return spokenBriefing(o.briefing || '');
  return null;
}
/** The desk briefing, trimmed to what is worth saying out loud: what needs them first, then at most two more facts. */
function spokenBriefing(b) {
  const parts = String(b || '').replace(/^Welcome back\.\s*/, '').split(/\.\s+/).map((s) => s.replace(/\.$/, '').trim()).filter(Boolean);
  if (!parts.length || /Nothing is waiting/i.test(b)) return "Nothing's waiting on you. All quiet.";
  return `${parts.slice(0, 3).join('. ')}.`;
}

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'What Ivy says back. Spoken English, 1-2 short sentences, under 30 words.' },
    action: { type: 'string', enum: ['none', 'task', 'note', 'remind', 'answer', 'switch', 'wellbeing', 'lookup', 'connect', 'hangup', 'meet', 'email', 'callout'] },
    lookup: { type: 'string', enum: ['weather', 'convert', 'mail', 'tracking', 'calendar'], description: 'action=lookup: weather (city optional), convert (amount, from, to currency codes), mail (today\'s Gmail), tracking (packages/flights), calendar (Apple Calendar next 24h). Ivy answers from the result.' },
    city: { type: 'string', description: 'action=lookup weather: city name, or empty for the owner\'s home city.' },
    amount: { type: 'number', description: 'action=lookup convert: the amount.' },
    from: { type: 'string', description: 'action=lookup convert: 3-letter source currency, e.g. USD.' },
    to: { type: 'string', description: 'action=lookup convert: 3-letter target currency, e.g. ILS.' },
    wellbeing: { type: 'string', enum: ['awake_on', 'awake_off', 'breaks_on', 'breaks_off'], description: 'action=wellbeing: keep the Mac awake on/off, or turn the break reminders on/off.' },
    hours: { type: 'number', description: 'action=wellbeing awake_on: how many hours to keep the Mac awake (default 8).' },
    task: { type: 'string', description: 'action=task: the work request for ARES, complete and self-contained, in the owner\'s own words plus any detail from earlier in the call.' },
    project: { type: 'string', description: 'action=task: one of the listed project names, or "" for the office itself.' },
    note: { type: 'string', description: 'action=note: what to remember.' },
    noteKind: { type: 'string', enum: ['schedule', 'fact'] },
    remindAt: { type: 'string', description: 'action=remind: when, as a full ISO 8601 date-time WITH the owner\'s UTC offset (see "Now"), e.g. 2026-10-31T09:45:00+02:00.' },
    remindText: { type: 'string', description: 'action=remind: what to remind them, short, in second person ("Call Dana").' },
    message: { type: 'string', description: 'action=callout: what Ivy says/asks on the call, in third person about the owner ("Alex is running about ten minutes late"; "Is Alex\'s booking on Tuesday at 3 still on?").' },
    goal: { type: 'string', enum: ['deliver', 'confirm', 'ask'], description: 'action=callout: deliver a message, confirm something, or ask a question.' },
    number: { type: 'string', description: 'action=callout: a phone number the owner said, digits only, if the person is not a contact.' },
    with: { type: 'array', items: { type: 'string' }, description: 'action=meet/email: who — email addresses exactly as said, or names (looked up in the owner\'s Google contacts).' },
    title: { type: 'string', description: 'action=meet: meeting title (short); action=email: the subject.' },
    start: { type: 'string', description: 'action=meet: start as a full ISO 8601 date-time WITH the owner\'s UTC offset (see "Now").' },
    minutes: { type: 'number', description: 'action=meet: length in minutes (default 30).' },
    body: { type: 'string', description: 'action=email: the email text, written as the owner, plain, short. action=meet: an optional note for the invite.' },
    contact: { type: 'string', description: 'action=connect: the contact\'s name as in the Contacts list.' },
    folder: { type: 'string', description: 'action=switch: the folder to open, exactly as listed (or a path they gave).' },
    answerRef: { type: 'string', description: 'action=answer: the [ref] of the open team question the owner is answering, copied exactly.' },
    answerText: { type: 'string', description: 'action=answer: the owner\'s answer for that teammate, in their words, complete.' },
    remindVia: { type: 'string', enum: ['whatsapp', 'call'], description: 'call only if they asked to be called.' },
  },
  required: ['say', 'action'],
};

const STYLE = [
  'You are Ivy, the owner\'s personal secretary at their AI office. ARES (the Floor Manager) and the crew do the work; you are the owner\'s assistant who handles things for them.',
  'How you talk: like a sharp, warm human assistant on a call. 1-2 short sentences, under 30 words. Contractions. Answer the question directly first. No lists, no markdown, no emoji, no IDs or file paths, round numbers in words.',
  'Never: recap what they just said back to them, explain how the office works, list options, say "great question", or end with "anything else?" / "let me know". Never say you are an AI.',
  'Act, don\'t instruct. If they ask for something to be done (fix, build, change, check, look into, send, make, find out, get someone to…), set action="task" and confirm in a few words ("Done, I\'ve passed that to ARES." / "On it, ARES has it."). Never tell them to say a phrase or to do it themselves.',
  'If they want to be reminded at a time ("remind me at 10", "ping me in an hour", "call me before my 3pm"), set action="remind" with remindAt/remindText; for a meeting reminder default to 15 minutes before. If no time is given, ask once. Confirm with the time ("Sure, I\'ll text you at 9:45."). Other things to remember (facts, schedule) are action="note".',
  'If they ask to keep the Mac awake / stop keeping it awake, or to turn the break reminders on / off, set action="wellbeing" with wellbeing = awake_on, awake_off, breaks_on or breaks_off (hours for awake_on), and confirm in a few words. Only turn these on when they ask.',
  'If they ask about the weather, to convert currency, what mail came today, whether packages/flights are on the way, or what is on their Apple Calendar, set action="lookup" with lookup = weather, convert, mail, tracking or calendar (plus city, or amount/from/to). Say a short line like "Checking."; the real answer is added from live data.',
  'Teammates waiting on the owner are listed under "Open questions from the team" with a [ref]. When the owner answers one ("tell FORGE option B", "yes go ahead with the redesign"), set action="answer" with that answerRef and their answer, and confirm in a few words ("Passed to FORGE."). If it\'s unclear which question they mean, ask.',
  'The office has a home (success-manager) and works in one folder at a time. When they say open / switch to / go to / work in / move the office to a folder, set action="switch" with folder = the matching name from "Folders in the projects folder" (or the path they gave), and confirm ("Done, the office is in atlas-app now."). A task for another project does not need a switch: file it with that project.',
  'If they ask you to call, dial, connect them to or put them through to someone in their Contacts, set action="connect" with that contact\'s name and say you\'re connecting them ("Connecting you to Dana now."). Only contacts from the list.',
  'To have you phone someone for them ("call Dana and tell her I\'m late", "call the dentist and confirm my booking"), set action="callout" with contact (a name from Contacts) or number, message, goal. Say only "Sure.": the office reads it back and they confirm before you dial.',
  'Google (their Gmail and Calendar): to set up a meeting / send a Google Meet link / invite someone at a time, use action="meet" (with, title, start, minutes). To send an email, action="email" (with, title as subject, body). Say only a short lead-in ("Sure, one sec."): you will read the details back and they confirm before anything is sent. Their calendar for the next two weeks is in your notes; use it to answer "what\'s on my calendar".',
  'If they say goodbye or ask you to hang up / end the call, say a short goodbye and set action="hangup".',
  'You know the office: the crew (who does what) and the Claude accounts METER switches between are in your notes; answer from them.',
  'You know their code: the Dev pulse in your notes lists failing checks, unpushed or uncommitted work and what they shipped. Use it when they ask about their repos, GitHub, CI or "what did I do yesterday". If they want something fixed there, that is a task for ARES (name the repo).',
  'If you don\'t know something about the office or its projects, say so in one line and offer to have ARES check. If they then say yes, that is a task. Things outside the office (weather, news, general trivia): answer briefly if you know, otherwise just say you can\'t check that from here.',
  'If the request is too vague to act on, ask ONE short question instead of filing it.',
  'Chit-chat or a question is action="none". Change nothing yourself.',
  'Speech-to-text mishears names: "Harris", "Aries", "Iris", "Ares" mean ARES; "I V", "Eve" mean you (Ivy). Use the crew and project names you know.',
  'If the owner\'s words stop mid-thought (an unfinished sentence like "Tell ARES that I want"), they are still talking: say only "Mm-hm." or "Go on." and nothing else, action="none".',
  'Never file the same request twice: if the conversation shows you already passed it on, just confirm it\'s with ARES (add the new detail as a fresh task only if it really is new).',
  'When you file, confirm in under 12 words. Don\'t read the task back.',
].join('\n');

/** Local date/time with the UTC offset, so "at 10" and "tomorrow" resolve correctly. */
function nowLine(d = new Date()) {
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const a = Math.abs(off);
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  return `${d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}${tz ? `, ${tz}` : ''})`;
}

/** One AI turn. Phone: no tools (speed). Text: may read the office's files. Resolves to the parsed turn or null. */
function claudeTurn(root, { heard, history = [], context = '', projects = [], questions = [], office = null, channel = 'phone', signal }, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const convo = history.slice(-10).map((h) => `${h.who === 'ivy' ? 'Ivy' : 'Owner'}: ${h.text}`).join('\n');
    const prompt = [
      STYLE,
      channel === 'text' ? 'This is a WhatsApp chat: same brevity, written. You may read lat.md/, README and the mission files to answer about the office or projects.' : 'This is a live phone call: speed matters, answer from the notes below.',
      `Now: ${nowLine()}.`,
      projects.length ? `Projects the office works on: ${projects.join(', ')}.` : '',
      office ? `The office is working in: ${office.current || 'success-manager (home)'}.${office.folders?.length ? ` Folders in the projects folder: ${office.folders.join(', ')}.` : ''}` : '',
      context ? `Your desk notes (current):\n${context}` : '',
      questions.length ? `Open questions from the team:\n${questions.map((q) => `- [${q.ref}] ${q.who} on ${q.project}: ${q.what}${q.reply ? ` (they want: ${q.reply})` : ''}`).join('\n')}` : '',
      convo ? `The conversation so far:\n${convo}` : '',
      `Owner: ${heard}`,
    ].filter(Boolean).join('\n\n');
    const tools = channel === 'text' ? ['--allowedTools', 'Read', 'Grep', 'Glob'] : [];
    const args = ['-p', prompt, '--model', 'sonnet', '--effort', 'low', '--max-budget-usd', '0.3', '--output-format', 'json', '--json-schema', JSON.stringify(TURN_SCHEMA), ...tools,
      '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent', ...(channel === 'text' ? [] : ['Read', 'Grep', 'Glob'])];
    let out = '';
    const c = spawn('claude', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SM_ROLE: 'auditor' } });
    const t = setTimeout(() => c.kill(), timeoutMs);
    signal?.addEventListener?.('abort', () => c.kill(), { once: true }); // the caller kept talking: stop paying for a stale turn
    c.stdout.on('data', (x) => (out += x));
    c.on('error', () => { clearTimeout(t); resolve(null); });
    c.on('close', (code, sig) => {
      clearTimeout(t);
      if (sig) return resolve(null);
      try { const j = JSON.parse(out); resolve(j.is_error ? null : (j.structured_output || null)); } catch { resolve(null); }
    });
  });
}

/**
 * `file(task, project)` files a request for ARES (returns the project it went to); `turn(input)` is one AI turn
 * (claudeTurn's shape); `note({kind,text})` saves to the desk; `projects()` lists project names.
 * Returns handle(text, opts): opts = { context, briefing, history, channel, onFiled(task) }.
 */
function createChat({ file, turn, session, google, findContactEmail, onDraft, onSent, callOut, note, remind, wellbeing, lookup, findContact, questions = () => [], answerQuestion, switchFolder, office = () => null, projects = () => [], now = () => Date.now() }) {
  let armedAt = -1;
  let log = []; let logAt = 0; // WhatsApp has no call state: keep a short rolling history here
  const remember = (who, text) => { if (now() - logAt > HISTORY_TTL_MS) log = []; logAt = now(); log.push({ who, text }); log = log.slice(-12); };
  const fileIt = async (task, project, opts) => { const p = await file(task, project || ''); opts.onFiled?.(task); return p; };
  // Google sends wait for a yes: one draft per conversation thread (a call, or the text line). A draft can also be
  // confirmed from Telegram (its buttons) by id. Addresses said out loud are read by code (bin/spoken-email.js), never
  // guessed by the model: a model once joined "i g a n i…" into the wrong address and the invite bounced (2026-11-01).
  const drafts = new Map(); const byId = new Map();
  const YES = /^(?:(?:yes|yeah|yep|yup|sure|ok(?:ay)?|correct|right|perfect|great)[,.!\s]*)*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|correct|perfect|great|send it|go ahead|do it|please do|confirm(?:ed)?|that'?s right|sounds good)(?:[,.!\s]+(?:please|thanks?|thank you|send it|go ahead))*[.!]*$/i;
  const NO = /^(?:no|nope|nah|cancel|don'?t|stop|never ?mind|forget it|hold on|wait)\b/i;
  const { spokenEmail, spellEmail, spokenPhone, sayPhone } = require('./spoken-email.js');
  const when = (iso) => { const d = new Date(iso); return d.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(/ (am|pm)/, '$1'); };
  const firstName = (p) => (p.name || p.email).split(' ')[0];
  const looksLikeAddress = (w) => /@|\bat\b.*\bdot\b/i.test(w);
  /** who → [{name, email, source: memory|contacts|spoken}]; heard = the owner's own words this turn. */
  async function resolvePeople(list, heard, names = []) {
    const out = []; const missing = [];
    const said = spokenEmail(heard);
    for (const raw of [].concat(list || [])) {
      const w = String(raw).trim(); if (!w) continue;
      if (looksLikeAddress(w)) { // an address: the owner's own spoken words beat the model's spelling
        const e = said?.email || spokenEmail(w)?.email || (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(w) ? w.toLowerCase() : '');
        if (e) { out.push({ name: names.shift() || '', email: e, source: 'spoken' }); continue; }
      }
      let hit = null; try { hit = findContactEmail ? await findContactEmail(w) : null; } catch { hit = null; }
      if (hit?.email) { out.push({ name: hit.name || w, email: hit.email, source: 'memory' }); continue; }
      if (google) { try { const g = (await google.findPeople(w))[0]; if (g?.email) { out.push({ name: g.name || w, email: g.email, source: 'contacts' }); continue; } } catch { /* not found */ } }
      missing.push(w);
    }
    return { out, missing };
  }
  const nameList = (ps) => ps.map((p) => (p.source === 'spoken' ? `${p.name ? `${p.name} at ` : ''}${spellEmail(p.email)}` : p.name || p.email)).join(' and ');
  async function draftReply(r, thread, heard, carried = {}) {
    const { out, missing } = await resolvePeople(r.with, heard, [...(carried.names || [])]);
    const people = [...(carried.people || []), ...out];
    if (missing.length) { // remember what they asked for; the next thing they say is the address
      drafts.set(thread, { kind: 'needAddress', at: now(), r, names: missing, people });
      return `I don't have an email for ${missing.join(' or ')}. What's the address? You can spell it.`;
    }
    if (!people.length) return r.action === 'meet' ? 'Who should I invite?' : 'Who should I send it to?';
    const id = `d${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    let d;
    if (r.action === 'meet') {
      const start = Date.parse(r.start || ''); if (Number.isNaN(start)) return 'When should it be?';
      const minutes = Math.max(5, Math.min(480, Number(r.minutes) || 30));
      let clash = ''; try { const b = google ? await google.busy(start, start + minutes * 60000) : []; if (b.length) clash = ' You already have something then.'; } catch { /* free/busy is a nicety */ }
      d = { id, kind: 'meet', at: now(), title: String(r.title || `Meeting with ${people.map(firstName).join(' & ')}`).trim(), start: new Date(start).toISOString(), minutes, people, note: String(r.body || ''), thread, clash };
    } else {
      const subject = String(r.title || '').trim(); const body = String(r.body || '').trim();
      if (!body) return 'What should the email say?';
      d = { id, kind: 'email', at: now(), people, subject: subject || body.split(/[.!?]/)[0].slice(0, 60), body, thread };
    }
    d.say = sayOf(d);
    drafts.set(thread, d); byId.set(id, d);
    try { onDraft?.(d); } catch { /* the Telegram copy is a nicety */ }
    return d.say;
  }
  /** What Ivy reads back before sending; addresses heard on the call are spelled out letter by letter. */
  function sayOf(d) {
    if (d.kind === 'callout') {
      const h = new Date(now()).getHours(); const late = h < 8 || h >= 21 ? ` It's ${new Date(now()).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })} there now, by the way.` : '';
      return `I'll call ${d.name || sayPhone(d.number)} and ${d.goal === 'confirm' ? 'confirm' : d.goal === 'ask' ? 'ask' : 'say'}: ${/[.!?]$/.test(d.message.trim()) ? d.message.trim() : `${d.message.trim()}.`}${late} Call now?`;
    }
    if (d.kind === 'meet') return `A ${d.minutes === 60 ? 'one-hour' : `${d.minutes}-minute`} Google Meet with ${nameList(d.people)}, ${when(d.start)}.${d.clash || ''} Send the invite?`;
    return `An email to ${nameList(d.people)}${d.subject ? `, "${d.subject}"` : ''}: ${d.body.length > 160 ? `${d.body.slice(0, 157)}…` : d.body} Send it?`;
  }
  async function sendDraft(d) {
    drafts.delete(d.thread); byId.delete(d.id);
    let r;
    if (d.kind === 'callout') {
      await callOut({ to: d.number, name: d.name, message: d.message, goal: d.goal });
      return { say: `Calling ${d.name ? d.name.split(' ')[0] : 'them'} now. I'll tell you how it goes.` };
    }
    if (d.kind === 'meet') {
      const m = await google.createMeeting({ title: d.title, start: d.start, minutes: d.minutes, attendees: d.people.map((p) => p.email), description: d.note, notify: true });
      r = { say: `Done. The invite's gone to ${d.people.map(firstName).join(' and ')} with the Meet link, and it's on your calendar.`, meet: m.meet, eventId: m.id };
    } else {
      await google.sendMail({ to: d.people.map((p) => p.email), subject: d.subject, text: d.body });
      r = { say: `Sent to ${d.people.map(firstName).join(' and ')}.` };
    }
    try { onSent?.(d, r); } catch { /* memory + bounce watch are best effort */ }
    return r;
  }
  /** Telegram's Send / Cancel buttons, or a corrected address typed there. */
  async function confirmDraft(id, { yes = false, address = '' } = {}) {
    const d = byId.get(id); if (!d || now() - d.at > 30 * 60000) return 'That draft is gone (sent, cancelled or too old).';
    if (address) {
      const e = spokenEmail(address)?.email; if (!e) return "That doesn't look like an email address.";
      const i = d.people.findIndex((p) => p.source === 'spoken') >= 0 ? d.people.findIndex((p) => p.source === 'spoken') : 0;
      d.people[i] = { ...d.people[i], email: e, source: 'spoken' }; d.at = now(); d.say = sayOf(d);
      try { onDraft?.(d); } catch { /* best effort */ }
      return `Fixed. ${d.say}`;
    }
    if (!yes) { drafts.delete(d.thread); byId.delete(id); return "Okay, I won't send it."; }
    try { return (await sendDraft(d)).say; } catch (e) { return `Sorry, Google didn't take it: ${String(e.message || 'error').replace(/\.$/, '')}.`; }
  }
  async function handle(text, opts = {}) {
    const t = String(text || '').trim();
    if (!t) return '';
    const thread = opts.thread || 'text';
    const draft = drafts.get(thread);
    if (draft && now() - draft.at < 10 * 60000) {
      if (draft.kind === 'needAddress') { // they were asked for an address: read it from their words, not the model
        const e = spokenEmail(t);
        if (e && google) {
          drafts.delete(thread);
          const names = [...draft.names]; const r = { ...draft.r, with: [e.email] };
          try { return await draftReply(r, thread, t, { people: draft.people, names }); } catch (err) { return `Sorry, I couldn't set that up: ${String(err.message || 'error').replace(/\.$/, '')}.`; }
        }
        if (NO.test(t)) { drafts.delete(thread); return 'Okay, never mind.'; }
        drafts.delete(thread);
      } else { // a send waiting for their yes
        const fix = spokenEmail(t);
        if (fix && !YES.test(t) && draft.people.some((p) => p.source === 'spoken')) return confirmDraft(draft.id, { address: t }); // "no, it's i g a n i…": the corrected address
        if (YES.test(t)) { try { const r = await sendDraft(draft); opts.onGoogle?.(draft, r); return r.say; } catch (e) { return `Sorry, Google didn't take it: ${String(e.message || 'error').replace(/\.$/, '')}.`; } }
        if (NO.test(t)) { drafts.delete(thread); byId.delete(draft.id); return draft.kind === 'callout' ? 'Okay, I won\'t call.' : 'Okay, I won\'t send it.'; }
        drafts.delete(thread); byId.delete(draft.id); // anything else: they moved on (or changed it, and the new turn drafts again)
      }
    }
    if (now() - logAt > HISTORY_TTL_MS) log = [];
    const armed = armedAt >= 0 && now() - armedAt < ARM_TTL_MS;
    if (armed) {
      armedAt = -1;
      if (CANCEL.test(t)) return 'Okay, nothing added.';
      const again = classify(t);
      if (again.kind === 'add' && !again.prompt) { armedAt = now(); return 'Ready. What should I add?'; }
      await fileIt(again.kind === 'add' ? again.prompt : t, '', opts);
      return "Done, I've passed that to ARES.";
    }
    const c = classify(t);
    if (c.kind === 'add') {
      if (c.prompt) { await fileIt(c.prompt, '', opts); return "Done, I've passed that to ARES."; }
      armedAt = now();
      return 'Sure, what should I add?';
    }
    const quick = quickReply(t, { get briefing() { return opts.briefing || ''; }, get today() { return opts.today || ''; } });
    if (quick) return quick;
    // read only when used: on a live call the warm session already knows all of this, and reading it costs time
    const once = (f, d) => { let v; let done = false; return () => { if (!done) { try { v = f() ?? d; } catch { v = d; } done = true; } return v; }; };
    const namesOf = once(projects, []); const openOf = once(questions, []); const whereOf = once(office, null);
    const lazy = (get) => new Proxy([], { get: (_, k) => { const v = get(); const x = v[k]; return typeof x === 'function' ? x.bind(v) : x; } });
    const names = lazy(namesOf); const open = lazy(openOf);
    // On a live call: the call's warm session streams sentences as they are written; else (or if it fails) one cold turn
    let r = null;
    if (opts.session && opts.session.alive) r = await opts.session.ask(opts.continued ? `[They kept talking; this is their whole message, answer only this:] ${t}` : t, { onSentence: opts.onSentence, stale: opts.stale });
    if (!r && !opts.stale?.() && turn) r = await turn({ heard: t, history: (opts.history || log).slice(), context: opts.context || '', projects: namesOf(), questions: openOf(), office: whereOf(), channel: opts.channel || 'phone', signal: opts.signal });
    if (opts.stale?.()) return ''; // the caller kept talking: this turn files nothing and says nothing
    if (!r || !String(r.say || '').trim()) return "Sorry, I couldn't get to that just now. Try me again in a moment.";
    if (r.action === 'task' && String(r.task || '').trim()) {
      const proj = names.includes(r.project) ? r.project : '';
      await fileIt(String(r.task).trim(), proj, opts);
    } else if (r.action === 'connect' && String(r.contact || '').trim()) {
      const who = findContact ? findContact(String(r.contact).trim()) : null;
      if (!who) return `I don't have ${String(r.contact).trim()} in your contacts. Add them on my desk and I can connect you.`;
      if (!opts.onConnect) return `I can only put calls through while you're on the phone with me. ${who.name}'s number is ${who.number}.`;
      opts.onConnect(who.number, who.name);
      return r.streamed ? String(r.say).trim() : `Connecting you to ${who.name} now.`;
    } else if (r.action === 'callout' && callOut) { // Ivy phones someone for the owner: read back, dial only on their yes
      const message = String(r.message || '').trim(); if (!message) return 'What should I tell them?';
      let who = r.contact && findContact ? findContact(String(r.contact).trim()) : null;
      const number = who?.number || spokenPhone(t) || spokenPhone(r.number);
      if (!number) return r.contact ? `I don't have a number for ${String(r.contact).trim()}. What's the number?` : 'Who should I call?';
      if (!who) who = { name: r.contact && !spokenPhone(r.contact) ? String(r.contact).trim() : '' };
      const d = { id: `c${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'callout', at: now(), thread, name: who.name || '', number, message, goal: ['deliver', 'confirm', 'ask'].includes(r.goal) ? r.goal : 'deliver', people: [] };
      d.say = sayOf(d); drafts.set(thread, d); byId.set(d.id, d);
      return d.say;
    } else if ((r.action === 'meet' || r.action === 'email') && google) {
      try { return await draftReply(r, thread, t); } catch (e) { return `Sorry, I couldn't set that up: ${String(e.message || 'error').replace(/\.$/, '')}.`; }
    } else if (r.action === 'hangup') {
      opts.onHangup?.();
    } else if (r.action === 'switch' && switchFolder && String(r.folder || '').trim()) {
      try { const f = await switchFolder(String(r.folder).trim()); return r.streamed && !f.added ? String(r.say).trim() : `Done, the office is working in ${f.project} now${f.added ? ' (I added it to the office first)' : ''}.`; } catch (e) { return `I couldn't open that: ${String(e.message || 'not found').replace(/\.$/, '')}.`; }
    } else if (r.action === 'answer' && answerQuestion && open.some((q) => q.ref === r.answerRef) && String(r.answerText || '').trim()) {
      try { answerQuestion(r.answerRef, String(r.answerText).trim()); opts.onAnswered?.(`q:${r.answerRef}`); } catch { return "Sorry, I couldn't pass that on. Reply to my message about it instead."; }
    } else if (r.action === 'remind' && String(r.remindText || '').trim() && remind) {
      try { remind({ text: String(r.remindText).trim(), at: r.remindAt, via: r.remindVia === 'call' ? 'call' : 'whatsapp' }); } catch (e) { return `Sorry, I couldn't set that: ${String(e.message || 'bad time').replace(/\.$/, '')}. When should I remind you?`; }
      opts.onReminder?.(r.remindText);
    } else if (r.action === 'wellbeing' && wellbeing) {
      try { return wellbeing(r.wellbeing, r.hours); } catch (e) { return `Sorry, I couldn't do that: ${String(e.message || 'failed').replace(/\.$/, '')}.`; }
    } else if (r.action === 'lookup' && lookup && r.lookup) {
      try { return await lookup(r); } catch (e) { return `Sorry, I couldn't check that: ${String(e.message || 'failed').replace(/\.$/, '')}.`; }
    } else if (r.action === 'note' && String(r.note || '').trim() && note) {
      try { note({ kind: r.noteKind === 'schedule' ? 'schedule' : 'fact', text: String(r.note).trim() }); } catch { /* the reply still stands */ }
    }
    if (!opts.history) { remember('owner', t); remember('ivy', r.say); }
    return String(r.say).trim();
  }
  /**
   * A warm voice session for one phone call: the system prompt carries everything a cold turn's prompt did (style,
   * time, projects, folder, desk, open questions); the session keeps the conversation itself.
   */
  handle.confirmDraft = confirmDraft;
  handle.openSession = (extra = {}) => {
    if (!session) return null;
    let names = []; try { names = projects() || []; } catch { /* none */ }
    let open = []; try { open = questions() || []; } catch { /* none */ }
    let where = null; try { where = office(); } catch { /* none */ }
    try { return session(voiceSystem({ context: extra.context || '', projects: names, questions: open, office: where })); } catch { return null; }
  };
  return handle;
}

/** The voice session's system prompt: the owner brain's rules + spoken-reply rules + the ACTION line format. */
function voiceSystem({ context = '', projects = [], questions = [], office = null } = {}) {
  const fields = Object.entries(TURN_SCHEMA.properties).filter(([k]) => k !== 'say').map(([k, v]) => `- ${k}${v.enum ? ` (${v.enum.join('|')})` : ''}${v.description ? `: ${v.description}` : ''}`).join('\n');
  return [
    STYLE,
    'This is a live phone call. Your words are turned into speech the moment you write each sentence, so:',
    '- Make your FIRST sentence short (a few words) so it can be spoken right away; then the rest.',
    '- Talk like a person on the phone: everyday words, contractions, a natural lead-in only when it adds warmth ("Sure.", "Got it.", "Okay, so…", vary them), times and numbers the way people say them ("quarter to ten", "about twenty"). No lists, no symbols, no markdown.',
    '- If they stop mid-thought, write only "Mm-hm."',
    'Format: write only what you say out loud. If you take an action, add ONE last line that is never spoken:',
    'ACTION: {"action": "...", ...the fields it needs}',
    `Fields:\n${fields}`,
    'No ACTION line for plain conversation (action none).',
    `Now (at the start of this call): ${nowLine()}.`,
    projects.length ? `Projects the office works on: ${projects.join(', ')}.` : '',
    office ? `The office is working in: ${office.current || 'success-manager (home)'}.${office.folders?.length ? ` Folders in the projects folder: ${office.folders.join(', ')}.` : ''}` : '',
    context ? `Your desk notes (current at the start of the call):\n${context}` : '',
    questions.length ? `Open questions from the team:\n${questions.map((q) => `- [${q.ref}] ${q.who} on ${q.project}: ${q.what}${q.reply ? ` (they want: ${q.reply})` : ''}`).join('\n')}` : '',
    'Each user message is what the owner just said on the call.',
  ].filter(Boolean).join('\n\n');
}

// ---- Callers who aren't the owner: their own brain, with no office knowledge at all ---------------------------------
const CALLER_INTENTS = ['message', 'callback', 'lead', 'delivery', 'urgent', 'personal', 'availability', 'spam', 'wrong_number', 'language', 'abusive', 'other'];
const CALLER_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'What Ivy says. Spoken, 1-2 short sentences, under 30 words.' },
    intent: { type: 'string', enum: CALLER_INTENTS },
    callerName: { type: 'string', description: 'Their name if they said it, else "".' },
    company: { type: 'string', description: 'Company/organisation if said.' },
    contact: { type: 'string', description: 'A callback number or email if they gave one other than the number they called from.' },
    details: { type: 'string', description: 'The message for the owner so far, complete, in third person, plain ("Dana from Acme wants a quote for a booking app; budget about 20k").' },
    bestTime: { type: 'string', description: 'When they want to be called back, if said.' },
    notifyNow: { type: 'boolean', description: 'true = the owner must know right now (a delivery at the door, an emergency, something time-critical today).' },
    transfer: { type: 'boolean', description: 'true = they need to talk to the owner live (urgent, or they insist and are a known contact).' },
    end: { type: 'boolean', description: 'true = the call is done: you said goodbye.' },
  },
  required: ['say', 'intent', 'details', 'end'],
};
const CALLER_STYLE = (o) => [
  `You are Ivy, the personal assistant who answers the phone for ${o.ownerName}. You are an AI and say so honestly if asked. ${o.ownerName} is not available on this line; you take care of the caller.`,
  'Sound like a warm, efficient human receptionist: 1-2 short sentences, contractions, never read lists, never repeat their words back at length.',
  `Refer to ${o.ownerName} by name (or "they"); never "he", "him", "she" or "her" for ${o.ownerName}.`,
  'Always answer in English: the phone line only speaks and hears English. If they speak another language, or their words come through garbled or nonsensical (another language heard as English), use intent "language": say slowly and simply in English that you only speak English and that you will let the owner know they called, then end.',
  `Privacy, always: never share where ${o.ownerName} is, ${o.ownerName}'s schedule, address, other numbers, family, clients, projects or anything about the work. "I can't share that, but I'll pass on a message." You know nothing about the business, so never make things up.`,
  'Work out why they are calling and handle it:',
  '- message / callback: get what it is about, their name once (unless known), and when is good to call back. Then confirm you\'ll pass it on and ask "Anything else?".',
  '- lead (a new client, a business enquiry, wants a quote or to work together): get name, company, what they need, timeline/budget if they offer it, and the best way to reach them. Don\'t promise prices or dates.',
  '- delivery (courier, package, someone at the door): get who and what, set notifyNow, tell them you\'re letting ${o.ownerName} know right now.',
  '- urgent (emergency, something that can\'t wait today): set notifyNow; if they need to talk to ${o.ownerName} live, set transfer and say you\'ll try to put them through.',
  '- personal (a friend/family member, often a known contact): be warm; if they ask to talk to ${o.ownerName}, set transfer when they are a known contact; otherwise take a message.',
  `- availability ("is he there?", "when is he back?"): "${o.ownerName} isn't available right now" and offer to take a message. No times.`,
  '- spam / sales / robocall / surveys: one polite line that you\'re not interested, then end. wrong_number: say so kindly, then end.',
  '- language: see above (English only).',
  '- abusive: one calm line that you\'re ending the call, then end.',
  'Ask one thing at a time. Don\'t ask for their number: you already have it. When they say no / that\'s it / thanks after "Anything else?", say a short goodbye and set end.',
  'Keep "details" up to date every turn with everything the owner should know.',
].join('\n');

/** One caller turn (not the owner). No tools, no office context. Resolves to the parsed turn or null. */
function callerTurn(root, { heard, history = [], caller = {}, ownerName = 'the owner', signal }, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const convo = history.slice(-12).map((h) => `${h.who === 'ivy' ? 'Ivy' : 'Caller'}: ${h.text}`).join('\n');
    const prompt = [CALLER_STYLE({ ownerName }), `Now: ${nowLine()}.`,
      caller.known ? `This caller is a known contact: ${caller.name}${caller.note ? ` (${caller.note})` : ''}. Greet them by first name; you may put them through if they ask to talk to ${ownerName}.` : 'This caller is not in the contacts.',
      caller.repeat ? 'They already called earlier today; their earlier message was passed on.' : '',
      caller.transferFailed ? `You tried to put them through and ${ownerName} didn't pick up: take a message instead.` : '',
      convo ? `The call so far:\n${convo}` : '', `Caller: ${heard}`].filter(Boolean).join('\n\n');
    const args = ['-p', prompt, '--model', 'haiku', '--effort', 'low', '--max-budget-usd', '0.2', '--output-format', 'json', '--json-schema', JSON.stringify(CALLER_SCHEMA),
      '--disallowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent'];
    let out = '';
    const c = spawn('claude', args, { cwd: require('os').tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SM_ROLE: 'auditor' } }); // not the office folder: nothing to read
    const t = setTimeout(() => c.kill(), timeoutMs);
    signal?.addEventListener?.('abort', () => c.kill(), { once: true });
    c.stdout.on('data', (x) => (out += x));
    c.on('error', () => { clearTimeout(t); resolve(null); });
    c.on('close', (code, sig) => { clearTimeout(t); if (sig) return resolve(null); try { const j = JSON.parse(out); resolve(j.is_error ? null : (j.structured_output || null)); } catch { resolve(null); } });
  });
}

// ---- Ivy calling someone FOR the owner (deliver a message, confirm a booking, ask one thing) -------------------------
const CALLOUT_OUTCOMES = ['delivered', 'confirmed', 'declined', 'rescheduled', 'answered', 'callback', 'wrong_person', 'unclear'];
/** The system prompt for an outbound call on the owner's behalf (one warm session per call, ACTION line at the end). */
function delegateSystem({ ownerName = 'the owner', name = '', goal = 'deliver', message = '', details = '' } = {}) {
  const who = name ? name.split(' ')[0] : 'them';
  const task = goal === 'confirm' ? `Confirm this with ${who}: ${message}` : goal === 'ask' ? `Ask ${who} this and get a clear answer: ${message}` : `Deliver this message to ${who}: ${message}`;
  return [
    `You are Ivy, ${ownerName}'s assistant, on a phone call you placed on ${ownerName}'s behalf to ${name || 'this person'}. You are an AI assistant and say so if asked.`,
    `Your one job: ${task}${details ? `\nDetails you may use: ${details}` : ''}`,
    `They have just heard: "Hi${name ? ` ${who}` : ''}, this is Ivy, ${ownerName}'s assistant." Their first words come next.`,
    `- If it isn't ${name || 'the right person'}, ask kindly to speak with them or whether they can pass on a message; if not, apologise and end.`,
    `- Get to the point in your first reply. Listen to their answer. If they ask something you don't know, say you'll pass it to ${ownerName}. Never share anything else about ${ownerName} (where they are, schedule, address, other people).`,
    `- Refer to ${ownerName} by name (or "they"), never he/she. Short, warm, natural phone sentences; contractions; no lists.`,
    '- Wrap up within a few exchanges: thank them, say goodbye, and end.',
    'Format: write only what you say out loud. Then ONE last line that is never spoken:',
    `ACTION: {"outcome": "${CALLOUT_OUTCOMES.join('|')}", "result": "what they said or agreed, short, third person", "end": true|false}`,
    'Every reply has the ACTION line; set end true only when you said goodbye.',
  ].join('\n');
}

module.exports = { delegateSystem, CALLOUT_OUTCOMES, voiceSystem, callerTurn, CALLER_SCHEMA, CALLER_INTENTS, createChat, classify, quickReply, spokenBriefing, claudeTurn, nowLine, TURN_SCHEMA };

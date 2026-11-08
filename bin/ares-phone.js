'use strict';
/**
 * The office phone. The secretary (Ivy) answers inbound calls; ARES still rings the owner (`call`) and the owner can text
 * him on WhatsApp (`handleWhatsApp`). `serve` is the small public port: only the signed webhooks and the call socket.
 * Two stacks, switched by `phone_stack` in the "sms" integration: `relay` (default; Twilio ConversationRelay: streaming
 * sentences, Twilio cuts the speech when the caller barges in) and `gather` (fallback, no extra service; Polly Neural).
 * Every call writes a record (bin/call-log.js). Keys come from the "sms" integration and the root .env; never printed.
 */
const crypto = require('crypto');
const http = require('http');
const path = require('path');

const PORT = 4781;
const e164 = (s) => { const d = String(s || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, ''); return d ? (d.startsWith('+') ? d : `+${d}`) : ''; };
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of url + sorted key+value pairs. */
function twilioSignature(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(data).digest('base64');
}

function createPhone(root, { fetchFn = globalThis.fetch, integrations, voice, onPrompt, webhookBudgetMs = 10000, callLog, desk, hints, errors, pulse, today, officeInfo, onCallEnded, endedDelayMs = 1500, delegateSession, callerBrain, canTransfer, ownerName, ownerPin, onUrgent, transferDelayMs = 2500, google, wsModule, idleMs = { first: 30000, second: 15000 }, fillerMs = 1000, answerMs = 25000, isOff = () => false } = {}) {
  const I = integrations || require('./integrations.js').createIntegrations(root);
  const V = voice || require('./voice.js').createVoice(root);
  const CL = callLog === undefined ? require('./call-log.js').createCallLog(root) : callLog;
  const wsLib = () => { if (wsModule !== undefined) return wsModule; for (const m of ['ws', path.join(root, 'pixel-office', 'node_modules', 'ws'), path.join(root, 'pixel-office', 'server', 'node_modules', 'ws')]) { try { return require(m); } catch { /* try next */ } } return null; };
  const clips = new Map(); // random id -> mp3 Buffer (served to Twilio while the call connects)
  const cfg = () => { const c = I.get('sms') || {}; return { sid: c.account_sid || '', token: c.auth_token || '', from: c.from_number || '', owner: e164(c.owner_phone), wa: e164(c.whatsapp_from), pub: String(c.public_url || '').replace(/\/+$/, ''), stack: String(c.phone_stack || '').toLowerCase(), relayVoice: c.relay_voice || '', ttsProvider: c.relay_tts_provider || '', sttProvider: c.relay_stt_provider || '', sttModel: c.relay_stt_model || '', eotThreshold: String(c.relay_eot_threshold || ''), speechTimeout: String(c.relay_speech_timeout || ''), relayHints: c.relay_hints || '', gatherVoice: c.gather_voice || '', secretary: c.secretary_name || '' }; };
  const auth = (c) => `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`;
  const api = async (c, p, form) => {
    const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/${p}`, { method: form ? 'POST' : 'GET', headers: { Authorization: auth(c), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw bad(`Twilio said ${r.status}: ${j.message || 'error'}`, 502);
    return j;
  };
  /** The "from number" may be saved as a Twilio number SID (PN…); turn it into +E.164. */
  async function fromNumber(c) {
    if (/^PN/.test(c.from)) { const j = await api(c, `IncomingPhoneNumbers/${c.from}.json`); return j.phone_number; }
    return e164(c.from);
  }
  const status = () => { const c = cfg(); return { twilio: !!(c.sid && c.token && c.from), ownerPhone: !!c.owner, voice: V.status().enabled, whatsapp: !!(c.wa && c.owner), publicUrl: !!c.pub, inbound: !!(c.owner && c.pub && c.token), voiceWebhook: c.pub ? `${c.pub}/ares/voice` : '', stack: stackFor(c), statusCallback: c.pub ? `${c.pub}/ares/status` : '' }; };

  /** ARES rings the owner and says `text`. ElevenLabs audio when a public_url is saved (Twilio must fetch it); else Twilio's own voice. */
  async function call(text, { to } = {}) {
    const c = cfg();
    const say = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!say) throw bad('text required');
    if (isOff()) throw bad('The phone line is switched off (sm phone --on).', 503);
    if (!c.sid || !c.token || !c.from) throw bad('Link Twilio first (Zoo → SMS the Fox).', 503);
    const dest = e164(to) || c.owner;
    if (!dest) throw bad('Add your phone number (owner_phone) to the SMS the Fox settings.', 503);
    let twiml = `<Response><Say voice="${xml(c.gatherVoice || 'Polly.Joanna-Neural')}">${xml(say)}</Say></Response>`;
    let engine = 'twilio';
    const st = newState(c, { from: dest, direction: 'out', isOwner: true, stack: stackFor(c) });
    st.announce = say.slice(0, 200); spoke(st, say);
    if (stackFor(c) === 'relay') { // the owner can interrupt and answer back: the secretary stays on the line
      twiml = relayTwiml(c, st, say); engine = 'relay';
    } else if (c.pub && V.status().enabled) {
      const { audio } = await V.speak({ text: say });
      const id = crypto.randomBytes(16).toString('hex');
      clips.set(id, audio); setTimeout(() => clips.delete(id), 10 * 60 * 1000).unref?.();
      twiml = `<Response><Play>${xml(`${c.pub}/ares/audio/${id}.mp3`)}</Play></Response>`;
      engine = 'elevenlabs';
    }
    const form = { To: dest, From: await fromNumber(c), Twiml: twiml };
    if (c.pub) Object.assign(form, { StatusCallback: `${c.pub}/ares/status`, StatusCallbackMethod: 'POST', MachineDetection: 'Enable', AsyncAmd: 'true', AsyncAmdStatusCallback: `${c.pub}/ares/status`, AsyncAmdStatusCallbackMethod: 'POST' });
    let j;
    try { j = await api(c, 'Calls.json', form); } catch (e) { st.statusOutcome = 'failed'; st.failed = true; finish(st); throw e; }
    st.callSid = j.sid; sessions.set(j.sid, st); record(st); // logged at dial time, so a call nobody picks up still leaves a record
    return { sid: j.sid, to: dest, engine };
  }
  // ---- Ivy calls someone FOR the owner (deliver / confirm / ask) ----------------------------------------------------
  const CC2 = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);
  /** "052…" (a local number) → +972 52… using the owner's own country code; "+…" stays. */
  function toE164(n, owner) {
    const d = String(n || '').replace(/[^\d+]/g, ''); if (d.startsWith('+')) return d; if (d.startsWith('00')) return `+${d.slice(2)}`;
    const o = String(owner || '').replace(/\D/g, ''); const cc = o.startsWith('1') || o.startsWith('7') ? o[0] : CC2.has(o.slice(0, 2)) ? o.slice(0, 2) : o.slice(0, 3);
    return d.startsWith('0') && cc ? `+${cc}${d.slice(1)}` : `+${d}`;
  }
  /** Place the call. One warm delegate session (bin/voice-brain.js) runs the conversation; voicemail gets the message. */
  async function callOut({ to, name = '', message, goal = 'deliver' } = {}) {
    const c = cfg();
    if (!c.sid || !c.token || !c.from) throw bad('Link Twilio first (Zoo → SMS the Fox).', 503);
    if (isOff()) throw bad('The phone line is switched off, so I can\'t call anyone. Turn it on with: sm phone --on', 503);
    if (stackFor(c) !== 'relay') throw bad('Calling for you needs the live voice line (relay).', 503);
    const dest = toE164(to, c.owner); if (dest.replace(/\D/g, '').length < 8) throw bad('That phone number looks too short.');
    const msg = String(message || '').trim(); if (!msg) throw bad('What should I tell them?');
    const st = newState(c, { from: dest, direction: 'out', isOwner: false, stack: 'relay' });
    st.callerName = name; st.delegate = { name, message: msg, goal, outcome: '', result: '' };
    const first = name ? cap(name.split(' ')[0]) : '';
    const hello = `Hi${first ? ` ${first}` : ''}, this is ${secretaryName()}, ${ownerFirst()}'s assistant.`;
    st.announce = hello; spoke(st, hello);
    if (delegateSession) { try { st.session = delegateSession({ ownerName: ownerFirst(), name, goal, message: msg }); } catch { st.session = null; } }
    const form = { To: dest, From: await fromNumber(c), Twiml: relayTwiml(c, st, hello) };
    if (c.pub) Object.assign(form, { StatusCallback: `${c.pub}/ares/status`, StatusCallbackMethod: 'POST', MachineDetection: 'DetectMessageEnd', AsyncAmd: 'true', AsyncAmdStatusCallback: `${c.pub}/ares/status`, AsyncAmdStatusCallbackMethod: 'POST' });
    let j;
    try { j = await api(c, 'Calls.json', form); } catch (e) { st.statusOutcome = 'failed'; st.failed = true; finish(st); throw e; }
    st.callSid = j.sid; sessions.set(j.sid, st); record(st);
    return { sid: j.sid, to: dest };
  }
  /** One turn of a call Ivy placed for the owner: the delegate session answers; its ACTION carries the outcome. */
  async function delegateReply(st, heard, { stale, onSentence } = {}) {
    let r = st.session && st.session.alive ? await st.session.ask(heard, { onSentence, stale }) : null;
    if (!r && !stale?.() && delegateSession && !st.reopened) { // the session stalled or died: one fresh session, same task
      st.reopened = true; try { st.session?.close(); } catch { /* gone */ }
      try { const d = st.delegate; st.session = delegateSession({ ownerName: ownerFirst(), name: d.name, goal: d.goal, message: d.message }); r = await st.session.ask(heard, { onSentence, stale }); } catch { r = null; }
    }
    if (stale?.()) return '';
    if (!r || !String(r.say || '').trim()) { st.wantsEnd = true; st.delegate.outcome = st.delegate.outcome || 'unclear'; return `Sorry, I'm having trouble on my end. I'll let ${ownerFirst()} know to reach you directly. Bye for now.`; }
    if (r.outcome) st.delegate.outcome = String(r.outcome);
    if (r.result) st.delegate.result = String(r.result).slice(0, 600);
    if (r.end === true || r.end === 'true') st.wantsEnd = true;
    record(st);
    return String(r.say).trim();
  }

  async function whatsapp(text, { to } = {}) {
    const c = cfg();
    if (!c.wa) throw bad('Add whatsapp_from (the Twilio WhatsApp sender) to the SMS the Fox settings.', 503);
    const dest = e164(to) || c.owner;
    if (!dest) throw bad('Add your phone number (owner_phone) first.', 503);
    const j = await api(c, 'Messages.json', { To: `whatsapp:${dest}`, From: `whatsapp:${c.wa}`, Body: String(text).slice(0, 1500) });
    return { sid: j.sid };
  }

  /** Twilio abandons a webhook after ~15s: wait this long for ARES, then hand the rest to a follow-up. */
  const SLOW = Symbol('slow');
  const withinBudget = (p, ms = webhookBudgetMs) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(SLOW), ms); })]).finally(() => clearTimeout(t)); };

  /** Twilio webhook for an incoming WhatsApp message. Returns TwiML. Only the owner's number may prompt ARES. */
  async function handleWhatsApp(params, signature) {
    const c = cfg();
    if (!c.token || !c.pub) throw bad('not configured', 503);
    const want = twilioSignature(c.token, `${c.pub}/ares/whatsapp`, params);
    const a = Buffer.from(want); const b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('bad signature', 403);
    if (!c.owner || e164(params.From) !== c.owner) throw bad('not the owner', 403);
    const body = String(params.Body || '').trim();
    if (!body) return '<Response/>';
    const work = Promise.resolve(onPrompt ? onPrompt(body, { context: fullContext(), briefing: deskBriefing(), today: todaySpoken(), channel: 'text' }) : null);
    const reply = await withinBudget(work);
    if (reply === SLOW) { // too slow for the webhook: answer as a normal WhatsApp message when ready
      work.then((r) => whatsapp(r || SORRY, { to: params.From.replace(/^whatsapp:/, '') }), () => whatsapp(SORRY, { to: params.From.replace(/^whatsapp:/, '') })).catch(() => {});
      return '<Response/>';
    }
    return `<Response><Message>${xml(reply || SORRY)}</Message></Response>`;
  }

  // ---- The secretary's conversation core (shared by both stacks) --------------------------------------------------
  const BYE = /^(?:(?:ok|okay|alright|great|perfect|thanks|thank you)[,.!\s]+)*(bye|goodbye|good bye|talk (?:to you )?(?:soon|later)|that'?s (?:all|it|everything)|that is all|hang up|nothing else|no thanks?|i'?m good|all good|no,? (?:that'?s|i'?m) (?:it|all|good|fine))\b/i;
  const NO = /^(?:no|nope|nah|no thanks?|not right now|that'?s it|nothing)[.!\s]*$/i; // ends the call only right after "Anything else?"
  const SORRY = "Sorry, I couldn't get to that just now. Try me again in a moment.";
  const FILLER = 'One sec.';
  // Spoken when nothing has come back after ~1s: short, neutral, never the same twice in a row (silence past ~1s reads as broken).
  const FILLERS = ['Mm.', 'Okay.', "Let's see.", 'Mm-hmm.', 'One sec.'];
  const pickFiller = (st) => { const opts = FILLERS.filter((f) => f !== st.lastFiller); const f = opts[Math.floor(Math.random() * opts.length)]; st.lastFiller = f; return f; };
  const BACKCHANNEL = /^(?:mm-?hm+|uh-huh|go on|sure, go on)[.!]?$/i;
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const norm = (t) => String(t || '').toLowerCase().replace(/\d+/g, (d) => WORDS[+d] || d).replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  /** Her own voice coming back down the line (speakerphone): a short phrase she just said. Never answered, never a barge-in. */
  const isEcho = (st, heard) => { const h = norm(heard); if (!h || h.split(' ').length > 6) return false; return st.spoken.slice(-3).some((s) => norm(s).includes(h)); };
  const said = (st, who, text, extra = {}) => { st.transcript.push({ who, text: String(text).slice(0, 400), t: Math.round((Date.now() - st.startedAt) / 100) / 10, ...extra }); if (st.transcript.length > 80) st.transcript.shift(); };
  const spoke = (st, text, filler, extra) => { st.spoken.push(text); st.spoken = st.spoken.slice(-5); said(st, 'ivy', text, { ...(filler ? { filler: true } : {}), ...(extra || {}) }); if (filler) return; st.history.push({ who: 'ivy', text }); st.history = st.history.slice(-14); st.askedMore = /anything else\?\s*$/i.test(text); };
  const sessions = new Map(); // CallSid -> call state, until the call ends
  const sentences = (t) => String(t || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [];
  const newState = (c, { callSid, from, direction = 'in', isOwner, stack }) => ({ callSid: callSid || `x-${crypto.randomBytes(4).toString('hex')}`, from: e164(from), direction, isOwner: isOwner ?? (!!c.owner && e164(from) === c.owner), stack, startedAt: Date.now(), turns: 0, interrupts: 0, utterances: [], spoken: [], history: [], transcript: [], pendingWords: [], requests: [], messages: [], callerName: '', failed: false, silent: false, closed: false, intent: '', details: '', lead: {} });
  const secretaryName = () => cfg().secretary || 'Ivy';
  const val = (v) => { try { return typeof v === 'function' ? v() : v; } catch { return undefined; } };
  const ownerFirst = () => String(val(ownerName) || 'the owner').split(' ')[0];
  const DIGIT = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9' };
  /** "one two three four" / "1234" / "12 34" → "1234" */
  const spokenDigits = (t) => String(t || '').toLowerCase().replace(/[a-z]+/g, (w) => DIGIT[w] ?? ' ').replace(/\D+/g, '');
  const hashPin = (p) => crypto.createHash('sha256').update(`ivy-pin:${p}`).digest('hex');
  const D = () => { try { return (typeof desk === 'function' ? desk() : desk) || null; } catch { return null; } };
  /** What the secretary has ready: the schedule, facts, open tasks, running work, what waits on the owner, plus the briefing. Plain text for her prompt. */
  function deskContext() {
    const d = D(); if (!d) return '';
    try {
      const k = d.knowledge(); const t = (a) => a.map((x) => `- ${x.text || x.title || x.prompt || ''}${x.project ? ` [${x.project}, ${x.status}]` : ''}${x.due ? ` (due ${x.due})` : ''}`).join('\n') || '- none';
      let recent = []; try { recent = (d.checklist ? d.checklist() : []).filter((i) => !i.done && ['finished', 'failed', 'call'].includes(i.kind)).slice(0, 8); } catch { /* optional */ }
      let g = null; try { g = typeof google === 'function' ? google() : null; } catch { /* optional */ }
      const cal = g && g.events && g.events.length ? g.events.map((e) => `- ${e.when}: ${e.title}${e.where ? ` @ ${e.where}` : ''}`).join('\n') : null;
      const drv = g && g.files && g.files.length ? g.files.map((f) => `- ${f.name}${f.modified ? ` (edited ${f.modified.slice(0, 10)})` : ''}`).join('\n') : null;
      return [`Today: ${new Date().toDateString()}`, `Briefing: ${d.briefing()}`, `Google Calendar (next 14 days):\n${cal || '- none, or Google is not linked'}`, `Schedule notes:\n${t(k.schedule)}`, `Recent Google Drive files (knowledge):\n${drv || '- none'}`, `Facts:\n${t(k.facts)}`, `Open office tasks:\n${t(k.tasks)}`, `Running missions:\n${t(k.activeMissions)}`,
        `Recently finished, failed, or calls:\n${recent.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}`).join('\n') || '- none'}`,
        `Waiting on the owner:\n${k.waitingOnOwner.map((q) => `- ${q.title}: ${q.ask}`).join('\n') || '- none'}`, `Contacts:\n${k.contacts.map((x) => `- ${x.name} ${x.number}${x.note ? ` (${x.note})` : ''}`).join('\n') || '- none'}`].join('\n\n').slice(0, 9000);
    } catch { return ''; }
  }
  /** Open problems from TRACE's error log (office/errors.json), so "any errors?" has a real answer. */
  function errorsContext() {
    let list = [];
    try { list = typeof errors === 'function' ? errors() : (JSON.parse(require('fs').readFileSync(path.join(root, 'office', 'errors.json'), 'utf8')).errors || []); } catch { /* none */ }
    const open = (list || []).filter((e) => e && (e.status === 'open' || e.status === 'approved'));
    return `Open errors (TRACE's log):\n${open.slice(0, 8).map((e) => `- ${e.title}${e.project ? ` [${e.project}]` : ''}${e.count > 1 ? ` (x${e.count})` : ''}${e.status === 'approved' ? ' (ARES is fixing it)' : ''}`).join('\n') || '- none'}`;
  }
  /** Words the speech-to-text should expect: crew and project names (else "ARES" comes out as "Harris"). */
  function hintWords() {
    if (hints) return typeof hints === 'function' ? hints() : hints;
    const w = ['Ivy', 'ARES', 'Jarvis', 'MCP', 'WhatsApp', 'Firebase', 'Vercel'];
    try { for (const x of require('./staff.js').createStaff(root).load().staff) w.push(x.name); } catch { /* optional */ }
    try { for (const n of require('fs').readdirSync(path.join(root, 'projects'))) if (!n.startsWith('.')) w.push(n.replace(/-/g, ' ')); } catch { /* optional */ }
    return [...new Set(w)].slice(0, 60).join(',');
  }
  /** Her developer view (bin/devpulse.js) and the day at a glance (spoken), both optional. */
  const pulseContext = () => { try { return (typeof pulse === 'function' ? pulse() : '') || ''; } catch { return ''; } };
  const todaySpoken = () => { try { return (typeof today === 'function' ? today() : '') || ''; } catch { return ''; } };
  const officeContext = () => { try { return (typeof officeInfo === 'function' ? officeInfo() : '') || ''; } catch { return ''; } };
  const fullContext = () => [deskContext(), officeContext(), errorsContext(), pulseContext()].filter(Boolean).join('\n\n');
  /** A typed conversation with Ivy (Telegram, WhatsApp): same brain and context as a call, written replies. */
  const converse = (text, extra = {}) => Promise.resolve(onPrompt ? onPrompt(text, { context: fullContext(), briefing: deskBriefing(), today: todaySpoken(), channel: 'text', ...extra }) : '');
  const deskBriefing = () => { try { const d = D(); return (d && d.briefing()) || ''; } catch { return ''; } };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const greeting = (st) => {
    const d = D(); let who = null; try { who = d && d.recognise(st.from); } catch { /* no desk */ }
    if (who && !st.callerName) st.callerName = who.name;
    if (who) { st.contact = true; st.contactNote = who.note || ''; }
    if (!st.isOwner && CL && st.from) { try { st.repeat = CL.list({ limit: 50 }).some((x) => x.callSid !== st.callSid && x.from === st.from && !x.isOwner && Date.now() - Date.parse(x.at) < 12 * 3600000); } catch { /* log optional */ } }
    let line;
    if (st.isOwner) { // short: one heads-up at most; the details come when they ask ("what did I miss?")
      let n = 0; try { n = (d && d.knowledge().waitingOnOwner.length) || 0; } catch { /* no desk */ }
      const heads = n ? ` ${n === 1 ? "One thing's" : `${cap(WORDS[n] || String(n))} things are`} waiting on you.` : '';
      line = `Hi${who ? ` ${cap(who.name.split(' ')[0])}` : ''}, it's ${secretaryName()}.${heads} What can I do for you?`;
    } else if (st.repeat) line = `Hi${who ? ` ${cap(who.name.split(' ')[0])}` : ''}, it's ${secretaryName()} again. I passed on your earlier message. How can I help?`;
    else line = who ? `Hi ${cap(who.name.split(' ')[0])}, this is ${secretaryName()} at the office. How can I help?` : `Hi, you've reached the office, this is ${secretaryName()}. How can I help?`;
    spoke(st, line);
    return line;
  };

  /** What the secretary does with one thing the caller said. Returns a promise of her reply. */
  /**
   * One turn. `heard` is everything the caller said since her last reply (speech-to-text splits a long sentence into
   * pieces); `fragment` is the newest piece. `stale()` true = the caller kept talking: no task or note may be filed.
   * History holds finished exchanges only; the caller's words join it when her reply is delivered (`answered`).
   */
  /** The owner's call gets one warm streaming session (bin/voice-brain.js), opened as the call starts so it is ready by the first question. */
  const ensureSession = (st) => { if (st.isOwner && !st.session && onPrompt?.openSession) { try { st.session = onPrompt.openSession({ context: fullContext() }); } catch { st.session = null; } } };
  function ask(st, heard, { fragment = heard, stale, signal, onSentence, continued } = {}) {
    st.turns++; st.utterances.push(fragment); said(st, 'caller', fragment); record(st);
    if (st.delegate) return delegateReply(st, heard, { stale, onSentence }); // a call Ivy placed for the owner
    if (!st.isOwner) { // callers never reach the office: their own brain, no office knowledge
      const pin = pinStep(st, fragment); if (pin) return Promise.resolve(pin);
      if (!callerBrain) return Promise.resolve(takeMessage(st, fragment));
      return callerReply(st, heard, fragment, { stale, signal });
    }
    const history = st.history.slice();
    // context/briefing/today are getters: built only if this turn needs them (a warm session already has the desk)
    const opts = { thread: `call:${st.callSid}`, history, channel: 'phone', stale, signal, onFiled: (t) => st.requests.push(t), onConnect: (number, name) => { st.transferTo = number; st.connecting = name; }, onHangup: () => { st.wantsEnd = true; }, session: st.session, onSentence, continued,
      get context() { return fullContext(); }, get briefing() { return deskBriefing(); }, get today() { return todaySpoken(); } };
    return Promise.resolve().then(() => (onPrompt ? onPrompt(heard, opts) : null)).then((r) => {
      record(st);
      if (!r) { st.failed = true; return SORRY; }
      return r;
    }, () => { st.failed = true; record(st); return SORRY; });
  }
  /**
   * The owner calling from another phone: "it's Alex" → PIN → full access. The PIN is stored hashed (ownerPin is the
   * hash). Two wrong tries and she carries on as with any caller.
   */
  function pinStep(st, heard) {
    const want = val(ownerPin); if (!want) return null;
    if (st.pinPending) {
      st.pinPending = false;
      if (hashPin(spokenDigits(heard)) === want) { st.isOwner = true; st.verified = true; ensureSession(st); st.history = []; st.pendingWords = []; record(st); return `Thanks, ${ownerFirst()}. You're in. What can I do for you?`; }
      st.pinFails = (st.pinFails || 0) + 1;
      if (st.pinFails >= 2) return "Sorry, that doesn't match. I can take a message instead. What's it about?";
      st.pinPending = true; return "That didn't match. Try once more?";
    }
    if (st.pinFails) return null;
    const me = new RegExp(`\\b(?:it'?s|this is|i'?m|i am)\\s+(?:${ownerFirst().replace(/[^\w]/g, '')}|the owner|your boss)\\b|^(?:hey ivy,? )?it'?s me\\b`, 'i');
    if (me.test(heard)) { st.pinPending = true; return "Hi! Before I open things up, what's your PIN?"; }
    return null;
  }
  const MESSAGE_INTENTS = ['message', 'callback', 'lead', 'delivery', 'urgent', 'personal', 'availability', 'other', 'language'];
  /** A caller (not the owner): the caller brain works out why they called and what to do; deterministic if it fails. */
  async function callerReply(st, heard, fragment, { stale, signal } = {}) {
    let r = null;
    try { r = await callerBrain({ heard, history: st.history.slice(), caller: { known: !!st.contact, name: st.callerName, note: st.contactNote, repeat: !!st.repeat, transferFailed: !!st.transferFailed }, ownerName: ownerFirst(), signal }); } catch { r = null; }
    if (stale?.()) return '';
    if (!r || !String(r.say || '').trim()) return takeMessage(st, fragment); // the brain failed: the plain message-taker still works
    if (r.callerName && !st.callerName) st.callerName = String(r.callerName).slice(0, 60);
    st.intent = r.intent || st.intent || 'other';
    if (r.details) st.details = String(r.details).slice(0, 1200);
    for (const k of ['company', 'contact', 'bestTime']) if (r[k]) st.lead[k] = String(r[k]).slice(0, 120);
    if (MESSAGE_INTENTS.includes(st.intent)) st.messages.push(fragment);
    record(st);
    let say = String(r.say).trim();
    if (r.notifyNow && !st.notifiedNow && onUrgent) { st.notifiedNow = true; try { onUrgent(snapshot(st)); } catch { /* best effort */ } }
    if (r.transfer && !st.transferFailed) {
      let ok = false; try { ok = !!(canTransfer && canTransfer(snapshot(st))); } catch { ok = false; }
      const owner = cfg().owner;
      if (ok && owner) { st.transferTo = owner; st.connecting = ownerFirst(); }
      else { if (!st.notifiedNow && onUrgent) { st.notifiedNow = true; try { onUrgent(snapshot(st)); } catch { /* best effort */ } }
        say = `${say.replace(/\s*[^.!?]*(?:put you through|connect you|transfer)[^.!?]*[.!?]?/i, '')} I can't put calls through right now, but I've let ${ownerFirst()} know.`.trim(); }
    }
    if (r.end) st.wantsEnd = true;
    return say;
  }
  const snapshot = (st) => ({ callSid: st.callSid, from: st.from, callerName: st.callerName, contact: !!st.contact, intent: st.intent, details: st.details, lead: { ...st.lead }, messages: [...st.messages] });

  /** Put the live call through to `st.transferTo` (owner or a contact). Twilio replaces the call's TwiML with a Dial;
   *  when the dial ends Twilio asks /ares/voice?after=dial, which hangs up (answered) or brings Ivy back. */
  async function dialTwiml(c, st) {
    const from = await fromNumber(c);
    return `<Response><Dial timeout="20" callerId="${xml(from)}" action="${xml(`${c.pub}/ares/voice?after=dial`)}" method="POST">${xml(st.transferTo)}</Dial></Response>`;
  }
  async function transfer(st) {
    const c = cfg(); st.transferring = true; record(st);
    try { await api(c, `Calls/${st.callSid}.json`, { Twiml: await dialTwiml(c, st) }); }
    catch { st.transferring = false; st.transferFailed = true; st.transferTo = null; }
  }

  /** A stranger: take the message, get a name once, keep it short. */
  function takeMessage(st, heard) {
    const first = (s) => s.split(' ')[0];
    if (st.askedName && !st.callerName) { // they are answering "who should I say called?"
      st.askedName = false;
      const nm = heard.replace(/^(?:(?:yeah|yes|sure|oh|um|uh)[,\s]+)*(?:it'?s|this is|my name is|i'?m|i am|tell (?:him|her|them) it'?s)\s+/i, '').replace(/[.!?,]+$/, '').trim();
      if (nm && nm.split(/\s+/).length <= 3) { st.callerName = nm.split(/\s+/).map(cap).join(' '); record(st); return `Thanks, ${first(st.callerName)}. I'll make sure they get your message. Anything else?`; }
    }
    const nm = heard.match(/\b(?:this is|my name is|it'?s|i am|i'm)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/);
    if (nm && !st.callerName) st.callerName = nm[1];
    st.messages.push(heard); record(st);
    if (!st.callerName && st.messages.length === 1) { st.askedName = true; return 'Got it. And who should I say called?'; }
    return st.messages.length === 1 ? `Thanks${st.callerName ? `, ${first(st.callerName)}` : ''}. I'll make sure they get your message. Anything else?` : "Got it, I'll add that. Anything else?";
  }
  /** Does this utterance end the call? A plain "no" only right after she asked "Anything else?". */
  const answered = (st, heard) => { st.history.push({ who: st.isOwner ? 'owner' : 'caller', text: heard }); st.pendingWords = []; };
  // "No. That's it. Thank you." right after "Anything else?" is a goodbye, not a second message. Unless it carries a
  // new ask ("no, but tell him…"), a short reply made only of closing words ends the call.
  const CLOSING = /^(?:(?:no|nope|nah|nothing|nothing else|that'?s it|that'?s all|that'?s everything|i'?m good|all good|i'?m fine|no thanks?|no thank you|thanks|thank you|thank you so much|thanks a lot|ok|okay|great|perfect|bye|goodbye|bye bye|have a good (?:one|day)|talk soon|cheers)[ ]*)+$/;
  const ends = (st, heard) => {
    if (BYE.test(heard)) return true;
    const t = norm(heard);
    return !!st.askedMore && t.split(' ').length <= 10 && CLOSING.test(t);
  };
  function outcomeOf(st) {
    if (st.delegate) return st.voicemailLeft ? 'voicemail-left' : (st.delegate.outcome ? `callout-${st.delegate.outcome}` : st.turns ? 'callout-unclear' : st.statusOutcome || (st.connected ? 'callout-no-reply' : 'calling'));
    if (st.blocked) return 'blocked';
    if (st.statusOutcome) return st.statusOutcome;
    if (st.transferred) return 'transferred';
    if (st.intent === 'spam') return 'spam';
    if (st.intent === 'wrong_number') return 'wrong-number';
    if (st.intent === 'abusive') return 'abusive';
    if (st.failed && !st.requests.length && !st.messages.length) return 'error';
    if (st.requests.length) return 'request-filed';
    if (st.messages.length) return 'message-taken';
    if (st.silent) return 'silent';
    if (st.turns) return 'owner-chat';
    if (st.direction === 'out') return st.connected || st.completed ? 'delivered' : 'calling';
    return 'hung-up-early';
  }
  function summaryOf(st) {
    const said = st.utterances.join(' / ').slice(0, 400);
    if (st.blocked) return 'Call refused (not signed correctly or not allowed).';
    if (st.direction === 'out' && !st.turns) return `We called: "${st.announce || ''}" (${outcomeOf(st)}).`;
    if (st.delegate) return `Called ${st.delegate.name || st.from} to ${st.delegate.goal}: "${st.delegate.message}"${st.delegate.result ? ` — ${st.delegate.result}` : ''}${st.voicemailLeft ? ' (left a voicemail)' : ''}`;
    if (st.transferred) return `Put through to ${st.connecting || 'the owner'}.${st.details ? ` ${st.details}` : ''}`;
    if (st.details && !st.isOwner) return `${st.callerName ? `${st.callerName}: ` : ''}${st.details}`;
    if (st.messages.length) return `Message${st.callerName ? ` from ${st.callerName}` : ''}: ${said}`;
    if (st.requests.length) return `Asked to add: ${st.requests.join(' / ').slice(0, 400)}`;
    return said ? `Talked about: ${said}` : 'No words were said.';
  }
  function record(st) {
    if (!CL) return;
    try {
      CL.upsert({ callSid: st.callSid, direction: st.direction, from: st.from, callerName: st.callerName, isOwner: st.isOwner, stack: st.stack, outcome: outcomeOf(st), summary: summaryOf(st), requests: st.requests, messages: st.messages, transcript: st.transcript, ...(st.intent ? { intent: st.intent } : {}), ...(st.details ? { details: st.details } : {}), ...(Object.keys(st.lead || {}).length ? { lead: st.lead } : {}), ...(st.verified ? { verified: true } : {}), ...(st.delegate ? { delegate: st.delegate } : {}), turns: st.turns, interrupts: st.interrupts, ...(st.lastHeard ? { lastInterrupted: st.lastHeard } : {}), ...(st.answeredBy ? { answeredBy: st.answeredBy } : {}), durationSec: Math.round((Date.now() - st.startedAt) / 1000), ...(st.closed ? { endedAt: new Date().toISOString() } : {}) });
    } catch { /* the log must never break a call */ }
  }
  const ended = new Map(); // CallSid -> state, two minutes after a call ends (a dropped relay can be picked up again)
  const finish = (st) => {
    if (st.closed) return; st.closed = true; record(st); sessions.delete(st.callSid);
    if (st.session && !st.transferring) { try { st.session.close(); } catch { /* gone */ } st.session = null; }
    ended.set(st.callSid, st); setTimeout(() => ended.delete(st.callSid), (st.transferring ? 120 : 2) * 60 * 1000).unref?.();
    if (st.transferring) return; // the call is being put through: reported when the dial ends
    if (!st.reported && onCallEnded) { st.reported = true; setTimeout(() => { try { onCallEnded({ ...st, outcome: outcomeOf(st), summary: summaryOf(st) }); } catch { /* never breaks a call */ } }, endedDelayMs).unref?.(); }
  };

  // ---- Stack A: Twilio ConversationRelay (streaming, barge-in handled by Twilio) ---------------------------------------
  const nonces = new Map(); // one-time url token -> call state, valid for two minutes
  const stackFor = (c) => (c.stack !== 'gather' && /^https:/.test(c.pub) && wsLib() ? 'relay' : 'gather');
  const attr = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}="${xml(v)}"`).join(' ');
  /**
   * The voice: ElevenLabs v4 (Twilio's recommended model: ~100ms to first audio, most natural) with a little more
   * expression (stability 0.4, similarity 0.8). relay_voice overrides it; a bare voice id gets the same model + settings.
   */
  const relayVoiceOf = (c) => { const v = c.relayVoice || V.voiceId?.() || '21m00Tcm4TlvDq8ikWAM'; return /-/.test(v) ? v : `${v}-v4-0.4_0.8`; };
  function relayTwiml(c, st, greet) {
    const n = crypto.randomBytes(16).toString('hex');
    nonces.set(n, st); setTimeout(() => nonces.delete(n), 2 * 60 * 1000).unref?.();
    const wss = `${c.pub.replace(/^https:/, 'wss:')}/ares/relay?n=${n}`;
    const a = attr({ url: wss, welcomeGreeting: greet, welcomeGreetingInterruptible: 'any', ttsProvider: c.ttsProvider || 'ElevenLabs', voice: relayVoiceOf(c), transcriptionProvider: c.sttProvider || 'Deepgram', speechModel: c.sttModel || 'flux', eotThreshold: (c.sttModel || 'flux') === 'flux' ? (c.eotThreshold || '0.75') : undefined, language: 'en-US', hints: c.relayHints || hintWords() || undefined, interruptible: 'any', interruptSensitivity: 'medium', speechTimeout: c.speechTimeout || '1500', ignoreBackchannel: 'true', dtmfDetection: 'false', reportInputDuringAgentSpeech: 'none', partialPrompts: 'true' });
    // when the relay session ends, Twilio asks this URL what to do: hang up if we ended it, otherwise carry on (gather)
    return `<Response><Connect action="${xml(`${c.pub}/ares/voice?after=relay`)}"><ConversationRelay ${a}/></Connect></Response>`;
  }
  /**
   * One live call over the relay socket. `send(obj)` writes to Twilio, `hangup()` closes the call. Returns { onMessage, onClose }.
   * Barge-in: Twilio stops the audio itself and sends `interrupt`; we drop the rest of the answer and remember what was heard.
   */
  function relaySession(st, send, hangup) {
    let gen = 0; let idle; let idleStage = 0; let aborter = null;
    const clearIdle = () => { clearTimeout(idle); idle = null; };
    const armIdle = () => {
      clearIdle();
      idle = setTimeout(() => {
        if (st.closed) return;
        if (idleStage++ === 0) { say('Are you still there?'); armIdle(); } else { st.silent = !st.turns; say('I will let you go. Bye for now.'); end(); }
      }, idleStage ? idleMs.second : idleMs.first); idle.unref?.();
    };
    // A filler can't be barged in on: otherwise its echo on a speakerphone cuts the line before the real answer.
    const say = (text, last = true, filler = false) => { spoke(st, text, filler); for (const s of sentences(text)) send({ type: 'text', token: s.endsWith(' ') ? s : `${s} `, last: false, ...(filler ? { interruptible: false } : {}) }); if (last) send({ type: 'text', token: '', last: true }); };
    const sayRaw = (text) => { for (const s of sentences(text)) send({ type: 'text', token: s.endsWith(' ') ? s : `${s} `, last: false }); send({ type: 'text', token: '', last: true }); };
    const bye = () => (st.isOwner ? 'Okay, talk soon.' : 'Thanks for calling. Bye now.');
    function end() { st.endedByUs = true; clearIdle(); setTimeout(() => { send({ type: 'end' }); hangup?.(); }, 1500).unref?.(); }
    async function onPrompt_(heard) {
      if (isEcho(st, heard)) return; // her own words coming back: ignore, keep whatever answer is on its way
      const g = ++gen; clearIdle(); idleStage = 0;
      if (aborter) aborter.abort(); // the caller kept talking: drop the half-heard turn (and its AI run)
      if (ends(st, heard)) { st.pendingWords = []; st.utterances.push(heard); said(st, 'caller', heard); say(bye()); end(); return; } // "that's it, you can hang up" ends it now
      st.pendingWords.push(heard);
      const all = st.pendingWords.join(' ');
      const ac = typeof AbortController === 'function' ? new AbortController() : null; aborter = ac;
      const t0 = Date.now();
      const filler = setTimeout(() => { if (g === gen && Date.now() - (st.fillerAt || 0) > 9000) { st.fillerAt = Date.now(); say(pickFiller(st), false, true); } }, fillerMs); filler.unref?.(); // once per wait: a caller saying "hello?" twice doesn't hear it twice
      // Streaming: each sentence the brain finishes is spoken at once (the rest is still being written).
      let streamed = ''; let firstMs = 0;
      const onSentence = (x) => {
        if (g !== gen || st.closed) return;
        clearTimeout(filler);
        if (!streamed) firstMs = Date.now() - t0;
        streamed += `${x} `;
        send({ type: 'text', token: `${x} `, last: false });
      };
      const reply = await withinBudget(ask(st, all, { fragment: heard, stale: () => g !== gen || st.closed, signal: ac?.signal, onSentence, continued: st.pendingWords.length > 1 }), answerMs).finally(() => clearTimeout(filler));
      if (g !== gen || st.closed) return; // the caller spoke again or hung up: this answer is stale
      aborter = null;
      const r = reply === SLOW ? '' : String(reply || '');
      const sp = streamed.trim();
      // "Mm-hm." = they stopped mid-sentence: say it, but keep their words so the rest joins the same request
      if (BACKCHANNEL.test(sp || r)) { spoke(st, sp || r, true); if (sp) send({ type: 'text', token: '', last: true }); else sayRaw(r); armIdle(); return; }
      answered(st, all);
      if (sp) { // already spoken: finish the talk cycle; add only what the stream didn't say (a correction or a lookup's answer)
        const nn = (x) => x.replace(/\s+/g, ' ').trim();
        const rest = r && nn(r) !== sp ? (nn(r).startsWith(sp) ? nn(r).slice(sp.length).trim() : nn(r)) : '';
        spoke(st, rest ? `${sp} ${rest}` : sp, false, { ms: firstMs, streamed: true });
        if (rest) sayRaw(rest); else send({ type: 'text', token: '', last: true });
      } else if (reply === SLOW) { st.failed = true; say(SORRY); } else if (r) { spoke(st, r, false, { ms: Date.now() - t0 }); sayRaw(r); }
      record(st);
      if (st.transferTo && !st.transferring) { clearIdle(); setTimeout(() => { if (!st.closed || st.transferring === false) transfer(st); }, transferDelayMs).unref?.(); return; }
      if (st.wantsEnd) { end(); return; }
      armIdle();
    }
    return {
      start() { armIdle(); },
      async onMessage(m) {
        if (!m || st.closed) return;
        if (m.type === 'prompt' && m.last !== false) { const t = String(m.voicePrompt || '').trim(); if (t) await onPrompt_(t); }
        // they are talking (a partial prompt): never ask "Are you still there?" in the middle of their sentence
        else if (m.type === 'prompt') { clearIdle(); idleStage = 0; armIdle(); }
        // the caller's next prompt (not the interrupt) retires a stale answer: an echo or a cough mustn't drop it
        else if (m.type === 'interrupt') { st.interrupts++; record(st); st.lastHeard = String(m.utteranceUntilInterrupt || ''); clearIdle(); armIdle(); }
        else if (m.type === 'error') { st.failed = true; record(st); }
      },
      onClose() { clearIdle(); gen++; if (aborter) aborter.abort(); finish(st); },
    };
  }

  // ---- Stack B: classic <Gather> fallback (no new keys; Polly Neural; every sentence is interruptible) ---------------
  const pending = new Map(); // CallSid -> { p, at } while a slow answer is still being worked out
  function gatherReply(c, st, text) {
    const voice = c.gatherVoice || 'Polly.Joanna-Neural';
    if (st && text.trim() && st.spoken[st.spoken.length - 1] !== text) spoke(st, text);
    const say = sentences(text).slice(0, 4).map((s) => `<Say voice="${xml(voice)}">${xml(s.trim())}</Say>`).join('');
    return `<Response><Gather input="speech" speechTimeout="auto" bargeIn="true" action="${xml(`${c.pub}/ares/voice`)}" method="POST">${say}</Gather><Say voice="${xml(voice)}">Okay, talk to you later.</Say><Hangup/></Response>`;
  }

  /** Twilio webhook for a call to the Twilio number. Signed. Owner: the secretary answers and relays; strangers: she takes a message. Returns TwiML. */
  async function handleVoice(params, signature, query = '') {
    const c = cfg();
    if (!c.token || !c.pub) throw bad('not configured', 503);
    const want = twilioSignature(c.token, `${c.pub}/ares/voice${query}`, params);
    const a = Buffer.from(want); const b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('bad signature', 403);
    if (isOff() && params.Direction === 'inbound') return '<Response><Reject reason="busy"/></Response>';
    const sid = params.CallSid;
    if (/after=dial/.test(query)) { // a put-through ended: answered → done; not answered → Ivy is back
      const old = sessions.get(sid) || ended.get(sid);
      if (!old) return '<Response><Hangup/></Response>';
      old.transferring = false;
      if (['completed', 'answered'].includes(params.DialCallStatus)) { old.transferred = true; old.closed = false; finish(old); return '<Response><Hangup/></Response>'; }
      if (params.CallStatus === 'completed') { old.closed = false; old.transferFailed = true; finish(old); return '<Response><Hangup/></Response>'; } // the caller gave up
      old.closed = false; old.reported = false; old.stack = 'gather'; old.transferFailed = true; old.transferTo = null; old.pendingWords = [];
      sessions.set(sid, old); ended.delete(sid); record(old);
      const who = old.connecting || ownerFirst();
      return gatherReply(c, old, old.isOwner ? `${who} didn't pick up. Anything else I can do?` : `${who} couldn't pick up. I'll make sure the message gets through. What should I pass on?`);
    }
    if (/after=relay/.test(query)) { // the live (relay) session ended
      const old = sessions.get(sid) || ended.get(sid);
      if (!old || old.endedByUs || params.CallStatus === 'completed') return '<Response><Hangup/></Response>';
      // the stream dropped mid-call (network, Twilio, our socket): keep the caller, carry on with the gather stack
      old.closed = false; old.reported = false; old.recovered = (old.recovered || 0) + 1; old.stack = 'gather'; old.pendingWords = [];
      sessions.set(sid, old); ended.delete(sid); record(old);
      if (old.recovered > 2) { finish(old); return `<Response><Say voice="${xml(c.gatherVoice || 'Polly.Joanna-Neural')}">Sorry, the line keeps dropping. Please call back in a minute.</Say><Hangup/></Response>`; }
      return gatherReply(c, old, "Sorry, I lost you for a second. I'm back. What were you saying?");
    }
    const stack = stackFor(c);
    let st = sid && sessions.get(sid);
    if (!st) {
      st = newState(c, { callSid: sid, from: params.From, stack });
      sessions.set(st.callSid, st); setTimeout(() => sessions.delete(st.callSid), 2 * 60 * 60 * 1000).unref?.();
      if (!st.from) { st.blocked = true; finish(st); return `<Response><Say voice="${xml(c.gatherVoice || 'Polly.Joanna-Neural')}">Sorry, I can't take this call.</Say><Hangup/></Response>`; }
      record(st);
      setImmediate(() => ensureSession(st)); // warms up while the greeting plays, after Twilio has its answer
      if (stack === 'relay') return relayTwiml(c, st, greeting(st));
    }
    const say = (t, hang) => `<Response><Say voice="${xml(c.gatherVoice || 'Polly.Joanna-Neural')}">${xml(t)}</Say>${hang ? '<Hangup/>' : ''}</Response>`;
    const wait = () => `<Response><Pause length="3"/><Redirect method="POST">${xml(`${c.pub}/ares/voice`)}</Redirect></Response>`;
    if (pending.has(st.callSid)) { // a slow answer from the last turn: keep the line alive until it is ready
      const w = pending.get(st.callSid);
      const r = await withinBudget(w.p, 3000);
      if (r === SLOW && Date.now() - w.at < 70000) return wait();
      pending.delete(st.callSid);
      return gatherReply(c, st, r === SLOW ? SORRY : String(r));
    }
    const heard = String(params.SpeechResult || '').trim();
    if (!heard) {
      if (params.SpeechResult === undefined && !st.turns) return gatherReply(c, st, greeting(st));
      if ((st.misses = (st.misses || 0) + 1) >= 2) { st.silent = !st.turns; finish(st); return say('I will let you go. Bye for now.', true); }
      return gatherReply(c, st, "Sorry, I didn't catch that.");
    }
    st.misses = 0;
    if (isEcho(st, heard)) return gatherReply(c, st, ' ');
    if (ends(st, heard)) { st.utterances.push(heard); finish(st); return say(st.isOwner ? 'Okay, talk soon.' : 'Thanks for calling. Bye now.', true); }
    const work = ask(st, heard).then((r) => { answered(st, heard); return r; });
    const reply = await withinBudget(work);
    if (reply === SLOW) { pending.set(st.callSid, { p: work, at: Date.now() }); spoke(st, FILLER, true); return `<Response><Say voice="${xml(c.gatherVoice || 'Polly.Joanna-Neural')}">${FILLER}</Say>${wait().replace(/^<Response>|<\/Response>$/g, '')}</Response>`; }
    if (st.transferTo && !st.transferring) { st.transferring = true; const v = xml(c.gatherVoice || 'Polly.Joanna-Neural'); spoke(st, String(reply)); return (await dialTwiml(c, st)).replace('<Response>', `<Response><Say voice="${v}">${xml(String(reply))}</Say>`); }
    if (st.wantsEnd) { spoke(st, String(reply)); finish(st); return say(String(reply), true); }
    return gatherReply(c, st, String(reply));
  }

  /**
   * Twilio's call-status callback (also the async answering-machine callback). Signed. Sets how a call ended:
   * no-answer / busy / failed (CallStatus), voicemail (AnsweredBy machine_* or fax), delivered (outbound answered, nobody talked).
   */
  const TERMINAL = { busy: 'busy', 'no-answer': 'no-answer', failed: 'failed', canceled: 'no-answer' };
  function handleStatus(params, signature) {
    const c = cfg();
    if (!c.token || !c.pub) throw bad('not configured', 503);
    const want = twilioSignature(c.token, `${c.pub}/ares/status`, params);
    const a = Buffer.from(want); const b = Buffer.from(String(signature || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('bad signature', 403);
    const st = sessions.get(params.CallSid);
    const answeredBy = String(params.AnsweredBy || '');
    const machine = /^(machine|fax)/.test(answeredBy);
    const outcome = TERMINAL[params.CallStatus] || (machine ? 'voicemail' : '');
    if (!st) { // a call this process never saw (e.g. restarted): still keep the record
      if (outcome && params.CallSid && CL) { try { CL.upsert({ callSid: params.CallSid, direction: params.Direction === 'inbound' ? 'in' : 'out', from: e164(params.Direction === 'inbound' ? params.From : params.To), outcome, summary: `Call ended: ${outcome}.`, endedAt: new Date().toISOString(), ...(answeredBy ? { answeredBy } : {}) }); } catch { /* ignore */ } }
      return '<Response/>';
    }
    if (answeredBy) st.answeredBy = answeredBy;
    if (outcome) st.statusOutcome = outcome;
    if (params.CallStatus === 'completed') st.completed = true;
    if (machine && st.delegate) { // their voicemail: leave the message after the beep, then hang up
      if (/^machine_end/.test(answeredBy) && !st.voicemailLeft) {
        st.voicemailLeft = true; record(st);
        const v = xml(c.gatherVoice || 'Polly.Joanna-Neural'); const d = st.delegate;
        const text = `Hi${d.name ? ` ${cap(d.name.split(' ')[0])}` : ''}, this is ${secretaryName()}, ${ownerFirst()}'s assistant. ${d.goal === 'confirm' ? 'I\'m calling to confirm: ' : d.goal === 'ask' ? 'I\'m calling to ask: ' : ''}${/[.!?]$/.test(d.message.trim()) ? d.message.trim() : `${d.message.trim()}.`} ${d.goal === 'deliver' ? '' : `Could you call ${ownerFirst()} back? `}Thanks, bye.`;
        api(c, `Calls/${params.CallSid}.json`, { Twiml: `<Response><Say voice="${v}">${xml(text)}</Say><Hangup/></Response>` }).catch(() => {});
      }
      return '<Response/>';
    }
    if (machine) { record(st); try { st.hangup?.(); } catch { /* already gone */ } return '<Response/>'; } // no point talking to a voicemail
    if (TERMINAL[params.CallStatus] || params.CallStatus === 'completed') finish(st); else record(st);
    return '<Response/>';
  }

  /** Accept a relay WebSocket (already upgraded). `n` is the one-time token from our own signed TwiML. */
  function acceptRelay(ws, n) {
    const st = nonces.get(n);
    nonces.delete(n);
    if (!st) { ws.close(); return; }
    sessions.set(st.callSid, st);
    st.connected = true; st.callSid = st.callSid || st.twilioSid;
    const rs = relaySession(st, (o) => { try { ws.send(JSON.stringify(o)); } catch { /* socket gone */ } }, () => { try { ws.close(); } catch { /* already closed */ } });
    st.hangup = () => { try { ws.close(); } catch { /* already closed */ } };
    ws.on('message', (d) => { let m; try { m = JSON.parse(String(d)); } catch { return; } if (m.type === 'setup' && m.callSid && !st.callSid.startsWith('x-')) st.twilioSid = m.callSid; Promise.resolve(rs.onMessage(m)).catch(() => { st.failed = true; record(st); }); });
    ws.on('close', () => rs.onClose());
    ws.on('error', () => { st.failed = true; });
    rs.start();
  }

  /** The only publicly reachable surface: the audio clips and the signed WhatsApp webhook. */
  function serve(port = PORT) {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const clip = u.pathname.match(/^\/ares\/audio\/([a-f0-9]{32})\.mp3$/);
      if (req.method === 'GET' && clip && clips.has(clip[1])) { const buf = clips.get(clip[1]); res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length }); return res.end(buf); }
      if (req.method === 'POST' && u.pathname === '/ares/whatsapp') {
        let raw = ''; req.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        req.on('end', async () => {
          try {
            const out = await handleWhatsApp(Object.fromEntries(new URLSearchParams(raw)), req.headers['x-twilio-signature']);
            res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(out);
          } catch (e) { res.writeHead(e.status || 500); res.end(); }
        });
        return;
      }
      if (req.method === 'POST' && u.pathname === '/ares/status') {
        let raw = ''; req.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        req.on('end', () => {
          try { const out = handleStatus(Object.fromEntries(new URLSearchParams(raw)), req.headers['x-twilio-signature']); res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(out); } catch (e) { res.writeHead(e.status || 500); res.end(); }
        });
        return;
      }
      if (req.method === 'POST' && u.pathname === '/ares/voice') {
        let raw = ''; req.on('data', (d) => { raw += d; if (raw.length > 20000) req.destroy(); });
        req.on('end', async () => {
          try {
            const out = await handleVoice(Object.fromEntries(new URLSearchParams(raw)), req.headers['x-twilio-signature'], u.search);
            res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(out);
          } catch (e) { res.writeHead(e.status || 500); res.end(); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const W = wsLib();
    if (W) {
      const wss = new W.WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
      srv.on('upgrade', (req, sock, head) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname !== '/ares/relay' || !nonces.has(u.searchParams.get('n'))) { sock.destroy(); return; }
        wss.handleUpgrade(req, sock, head, (ws) => acceptRelay(ws, u.searchParams.get('n')));
      });
    }
    srv.on('error', () => { /* port busy: another office instance already serves it */ });
    srv.listen(port, '127.0.0.1');
    return srv;
  }
  return { chat: onPrompt, status, call, callOut, toE164, whatsapp, converse, handleWhatsApp, handleVoice, handleStatus, relaySession, newState, acceptRelay, serve, calls: (o) => (CL ? CL.list(o) : []), fromNumber: () => fromNumber(cfg()), _clips: clips };
}

module.exports = { createPhone, twilioSignature, e164, PORT };

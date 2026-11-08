const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createPhone, twilioSignature } = require('../bin/ares-phone.js');
const { createCallLog } = require('../bin/call-log.js');

const sms = { account_sid: 'ACx', auth_token: 'tok', from_number: '+97211111111', owner_phone: '+972500000000', public_url: 'https://x.example' };
const OWNER = '+972500000000';
const sign = (p, path_ = 'voice') => twilioSignature('tok', `https://x.example/ares/${path_}`, p);
function mk(over = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calls-'));
  const callLog = createCallLog(dir);
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: String(init.body || '') }); return { ok: true, json: async () => ({ sid: 'CA1' }) }; };
  const phone = createPhone(dir, { fetchFn, callLog, wsModule: {}, integrations: { get: () => ({ ...sms, ...over }) }, voice: { status: () => ({ enabled: false }), voiceId: () => 'VOICE123' }, fillerMs: 30, answerMs: 120, idleMs: { first: 40, second: 40 }, ...extra });
  return { phone, calls, log: () => callLog.list({ limit: 50 }) };
}
const relay = (phone, st) => { const out = []; const rs = phone.relaySession(st, (o) => out.push(o), () => out.push({ hangup: true })); return { rs, out, text: () => out.filter((o) => o.type === 'text').map((o) => o.token).join('') }; };
const st = (phone, o = {}) => phone.newState({ owner: OWNER }, { callSid: 'CAx' + Math.random(), from: OWNER, stack: 'relay', ...o });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('inbound owner call on relay stack returns ConversationRelay TwiML with barge-in', async () => {
  const { phone, log } = mk();
  const p = { From: OWNER, CallSid: 'CA1' };
  const twiml = await phone.handleVoice(p, sign(p));
  assert.match(twiml, /<Connect action="[^"]*"><ConversationRelay [^>]*url="wss:\/\/x\.example\/ares\/relay\?n=[a-f0-9]{32}"/);
  assert.match(twiml, /interruptible="any"/);
  assert.match(twiml, /speechTimeout="1500"/, 'Flux decides when a turn ends; this is only the maximum silence');
  assert.match(twiml, /ignoreBackchannel="true"/, '"yeah" / "okay" does not cut her off');
  assert.match(twiml, /voice="VOICE123-v4-0\.4_0\.8"/);
  assert.match(twiml, /welcomeGreeting="Hi, it&apos;s Ivy/);
  assert.strictEqual(log()[0].outcome, 'hung-up-early');
});

test('phone_stack=gather switches to the Gather fallback with Neural voice and barge-in', async () => {
  const { phone } = mk({ phone_stack: 'gather' });
  const p = { From: OWNER, CallSid: 'CA2' };
  const twiml = await phone.handleVoice(p, sign(p));
  assert.match(twiml, /<Gather input="speech"[^>]*bargeIn="true"/);
  assert.match(twiml, /Polly\.Joanna-Neural/);
  assert.doesNotMatch(twiml, /Polly\.Matthew/);
});

test('no ws library: relay is unavailable, falls back to gather', async () => {
  const { phone } = mk({}, { wsModule: null });
  const p = { From: OWNER, CallSid: 'CA3' };
  assert.match(await phone.handleVoice(p, sign(p)), /<Gather/);
  assert.strictEqual(phone.status().stack, 'gather');
});

test('bad signature is refused', async () => {
  const { phone } = mk();
  await assert.rejects(phone.handleVoice({ From: OWNER, CallSid: 'CA4' }, 'bad'), (e) => e.status === 403);
});

test('missing caller id is blocked and recorded', async () => {
  const { phone, log } = mk();
  const p = { CallSid: 'CA5' };
  assert.match(await phone.handleVoice(p, sign(p)), /can't take this call[\s\S]*<Hangup\/>/);
  assert.strictEqual(log()[0].outcome, 'blocked');
});

test('owner chat streams sentence chunks, then closes with last:true; outcome owner-chat', async () => {
  const { phone, log } = mk({}, { onPrompt: async () => 'Two projects are running. Nothing is stuck.' });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'what is running', last: true });
  const toks = r.out.filter((o) => o.type === 'text');
  assert.deepStrictEqual(toks.map((t) => t.token), ['Two projects are running. ', 'Nothing is stuck. ', '']);
  assert.strictEqual(toks.at(-1).last, true);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'owner-chat');
  assert.match(log()[0].summary, /what is running/);
});

test('a request Ivy files is recorded on the call', async () => {
  const { phone, log } = mk({}, { onPrompt: async (t, o) => { o.onFiled('fix login'); return "On it, ARES has it."; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'add this to the list fix login', last: true });
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'request-filed');
  assert.deepStrictEqual(log()[0].requests, ['fix login']);
});

test('barge-in: the stale answer is dropped; the caller\'s words are answered together', async () => {
  const { phone } = mk({}, { onPrompt: (t) => new Promise((res) => setTimeout(() => res(`answer to ${t}`), t === 'first' ? 60 : 5)) });
  const s = st(phone); const r = relay(phone, s);
  const a = r.rs.onMessage({ type: 'prompt', voicePrompt: 'first', last: true });
  await wait(10);
  await r.rs.onMessage({ type: 'interrupt', utteranceUntilInterrupt: 'Two proj' });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'second', last: true });
  await a; await wait(80);
  assert.strictEqual((r.text().match(/answer to/g) || []).length, 1, 'the half-heard first turn is never spoken');
  assert.match(r.text(), /answer to first second/, 'what came after the barge-in joins what came before');
  assert.strictEqual(s.lastHeard, 'Two proj');
  r.rs.onClose();
});

test('slow answer: a filler goes out, then the answer', async () => {
  const { phone } = mk({}, { onPrompt: () => new Promise((res) => setTimeout(() => res('Done thinking.'), 70)) });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'hard one', last: true });
  assert.match(r.text(), /^(Mm|Okay|Let's see|Mm-hmm|One sec)\.\s+Done thinking\./, 'a short natural filler, then the answer');
  assert.ok(r.out.some((o) => /^(Mm|Okay|Let's see|Mm-hmm|One sec)\. $/.test(o.token) && o.interruptible === false), 'the filler cannot be barged in on');
  r.rs.onClose();
});

test('answer that never finishes: sorry message inside the cap, outcome error', async () => {
  const { phone, log } = mk({}, { onPrompt: () => new Promise(() => {}) });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'hang', last: true });
  assert.match(r.text(), /couldn't get to that/);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'error');
});

test('answer that throws: sorry message, outcome error', async () => {
  const { phone, log } = mk({}, { onPrompt: async () => { throw new Error('boom'); } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'x', last: true });
  assert.match(r.text(), /couldn't get to that/);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'error');
});

test('goodbye ends the call', async () => {
  const { phone } = mk({}, { onPrompt: async () => 'x' });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'ok bye', last: true });
  assert.match(r.text(), /talk soon/);
  await wait(1700);
  assert.ok(r.out.some((o) => o.type === 'end'));
  r.rs.onClose();
});

test('silence: asked once, then hung up, outcome silent', async () => {
  const { phone, log } = mk();
  const s = st(phone); const r = relay(phone, s);
  r.rs.start();
  await wait(120);
  assert.match(r.text(), /still there[\s\S]*Bye for now/);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'silent');
});

test('caller hangs up before speaking: hung-up-early', async () => {
  const { phone, log } = mk();
  const s = st(phone); const r = relay(phone, s);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'hung-up-early');
});

test('stranger gets a message-taker, never the office', async () => {
  let asked = 0;
  const { phone, log } = mk({}, { onPrompt: async () => { asked++; return 'secret'; } });
  const s = st(phone, { from: '+1999', isOwner: false }); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "Hi, this is Dana Cole, please call me back about the invoice", last: true });
  assert.match(r.text(), /Thanks, Dana\. I'll make sure they get your message\. Anything else\?/);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'No.', last: true });
  assert.match(r.text(), /Thanks for calling/);
  assert.strictEqual(asked, 0);
  r.rs.onClose();
  const rec = log()[0];
  assert.strictEqual(rec.outcome, 'message-taken');
  assert.strictEqual(rec.callerName, 'Dana Cole');
  assert.match(rec.summary, /invoice/);
});

test('stranger on the gather stack leaves a message and the status callback closes the record', async () => {
  const { phone, log } = mk({ phone_stack: 'gather' });
  const base = { From: '+1999', CallSid: 'CA20' };
  assert.match(await phone.handleVoice(base, sign(base)), /How can I help/);
  const talk = { ...base, SpeechResult: 'call me back' };
  assert.match(await phone.handleVoice(talk, sign(talk)), /who should I say called/);
  const name = { ...base, SpeechResult: "it's dana cole" };
  assert.match(await phone.handleVoice(name, sign(name)), /Thanks, Dana\.[\s\S]*make sure they get your message/);
  const done = { CallSid: 'CA20', CallStatus: 'completed' };
  phone.handleStatus(done, sign(done, 'status'));
  assert.strictEqual(log()[0].outcome, 'message-taken');
  assert.ok(log()[0].endedAt);
});

test('gather: two silent turns end the call as silent', async () => {
  const { phone, log } = mk({ phone_stack: 'gather' });
  const base = { From: OWNER, CallSid: 'CA21' };
  await phone.handleVoice(base, sign(base));
  const quiet = { ...base, SpeechResult: '' };
  assert.match(await phone.handleVoice(quiet, sign(quiet)), /didn&apos;t catch/);
  assert.match(await phone.handleVoice(quiet, sign(quiet)), /<Hangup\/>/);
  assert.strictEqual(log()[0].outcome, 'silent');
});

test('gather: long answers are split into sentences inside the Gather (interruptible)', async () => {
  const { phone } = mk({ phone_stack: 'gather' }, { onPrompt: async () => 'One. Two. Three.' });
  const base = { From: OWNER, CallSid: 'CA22' };
  await phone.handleVoice(base, sign(base));
  const talk = { ...base, SpeechResult: 'status' };
  const t = await phone.handleVoice(talk, sign(talk));
  assert.match(t, /<Gather[^>]*>(<Say[^>]*>[^<]*<\/Say>){3,}<\/Gather>/);
});

test('outbound call on relay lets the owner answer back', async () => {
  const { phone, calls } = mk();
  const r = await phone.call('Your mission finished.');
  assert.strictEqual(r.engine, 'relay');
  assert.match(new URLSearchParams(calls[0].body).get('Twiml'), /ConversationRelay[^>]*welcomeGreeting="Your mission finished\."/);
});

test('acceptRelay refuses an unknown token', () => {
  const { phone } = mk();
  let closed = false;
  phone.acceptRelay({ close: () => { closed = true; }, on() {}, send() {} }, 'nope');
  assert.ok(closed);
});

// ---- desk wiring: greeting by name, answers from her knowledge ----
const deskStub = (over = {}) => ({
  recognise: (n) => (n === '+1999' ? { name: 'Dana', note: 'accountant' } : null),
  knowledge: () => ({ schedule: [{ text: 'Dentist at 3pm' }], facts: [{ text: 'Wifi is blue-fox' }], contacts: [{ name: 'Dana', number: '+1999' }], tasks: [{ title: 'Renew domain', due: 'Fri' }], activeMissions: [], waitingOnOwner: [{ title: 'Pick a logo', ask: 'A or B?' }] }),
  briefing: () => 'Welcome back. 1 thing needs you: Pick a logo.',
  ...over,
});

test('desk: stranger who is a known contact is greeted by name (relay and gather)', async () => {
  const { phone } = mk({}, { desk: () => deskStub() });
  const p = { From: '+1999', CallSid: 'CA30' };
  assert.match(await phone.handleVoice(p, sign(p)), /welcomeGreeting="Hi Dana, this is Ivy at the office\. How can I help\?"/);
  const g = mk({ phone_stack: 'gather' }, { desk: () => deskStub() });
  const q = { From: '+1999', CallSid: 'CA31' };
  assert.match(await g.phone.handleVoice(q, sign(q)), /Hi Dana/);
});

test('desk: the owner gets a short greeting with one heads-up, not the whole briefing', async () => {
  const { phone } = mk({}, { desk: () => deskStub() });
  const p = { From: OWNER, CallSid: 'CA32' };
  const t = await phone.handleVoice(p, sign(p));
  assert.match(t, /welcomeGreeting="Hi, it&apos;s Ivy\. One thing&apos;s waiting on you\. What can I do for you\?"/);
  assert.doesNotMatch(t, /Pick a logo/);
});

test('desk: owner questions are answered with schedule, facts, tasks and what waits on them', async () => {
  const seen = [];
  const { phone } = mk({}, { desk: () => deskStub(), onPrompt: async (t, o) => { seen.push(o); return 'Dentist at three.'; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "what's on my schedule today", last: true });
  const ctx = seen[0].context;
  for (const w of ['Dentist at 3pm', 'blue-fox', 'Renew domain', 'Pick a logo', 'Briefing:']) assert.match(ctx, new RegExp(w));
  r.rs.onClose();
});

test('the call remembers what was said: each turn gets the conversation so far', async () => {
  const seen = [];
  const { phone } = mk({}, { onPrompt: async (t, o) => { seen.push(o.history.map((h) => `${h.who}:${h.text}`)); return `re ${t}`; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'how is bloom', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'ok fix it then', last: true });
  assert.deepStrictEqual(seen[1], ['owner:how is bloom', 'ivy:re how is bloom']);
  assert.strictEqual(seen[0].length, 0);
  r.rs.onClose();
});

test('echo: her own "One sec." coming back as "1 moment"-style speech is ignored and does not drop the answer', async () => {
  let n = 0;
  const { phone } = mk({}, { onPrompt: () => { n++; return new Promise((res) => setTimeout(() => res('Bloom is live.'), 80)); } });
  const s = st(phone); const r = relay(phone, s);
  const a = r.rs.onMessage({ type: 'prompt', voicePrompt: 'is bloom live', last: true });
  await wait(45); // filler has gone out
  await r.rs.onMessage({ type: 'interrupt', utteranceUntilInterrupt: 'One' });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: (s.lastFiller || 'One sec.').replace('One', '1'), last: true }); // her filler, heard back
  await a;
  assert.match(r.text(), /Bloom is live/);
  assert.strictEqual(n, 1, 'the echo never became a question');
  r.rs.onClose();
});

test('"no" ends the call only right after "Anything else?"', async () => {
  const { phone } = mk({}, { onPrompt: async (t) => (t === 'no' ? 'Okay, I will leave it.' : 'Want me to have ARES check?') });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'is the deploy done', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'no', last: true });
  assert.match(r.text(), /leave it/);
  assert.doesNotMatch(r.text(), /talk soon/);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "that's it, thanks", last: true });
  assert.match(r.text(), /talk soon/);
  r.rs.onClose();
});

test('desk missing or broken never breaks a call', async () => {
  const { phone } = mk({}, { desk: () => ({ recognise() { throw new Error('x'); }, knowledge() { throw new Error('x'); }, briefing() { throw new Error('x'); } }), onPrompt: async () => 'fine' });
  const p = { From: OWNER, CallSid: 'CA33' };
  assert.match(await phone.handleVoice(p, sign(p)), /Hi, it&apos;s Ivy\. What can I do/);
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'hi', last: true });
  assert.match(r.text(), /fine/);
  r.rs.onClose();
});

// ---- outbound outcomes and interrupts ----
const dial = async (over = {}, extra = {}) => {
  const m = mk(over, extra);
  await m.phone.call('Your mission finished.');
  return m;
};
const status = (phone, p) => { const q = { CallSid: 'CA1', ...p }; return phone.handleStatus(q, sign(q, 'status')); };

test('outbound call is logged at dial time and asks Twilio for status + machine detection', async () => {
  const { log, calls } = await dial();
  assert.strictEqual(log()[0].outcome, 'calling');
  assert.strictEqual(log()[0].direction, 'out');
  const f = new URLSearchParams(calls[0].body);
  assert.strictEqual(f.get('StatusCallback'), 'https://x.example/ares/status');
  assert.strictEqual(f.get('AsyncAmd'), 'true');
});

for (const [callStatus, outcome] of [['no-answer', 'no-answer'], ['busy', 'busy'], ['failed', 'failed'], ['canceled', 'no-answer']]) {
  test(`outbound ${callStatus} -> outcome ${outcome}, closed`, async () => {
    const { phone, log } = await dial();
    status(phone, { CallStatus: callStatus });
    assert.strictEqual(log()[0].outcome, outcome);
    assert.ok(log()[0].endedAt);
  });
}

test('outbound voicemail (AnsweredBy machine) -> voicemail, and we hang up on it', async () => {
  const { phone, log } = await dial();
  status(phone, { AnsweredBy: 'machine_start' });
  assert.strictEqual(log()[0].outcome, 'voicemail');
  assert.strictEqual(log()[0].answeredBy, 'machine_start');
  status(phone, { CallStatus: 'completed' });
  assert.strictEqual(log()[0].outcome, 'voicemail');
});

test('outbound answered by the owner, nobody talks -> delivered', async () => {
  const { phone, log } = await dial({ phone_stack: 'gather' });
  status(phone, { CallStatus: 'completed', AnsweredBy: 'human' });
  assert.strictEqual(log()[0].outcome, 'delivered');
  assert.match(log()[0].summary, /We called/);
});

test('Twilio refuses to dial -> failed record and the error is thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calls-'));
  const callLog = createCallLog(dir);
  const phone = createPhone(dir, { callLog, wsModule: {}, fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ message: 'bad number' }) }), integrations: { get: () => sms }, voice: { status: () => ({ enabled: false }) } });
  await assert.rejects(phone.call('hi'));
  assert.strictEqual(callLog.list()[0].outcome, 'failed');
});

test('status callback for a call we never saw still leaves a record; bad signature refused', () => {
  const { phone, log } = mk();
  const q = { CallSid: 'CAold', CallStatus: 'no-answer', Direction: 'outbound-api', To: OWNER };
  phone.handleStatus(q, sign(q, 'status'));
  assert.strictEqual(log()[0].outcome, 'no-answer');
  assert.throws(() => phone.handleStatus(q, 'bad'), (e) => e.status === 403);
});

test('interrupts are counted and kept in the call record', async () => {
  const { phone, log } = mk({}, { onPrompt: async () => 'Long answer. More.' });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'tell me', last: true });
  await r.rs.onMessage({ type: 'interrupt', utteranceUntilInterrupt: 'Long ans' });
  await r.rs.onMessage({ type: 'interrupt', utteranceUntilInterrupt: 'Long' });
  r.rs.onClose();
  assert.strictEqual(log()[0].interrupts, 2);
  assert.strictEqual(log()[0].lastInterrupted, 'Long');
});

test('checklist shows owner calls nobody answered', () => {
  const { createSecretary } = require('../bin/secretary.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const sec = createSecretary(dir, { calls: () => [{ callSid: 'A', isOwner: true, outcome: 'no-answer', summary: 'We called', at: new Date().toISOString() }] });
  assert.match(sec.checklist()[0].title, /missed our call/);
});

// ---- from the owner's first real call (2026-10-30): fragments, mishearing, transcript ----
test('a sentence split into pieces is answered once, as a whole; half-heard turns file nothing', async () => {
  const filed = []; const heardAll = [];
  const onPrompt = (t, o) => { heardAll.push(t); return new Promise((res) => setTimeout(() => { if (o.stale()) return res(''); o.onFiled(t); filed.push(t); res('On it.'); }, 40)); };
  const { phone, log } = mk({}, { onPrompt });
  const s = st(phone); const r = relay(phone, s);
  const a = r.rs.onMessage({ type: 'prompt', voicePrompt: 'Tell ARES that I want', last: true });
  await wait(10);
  const b = r.rs.onMessage({ type: 'prompt', voicePrompt: 'integration with Jarvis as well.', last: true });
  await wait(10);
  const c = r.rs.onMessage({ type: 'prompt', voicePrompt: 'From the WhatsApp MCP server.', last: true });
  await Promise.all([a, b, c]);
  assert.deepStrictEqual(filed, ['Tell ARES that I want integration with Jarvis as well. From the WhatsApp MCP server.']);
  assert.strictEqual(heardAll.at(-1), filed[0]);
  assert.strictEqual((r.text().match(/On it\./g) || []).length, 1);
  r.rs.onClose();
  assert.deepStrictEqual(log()[0].requests, filed);
});

test('the stale turn\'s AI run is aborted when the caller keeps talking', async () => {
  const signals = [];
  const { phone } = mk({}, { onPrompt: (t, o) => { signals.push(o.signal); return new Promise((res) => setTimeout(() => res('ok'), 30)); } });
  const s = st(phone); const r = relay(phone, s);
  const a = r.rs.onMessage({ type: 'prompt', voicePrompt: 'so', last: true });
  await wait(5);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'what is running', last: true });
  await a;
  assert.strictEqual(signals[0].aborted, true);
  assert.strictEqual(signals[1].aborted, false);
  r.rs.onClose();
});

test('"Mm-hm." keeps listening: the next piece joins the same request', async () => {
  const heard = [];
  const { phone } = mk({}, { onPrompt: async (t) => { heard.push(t); return /Jarvis/.test(t) ? 'Got it, ARES has it.' : 'Mm-hm.'; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Tell ARES that I want', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Jarvis connected too.', last: true });
  assert.deepStrictEqual(heard, ['Tell ARES that I want', 'Tell ARES that I want Jarvis connected too.']);
  assert.match(r.text(), /Mm-hm\.[\s\S]*Got it, ARES has it\./);
  r.rs.onClose();
});

test('the call record keeps both sides of the conversation, with how long she took', async () => {
  const { phone, log } = mk({}, { onPrompt: async () => 'Two missions are running.' });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'what is running', last: true });
  r.rs.onClose();
  const tr = log()[0].transcript;
  assert.deepStrictEqual(tr.map((x) => [x.who, x.text]), [['caller', 'what is running'], ['ivy', 'Two missions are running.']]);
  assert.ok(typeof tr[1].ms === 'number');
});

test('speech recognition gets crew and project names as hints', async () => {
  const { phone } = mk({}, { hints: 'Ivy,ARES,FORGE,bloom booking' });
  const p = { From: OWNER, CallSid: 'CA40' };
  assert.match(await phone.handleVoice(p, sign(p)), /hints="Ivy,ARES,FORGE,bloom booking"/);
});

test('open errors are part of what she knows; dismissed ones are not', async () => {
  const seen = [];
  const errors = () => [{ title: 'Deploy failed', project: 'bloom-booking', status: 'open', count: 3 }, { title: 'Old noise', status: 'dismissed' }];
  const { phone } = mk({}, { errors, desk: () => deskStub(), onPrompt: async (t, o) => { seen.push(o.context); return 'One deploy is failing.'; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'any errors', last: true });
  assert.match(seen[0], /Deploy failed \[bloom-booking\] \(x3\)/);
  assert.doesNotMatch(seen[0], /Old noise/);
  r.rs.onClose();
});

// ---- reliability (2026-10-30): goodbyes, dropped relay, message alerts ----
test('"No. That\'s it. Thank you." after "Anything else?" is a goodbye, not a second message; "no, but…" is a message', async () => {
  const { phone, log } = mk({}, { desk: () => deskStub() });
  const s = st(phone, { from: '+1999', isOwner: false }); s.callerName = 'Maya'; const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Can you tell Alex to call me back?', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "No. That's it. Thank you.", last: true });
  assert.match(r.text(), /Thanks for calling\. Bye now\./);
  r.rs.onClose();
  assert.deepStrictEqual(log()[0].messages, ['Can you tell Alex to call me back?']);
  const b = mk(); const s2 = st(b.phone, { from: '+1999', isOwner: false }); s2.callerName = 'Maya'; const r2 = relay(b.phone, s2);
  await r2.rs.onMessage({ type: 'prompt', voicePrompt: 'Call me back please', last: true });
  await r2.rs.onMessage({ type: 'prompt', voicePrompt: 'No, but tell him to bring the invoice', last: true });
  assert.doesNotMatch(r2.text(), /Bye now/);
  r2.rs.onClose();
  assert.strictEqual(b.log()[0].messages.length, 2);
});

test('a caller who leaves a message is reported once when the call ends (Telegram alert hook)', async () => {
  const ended = [];
  const { phone } = mk({}, { onCallEnded: (c) => ended.push(c), endedDelayMs: 0 });
  const s = st(phone, { from: '+1999', isOwner: false }); s.callerName = 'maya'; const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Tell him to call me', last: true });
  r.rs.onClose(); r.rs.onClose();
  await wait(20);
  assert.strictEqual(ended.length, 1);
  assert.deepStrictEqual([ended[0].messages, ended[0].outcome, ended[0].from], [['Tell him to call me'], 'message-taken', '+1999']);
});

test('the relay drops mid-call: Twilio asks the action URL and Ivy carries on (gather); when she ended it, it hangs up', async () => {
  const { phone } = mk({}, { onPrompt: async () => 'ok' });
  const p = { From: OWNER, CallSid: 'CA50' };
  const twiml = await phone.handleVoice(p, sign(p));
  assert.match(twiml, /<Connect action="https:\/\/x\.example\/ares\/voice\?after=relay">/);
  const after = { CallSid: 'CA50', CallStatus: 'in-progress', SessionStatus: 'failed' };
  const sig = twilioSignature('tok', 'https://x.example/ares/voice?after=relay', after);
  const back = await phone.handleVoice(after, sig, '?after=relay');
  assert.match(back, /<Gather[\s\S]*Sorry, I lost you for a second\.[\s\S]*I&apos;m back\./);
  await assert.rejects(phone.handleVoice(after, sign(after), '?after=relay'), (e) => e.status === 403, 'signed over the full URL');
  const q = { From: OWNER, CallSid: 'CA51' }; await phone.handleVoice(q, sign(q));
  const done = { CallSid: 'CA51', CallStatus: 'completed' };
  assert.strictEqual(await phone.handleVoice(done, twilioSignature('tok', 'https://x.example/ares/voice?after=relay', done), '?after=relay'), '<Response><Hangup/></Response>');
});

test('contact names are capitalised in the greeting', async () => {
  const { phone } = mk({}, { desk: () => deskStub({ recognise: () => ({ name: 'maya' }) }) });
  const p = { From: '+1999', CallSid: 'CA52' };
  assert.match(await phone.handleVoice(p, sign(p)), /welcomeGreeting="Hi Maya, this is Ivy/);
});

// ---- caller scenarios (2026-10-30): every kind of caller, the owner from another phone, put-throughs ----
const crypto_ = require('crypto');
const brain = (script) => { let i = 0; return async () => (Array.isArray(script) ? script[Math.min(i++, script.length - 1)] : script); };
const callerSt = (phone, o = {}) => st(phone, { from: '+1999', isOwner: false, ...o });

test('a new lead: the details and lead fields reach the end-of-call alert and the summary', async () => {
  const ended = [];
  const { phone, log } = mk({}, { endedDelayMs: 0, onCallEnded: (c) => ended.push(c), callerBrain: brain([
    { say: 'Happy to help. Your name?', intent: 'lead', details: 'Wants a booking app', end: false },
    { say: 'Thanks Maya. Anything else?', intent: 'lead', callerName: 'Maya', company: 'Lotus Yoga', bestTime: 'mornings', details: 'Maya (Lotus Yoga) wants a booking app by January, ~15k', end: false },
    { say: 'Thanks for calling, bye.', intent: 'lead', details: 'Maya (Lotus Yoga) wants a booking app by January, ~15k', end: true }]) });
  const s = callerSt(phone); const r = relay(phone, s);
  for (const t of ['I need a booking app', "It's Maya from Lotus Yoga, by January, 15k", 'No that is all']) await r.rs.onMessage({ type: 'prompt', voicePrompt: t, last: true });
  await wait(1700);
  assert.ok(r.out.some((o) => o.type === 'end'), 'she ends the call when the brain says so');
  r.rs.onClose(); await wait(10);
  assert.strictEqual(ended.length, 1);
  assert.deepStrictEqual([ended[0].intent, ended[0].callerName, ended[0].lead.company, ended[0].lead.bestTime], ['lead', 'Maya', 'Lotus Yoga', 'mornings']);
  assert.match(log()[0].summary, /^Maya: Maya \(Lotus Yoga\) wants a booking app/);
  assert.strictEqual(log()[0].intent, 'lead');
});

test('a delivery at the door: the owner is told during the call, once', async () => {
  const urgent = [];
  const { phone } = mk({}, { onUrgent: (c) => urgent.push(c), callerBrain: brain({ say: "I'm letting them know right now.", intent: 'delivery', details: 'DHL downstairs, needs a signature', notifyNow: true, end: false }) });
  const s = callerSt(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'DHL downstairs with a package', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'it needs a signature', last: true });
  assert.strictEqual(urgent.length, 1);
  assert.deepStrictEqual([urgent[0].intent, urgent[0].details], ['delivery', 'DHL downstairs, needs a signature']);
  r.rs.onClose();
});

test('urgent + allowed: Ivy says so, then the live call is put through to the owner; no answer brings her back, an answer hangs up as transferred', async () => {
  const { phone, calls, log } = mk({}, { transferDelayMs: 5, endedDelayMs: 0, canTransfer: () => true, callerBrain: brain({ say: "I'll try to put you through.", intent: 'urgent', details: 'Landlord: leak', notifyNow: false, transfer: true, end: false }) });
  const p = { From: '+1999', CallSid: 'CA60' }; await phone.handleVoice(p, sign(p));
  const s = callerSt(phone, { callSid: 'CA60' }); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'water is leaking, I need him now', last: true });
  await wait(30);
  const upd = calls.find((c) => /Calls\/CA60\.json/.test(c.url));
  assert.ok(upd, 'the live call is updated');
  assert.match(new URLSearchParams(upd.body).get('Twiml'), /<Dial timeout="20" callerId="[^"]+" action="https:\/\/x\.example\/ares\/voice\?after=dial" method="POST">\+972500000000<\/Dial>/);
  r.rs.onClose();
  const miss = { CallSid: 'CA60', CallStatus: 'in-progress', DialCallStatus: 'no-answer' };
  const back = await phone.handleVoice(miss, twilioSignature('tok', 'https://x.example/ares/voice?after=dial', miss), '?after=dial');
  assert.match(back, /<Gather[\s\S]*couldn&apos;t pick up/);
  const p2 = { From: '+1999', CallSid: 'CA61' }; await phone.handleVoice(p2, sign(p2));
  const s2 = callerSt(phone, { callSid: 'CA61' }); const r2 = relay(phone, s2);
  await r2.rs.onMessage({ type: 'prompt', voicePrompt: 'urgent', last: true }); await wait(30); r2.rs.onClose();
  const ok = { CallSid: 'CA61', CallStatus: 'in-progress', DialCallStatus: 'completed' };
  assert.strictEqual(await phone.handleVoice(ok, twilioSignature('tok', 'https://x.example/ares/voice?after=dial', ok), '?after=dial'), '<Response><Hangup/></Response>');
  assert.strictEqual(log().find((x) => x.callSid === 'CA61').outcome, 'transferred');
});

test('put-through not allowed: no transfer, she says she can\'t and the owner is alerted instead', async () => {
  const urgent = [];
  const { phone, calls } = mk({}, { transferDelayMs: 5, canTransfer: () => false, onUrgent: (c) => urgent.push(c), callerBrain: brain({ say: 'Let me put you through to them now.', intent: 'personal', details: 'wants to talk', transfer: true, end: false }) });
  const s = callerSt(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'can I talk to him', last: true });
  await wait(20);
  assert.ok(!calls.some((c) => /Calls\/.*\.json/.test(c.url) && /Dial/.test(c.body)));
  assert.match(r.text(), /I can't put calls through right now, but I've let \w+ know\./);
  assert.doesNotMatch(r.text(), /put you through to them now/);
  assert.strictEqual(urgent.length, 1);
  r.rs.onClose();
});

test('spam and wrong numbers end politely and are logged as such', async () => {
  for (const [intent, outcome] of [['spam', 'spam'], ['wrong_number', 'wrong-number']]) {
    const { phone, log } = mk({}, { callerBrain: brain({ say: 'Not interested, goodbye.', intent, details: 'x', end: true }) });
    const s = callerSt(phone); const r = relay(phone, s);
    await r.rs.onMessage({ type: 'prompt', voicePrompt: 'special offer', last: true });
    await wait(1700); r.rs.onClose();
    assert.ok(r.out.some((o) => o.type === 'end'));
    assert.strictEqual(log()[0].outcome, outcome);
  }
});

test('the owner from another phone: "it\'s Alex" → PIN → full access; wrong twice → stays a caller', async () => {
  const asked = [];
  const pinHash = crypto_.createHash('sha256').update('ivy-pin:4321').digest('hex');
  const { phone, log } = mk({}, { ownerName: 'Alex', ownerPin: () => pinHash, onPrompt: async (t) => { asked.push(t); return 'Two missions running.'; }, callerBrain: brain({ say: 'What is it about?', intent: 'message', details: '', end: false }) });
  const s = callerSt(phone, { from: '+1555' }); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "Hi Ivy, it's Alex", last: true });
  assert.match(r.text(), /what's your PIN\?/);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'four three two one', last: true });
  assert.match(r.text(), /Thanks, Alex\. You're in\./);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "what's running", last: true });
  assert.deepStrictEqual(asked, ["what's running"], 'now it is the owner brain');
  r.rs.onClose();
  assert.strictEqual(log()[0].verified, true);
  const b = mk({}, { ownerName: 'Alex', ownerPin: () => pinHash, onPrompt: async () => 'secret', callerBrain: brain({ say: 'What is it about?', intent: 'message', details: '', end: false }) });
  const s2 = callerSt(b.phone, { from: '+1555' }); const r2 = relay(b.phone, s2);
  for (const t of ["it's Alex", '1111', '2222', 'what missions are running']) await r2.rs.onMessage({ type: 'prompt', voicePrompt: t, last: true });
  assert.match(r2.text(), /didn't match[\s\S]*doesn't match/);
  assert.doesNotMatch(r2.text(), /secret/);
  r2.rs.onClose();
});

test('the caller brain fails → the plain message-taker still works', async () => {
  const { phone, log } = mk({}, { callerBrain: async () => null });
  const s = callerSt(phone); s.callerName = 'Dana'; const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'please call me back', last: true });
  assert.match(r.text(), /Thanks, Dana\. I'll make sure they get your message/);
  r.rs.onClose();
  assert.strictEqual(log()[0].outcome, 'message-taken');
});

test('a caller who already called today is greeted "again"; gather stack puts calls through with a Dial', async () => {
  const { phone } = mk({ phone_stack: 'gather' }, { canTransfer: () => true, callerBrain: brain({ say: 'Putting you through.', intent: 'urgent', details: 'x', transfer: true, end: false }) });
  const p = { From: '+1999', CallSid: 'CA70', SpeechResult: 'hello' }; await phone.handleVoice({ From: '+1999', CallSid: 'CA70' }, sign({ From: '+1999', CallSid: 'CA70' }));
  const t = await phone.handleVoice(p, sign(p));
  assert.match(t, /<Say[^>]*>Putting you through\.<\/Say><Dial timeout="20"[^>]*>\+972500000000<\/Dial>/);
  const again = { From: '+1999', CallSid: 'CA71' };
  assert.match(await phone.handleVoice(again, sign(again)), /it&apos;s Ivy again\.[\s\S]*I passed on your earlier message/);
});

test('the owner says "connect me to Dana": the call is put through to Dana', async () => {
  const { phone, calls } = mk({}, { transferDelayMs: 5, onPrompt: async (t, o) => { o.onConnect('+1777', 'Dana'); return 'Connecting you to Dana now.'; } });
  const p = { From: OWNER, CallSid: 'CA80' }; await phone.handleVoice(p, sign(p));
  const s = st(phone, { callSid: 'CA80' }); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'connect me to Dana', last: true });
  await wait(30);
  assert.match(new URLSearchParams(calls.find((c) => /Calls\/CA80\.json/.test(c.url)).body).get('Twiml'), /<Dial[^>]*>\+1777<\/Dial>/);
  r.rs.onClose();
});

// ---- speed + voice (2026-11-01): one warm session per call, sentences streamed, Flux turn-taking, ElevenLabs v4 ----
test('relay TwiML: Deepgram Flux turn detection and the ElevenLabs v4 voice', async () => {
  const { phone } = mk();
  const p = { From: OWNER, CallSid: 'CA90' };
  const t = await phone.handleVoice(p, sign(p));
  assert.match(t, /speechModel="flux"/); assert.match(t, /eotThreshold="0\.75"/);
  assert.match(t, /voice="VOICE123-v4-0\.4_0\.8"/);
  const custom = mk({ relay_voice: 'abc-flash_v2_5-1.0_0.5_0.8', relay_stt_model: 'nova-3-general' });
  const t2 = await custom.phone.handleVoice(p, sign(p));
  assert.match(t2, /voice="abc-flash_v2_5-1\.0_0\.5_0\.8"/); assert.doesNotMatch(t2, /eotThreshold/);
});

test('streamed sentences go out before the turn ends; a different final (e.g. a lookup result) is added after', async () => {
  let release;
  const { phone, log } = mk({}, { onPrompt: (t, o) => new Promise((res) => { o.onSentence('Let me check.'); release = () => res('It is 22 degrees in Tel Aviv.'); }) });
  const s = st(phone); const r = relay(phone, s);
  const p = r.rs.onMessage({ type: 'prompt', voicePrompt: 'weather in tel aviv', last: true });
  await wait(5);
  assert.deepStrictEqual(r.out.filter((o) => o.type === 'text').map((o) => o.token), ['Let me check. '], 'spoken before the answer is complete');
  release(); await p;
  assert.match(r.text(), /^Let me check\. It is 22 degrees in Tel Aviv\. $/);
  assert.strictEqual(r.out.at(-1).last, true);
  r.rs.onClose();
  const ivy = log()[0].transcript.filter((x) => x.who === 'ivy').at(-1);
  assert.strictEqual(ivy.text, 'Let me check. It is 22 degrees in Tel Aviv.');
  assert.ok(ivy.streamed && typeof ivy.ms === 'number');
});

test('streamed and final are the same: nothing is said twice', async () => {
  const { phone } = mk({}, { onPrompt: async (t, o) => { o.onSentence('Sure.'); o.onSentence("I'll text you at four."); return "Sure. I'll text you at four."; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'remind me at 4', last: true });
  assert.strictEqual(r.text(), "Sure. I'll text you at four. ");
  r.rs.onClose();
});

test('the owner\'s call opens one warm session at the start and closes it at the end; it is passed to every turn', async () => {
  const opened = []; let closed = 0; const seen = [];
  const onPrompt = async (t, o) => { seen.push(o.session); return 'ok'; };
  onPrompt.openSession = (x) => { opened.push(x); return { alive: true, close: () => { closed++; } }; };
  const { phone } = mk({}, { onPrompt });
  const p = { From: OWNER, CallSid: 'CA91' };
  await phone.handleVoice(p, sign(p)); await wait(5);
  assert.strictEqual(opened.length, 1, 'warming while the greeting plays');
  const stranger = { From: '+1999', CallSid: 'CA92' }; await phone.handleVoice(stranger, sign(stranger));
  assert.strictEqual(opened.length, 1, 'callers never get the owner\'s session');
  const done = { CallSid: 'CA91', CallStatus: 'completed' };
  phone.handleStatus(done, sign(done, 'status'));
  assert.strictEqual(closed, 1);
});

// ---- from the 2026-11-01 13:40 call ----
test('while the owner is talking (partial prompts) Ivy never asks "Are you still there?"', async () => {
  const { phone } = mk({}, { idleMs: { first: 40, second: 40 } });
  const s = st(phone); const r = relay(phone, s);
  r.rs.start();
  for (let i = 0; i < 4; i++) { await wait(25); await r.rs.onMessage({ type: 'prompt', voicePrompt: 'So I want the', last: false }); }
  assert.doesNotMatch(r.text(), /still there/);
  r.rs.onClose();
  const t = await phone.handleVoice({ From: OWNER, CallSid: 'CA95' }, sign({ From: OWNER, CallSid: 'CA95' }));
  assert.match(t, /partialPrompts="true"/);
});

test('"That\'s it. You can hang up." ends the call even with half-heard words pending', async () => {
  const { phone } = mk({}, { onPrompt: async () => 'Mm-hm.' });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'government.', last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "That's it. You can hang up.", last: true });
  assert.match(r.text(), /talk soon/);
  await wait(1700);
  assert.ok(r.out.some((o) => o.type === 'end'));
  r.rs.onClose();
});

test('the brain\'s hangup action ends the call after her goodbye', async () => {
  const { phone } = mk({}, { onPrompt: async (t, o) => { o.onHangup(); return 'Okay, bye for now.'; } });
  const s = st(phone); const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'alright I am going now', last: true });
  await wait(1700);
  assert.match(r.text(), /bye for now/); assert.ok(r.out.some((o) => o.type === 'end'));
  r.rs.onClose();
});

test('with a warm session, a turn never rebuilds the desk notes; without one it does, and the crew/accounts are in them', async () => {
  let reads = 0;
  const desk = () => deskStub({ knowledge: () => { reads++; return deskStub().knowledge(); } });
  const seen = [];
  const onPrompt = async (t, o) => { if (!o.session) seen.push(o.context); return 'ok'; };
  onPrompt.openSession = () => ({ alive: true, close() {} });
  const { phone } = mk({}, { desk, onPrompt, officeInfo: () => 'Claude accounts the office runs on (METER): #4 m@x (ACTIVE)' });
  const p = { From: OWNER, CallSid: 'CA96' }; await phone.handleVoice(p, sign(p));
  const before = reads;
  const s = st(phone, { callSid: 'CA96' }); s.session = { alive: true, close() {} }; const r = relay(phone, s);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'what is running', last: true });
  assert.strictEqual(reads, before, 'no desk rebuild on a warm turn');
  r.rs.onClose();
  const s2 = st(phone); const r2 = relay(phone, s2);
  await r2.rs.onMessage({ type: 'prompt', voicePrompt: 'which claude account are we on', last: true });
  assert.match(seen[0], /METER\): #4 m@x \(ACTIVE\)/);
  r2.rs.onClose();
});

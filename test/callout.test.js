'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createPhone, twilioSignature } = require('../bin/ares-phone.js');
const { createCallLog } = require('../bin/call-log.js');
const { createChat } = require('../bin/ares-chat.js');

const sms = { account_sid: 'ACx', auth_token: 'tok', from_number: '+97211111111', owner_phone: '+972500000000', public_url: 'https://x.example' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function mk(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callout-'));
  const callLog = createCallLog(dir); const calls = []; const ended = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: String(init.body || '') }); return { ok: true, json: async () => ({ sid: 'CAout1' }) }; };
  const phone = createPhone(dir, { fetchFn, callLog, wsModule: {}, integrations: { get: () => sms }, voice: { status: () => ({ enabled: false }), voiceId: () => 'V' }, ownerName: 'Alex', endedDelayMs: 0, onCallEnded: (c) => ended.push(c), fillerMs: 5000, ...extra });
  return { phone, calls, ended, log: () => callLog.list({ limit: 10 }) };
}
const relay = (phone, st) => { const out = []; const rs = phone.relaySession(st, (o) => out.push(o), () => out.push({ hangup: true })); return { rs, out, text: () => out.filter((o) => o.type === 'text').map((o) => o.token).join('') }; };

test('callOut: dials the local number in E.164 with the relay, a greeting as the owner\'s assistant, and voicemail detection', async () => {
  const opened = [];
  const { phone, calls } = mk({ delegateSession: (m) => { opened.push(m); return { alive: true, ask: async () => null, close() {} }; } });
  const r = await phone.callOut({ to: '052-123-4567', name: 'dana cole', message: 'Alex is running ten minutes late', goal: 'deliver' });
  assert.strictEqual(r.to, '+972521234567');
  const form = new URLSearchParams(calls[0].body);
  assert.strictEqual(form.get('To'), '+972521234567');
  assert.match(form.get('Twiml'), /welcomeGreeting="Hi Dana, this is Ivy, Alex&apos;s assistant\."/);
  assert.strictEqual(form.get('MachineDetection'), 'DetectMessageEnd');
  assert.deepStrictEqual(opened[0], { ownerName: 'Alex', name: 'dana cole', goal: 'deliver', message: 'Alex is running ten minutes late' });
  await assert.rejects(phone.callOut({ to: '123', message: 'x' }), /too short/);
});

test('the call itself: the delegate session talks; its outcome and result reach the owner\'s report', async () => {
  const turns = [
    { say: "Hi Dana, I'm calling because Alex is running about ten minutes late.", outcome: 'delivered', result: '', end: false },
    { say: 'Got it, I\'ll pass that on. Bye!', outcome: 'delivered', result: 'Dana is fine; she will wait by the window.', end: true },
  ];
  let i = 0;
  const { phone, ended, log } = mk({ delegateSession: () => ({ alive: true, ask: async (t, o) => { const r = turns[i++]; o.onSentence?.(r.say); return { ...r, streamed: true }; }, close() {} }) });
  await phone.callOut({ to: '+15550001111', name: 'Dana', message: 'Alex is running late', goal: 'deliver' });
  const st = phone.newState({ owner: sms.owner_phone }, { callSid: 'CAout1', from: '+15550001111', direction: 'out', isOwner: false, stack: 'relay' });
  st.delegate = { name: 'Dana', message: 'Alex is running late', goal: 'deliver', outcome: '', result: '' }; st.session = { alive: true, ask: async (t, o) => { const r = turns[i++]; o.onSentence?.(r.say); return { ...r, streamed: true }; }, close() {} }; i = 0;
  const r = relay(phone, st);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: "Hello? Yes, it's Dana.", last: true });
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'No problem, I will wait by the window.', last: true });
  await wait(1700);
  assert.ok(r.out.some((o) => o.type === 'end'), 'she ends the call after goodbye');
  r.rs.onClose(); await wait(10);
  const rep = ended.find((c) => c.delegate);
  assert.deepStrictEqual([rep.outcome, rep.delegate.result], ['callout-delivered', 'Dana is fine; she will wait by the window.']);
  assert.match(log().find((x) => x.callSid === 'CAout1').summary, /^Called Dana to deliver: "Alex is running late" — Dana is fine/);
});

test('their voicemail: after the beep Ivy leaves the message and hangs up; reported as voicemail-left', async () => {
  const { phone, calls, ended } = mk({ delegateSession: () => ({ alive: true, ask: async () => null, close() {} }) });
  await phone.callOut({ to: '+15550002222', name: 'Smile Dental', message: "Is Alex's cleaning on Tuesday at 3pm still on?", goal: 'confirm' });
  const p = { CallSid: 'CAout1', AnsweredBy: 'machine_end_beep', CallStatus: 'in-progress' };
  phone.handleStatus(p, twilioSignature('tok', 'https://x.example/ares/status', p));
  await wait(5);
  const vm = calls.find((c) => /Calls\/CAout1\.json/.test(c.url));
  assert.match(new URLSearchParams(vm.body).get('Twiml'), /<Say[^>]*>Hi Smile, this is Ivy, Alex&apos;s assistant\. I&apos;m calling to confirm: Is Alex&apos;s cleaning on Tuesday at 3pm still on\? Could you call Alex back\? Thanks, bye\.<\/Say><Hangup\/>/);
  const done = { CallSid: 'CAout1', CallStatus: 'completed' };
  phone.handleStatus(done, twilioSignature('tok', 'https://x.example/ares/status', done)); await wait(10);
  assert.strictEqual(ended.at(-1).outcome, 'voicemail-left');
});

test('a stalled session is replaced once; if that fails too she apologises and ends', async () => {
  let opens = 0;
  const { phone } = mk({ delegateSession: () => { opens++; return { alive: true, ask: async () => (opens === 1 ? { say: 'Hi, Alex asked me to tell you he is late.', outcome: 'delivered', end: false } : null), close() {} }; } });
  const st = phone.newState({ owner: sms.owner_phone }, { callSid: 'CAz', from: '+1555', direction: 'out', isOwner: false, stack: 'relay' });
  st.delegate = { name: 'Dana', message: 'late', goal: 'deliver', outcome: '', result: '' }; st.session = { alive: false, ask: async () => null, close() {} };
  const r = relay(phone, st);
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Hello?', last: true });
  assert.strictEqual(opens, 1); assert.match(r.text(), /tell you he is late/);
  st.session = { alive: false, close() {} };
  await r.rs.onMessage({ type: 'prompt', voicePrompt: 'Sorry what?', last: true });
  assert.match(r.text(), /having trouble on my end/);
  r.rs.onClose();
});

test('owner side: "call Dana and tell her I\'m late" is read back, and only a yes dials', async () => {
  const dialled = [];
  const h = createChat({ file: async () => 'x', projects: () => [], now: () => Date.parse('2026-11-01T12:00:00Z'), findContact: (n) => (/dana/i.test(n) ? { name: 'Dana Cole', number: '+15550001111' } : null), callOut: async (o) => { dialled.push(o); return { sid: 'CA' }; },
    turn: async (i) => (/bob/i.test(i.heard) ? { say: 'Sure.', action: 'callout', contact: 'Bob', message: 'x', goal: 'deliver' } : /0 5 2|oh five/i.test(i.heard) ? { say: 'Sure.', action: 'callout', number: '0521234567', message: 'Alex says hi', goal: 'deliver' } : { say: 'Sure.', action: 'callout', contact: 'Dana', message: 'Alex is running about ten minutes late', goal: 'deliver' }) });
  const ask = await h("call dana and tell her I'm running late", { thread: 'call:1' });
  assert.match(ask, /^I'll call Dana Cole and say: Alex is running about ten minutes late\.( It's .* there now, by the way\.)? Call now\?$/);
  assert.strictEqual(dialled.length, 0);
  assert.match(await h('yes', { thread: 'call:1' }), /^Calling Dana now\. I'll tell you how it goes\.$/);
  assert.deepStrictEqual(dialled[0], { to: '+15550001111', name: 'Dana Cole', message: 'Alex is running about ten minutes late', goal: 'deliver' });
  assert.match(await h('call bob and say hi', { thread: 'call:2' }), /don't have a number for Bob/);
  assert.match(await h('call oh five two, one two three, four five six seven and say hi', { thread: 'call:3' }), /^I'll call 0 5 2, 1 2 3, 4 5 6, 7 and say: Alex says hi\./);
  assert.match(await h('no', { thread: 'call:3' }), /^Okay, I won't call\.$/);
  assert.strictEqual(dialled.length, 1);
});

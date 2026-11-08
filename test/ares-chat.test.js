'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createChat, classify, quickReply, spokenBriefing } = require('../bin/ares-chat.js');

/** `reply` is what the fake AI turn returns for every question. */
const mk = (reply = { say: 'answer', action: 'none' }) => {
  const filed = [], asked = [], notes = [];
  let t = 0;
  const chat = createChat({
    file: async (p, proj) => { filed.push(proj ? `${proj}: ${p}` : p); return proj || 'success-manager'; },
    turn: async (input) => { asked.push(input); return typeof reply === 'function' ? reply(input) : reply; },
    note: (n) => notes.push(n), projects: () => ['bloom-booking', 'fuel-app'], now: () => t,
  });
  return { chat, filed, asked, notes, tick: (ms) => { t += ms; } };
};

test('classify spots the add-to-list phrase', () => {
  assert.deepStrictEqual(classify('add this to the list: fix the header'), { kind: 'add', prompt: 'fix the header' });
  assert.deepStrictEqual(classify('Hey ARES, add to the list'), { kind: 'add', prompt: '' });
  assert.deepStrictEqual(classify('Ivy, put this on my list: renew domain'), { kind: 'add', prompt: 'renew domain' });
  assert.strictEqual(classify('what is the crew doing?').kind, 'chat');
  assert.strictEqual(classify('can you list the projects, add this later').kind, 'chat');
});

test('small talk is answered instantly, no AI call', async () => {
  const { chat, asked } = mk();
  for (const s of ['Hi.', 'hey Ivy', 'Hello?', 'can you hear me']) assert.match(await chat(s), /What can I do/);
  for (const s of ['thanks', 'Okay, thank you.', 'perfect']) assert.strictEqual(await chat(s), 'Sure thing.');
  assert.strictEqual(asked.length, 0);
});

test('"what did I miss" reads at most three items of the briefing, no AI call', async () => {
  const { chat, asked } = mk();
  const b = 'Welcome back. 1 thing needs you: Pick a logo. 2 missions finished. 3 calls while you were away. 4 missions running.';
  assert.strictEqual(await chat('what did I miss?', { briefing: b }), '1 thing needs you: Pick a logo. 2 missions finished. 3 calls while you were away.');
  assert.match(await chat('any updates', { briefing: 'Welcome back. Nothing is waiting on you.' }), /Nothing's waiting/);
  assert.strictEqual(asked.length, 0);
  assert.strictEqual(quickReply('what did I miss on the bloom booking deploy that failed yesterday afternoon'), null, 'a long, specific question goes to the AI');
  assert.match(spokenBriefing(''), /Nothing's waiting/);
});

test('questions go to the AI with desk notes, history and project names; nothing is filed', async () => {
  const { chat, filed, asked } = mk();
  assert.strictEqual(await chat('what is METER doing?', { context: 'Schedule: dentist', history: [{ who: 'ivy', text: 'Hi' }], channel: 'phone' }), 'answer');
  assert.deepStrictEqual(filed, []);
  assert.strictEqual(asked[0].context, 'Schedule: dentist');
  assert.deepStrictEqual(asked[0].projects, ['bloom-booking', 'fuel-app']);
  assert.strictEqual(asked[0].history.length, 1);
});

test('a plain request is filed by Ivy herself — no magic phrase — to the project she picked', async () => {
  const seen = [];
  const { chat, filed } = mk({ say: "On it, ARES has it.", action: 'task', task: 'Fix the login button on the booking page', project: 'bloom-booking' });
  assert.strictEqual(await chat('can you get Forge to fix the login button on bloom', { onFiled: (t) => seen.push(t) }), 'On it, ARES has it.');
  assert.deepStrictEqual(filed, ['bloom-booking: Fix the login button on the booking page']);
  assert.deepStrictEqual(seen, ['Fix the login button on the booking page']);
});

test('an unknown project from the AI falls back to the office; notes go on the desk', async () => {
  const a = mk({ say: 'Done.', action: 'task', task: 'Tidy the lobby', project: 'nope' });
  await a.chat('tidy the lobby');
  assert.deepStrictEqual(a.filed, ['Tidy the lobby']);
  const b = mk({ say: "Noted, dentist at three.", action: 'note', note: 'Dentist Friday 3pm', noteKind: 'schedule' });
  assert.match(await b.chat('remind me I have the dentist friday at 3'), /Noted/);
  assert.deepStrictEqual(b.notes, [{ kind: 'schedule', text: 'Dentist Friday 3pm' }]);
  assert.deepStrictEqual(b.filed, []);
});

test('AI failure is an honest sorry, never a fake "on it"', async () => {
  const { chat, filed } = mk(null);
  assert.match(await chat('what broke last night?'), /couldn't get to that/);
  assert.deepStrictEqual(filed, []);
});

test('WhatsApp (no call history) keeps its own short rolling history', async () => {
  const { chat, asked, tick } = mk();
  await chat('how is bloom going?');
  await chat('and gas monitor?');
  assert.deepStrictEqual(asked[1].history.map((h) => h.who), ['owner', 'ivy']);
  tick(31 * 60 * 1000);
  await chat('new topic');
  assert.strictEqual(asked[2].history.length, 0, 'old conversation forgotten after 30 minutes');
});

test('"add this to the list" still files at once; alone it arms the next message', async () => {
  const { chat, filed, asked } = mk();
  assert.match(await chat('add this to the list make the logo bigger'), /passed that to ARES/);
  assert.match(await chat('add this to the list'), /what should I add/);
  assert.match(await chat('fix the login page'), /passed that to ARES/);
  assert.strictEqual(await chat('how many missions ran?'), 'answer');
  assert.deepStrictEqual([filed, asked.map((a) => a.heard)], [['make the logo bigger', 'fix the login page'], ['how many missions ran?']]);
});

test('cancel and expiry disarm', async () => {
  const a = mk();
  await a.chat('add this to the list');
  assert.match(await a.chat('never mind'), /nothing added/i);
  assert.deepStrictEqual(a.filed, []);
  const b = mk();
  await b.chat('add this to the list');
  b.tick(11 * 60 * 1000);
  assert.strictEqual(await b.chat('what is up with bloom?'), 'answer');
  assert.deepStrictEqual(b.filed, []);
});

test('a stale turn (caller kept talking) files nothing and says nothing', async () => {
  const { chat, filed } = mk({ say: 'On it.', action: 'task', task: 'Half a request' });
  assert.strictEqual(await chat('Tell ARES that I want', { stale: () => true }), '');
  assert.deepStrictEqual(filed, []);
});

test('"remind me" sets a real reminder with the AI\'s time; a bad time is an honest question', async () => {
  const set = [];
  const mkR = (reply, remind) => createChat({ file: async () => 'x', turn: async () => reply, remind, projects: () => [] });
  const a = mkR({ say: "Sure, I'll text you at 9:45.", action: 'remind', remindAt: '2026-10-31T09:45:00+02:00', remindText: 'Call Dana' }, (r) => set.push(r));
  assert.match(await a('remind me to call Dana at quarter to ten tomorrow'), /9:45/);
  assert.deepStrictEqual(set, [{ text: 'Call Dana', at: '2026-10-31T09:45:00+02:00', via: 'whatsapp' }]);
  const b = mkR({ say: 'Done.', action: 'remind', remindAt: 'yesterday', remindText: 'x' }, () => { throw new Error('That time has already passed.'); });
  assert.match(await b('remind me yesterday'), /couldn't set that: That time has already passed\. When should I remind you\?/);
});

test('"what\'s my day look like" reads the day brief instantly; without one it goes to the AI', async () => {
  const { chat, asked } = mk();
  assert.strictEqual(await chat("What's on today?", { today: 'Nothing on your calendar.' }), 'Nothing on your calendar.');
  assert.strictEqual(await chat('morning brief', { today: 'Two meetings.' }), 'Two meetings.');
  assert.strictEqual(asked.length, 0);
  await chat("what's on today", {});
  assert.strictEqual(asked.length, 1);
});

test('the AI is told the local date, time and UTC offset (so "at 10" and "tomorrow" resolve)', () => {
  const { nowLine } = require('../bin/ares-chat.js');
  assert.match(nowLine(new Date('2026-10-30T08:00:00Z')), /30 October 2026 .*\(UTC[+-]\d\d:\d\d/);
});

test('"tell FORGE option B" answers that agent\'s open question; an unknown ref is never answered', async () => {
  const answered = []; const seen = [];
  const qs = () => [{ ref: 'bloom/m1/s1', who: 'FORGE', project: 'bloom', what: 'Login style A or B?', reply: 'A or B' }];
  const chat = createChat({ file: async () => 'x', turn: async (i) => { seen.push(i.questions); return { say: 'Passed to FORGE.', action: 'answer', answerRef: 'bloom/m1/s1', answerText: 'B' }; }, questions: qs, answerQuestion: (r, t) => answered.push([r, t]), projects: () => [] });
  const flagged = [];
  assert.strictEqual(await chat('tell forge option B', { onAnswered: (k) => flagged.push(k) }), 'Passed to FORGE.');
  assert.deepStrictEqual(answered, [['bloom/m1/s1', 'B']]);
  assert.deepStrictEqual(flagged, ['q:bloom/m1/s1']);
  assert.strictEqual(seen[0][0].ref, 'bloom/m1/s1', 'Ivy sees the open questions');
  const bad = createChat({ file: async () => 'x', turn: async () => ({ say: 'Passed.', action: 'answer', answerRef: 'made/up/ref', answerText: 'B' }), questions: qs, answerQuestion: (r, t) => answered.push([r, t]), projects: () => [] });
  await bad('tell someone B');
  assert.strictEqual(answered.length, 1);
});

test('"open the atlas-app folder" moves the office; she sees the current folder and the folder list; errors are honest', async () => {
  let got = null; const seen = [];
  const chat = createChat({ file: async () => 'x', projects: () => [], office: () => ({ current: 'bloom-booking', folders: ['atlas-app', 'bloom-booking', 'Real estate'] }),
    turn: async (i) => { seen.push(i.office); return { say: 'Sure.', action: 'switch', folder: 'atlas-app' }; },
    switchFolder: async (f) => { got = f; return { project: 'atlas-app', added: true }; } });
  assert.strictEqual(await chat('open the atlas-app folder'), 'Done, the office is working in atlas-app now (I added it to the office first).');
  assert.strictEqual(got, 'atlas-app');
  assert.deepStrictEqual(seen[0], { current: 'bloom-booking', folders: ['atlas-app', 'bloom-booking', 'Real estate'] });
  const bad = createChat({ file: async () => 'x', projects: () => [], turn: async () => ({ say: 'Sure.', action: 'switch', folder: 'nope' }), switchFolder: async () => { throw new Error('I couldn\'t find a folder called "nope".'); } });
  assert.match(await bad('open nope'), /^I couldn't open that: I couldn't find a folder called "nope"\.$/);
});

test('IVY toggles wellbeing from chat only when asked (action=wellbeing)', async () => {
  const calls = [];
  const chat = createChat({ file: async () => 'x', projects: () => [], turn: async () => ({ say: 'ok', action: 'wellbeing', wellbeing: 'awake_on', hours: 3 }), wellbeing: (w, h) => { calls.push([w, h]); return 'Done, awake.'; } });
  assert.equal(await chat('keep my mac awake for 3 hours'), 'Done, awake.');
  assert.deepEqual(calls, [['awake_on', 3]]);
  const none = createChat({ file: async () => 'x', projects: () => [], turn: async () => ({ say: 'hi', action: 'none' }), wellbeing: () => { calls.push('bad'); return ''; } });
  await none('hello'); assert.equal(calls.length, 1);
});

test('IVY answers weather/convert/mail from live data (action=lookup), and a failed lookup is a sorry, not a crash', async () => {
  const seen = [];
  const lookup = async (r) => { seen.push(r.lookup); if (r.lookup === 'mail') throw new Error('not linked'); return `${r.lookup}: ok`; };
  const mkL = (reply) => createChat({ file: async () => 'x', projects: () => [], turn: async () => reply, lookup });
  assert.strictEqual(await mkL({ say: 'Checking.', action: 'lookup', lookup: 'weather' })('weather?'), 'weather: ok');
  assert.match(await mkL({ say: 'Checking.', action: 'lookup', lookup: 'mail' })('mail?'), /^Sorry, I couldn't check that: not linked\.$/);
  assert.deepStrictEqual(seen, ['weather', 'mail']);
});

test('"call Dana" connects on the phone; by text she gives the number; unknown names are said honestly', async () => {
  const contacts = { dana: { name: 'Dana Cole', number: '+1777' } };
  const mkC = () => createChat({ file: async () => 'x', projects: () => [], findContact: (n) => contacts[n.toLowerCase().split(' ')[0]] || null, turn: async (i) => ({ say: 'Sure.', action: 'connect', contact: /bob/i.test(i.heard) ? 'Bob' : 'Dana' }) });
  const got = [];
  assert.strictEqual(await mkC()('call Dana', { onConnect: (n, name) => got.push([n, name]) }), 'Connecting you to Dana Cole now.');
  assert.deepStrictEqual(got, [['+1777', 'Dana Cole']]);
  assert.match(await mkC()('call Dana', {}), /only put calls through while you're on the phone with me\. Dana Cole's number is \+1777/);
  assert.match(await mkC()('call Bob', { onConnect: () => {} }), /don't have Bob in your contacts/);
});

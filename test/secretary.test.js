const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createSecretary } = require('../bin/secretary.js');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
function mk(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const sent = [];
  const deps = {
    now: () => NOW,
    calls: () => [
      { id: 'c1', callSid: 'CA1', direction: 'in', from: '+15551230000', isOwner: false, outcome: 'message-taken', messages: ['Call me about the invoice'], summary: 'Left a message', endedAt: ago(2) },
      { id: 'c2', callSid: 'CA2', direction: 'in', from: '+972500000000', isOwner: true, outcome: 'owner-chat', summary: 'Asked status', endedAt: ago(3) },
      { id: 'c3', callSid: 'CA3', direction: 'in', from: '+15559990000', isOwner: false, outcome: 'blocked', endedAt: ago(4) },
      { id: 'c4', callSid: 'CA4', direction: 'in', from: '+15550001111', isOwner: false, outcome: 'message-taken', messages: ['old'], endedAt: ago(24 * 20) },
    ],
    missions: () => [{ project: 'p', id: 'm1', prompt: 'do x', status: 'done', report: { at: ago(1), headline: 'X shipped', verdict: 'success' } }, { project: 'p', id: 'm2', prompt: 'do y', status: 'working' }, { project: 'p', id: 'm3', prompt: 'do z', status: 'failed', report: { at: ago(1), headline: 'Z broke', verdict: 'failed' } }],
    questions: () => [{ missionId: 'm2', subtaskId: 's1', title: 'Pick a colour', ask: 'Red or blue?' }],
    sendText: async (t) => { sent.push(t); },
    ...over,
  };
  return { sec: createSecretary(dir, deps), sent, dir };
}

test('tasks: add, complete, remove, validate', () => {
  const { sec } = mk();
  assert.throws(() => sec.addTask({ title: ' ' }), /task/);
  const t = sec.addTask({ title: 'Book the florist', due: 'Friday' });
  assert.equal(sec.state().tasks.length, 1);
  assert.equal(sec.setTask(t.id, { done: true }).status, 'done');
  assert.ok(!sec.checklist().some((i) => i.kind === 'task' && i.title.includes('florist')) || sec.checklist().find((i) => i.kind === 'task').done === false);
  sec.removeTask(t.id);
  assert.equal(sec.state().tasks.length, 0);
  assert.throws(() => sec.removeTask('nope'), /No such/);
});

test('tasks: handed to ARES as a mission by default, reminder-only when toAres is false', () => {
  const filed = [];
  const { sec } = mk({ handOff: (project, prompt) => { filed.push({ project, prompt }); return { project: project || 'success-manager', id: 'm2' }; } });
  const t = sec.addTask({ title: 'Add a dark mode', detail: 'office UI', project: 'p' });
  assert.equal(filed.length, 1);
  assert.equal(filed[0].project, 'p');
  assert.match(filed[0].prompt, /^For ARES .*Add a dark mode\n\noffice UI$/s);
  assert.deepEqual(t.mission, { project: 'p', id: 'm2' });
  assert.equal(sec.state().tasks[0].missionStatus, 'working');
  const r = sec.addTask({ title: 'Call mum', toAres: false });
  assert.equal(filed.length, 1);
  assert.equal(r.mission, undefined);
});

test('route-style calls: the HTTP body ({ id, done }) works like (id, done)', () => {
  const { sec } = mk();
  const t = sec.addTask({ title: 'Water the plants', toAres: false });
  assert.equal(sec.setTask({ id: t.id, done: true }).status, 'done');
  sec.removeTask({ id: t.id });
  assert.equal(sec.state().tasks.length, 0);
  const item = sec.checklist().find((i) => !i.done);
  sec.tick({ id: item.id, done: true });
  assert.ok(sec.checklist().find((i) => i.id === item.id).done);
  sec.tick({ id: item.id, done: false });
  assert.ok(!sec.checklist().find((i) => i.id === item.id).done);
  const n = sec.addNote({ kind: 'fact', text: 'Closed Friday' });
  sec.removeNote({ id: n.id });
  assert.equal(sec.knowledge().facts.length, 0);
});

test('checklist: strangers, missions, questions; owner chat/blocked/old are skipped; ticks persist', () => {
  const { sec } = mk();
  const titles = sec.checklist().map((i) => i.title);
  assert.ok(titles.includes('Message from +15551230000'));
  assert.ok(titles.includes('Finished: X shipped'));
  assert.ok(titles.includes('Failed: Z broke'));
  assert.ok(titles.includes('Needs you: Pick a colour'));
  assert.equal(titles.filter((t) => /Call from|Message from/.test(t)).length, 1);
  assert.equal(sec.checklist()[0].kind, 'needs-you');
  sec.tick('mission:m1');
  assert.equal(sec.checklist().find((i) => i.id === 'mission:m1').done, true);
  sec.tick('mission:m1', false);
  assert.equal(sec.checklist().find((i) => i.id === 'mission:m1').done, false);
});

test('contacts: recognition names callers in checklist, callbacks and call log', () => {
  const { sec } = mk();
  sec.addContact({ name: 'Dana', number: '1 555 123 0000' });
  assert.deepEqual(sec.recognise('whatsapp:+15551230000'), { name: 'Dana', note: '' });
  assert.equal(sec.recognise('+1999'), null);
  assert.ok(sec.checklist().some((i) => i.title === 'Message from Dana'));
  assert.equal(sec.callbacks()[0].title, 'Call back Dana');
  assert.equal(sec.calls().find((c) => c.callSid === 'CA1').callerName, 'Dana');
  assert.throws(() => sec.addContact({ name: 'x', number: '' }), /number/);
});

test('callbacks tick; briefing and digest summarise; sendDigest texts', async () => {
  const { sec, sent } = mk();
  assert.equal(sec.callbacks().length, 1);
  sec.tick('cb:CA1');
  assert.equal(sec.callbacks()[0].done, true);
  sec.addNote({ kind: 'schedule', text: 'Dentist 3pm' });
  const b = sec.briefing();
  assert.match(b, /1 thing need|1 mission failed|next on your schedule: Dentist 3pm/);
  assert.match(sec.digest(), /Needs you: Pick a colour/);
  await sec.sendDigest();
  assert.equal(sent.length, 1);
  assert.ok(sec.state().digestAt);
});

test('knowledge lists live missions and survives broken deps', () => {
  const { sec } = mk();
  const k = sec.knowledge();
  assert.equal(k.activeMissions.length, 1);
  assert.equal(k.waitingOnOwner.length, 1);
  const bad = mk({ calls: () => { throw new Error('x'); }, missions: () => { throw new Error('x'); } }).sec;
  assert.match(bad.briefing(), /^Welcome back\./);
  assert.ok(bad.state().checklist.length >= 1); // the question still shows
});

test('importContacts: bulk-adds from the WhatsApp contacts file, keeps ids, skips junk', () => {
  const { sec, dir } = mk();
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify([{ fullName: 'Dana', phoneNumber: '972500000001', relationship: 'friend' }, { fullName: '', phoneNumber: '1' }, { fullName: 'Bad', phoneNumber: '12' }]));
  assert.deepStrictEqual(sec.importContacts({ path: f }), { ok: true, added: 1, updated: 0, skipped: 2, total: 1 });
  const id = sec.knowledge().contacts[0].id;
  assert.strictEqual(sec.importContacts({ path: f }).updated, 1);
  assert.strictEqual(sec.knowledge().contacts[0].id, id);
  assert.strictEqual(sec.recognise('+972500000001').name, 'Dana');
  assert.throws(() => sec.importContacts({ path: path.join(dir, 'nope.json') }));
});

// ---- reminders and the morning brief (IVY's day) ----
test('reminders: future only, listed in order, due when the time comes, marked sent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-rem-'));
  let t = Date.parse('2026-10-30T07:00:00Z');
  const S = createSecretary(dir, { now: () => t });
  assert.throws(() => S.addReminder({ text: 'x', at: '2026-10-30T06:00:00Z' }), /already passed/);
  assert.throws(() => S.addReminder({ text: 'x', at: 'later' }), /When/);
  const b = S.addReminder({ text: 'Call Dana', at: '2026-10-30T09:45:00+02:00', via: 'call' });
  S.addReminder({ text: 'Stand-up', at: '2026-10-30T07:30:00Z' });
  assert.deepStrictEqual(S.reminders().map((r) => r.text), ['Stand-up', 'Call Dana'], 'soonest first (09:45+02:00 is 07:45Z)');
  assert.strictEqual(S.dueReminders().length, 0);
  t = Date.parse('2026-10-30T07:46:00Z');
  assert.deepStrictEqual(S.dueReminders().map((r) => [r.text, r.via]), [['Stand-up', 'whatsapp'], ['Call Dana', 'call']]);
  S.markReminder(b.id, 'sent');
  assert.deepStrictEqual(S.dueReminders().map((r) => r.text), ['Stand-up']);
  assert.strictEqual(S.knowledge().reminders.length, 1);
});

test('morning brief: due once a day from briefTime to noon; settings validated; text and spoken versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-brief-'));
  const at = (h, m = 0) => { const d = new Date(2026, 9, 30, h, m); return d.getTime(); };
  let t = at(7, 0);
  const S = createSecretary(dir, { now: () => t, questions: () => [{ missionId: 'm1', title: 'Pick a logo', ask: 'A or B?' }],
    missions: () => [{ project: 'bloom', id: 'm9', status: 'failed', prompt: 'Deploy', updatedAt: new Date(at(3)).toISOString() }] });
  assert.throws(() => S.briefSettings({ briefTime: '8am' }), /HH:MM/);
  S.briefSettings({ briefTime: '08:30' });
  assert.strictEqual(S.briefDue(), false, 'too early');
  t = at(8, 31); assert.strictEqual(S.briefDue(), true);
  const today = new Date(at(10)).toISOString();
  S.addReminder({ text: 'Call Dana', at: today });
  const b = S.morningBrief({ events: [{ when: new Date(at(11)).toISOString().replace('Z', ''), title: 'Client call' }, { when: '2026-11-02', title: 'Not today' }], code: ['atlas-app: 1 commit not pushed'], yesterday: [{ repo: 'bloom', commits: ['Fix kiosk', 'Docs'] }] });
  assert.match(b.text, /^Good morning\. Friday 30 October\./);
  assert.match(b.text, /\*Today\*\n- \d\d:\d\d Client call\n- 10:00 reminder: Call Dana/);
  assert.doesNotMatch(b.text, /Not today/);
  assert.match(b.text, /\*Needs you\*\n- Pick a logo: A or B\?/);
  assert.match(b.text, /\*Code\*\n- atlas-app: 1 commit not pushed/);
  assert.match(b.text, /\*Overnight\*\n- Failed: Deploy/);
  assert.match(b.text, /\*You shipped yesterday\*\n- bloom: Fix kiosk \(\+1\)/);
  assert.match(b.spoken, /^1 thing on your calendar, first at \d\d:\d\d Client call\. 1 thing waiting on you\. In code, atlas-app: 1 commit not pushed\. 1 mission failed overnight\.$/);
  S.markBriefSent();
  assert.strictEqual(S.briefDue(), false, 'once a day');
  t = at(13); S.briefSettings({ briefOn: true });
  const S2 = createSecretary(fs.mkdtempSync(path.join(os.tmpdir(), 'sec-brief2-')), { now: () => at(13) });
  assert.strictEqual(S2.briefDue(), false, 'after noon it is no longer a morning brief');
});

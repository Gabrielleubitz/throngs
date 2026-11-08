'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createIvyTelegram } = require('../bin/ivy-telegram.js');
const { createTelegram } = require('../bin/telegram.js');

function mk(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ivytg-'));
  let id = 100; let t = Date.parse('2026-10-30T10:00:00Z');
  const sent = [], answers = [], replies = [], calls = [], chats = [];
  const tg = { linked: () => true, send: async (text, o = {}) => { sent.push({ text, ...o }); return { messageId: ++id }; }, typing: () => {}, start: () => {}, stop: () => {}, keyboard: (rows) => ({ keyboard: rows, is_persistent: true }) };
  const world = { missions: [], questions: [] };
  const G = createIvyTelegram(dir, {
    tg, now: () => t, missions: () => world.missions, questions: () => world.questions, name: (x) => ({ builder: 'FORGE' })[x] || '',
    answer: (...a) => answers.push(a), reply: (...a) => replies.push(a), call: async (x) => { calls.push(x); },
    chat: async (x, o) => { chats.push(x); if (/option b/i.test(x)) o.onAnswered('q:bloom/m1/s1'); return `ivy: ${x}`; },
    today: () => 'Good morning.', code: () => 'All green.', status: () => 'Two running.', ...over,
  });
  return { G, sent, answers, replies, calls, chats, world, tick: (ms) => { t += ms; }, lastId: () => id };
}
const Q = { project: 'bloom', missionId: 'm1', subtaskId: 's1', who: 'builder', title: 'Login', ask: { what: 'Which login style, A or B?', why: 'It changes the design', steps: [], reply: 'A or B' } };
const DONE = { project: 'bloom', id: 'm2', status: 'done', prompt: 'Add dark mode', report: { headline: 'Dark mode added', summary: 'Toggle in settings.', for_you: 'Nothing' } };

test('first run is quiet: what already exists is not re-announced', async () => {
  const x = mk(); x.world.missions = [DONE]; x.world.questions = [Q];
  assert.deepStrictEqual(await x.G.tick(), { seeded: true });
  await x.G.tick();
  assert.strictEqual(x.sent.length, 0);
});

test('a finished mission and an agent\'s question each send one message', async () => {
  const x = mk(); await x.G.tick();
  x.world.missions = [DONE, { ...DONE, id: 'm3', status: 'failed', report: { headline: 'Deploy broke', summary: 'Build error', for_you: 'Add the Stripe key' } }];
  x.world.questions = [Q];
  await x.G.tick(); await x.G.tick();
  assert.strictEqual(x.sent.length, 3, 'once each, never repeated');
  assert.match(x.sent[0].text, /^✅ Done \(bloom\): Dark mode added\nToggle in settings\.\n\n↩️ Reply/);
  assert.deepStrictEqual(x.sent[0].markup.inline_keyboard[0].map((b) => b.data), ['f', 'x']);
  assert.deepStrictEqual(x.sent[2].markup.inline_keyboard.map((r) => r.map((b) => b.text)), [['A', 'B'], ['✍️ Answer…']], 'tap-able answers from "A or B"');
  assert.doesNotMatch(x.sent[0].text, /For you/, '"Nothing" for you is left out');
  assert.match(x.sent[1].text, /^❌ Failed \(bloom\): Deploy broke[\s\S]*For you: Add the Stripe key/);
  assert.match(x.sent[2].text, /^🙋 FORGE needs you \(bloom\)\nWhich login style, A or B\?\nWhy: It changes the design\nReply with: A or B\n\n↩️ Tap an answer, or reply to this message\./);
});

test('replying to a question answers that agent; replying to a report asks ARES for a follow-up', async () => {
  const x = mk(); await x.G.tick();
  x.world.missions = [DONE]; x.world.questions = [Q]; await x.G.tick();
  const reportId = 101, questionId = 102;
  assert.match(await x.G.onMessage({ text: 'B please', replyTo: questionId, kind: 'text' }), /passed to FORGE/);
  assert.deepStrictEqual(x.answers, [['bloom', 'm1', 's1', 'B please']]);
  assert.match(await x.G.onMessage({ text: 'can you also add it to mobile?', replyTo: reportId, kind: 'text' }), /Passed to ARES/);
  assert.deepStrictEqual(x.replies, [['bloom', 'm2', 'can you also add it to mobile?']]);
  x.tick(11 * 60000); await x.G.tick();
  assert.strictEqual(x.calls.length, 0, 'answered on Telegram: no call');
});

test('urgent: no answer within the wait → Ivy calls once, and says so on Telegram', async () => {
  const x = mk(); await x.G.tick();
  x.world.questions = [Q]; await x.G.tick();
  x.tick(9 * 60000); await x.G.tick();
  assert.strictEqual(x.calls.length, 0, 'not yet');
  x.tick(2 * 60000); await x.G.tick(); await x.G.tick();
  assert.strictEqual(x.calls.length, 1, 'one call only');
  assert.match(x.calls[0], /^Hi, it's Ivy\. FORGE is stuck and needs you on bloom: Which login style, A or B\?/);
  await new Promise((r) => setImmediate(r));
  assert.ok(x.sent.some((s) => /I called you about this/.test(s.text) && s.replyTo === 101));
});

test('no call when the question was answered elsewhere, in quiet hours, or with calling off', async () => {
  const a = mk(); await a.G.tick(); a.world.questions = [Q]; await a.G.tick();
  a.world.questions = []; a.tick(20 * 60000); await a.G.tick();
  assert.strictEqual(a.calls.length, 0, 'answered in the office');
  const b = mk(); b.G.settings({ quiet: '00:00-23:59' }); await b.G.tick(); b.world.questions = [Q]; await b.G.tick();
  b.tick(20 * 60000); await b.G.tick();
  assert.strictEqual(b.calls.length, 0, 'quiet hours');
  const c = mk(); c.G.settings({ callOnUrgent: false, escalateMin: 5 }); await c.G.tick(); c.world.questions = [Q]; await c.G.tick();
  c.tick(20 * 60000); await c.G.tick();
  assert.strictEqual(c.calls.length, 0, 'calling off');
  assert.throws(() => c.G.settings({ escalateMin: 0 }), /1-240/);
  assert.throws(() => c.G.settings({ quiet: 'late' }), /HH:MM/);
});

test('free text is a conversation with Ivy; when she answers an agent in chat, no call follows', async () => {
  const x = mk(); await x.G.tick(); x.world.questions = [Q]; await x.G.tick();
  assert.strictEqual(await x.G.onMessage({ text: "what's running?", kind: 'text' }), "ivy: what's running?");
  await x.G.onMessage({ text: 'tell forge option B', kind: 'text' });
  x.tick(20 * 60000); await x.G.tick();
  assert.strictEqual(x.calls.length, 0);
});

test('commands answer instantly; voice notes get an honest line', async () => {
  const x = mk();
  assert.match(await x.G.onMessage({ text: '/start', kind: 'text' }), /I'm Ivy, your line to the office[\s\S]*\/today — Your day/);
  assert.deepStrictEqual(x.sent.at(-1).markup.keyboard[0], ['📅 Today', '🙋 Waiting on me', '📊 Status'], 'help comes with the button bar');
  assert.strictEqual(await x.G.onMessage({ text: '📅 Today', kind: 'text' }), 'Good morning.', 'a bar button runs its command');
  assert.strictEqual(await x.G.onMessage({ text: '/today', kind: 'text' }), 'Good morning.');
  assert.strictEqual(await x.G.onMessage({ text: '/code', kind: 'text' }), 'All green.');
  assert.strictEqual(await x.G.onMessage({ text: '/status', kind: 'text' }), 'Two running.');
  assert.match(await x.G.onMessage({ text: '/urgent', kind: 'text' }), /in 10 min, I call you/);
  assert.match(await x.G.onMessage({ text: '', kind: 'voice' }), /voice notes/);
  assert.strictEqual(x.chats.length, 0);
});

test('transport: only the owner\'s chat reaches Ivy; the offset is saved; strangers get one line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const calls = [];
  let served = false;
  const fetchFn = async (url, init) => {
    const method = url.split('/').pop(); const body = JSON.parse(init.body); calls.push({ method, body });
    assert.doesNotMatch(JSON.stringify(calls.at(-1)), /SECRET/, 'the token only ever goes in the URL');
    if (method === 'getUpdates') {
      if (served) { await new Promise((r) => setTimeout(r, 20)); return { json: async () => ({ ok: true, result: [] }) }; }
      served = true;
      return { json: async () => ({ ok: true, result: [
        { update_id: 7, message: { message_id: 1, chat: { id: 555 }, text: 'hi ivy' } },
        { update_id: 8, message: { message_id: 2, chat: { id: 999 }, text: 'who are you' } },
        { update_id: 9, message: { message_id: 3, chat: { id: 555 }, text: 'B', reply_to_message: { message_id: 42 } } }] }) };
    }
    return { json: async () => ({ ok: true, result: { message_id: 50 } }) };
  };
  const T = createTelegram(dir, { fetchFn, pollTimeoutSec: 0, integrations: { get: () => ({ bot_token: 'SECRET', default_chat_id: '555' }) } });
  const got = [];
  T.start(async (m) => { got.push(m); });
  await new Promise((r) => setTimeout(r, 80)); T.stop();
  assert.deepStrictEqual(got.map((m) => [m.text, m.replyTo]), [['hi ivy', null], ['B', 42]]);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === 999 && /private line/.test(c.body.text)));
  assert.strictEqual(JSON.parse(fs.readFileSync(T.file, 'utf8')).offset, 10);
  assert.ok(calls.filter((c) => c.method === 'getUpdates').slice(1).every((c) => c.body.offset === 10), 'never re-reads old messages');
});

test('/open moves the office instantly; /where says where it is', async () => {
  let at = 'bloom';
  const x = mk({ open: async (q) => { if (q === 'nope') throw new Error('No such folder.'); at = q; return { project: q, added: q === 'atlas-app' }; }, where: () => at });
  assert.strictEqual(await x.G.onMessage({ text: '/where', kind: 'text' }), 'The office is working in bloom.');
  assert.strictEqual(await x.G.onMessage({ text: '/open atlas-app', kind: 'text' }), 'Done, the office is working in atlas-app now (added it to the office first).');
  assert.strictEqual(await x.G.onMessage({ text: '/open', kind: 'text' }), 'Which folder? e.g. /open atlas-app');
  assert.match(await x.G.onMessage({ text: '/open nope', kind: 'text' }), /couldn't open that: No such folder/);
  assert.strictEqual(x.chats.length, 0);
});


test('buttons: tap an answer, tap Answer… to type one, Follow up on a report, pick a folder, list what waits', async () => {
  const opened = [];
  const x = mk({ open: async (q) => { opened.push(q); return { project: q, added: false }; }, where: () => 'bloom', folders: () => ['bloom', 'atlas-app', 'Real estate'] });
  await x.G.tick(); x.world.missions = [DONE]; x.world.questions = [Q]; await x.G.tick();
  const reportId = 101, questionId = 102;
  assert.strictEqual(await x.G.onMessage({ kind: 'button', data: 'a:1', messageId: questionId, buttonId: 'b1' }), 'Got it, passed to FORGE: B.');
  assert.deepStrictEqual(x.answers, [['bloom', 'm1', 's1', 'B']]);
  x.tick(20 * 60000); await x.G.tick();
  assert.strictEqual(x.calls.length, 0, 'answered by a tap: no call');
  await x.G.onMessage({ kind: 'button', data: 'w', messageId: questionId, buttonId: 'b2' });
  assert.match(x.sent.at(-1).text, /^Your answer for FORGE:/);
  assert.strictEqual(x.sent.at(-1).markup.force_reply, true);
  await x.G.onMessage({ text: 'Actually C, the minimal one', replyTo: x.lastId(), kind: 'text' });
  assert.deepStrictEqual(x.answers.at(-1), ['bloom', 'm1', 's1', 'Actually C, the minimal one'], 'the typed reply maps back to the question');
  await x.G.onMessage({ kind: 'button', data: 'f', messageId: reportId, buttonId: 'b3' });
  await x.G.onMessage({ text: 'add it to mobile too', replyTo: x.lastId(), kind: 'text' });
  assert.deepStrictEqual(x.replies, [['bloom', 'm2', 'add it to mobile too']]);
  await x.G.onMessage({ text: '📂 Open folder', kind: 'text' });
  assert.deepStrictEqual(x.sent.at(-1).markup.inline_keyboard[0].map((b) => b.data), ['o:bloom', 'o:atlas-app', 'o:Real estate']);
  assert.match(await x.G.onMessage({ kind: 'button', data: 'o:atlas-app', messageId: 999, buttonId: 'b4' }), /working in atlas-app now/);
  assert.deepStrictEqual(opened, ['atlas-app']);
  const before = x.sent.length;
  assert.strictEqual(await x.G.onMessage({ text: '🙋 Waiting on me', kind: 'text' }), '1 waiting');
  assert.match(x.sent[before].text, /^1 thing waiting on you/);
  assert.match(x.sent[before + 1].text, /^🙋 FORGE needs you/);
  x.world.questions = [];
  assert.match(await x.G.onMessage({ text: '/waiting', kind: 'text' }), /Nobody's waiting/);
  assert.strictEqual(await x.G.onMessage({ kind: 'button', data: 'a:0', messageId: 424242, buttonId: 'b5' }), '', 'a stale message never answers anything');
});

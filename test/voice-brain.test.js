'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createVoiceSession } = require('../bin/voice-brain.js');
const { createChat, voiceSystem } = require('../bin/ares-chat.js');

/** A fake `claude` stream-json process: each user line gets the scripted reply streamed in small deltas. */
function fakeClaude(replies) {
  const got = [];
  const spawnFn = (bin, args) => {
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.args = args;
    let i = 0;
    p.stdin = { write(line) { got.push(JSON.parse(line).message.content); const text = replies[i++] ?? 'Okay.';
      setImmediate(() => {
        for (let k = 0; k < text.length; k += 7) p.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(k, k + 7) } } }) + '\n');
        p.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: text }) + '\n');
      }); }, end() {} };
    p.kill = () => {}; spawnFn.proc = p; return p;
  };
  return { spawnFn, got };
}

test('sentences stream out as they finish; the ACTION line is never spoken, and is parsed', async () => {
  const f = fakeClaude(['Sure. I\'ll get FORGE on it now.\nACTION: {"action":"task","task":"Fix login","project":"bloom"}']);
  const s = createVoiceSession({ system: 'sys', spawnFn: f.spawnFn, warm: false });
  assert.ok(f.spawnFn.proc.args.includes('--include-partial-messages') && f.spawnFn.proc.args.includes('stream-json'));
  const heard = [];
  const r = await s.ask('fix the login on bloom', { onSentence: (x) => heard.push(x) });
  assert.deepStrictEqual(heard, ['Sure.', "I'll get FORGE on it now."]);
  assert.deepStrictEqual([r.say, r.action, r.task, r.project, r.streamed], ["Sure. I'll get FORGE on it now.", 'task', 'Fix login', 'bloom', true]);
});

test('turns queue in order on one session; a stale turn is never spoken', async () => {
  const f = fakeClaude(['First answer.', 'Second answer.']);
  const s = createVoiceSession({ system: 'sys', spawnFn: f.spawnFn, warm: false });
  const out = [];
  const a = s.ask('one', { onSentence: (x) => out.push(x), stale: () => true });
  const b = s.ask('two', { onSentence: (x) => out.push(x) });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepStrictEqual(f.got, ['one', 'two']);
  assert.deepStrictEqual(out, ['Second answer.']);
  assert.strictEqual(ra.say, 'First answer.'); assert.strictEqual(rb.say, 'Second answer.');
});

test('the owner brain on a session: streams, files the task, and keeps the streamed words as the reply', async () => {
  const f = fakeClaude(['On it. ARES has it.\nACTION: {"action":"task","task":"Fix login","project":"bloom-booking"}']);
  const filed = [];
  const h = createChat({ file: async (t, p) => { filed.push([t, p]); return p; }, projects: () => ['bloom-booking'], session: (system) => createVoiceSession({ system, spawnFn: f.spawnFn, warm: false }) });
  const s = h.openSession({ context: 'Desk: dentist at 3' });
  assert.match(f.spawnFn.proc.args[f.spawnFn.proc.args.indexOf('--system-prompt') + 1], /ACTION: \{"action"[\s\S]*bloom-booking[\s\S]*Desk: dentist at 3/);
  const said = [];
  const r = await h('fix the login on bloom', { session: s, onSentence: (x) => said.push(x), history: [] });
  assert.deepStrictEqual(said, ['On it.', 'ARES has it.']);
  assert.strictEqual(r, 'On it. ARES has it.');
  assert.deepStrictEqual(filed, [['Fix login', 'bloom-booking']]);
});

test('voiceSystem lists every action field and the spoken-style rules', () => {
  const t = voiceSystem({ projects: ['atlas-app'] });
  for (const w of ['FIRST sentence short', 'ACTION:', 'remindAt', 'answerRef', 'folder', 'contact', 'atlas-app']) assert.ok(t.includes(w), w);
});

test('the session warms up with one silent turn as it opens', async () => {
  const f = fakeClaude(['ok', 'Hi there.']);
  const s = createVoiceSession({ system: 'sys', spawnFn: f.spawnFn });
  const out = [];
  const r = await s.ask('hello', { onSentence: (x) => out.push(x) });
  assert.match(f.got[0], /call is connecting/);
  assert.deepStrictEqual(out, ['Hi there.'], 'the warm-up reply is never spoken');
  assert.strictEqual(r.say, 'Hi there.');
});

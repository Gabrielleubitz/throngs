/** node --test test/ — missions.reply(): validation, thread, ARES answer, follow-up mission linking. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMissions } = require('../bin/missions.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reply-'));
const ROOT = path.join(tmp, 'root');
const projDir = path.join(ROOT, 'projects', 'demo');
const repo = path.join(tmp, 'repo');
const bin = path.join(tmp, 'bin');
for (const d of [projDir, repo, bin]) fs.mkdirSync(d, { recursive: true });
// fake `claude`: answers per FAKE_FOLLOW_UP; fake runner: exits at once
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
echo '{"type":"result","is_error":false,"session_id":"s1","total_cost_usd":0.01,"structured_output":{"answer":"Sure thing.","follow_up":'"$FAKE_FOLLOW_UP"',"follow_up_prompt":"Add the button too."}}'
`, { mode: 0o755 });
const SELF = path.join(bin, 'noop.js');
fs.writeFileSync(SELF, '');
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const sm = {
  ROOT, SELF,
  loadProject: (name) => ({ name, dir: projDir, config: { path: repo }, state: {} }),
  readJSON: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
  usesBeads: () => false,
};
const M = createMissions(sm);
const file = (id) => path.join(projDir, 'missions', `${id}.json`);
const read = (id) => JSON.parse(fs.readFileSync(file(id), 'utf8'));
const report = { headline: 'Added X', verdict: 'success', summary: 'Done.', completed: [], changes: [], checks: { qa_passed: true, notes: '' }, concerns: ['Y untested'], next_steps: [], for_you: 'Nothing', at: new Date().toISOString() };
let n = 0;
function seed(withReport = true) {
  const id = `m-test${n++}`;
  fs.mkdirSync(path.dirname(file(id)), { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify({ id, project: 'demo', prompt: 'Add X', status: 'done', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0, ...(withReport ? { report } : {}) }));
  return id;
}
async function answered(id) {
  for (let i = 0; i < 100; i++) {
    const m = read(id);
    if (m.replies?.at(-1)?.from === 'orchestrator') return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('ARES never answered');
}
const status = (fn) => { try { fn(); } catch (e) { return e.status; } return 200; };

test('validates mission, report and text', () => {
  assert.strictEqual(status(() => M.reply('demo', 'm-nope', 'hi')), 404);
  assert.strictEqual(status(() => M.reply('demo', seed(false), 'hi')), 409);
  const id = seed();
  assert.strictEqual(status(() => M.reply('demo', id, '   ')), 400);
  assert.strictEqual(status(() => M.reply('demo', id, 'x'.repeat(4001))), 400);
  assert.strictEqual(read(id).replies, undefined);
});

test('a question gets an answer in the thread, no follow-up', async () => {
  process.env.FAKE_FOLLOW_UP = 'false';
  const id = seed();
  const r = M.reply('demo', id, '  Is Y safe?  ');
  assert.deepStrictEqual({ id: r.reply.id, from: r.reply.from, text: r.reply.text }, { id: 'r1', from: 'owner', text: 'Is Y safe?' });
  assert.strictEqual(M.snapshot('demo').find((m) => m.id === id).replyPending, true);
  assert.strictEqual(status(() => M.reply('demo', id, 'again')), 409); // one at a time
  const m = await answered(id);
  assert.strictEqual(m.replies[1].text, 'Sure thing.');
  assert.strictEqual(m.replies[1].inReplyTo, 'r1');
  assert.strictEqual(m.followUpId, undefined);
  assert.ok(m.events.some((e) => e.kind === 'reply' && e.who === 'owner'));
  assert.ok(m.cost > 0);
});

test('a work request starts a linked follow-up mission', async () => {
  process.env.FAKE_FOLLOW_UP = 'true';
  const id = seed();
  M.reply('demo', id, 'Please also add a button');
  const m = await answered(id);
  assert.ok(m.followUpId);
  assert.strictEqual(m.replies[1].followUpId, m.followUpId);
  const child = read(m.followUpId);
  assert.strictEqual(child.parentId, id);
  assert.strictEqual(child.prompt, 'Please also add a button');
  assert.match(child.context, /Add X/);
  assert.match(child.context, /Y untested/);
  assert.match(child.context, /Please also add a button/);
});

test('answerOnly never starts new work', async () => {
  process.env.FAKE_FOLLOW_UP = 'true';
  const id = seed();
  M.reply('demo', id, 'Please also add a button', { answerOnly: true });
  const m = await answered(id);
  assert.strictEqual(m.followUpId, undefined);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

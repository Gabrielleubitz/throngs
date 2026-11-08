const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createErrorLog } = require('../bin/errorlog.js');
const { createLearning } = require('../bin/learning.js');

const mk = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
  const created = [];
  const snaps = { demo: [] };
  const missions = { create: (p, text) => { created.push({ p, text }); const m = { id: `m-fix${created.length}`, status: 'working' }; (snaps[p] ||= []).push(m); return m; }, snapshot: (p) => snaps[p] || [] };
  const learning = createLearning(root);
  const log = createErrorLog({ ROOT: root, listProjects: () => ['demo'] }, { missions, learning });
  return { log, learning, created, snaps };
};

test('same error merges and counts; keys are hidden', () => {
  const { log } = mk();
  log.record({ title: 'Boom 12 at sk-abcdefghijklmnop', detail: 'token=abcdefgh12345' });
  const e = log.record({ title: 'Boom 99 at sk-abcdefghijklmnop' });
  assert.strictEqual(e.count, 2);
  assert.ok(!/sk-abcdef/.test(JSON.stringify(log.list())));
});

test('ARES gets nothing until the owner approves; approval opens a mission once', () => {
  const { log, created } = mk();
  const e = log.record({ title: 'Crash', project: 'demo' });
  assert.strictEqual(created.length, 0);
  log.approve(e.id);
  assert.strictEqual(created.length, 1);
  assert.match(created[0].text, /For ARES/);
  assert.throws(() => log.approve(e.id), /already/);
});

test('finished fix marks error fixed and teaches a lesson', () => {
  const { log, learning, snaps } = mk();
  const e = log.record({ title: 'Crash', project: 'demo' });
  log.approve(e.id);
  snaps.demo[0].status = 'done';
  assert.strictEqual(log.list()[0].status, 'fixed');
  assert.strictEqual(learning.list().length, 1);
});

test('sweep logs failed missions and critical watch findings', () => {
  const { log, snaps } = mk();
  snaps.demo = [{ id: 'm-9', status: 'failed', prompt: 'x', createdAt: new Date().toISOString(), error: 'nope' }];
  log.sweep([{ severity: 'critical', title: 'Two runners', detail: 'd' }, { severity: 'warn', title: 'meh' }]);
  assert.strictEqual(log.list().length, 2);
});

test('learning: dedupes, caps prompt block, removes', () => {
  const { learning } = mk();
  const a = learning.add('Test UI live');
  assert.strictEqual(learning.add('test ui live').id, a.id);
  assert.match(learning.promptBlock(), /Test UI live/);
  learning.remove(a.id);
  assert.strictEqual(learning.promptBlock(), '');
});

test('sweep after a fix does not reopen the error', () => {
  const { log, snaps } = mk();
  snaps.demo = [{ id: 'm-9', status: 'failed', prompt: 'x', createdAt: new Date().toISOString(), error: 'nope' }];
  log.sweep();
  const e = log.list()[0];
  log.approve(e.id);
  snaps.demo.find((m) => m.id === 'm-fix1').status = 'done';
  assert.strictEqual(log.list()[0].status, 'fixed');
  log.sweep();
  const after = log.list();
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].status, 'fixed');
  assert.strictEqual(after[0].count, 1);
});

test('learnFromPrompt saves only rule-like sentences', () => {
  const { learning } = mk();
  const got = learning.learnFromPrompt('Add a button to the panel. Always test it in the live office before reporting. Make it blue.');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].kind, 'prompt');
  assert.deepStrictEqual(learning.learnFromPrompt('Fix the typo in the header.'), []);
});

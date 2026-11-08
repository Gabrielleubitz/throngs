/** node --test test/ — the QA-supervisor guard allows bin/, test/, pixel-office/ and nothing else. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWorkerEditable } = require('../bin/guard-paths.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-guard-'));
for (const d of ['bin', 'test', 'pixel-office', 'bin-evil', 'projects/x']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.symlinkSync(path.join(root, 'projects'), path.join(root, 'bin', 'link'));

test('allows bin/, test/, pixel-office/ (existing and new files)', () => {
  assert.ok(isWorkerEditable(root, path.join(root, 'bin/sm.js')));
  assert.ok(isWorkerEditable(root, path.join(root, 'test/new/a.test.js')));
  assert.ok(isWorkerEditable(root, path.join(root, 'pixel-office/webview-ui/src/a.ts')));
});

test('denies everything else', () => {
  assert.ok(!isWorkerEditable(root, path.join(root, 'projects/x/config.json')));
  assert.ok(!isWorkerEditable(root, path.join(root, 'CLAUDE.md')));
  assert.ok(!isWorkerEditable(root, path.join(root, 'bin')), 'the dir itself');
  assert.ok(!isWorkerEditable(root, path.join(root, 'bin-evil/a.js')));
  assert.ok(!isWorkerEditable(root, path.join(root, 'pixel-office-x/a.js')));
});

test('denies ../ traversal and symlink escapes', () => {
  assert.ok(!isWorkerEditable(root, path.join(root, 'bin/../projects/x/config.json')));
  assert.ok(!isWorkerEditable(root, path.join(root, 'bin/link/x/config.json')));
});

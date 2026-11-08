/** git push: only the selected folder's repo, to its own remote, never forced — unless the owner named another repo. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pushVerdict } = require('../bin/sm.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-push-')));
const mkRepo = (name) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q', d]);
  spawnSync('git', ['-C', d, 'remote', 'add', 'origin', `git@example.com:me/${name}.git`]);
  return d;
};
const app = mkRepo('app');
const nested = mkRepo('app/web'); // a repo inside the selected folder
const other = mkRepo('other');
const proj = (extra = {}) => ({ config: { path: app, fullAccess: true, ...extra } });
const allow = (c, cwd = app, p = proj()) => pushVerdict(c, cwd, p) === '';

test('pushes to the selected folder\'s repo (and repos inside it) are allowed', () => {
  delete process.env.SM_PUSH_ROOT; delete process.env.SM_PUSH_EXTRA;
  assert.ok(allow('git push'));
  assert.ok(allow('git push origin main'));
  assert.ok(allow('git push -u origin feature/x'));
  assert.ok(allow(`cd ${nested} && git push`));
  assert.ok(allow('git push', nested));
});

test('other repos, other remotes and force pushes are not', () => {
  assert.ok(!allow(`cd ${other} && git push`));
  assert.ok(!allow(`git -C ${other} push origin main`));
  assert.ok(!allow('git push', other));
  assert.ok(!allow('git push git@evil.com:x/y.git main'), 'a raw URL is not one of the repo\'s remotes');
  assert.ok(!allow('git push --force origin main'));
  assert.ok(!allow('git push -f'));
  assert.ok(!allow('git push origin +main:main'));
  assert.ok(!allow('git push origin --delete main'));
});

test('the owner can name another repo, or switch pushing off', () => {
  process.env.SM_PUSH_EXTRA = other;
  try { assert.ok(allow(`cd ${other} && git push`)); } finally { delete process.env.SM_PUSH_EXTRA; }
  assert.ok(allow(`cd ${other} && git push`, app, proj({ pushRepos: [other] })));
  assert.ok(!allow('git push', app, proj({ allowPush: false })));
  assert.ok(!allow('git push', app, { config: { path: app } }), 'no full access, no push');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createDevPulse, ghSlug } = require('../bin/devpulse.js');

const DAY = 86400000;
const NOW = Date.parse('2026-10-30T09:00:00Z');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: process.env.GD, GIT_COMMITTER_DATE: process.env.GD } });
function repo(root, name, { daysAgo = 0, dirty = 0, slug = '' } = {}) {
  const d = path.join(root, name); fs.mkdirSync(d);
  g(d, 'init', '-q'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'a.txt'), 'a'); g(d, 'add', '.');
  process.env.GD = new Date(Date.now() - daysAgo * DAY).toISOString(); g(d, 'commit', '-qm', `first in ${name}`); delete process.env.GD;
  for (let i = 0; i < dirty; i++) fs.writeFileSync(path.join(d, 'a.txt'), `changed ${i}`);
  if (slug) g(d, 'remote', 'add', 'origin', `ssh://git@ssh.github.com:443/${slug}.git`);
  return d;
}

test('ghSlug reads https, scp-style and port-443 ssh remotes', () => {
  assert.strictEqual(ghSlug('https://github.com/me/app.git'), 'me/app');
  assert.strictEqual(ghSlug('git@github.com:me/app.git'), 'me/app');
  assert.strictEqual(ghSlug('ssh://git@ssh.github.com:443/me/app.git'), 'me/app');
  assert.strictEqual(ghSlug('https://gitlab.com/me/app'), '');
});

test('local scan + GitHub are ranked: failing CI first, dormant repos never nag, others\' repos never "unpushed"', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
  repo(root, 'live', { daysAgo: 0, dirty: 1, slug: 'me/live' });
  repo(root, 'old', { daysAgo: 200, dirty: 1 });
  const office = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  const ghData = { data: { viewer: { login: 'me', pullRequests: { nodes: [{ title: 'Add login', url: 'u', isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', repository: { nameWithOwner: 'me/live' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } }] },
    repositories: { nodes: [
      { nameWithOwner: 'me/live', pushedAt: new Date().toISOString(), isArchived: false, isFork: false, defaultBranchRef: { name: 'main', target: { messageHeadline: 'x', statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ context: 'Vercel', state: 'FAILURE' }] } } } }, issues: { totalCount: 2 }, pullRequests: { totalCount: 1 }, vulnerabilityAlerts: { totalCount: 1 } },
      { nameWithOwner: 'me/ancient', pushedAt: '2024-01-01T00:00:00Z', isArchived: false, isFork: false, defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [] } } } }, issues: { totalCount: 0 }, pullRequests: { totalCount: 0 }, vulnerabilityAlerts: { totalCount: 0 } }] } },
    rr: { nodes: [{ title: 'Fix nav', url: 'v', repository: { nameWithOwner: 'friend/site' } }] }, asg: { nodes: [] } } };
  const real = (cmd, args, cwd) => new Promise((res, rej) => require('child_process').execFile(cmd, args, { cwd, encoding: 'utf8' }, (e, o) => (e ? rej(e) : res(String(o).trim()))));
  const P = createDevPulse(office, { roots: [root], exec: (cmd, args, cwd) => (cmd === 'gh' ? Promise.resolve(JSON.stringify(ghData)) : real(cmd, args, cwd)) });
  const d = await P.refresh();
  assert.strictEqual(d.repos.length, 2);
  const att = P.attention(d).map((a) => `${a.level} ${a.text}`);
  assert.match(att[0], /^0 live: checks failing on main \(Vercel\)/);
  assert.ok(att.some((x) => /^0 live: open security alert/.test(x)));
  assert.ok(att.some((x) => /^1 Review requested: Fix nav/.test(x)));
  assert.ok(att.some((x) => /^1 Ready to merge: Add login/.test(x)));
  assert.ok(att.some((x) => /^3 ancient: checks failing/.test(x)), 'a repo nobody pushed in ages is not urgent');
  assert.ok(att.some((x) => /^3 old \(untouched/.test(x)), 'old uncommitted work is mentioned quietly');
  assert.ok(att.some((x) => /^[23] live: 1 uncommitted change/.test(x)));
  assert.deepStrictEqual(P.yesterday(d).map((r) => r.repo), ['live']);
  assert.match(P.spoken(d), /^live: checks failing on main\. live: open security alert\./);
  assert.match(P.context(d), /Needs attention:[\s\S]*Committed in the last 24h:\n- live: first in live/);
  assert.ok(fs.existsSync(P.file), 'cached for IVY and the office');
  const fp = await P.forProject(path.join(root, 'live'));
  assert.match(fp, /Repo state \(live, branch \w+, GitHub me\/live\)[\s\S]*CI on main: FAILURE \(failing: Vercel\)[\s\S]*first in live/);
});

test('GitHub down: local results still come back, with the reason', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
  repo(root, 'solo');
  const real = (cmd, args, cwd) => new Promise((res, rej) => require('child_process').execFile(cmd, args, { cwd, encoding: 'utf8' }, (e, o) => (e ? rej(e) : res(String(o).trim()))));
  const P = createDevPulse(fs.mkdtempSync(path.join(os.tmpdir(), 'office-')), { roots: [root], exec: (cmd, a, cwd) => (cmd === 'gh' ? Promise.reject(new Error('not logged in')) : real(cmd, a, cwd)) });
  const d = await P.refresh();
  assert.strictEqual(d.repos.length, 1);
  assert.match(d.github.error, /GitHub unavailable/);
  assert.match(P.context(d), /GitHub unavailable/);
});

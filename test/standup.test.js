/** node --test test/ — daily standup: three sections, empty day, one note per day. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStandup } = require('../bin/standup.js');

const NOW = new Date('2026-10-27T08:00:00');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

function setup({ issues = [], missions = [], state = {}, status = 'IN_PROGRESS' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-standup-'));
  const pdir = path.join(root, 'projects', 'demo');
  fs.mkdirSync(path.join(pdir, 'missions'), { recursive: true });
  missions.forEach((m, i) => fs.writeFileSync(path.join(pdir, 'missions', `m-${i}.json`), JSON.stringify(m)));
  const p = { name: 'demo', dir: pdir, config: { path: root }, state };
  const sm = {
    ROOT: root, loadProject: () => p, listProjects: () => ['demo'], usesBeads: () => true,
    bd: () => JSON.stringify(issues), readJSON: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    overallStatus: () => status,
  };
  return { root, standup: createStandup(sm) };
}

test('yesterday / today / blocked come from real state', () => {
  const { standup } = setup({
    issues: [
      { id: 'a-1', title: 'Fixed login', status: 'closed', closed_at: hoursAgo(5), labels: [] }, // the field name bd really emits
      { id: 'a-2', title: 'Ancient work', status: 'closed', closedAt: hoursAgo(72), labels: [] },
      { id: 'a-3', title: 'Build widget', status: 'in_progress', labels: [] },
      { id: 'a-4', title: 'Test on device', status: 'open', labels: ['human'] },
      { id: 'a-5', title: 'Mission epic', status: 'open', labels: ['mission'] },
    ],
    missions: [
      { status: 'done', prompt: 'Ship the thing', finishedAt: hoursAgo(3), report: { verdict: 'success' } },
      { status: 'working', prompt: 'Refactor router' },
    ],
    state: { lastVerdict: 'GAVE UP (no progress)' },
  });
  const md = standup.render(standup.collect(NOW), NOW);
  const [, y, t, b] = md.split(/^## /m);
  assert.match(y, /Yesterday/); assert.match(y, /a-1: Fixed login/); assert.match(y, /Ship the thing — success/);
  assert.doesNotMatch(y, /Ancient work|Mission epic/);
  assert.match(t, /a-3: Build widget \(in progress\)/); assert.match(t, /mission running — Refactor router/);
  assert.match(b, /needs you — a-4: Test on device/); assert.match(b, /GAVE UP — \(no progress\)/);
});

test('AWAITING_HUMAN_INPUT is reported as blocked', () => {
  const { standup } = setup({ status: 'AWAITING_HUMAN_INPUT' });
  assert.match(standup.render(standup.collect(NOW), NOW), /AWAITING_HUMAN_INPUT/);
});

test('empty day still produces a readable note', () => {
  const { standup } = setup();
  const md = standup.render(standup.collect(NOW), NOW);
  assert.match(md, /# Standup — 2026-10-27/);
  assert.match(md, /Nothing was closed or finished/);
  assert.match(md, /Nothing queued or running/);
  assert.match(md, /Nothing is blocked/);
});

test('one note per day: second run does not duplicate or rewrite; latest mirrors it', () => {
  const { root, standup } = setup({ issues: [{ id: 'a-1', title: 'X', status: 'open', labels: [] }] });
  const first = standup.generate({ now: NOW });
  assert.equal(first.created, true);
  const again = standup.generate({ now: new Date(NOW.getTime() + 3600 * 1000) });
  assert.equal(again.created, false);
  assert.equal(again.text, first.text);
  const files = fs.readdirSync(path.join(root, 'standup')).sort();
  assert.deepEqual(files, ['2026-10-27.md', 'latest.md']);
  assert.equal(standup.latest().text, first.text);
  assert.equal(standup.generate({ now: NOW, force: true }).created, true);
  const next = standup.generate({ now: new Date('2026-10-28T08:00:00') });
  assert.equal(next.created, true);
  assert.equal(fs.readdirSync(path.join(root, 'standup')).length, 3);
});

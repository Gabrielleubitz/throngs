/** ARES's watch finds the flow bugs the owner used to spot by hand — and fixes the safe ones. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWatchdog } = require('../bin/watchdog.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-watch-'));
const dir = path.join(ROOT, 'projects', 'demo', 'missions');
fs.mkdirSync(dir, { recursive: true });
const sm = { ROOT, listProjects: () => ['demo'], loadProject: () => ({ config: { path: ROOT } }) };
const now = new Date().toISOString();
const write = (m, streams = {}) => {
  fs.writeFileSync(path.join(dir, `${m.id}.json`), JSON.stringify(m));
  for (const [sid, text] of Object.entries(streams)) fs.writeFileSync(path.join(dir, `${m.id}.${sid}.stream.jsonl`), text);
};

write({ id: 'm-dead', prompt: 'Make it blue', status: 'working', runnerPid: 999999, createdAt: now, subtasks: [] });
write({
  id: 'm-flaky', prompt: 'Add a TODAY box', status: 'done', finishedAt: now, cost: 1.2, createdAt: now, route: { funnel: 'solo' },
  loop: { history: [{ round: 1, by: 'the QA script', issues: ['QA command "office-live" fails'] }] },
  subtasks: [{ id: 's2', kind: 'rework', title: 'Fix round 1: 1 problem(s) found by the QA script', status: 'done', cost: 0.4, result: { files_changed: [] } }],
}, { s1: Array(4).fill('{"kind":"error","text":"PreToolUse:Bash hook error: Success Manager: the supervisor is off-limits"}').join('\n') });

test('finds a mission whose runner died, a flaky QA round and guard fights — and marks the dead one stalled', () => {
  const W = createWatchdog(sm);
  const r = W.run({ fix: true });
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes('dead-runner:m-dead'));
  assert.ok(ids.includes('flaky-qa:m-flaky:1'));
  assert.ok(ids.includes('guard-fights:m-flaky'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'm-dead.json'), 'utf8')).status, 'stalled', 'safe fix applied');
  assert.deepEqual(W.latest().findings.map((f) => f.id), ids, 'saved for the panel');
  const order = { critical: 0, warn: 1, info: 2 };
  assert.ok(r.findings.every((f, i, a) => i === 0 || order[a[i - 1].severity] <= order[f.severity]), 'worst first');
});

test('home vs workplace: a client project\'s material sitting in the office is flagged', () => {
  const { spawnSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-home-'));
  const client = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-client-'));
  spawnSync('git', ['init', '-q', home]);
  fs.mkdirSync(path.join(home, 'videos', 'public-bloom'), { recursive: true });
  fs.writeFileSync(path.join(home, 'videos', 'public-bloom', 'logo.png'), 'x');
  fs.writeFileSync(path.join(home, 'shoot.mjs'), `const CB = '${fs.realpathSync(client)}/';`);
  fs.writeFileSync(path.join(home, 'office.js'), 'module.exports = 1;');
  const W = createWatchdog({ ROOT: home, listProjects: () => ['home', 'bloom-booking'], loadProject: (n) => ({ config: { path: n === 'home' ? home : client } }) });
  const f = W.run().findings.find((x) => x.id === 'project-in-office');
  assert.ok(f, 'flagged');
  assert.match(f.detail, /videos\/public-bloom\/logo\.png → bloom-booking \(named after it\)/);
  assert.match(f.detail, /shoot\.mjs → bloom-booking \(points into its folder\)/);
  assert.doesNotMatch(f.detail, /office\.js/);
});

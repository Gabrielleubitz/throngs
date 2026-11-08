const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../bin/health.js');

const HIST = [
  '2026-10-27T10:00:00.000Z  iter=1  verdict=CONTINUE  qa=a:pass,b:fail  open=2',
  '2026-10-27T11:00:00.000Z  AUDIT new_blocking=1 suggestions=2 human=0 cost=$0.42',
  '2026-10-27T10:06:54.536Z  iter=3  verdict=GAVE UP (no progress)  qa=a:pass,b:pass  open=1',
  'garbage line',
].join('\n');

test('parseHistory reads run lines and skips AUDIT/garbage', () => {
  const r = H.parseHistory(HIST);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0].qa, [{ name: 'a', pass: true }, { name: 'b', pass: false }]);
  assert.strictEqual(r[1].verdict, 'GAVE UP (no progress)');
  assert.deepStrictEqual(H.parseHistory('x  iter=1  verdict=COMPLETE  qa=none  open=0')[0].qa, []);
});

test('parseLatest reads verdict, time and QA marks', () => {
  const l = H.parseLatest('- Time: 2026-10-27T10:00:00Z\n- Verdict: **GAVE UP (no progress)**\n- ✅ `kit` (exit 0)\n- ❌ `app` (exit 1)');
  assert.strictEqual(l.verdict, 'GAVE UP (no progress)');
  assert.strictEqual(l.at, '2026-10-27T10:00:00Z');
  assert.strictEqual(H.qaState(l.qa), 'fail');
  assert.strictEqual(H.qaState([]), 'unknown');
});

test('markdownPriorities and countByPriority', () => {
  const p = H.markdownPriorities('- [ ] a _(P0, from x)_\n- [x] done _(P1)_\n- [ ] b\n- [ ] c _(P4, from y)_');
  assert.deepStrictEqual(p, [0, 2, 4]);
  assert.deepStrictEqual(H.countByPriority([0, 2, 4, 9, undefined]), [1, 0, 2, 0, 2]);
});

test('ranking: GAVE UP, then QA fail, then P0/P1, then rest', () => {
  const rec = (name, hist, pri) => H.buildRecord(name, { latestText: '', historyText: hist, priorities: pri });
  const ok = (q) => `2026-10-27T10:00:00.000Z  iter=1  verdict=COMPLETE  qa=a:${q}  open=0`;
  const rows = H.sortBoard([
    rec('calm', ok('pass'), [3]),
    rec('p1', ok('pass'), [1]),
    rec('failing', ok('fail'), []),
    rec('gaveup', HIST, []),
  ]);
  assert.deepStrictEqual(rows.map((r) => r.name), ['gaveup', 'failing', 'p1', 'calm']);
  assert.strictEqual(rows[0].gaveUp, true);
  assert.strictEqual(rows[2].openTasks[1], 1);
});

test('missing files give unknown, never throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'md'));
  fs.writeFileSync(path.join(dir, 'md', 'TASKS.md'), '- [ ] x _(P1, from y)_\n');
  const board = H.createHealth({ PROJECTS: dir, listProjects: () => ['empty', 'md', 'nodir'] })();
  const by = Object.fromEntries(board.map((r) => [r.name, r]));
  assert.strictEqual(by.empty.lastQa, 'unknown');
  assert.strictEqual(by.empty.lastRun, null);
  assert.strictEqual(by.empty.gaveUp, false);
  assert.strictEqual(by.nodir.openTotal, 0);
  assert.strictEqual(by.md.openTasks[1], 1);
  assert.strictEqual(by.md.rank, 2);
});

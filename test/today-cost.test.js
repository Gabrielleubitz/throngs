/** node --test test/ — missions.todayCost(): sums every mission started today, beyond the 15 shown in snapshots. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMissions } = require('../bin/missions.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-today-'));
const projDir = path.join(tmp, 'projects', 'demo');
fs.mkdirSync(path.join(projDir, 'missions'), { recursive: true });
const sm = {
  ROOT: tmp, SELF: '',
  loadProject: (name) => ({ name, dir: projDir, config: { path: tmp }, state: {} }),
  readJSON: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
  usesBeads: () => false,
};
const M = createMissions(sm);

test('todayCost counts all of today\'s missions (not just 15) and skips older days', () => {
  const noon = new Date(2026, 9, 28, 12, 0, 0);
  const put = (id, at, cost) => fs.writeFileSync(path.join(projDir, 'missions', `${id}.json`), JSON.stringify({ id, createdAt: at.toISOString(), cost, subtasks: [], events: [], status: 'done' }));
  for (let i = 0; i < 20; i++) put(`m-t${i}`, new Date(2026, 9, 28, 1, i), 1);
  put('m-old', new Date(2026, 9, 27, 23, 59), 50);
  assert.strictEqual(M.snapshot('demo').length, 15);
  assert.strictEqual(M.todayCost('demo', noon), 20);
});

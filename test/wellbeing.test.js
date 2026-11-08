'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createWellbeing } = require('../bin/wellbeing.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
const at = (h) => new Date(2026, 9, 30, h, 0, 0).getTime();

test('awake on/off tracks the caffeinate pid and expires', () => {
  const root = tmp(); let t = at(10); const killed = []; const live = new Set([4242]);
  const w = createWellbeing(root, { now: () => t, spawnFn: (c, a) => { assert.equal(c, 'caffeinate'); assert.ok(a.includes('-t')); return { pid: 4242, unref() {} }; }, alive: (p) => live.has(p), kill: (p) => { killed.push(p); live.delete(p); } });
  assert.equal(w.awake().on, false);
  assert.equal(w.awakeOn(2).on, true);
  t += 3 * 3600000; assert.equal(w.awake().on, false); // past `until`
  w.awakeOn(1); w.awakeOff(); assert.ok(killed.includes(4242)); assert.equal(w.awake().on, false);
});

test('break nudges only inside work hours, one per interval, off by default', () => {
  const root = tmp(); let t = at(10);
  const w = createWellbeing(root, { now: () => t });
  assert.equal(w.breakDue(), null);
  w.setBreaks({ on: true, everyMin: 30 });
  assert.equal(w.breakDue(), null); // first one a full interval away
  t += 31 * 60000; assert.match(w.breakDue(), /Break/);
  assert.equal(w.breakDue(), null);
  t = at(20); assert.equal(w.breakDue(), null); // after hours
  assert.throws(() => w.setBreaks({ everyMin: 1 }));
  assert.throws(() => w.setBreaks({ from: 18, to: 9 }));
});

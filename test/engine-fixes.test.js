/** Regressions found by the reviewer sweep: flag parsing, incomplete audits, task descriptions with checklists. */
const test = require('node:test');
const assert = require('node:assert');
const { parseFlags, overallStatus } = require('../bin/sm.js');

test('switch flags never swallow the title; text flags keep values that start with "-"', () => {
  const { flags, rest } = parseFlags(['--human', 'Fix the login', '--desc', '-5% on checkout', '-p', '1']);
  assert.equal(flags.human, true);
  assert.deepEqual(rest, ['Fix the login']);
  assert.equal(flags.desc, '-5% on checkout');
  assert.equal(flags.priority, '1');
  assert.equal(parseFlags(['--check', '--screenshot', '/tmp/a.png']).flags.screenshot, '/tmp/a.png');
});

test('an audit where a reviewer failed is not a clean bill of health', () => {
  const tasks = { open: [], human: [], suggestions: [] };
  const green = [{ ok: true }];
  const state = (lastAudit) => ({ state: { lastAudit } });
  assert.equal(overallStatus(state({ newBlocking: 0, complete: true }), green, tasks), 'PRODUCTION_READY');
  assert.equal(overallStatus(state({ newBlocking: 0, complete: false, failedAgents: ['ui'] }), green, tasks), 'IN_PROGRESS');
  assert.equal(overallStatus(state({ newBlocking: 0 }), green, tasks), 'PRODUCTION_READY', 'audits from before the flag still count');
});

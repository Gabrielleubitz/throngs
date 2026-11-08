const test = require('node:test');
const assert = require('node:assert');
const W = require('../bin/cswap-watch.js');

const acc = (number, active, five, seven, extra = {}) => ({ number, email: `a${number}@x`, active, usageStatus: 'ok',
  usage: { fiveHour: { pct: five, resetsAt: '2026-10-28T15:00:00Z', countdown: '1h' }, sevenDay: { pct: seven, resetsAt: '2026-10-30T15:00:00Z', countdown: '2d' } }, ...extra });

test('decide: stay / switch to emptiest / wait for earliest reset', () => {
  assert.deepStrictEqual(W.decide({ accounts: [acc(1, true, 10, 50), acc(2, false, 0, 0)] }), { action: 'stay' });
  assert.deepStrictEqual(W.decide({ accounts: [acc(1, true, 96, 50), acc(2, false, 80, 10), acc(3, false, 5, 5)] }), { action: 'switch', to: 3 });
  assert.strictEqual(W.decide({ accounts: [acc(1, true, 10, 97), acc(2, false, 0, 0, { usageStatus: 'disabled' })] }).action, 'wait');
  assert.strictEqual(W.decide({ accounts: [acc(1, true, 99, 0)] }).until, '2026-10-28T15:00:00.000Z');
});

test('tick switches when active is out, then reports the new active numbers', () => {
  let doc = { accounts: [acc(1, true, 99, 40), acc(2, false, 12, 30)] };
  const calls = [];
  const w = W.createWatcher({ bin: 'x', run: (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'switch') doc = { accounts: [acc(1, false, 99, 40), acc(2, true, 12, 30)] };
    return { status: 0, stdout: JSON.stringify(doc) };
  } });
  const s = w.tick();
  assert.ok(calls.includes('switch 2'));
  assert.strictEqual(s.active.number, 2);
  assert.strictEqual(s.active.fiveHour.pct, 12);
  assert.strictEqual(s.lastSwitch.from, 1);
});

test('broken cswap degrades to unavailable', () => {
  const w = W.createWatcher({ bin: 'x', run: () => ({ status: 1, stdout: '' }) });
  assert.strictEqual(w.tick().available, false);
});

test('describe: live numbers and last switch in one line', () => {
  const { describe: d, summarize } = require('../bin/cswap-watch.js');
  const snap = { ...summarize({ accounts: [{ number: 2, active: true, usage: { fiveHour: { pct: 43.2 }, sevenDay: { pct: 12 } } }] }), lastSwitch: { at: new Date(Date.now() - 180000).toISOString(), from: 1, to: 2 } };
  assert.match(d(snap), /#2 5h 43% · 7d 12% · switched #1→#2 3m ago/);
  assert.equal(d({ available: false }), 'No cswap accounts found');
});

// 2026-11-01: account #3's login died (usage null) and METER picked it every minute as "0% used"; #1 ran to 100%.
const dead = (number) => ({ number, email: `a${number}@x`, active: false, usageStatus: 'relogin_required', usage: null });

test('an account with a dead login (or unreadable usage) is never picked as the spare', () => {
  assert.deepStrictEqual(W.decide({ accounts: [acc(1, true, 100, 55), dead(3), acc(4, false, 0, 7)] }), { action: 'switch', to: 4 });
  assert.strictEqual(W.decide({ accounts: [acc(1, true, 100, 55), dead(3)] }).action, 'wait');
  assert.deepStrictEqual(W.decide({ accounts: [acc(1, true, 100, 55), acc(2, false, 0, 0, { usageStatus: 'error', usage: null }), acc(4, false, 30, 7)] }), { action: 'switch', to: 4 });
});

test('the active account itself losing its login → switch away; unreadable usage for a moment → stay (no flapping)', () => {
  assert.deepStrictEqual(W.decide({ accounts: [{ ...dead(1), active: true }, acc(4, false, 0, 7)] }), { action: 'switch', to: 4 });
  assert.deepStrictEqual(W.decide({ accounts: [acc(1, true, 0, 0, { usageStatus: 'error', usage: null }), acc(4, false, 0, 7)] }), { action: 'stay' });
});

test('a failed switch is skipped for 30 minutes and the next good account is tried in the same tick; events are reported once', () => {
  let doc = { accounts: [acc(1, true, 99, 40), acc(2, false, 5, 5), acc(4, false, 20, 10)] };
  const events = []; const calls = []; let t = Date.parse('2026-11-01T10:00:00Z');
  const w = W.createWatcher({ bin: 'x', now: () => t, onEvent: (e) => events.push(e), run: (args) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'switch 2') return { status: 1, stdout: 'Error: token expired' };
    if (args.join(' ') === 'switch 4') doc = { accounts: [acc(1, false, 99, 40), acc(2, false, 5, 5), acc(4, true, 20, 10)] };
    return { status: 0, stdout: JSON.stringify(doc) };
  } });
  const s = w.tick();
  assert.deepStrictEqual(calls.filter((c) => c.startsWith('switch')), ['switch 2', 'switch 4']);
  assert.strictEqual(s.active.number, 4);
  assert.deepStrictEqual(events.map((e) => e.kind), ['switch-failed', 'switched']);
  assert.deepStrictEqual([events[1].from, events[1].to], [1, 4]);
});

test('dead logins and "all full" are reported once, and shown in METER\'s bubble', () => {
  const doc = { accounts: [acc(1, true, 100, 40), dead(3)] };
  const events = [];
  const w = W.createWatcher({ bin: 'x', onEvent: (e) => events.push(e), run: () => ({ status: 0, stdout: JSON.stringify(doc) }) });
  w.tick(); const s = w.tick();
  assert.deepStrictEqual(events.map((e) => e.kind).sort(), ['all-full', 'relogin']);
  assert.match(W.describe(s), /all accounts full · #3 needs re-login/);
});

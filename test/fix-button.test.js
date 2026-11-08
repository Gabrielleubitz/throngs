/** node --test test/ — Fix button: which tasks count as review-created, and what POST /fix refuses. */
const test = require('node:test');
const assert = require('node:assert');
const { isReviewTask, createApi } = require('../bin/sm-api.js');

test('only tasks filed by a reviewer (src:audit-*) are review tasks', () => {
  assert.equal(isReviewTask({ labels: ['src:audit-code'] }), true);
  assert.equal(isReviewTask({ labels: ['x', 'src:audit-marketing'] }), true);
  assert.equal(isReviewTask({ labels: ['src:audit-hired-reviewer'] }), true);
  assert.equal(isReviewTask({ labels: ['src:slack'] }), false);
  assert.equal(isReviewTask({ labels: ['src:manual'] }), false);
  assert.equal(isReviewTask({ labels: [] }), false);
  assert.equal(isReviewTask({}), false);
});

// A stub sm: one beads project holding a handful of issues; nothing is ever spawned in these tests.
function stubApi({ issues, running = false }) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fix-'));
  const p = { name: 'demo', dir, config: { path: dir }, state: {} };
  const sm = {
    ROOT: dir, SELF: '/nonexistent', readJSON: () => ({}),
    loadProject: () => p, listProjects: () => ['demo'], isRunning: () => running,
    overallStatus: () => 'IN_PROGRESS', usesBeads: () => true,
    bd: () => JSON.stringify(issues),
  };
  return createApi(sm);
}
const issue = (id, labels, status = 'open') => ({ id, title: id, status, priority: 2, labels, description: '' });
const call = (api, id) => { try { api.fix({ project: 'demo', id }); return null; } catch (e) { return e; } };

test('fix refuses bad ids, unknown, closed, non-review, human and busy projects', () => {
  const issues = [
    issue('a-1', ['src:audit-code'], 'closed'),
    issue('a-2', ['src:slack']),
    issue('a-3', ['src:audit-ux', 'human']),
    issue('a-4', ['src:audit-ui', 'escalated']),
  ];
  const api = stubApi({ issues });
  assert.equal(call(api, '../etc').status, 400);
  assert.equal(call(api, 'nope').status, 404);
  assert.equal(call(api, 'a-1').status, 409);
  assert.equal(call(api, 'a-2').status, 400);
  assert.match(call(api, 'a-2').message, /review/);
  assert.equal(call(api, 'a-3').status, 400);
  assert.equal(call(api, 'a-4').status, 400);

  const busy = stubApi({ issues: [issue('b-1', ['src:audit-code'])], running: true });
  assert.equal(call(busy, 'b-1').status, 409);
});

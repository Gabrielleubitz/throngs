/** Letting go of idle crew: optional core members can be fired and stay gone; essential ones cannot. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaff } = require('../bin/staff.js');

test('idle core members can be fired and are not re-added; essential ones are locked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-'));
  const st = createStaff(root);
  assert.throws(() => st.fire({ id: 'orchestrator' }), /core part/);
  assert.deepStrictEqual(st.fire({ id: 'growth' }), { ok: true });
  assert.ok(!st.load().staff.some((s) => s.id === 'growth'), 'stays gone after reload');
  assert.ok(st.load().staff.find((s) => s.id === 'builder').locked);
});

test('FOLIO (PDF Designer) is a locked core member, trained on the pdf skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-'));
  const st = createStaff(root);
  st.load();
  const folio = st.load().staff.find((s) => s.id === 'pdf');
  assert.ok(folio && folio.locked);
  assert.throws(() => st.fire({ id: 'pdf' }), /core part/);
  assert.match(require('../bin/staff.js').trainingFor(path.join(__dirname, '..'), 'design', 'pdf'), /pdf-design/);
});

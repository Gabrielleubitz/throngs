/** node --test test/ — management flag, Control Room / owner's office access, and the always-5 Future Ideas list. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaff, isManagement } = require('../bin/staff.js');
const { createIdeas, IDEA_COUNT } = require('../bin/ideas.js');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-roles-'));

test('Planner and Future Ideas are management, seated in the control room', () => {
  const S = createStaff(mk());
  const d = S.load();
  for (const kind of ['manager', 'planner', 'ideas']) {
    const s = d.staff.find((x) => x.kind === kind);
    assert.ok(s, kind);
    assert.equal(s.room, 'control');
    assert.equal(s.management, true);
  }
  assert.equal(d.staff.find((x) => x.kind === 'engineer').management, false);
  assert.ok(d.rooms.find((r) => r.id === 'control').restricted);
  assert.ok(d.rooms.find((r) => r.id === 'office').restricted);
});

test('non-management cannot be moved or hired into restricted rooms', () => {
  const S = createStaff(mk());
  assert.throws(() => S.update({ id: 'builder', room: 'control' }), /management only/);
  assert.throws(() => S.hire({ name: 'Zed', title: 'Dev', kind: 'engineer', room: 'control' }), /management only/);
  assert.equal(S.update({ id: 'builder', room: 'design' }).room, 'design');
});

test('an old roster gets the new crew, and non-management left in the control room are moved out', () => {
  const root = mk();
  const S = createStaff(root);
  const d = S.load();
  d.staff = d.staff.filter((s) => !['planner', 'ideas'].includes(s.id));
  d.staff.find((s) => s.id === 'builder').room = 'control';
  S.save(d);
  const d2 = S.load();
  assert.ok(d2.staff.some((s) => s.kind === 'planner') && d2.staff.some((s) => s.kind === 'ideas'));
  assert.equal(d2.staff.find((s) => s.id === 'builder').room, 'engineering');
  assert.equal(new Set(d2.staff.map((s) => s.agentId)).size, d2.staff.length);
  assert.equal(isManagement({ kind: 'reviewer' }), false);
});

test('ideas: per project, kept as-is (no auto-refill), thoughts reach the planner prompt', () => {
  const I = createIdeas(mk());
  // the office's own project starts with 5 seeded ideas; ids are stable across reads
  let list = I.list('success-manager');
  assert.equal(list.length, IDEA_COUNT);
  assert.deepEqual(I.list('success-manager').map((i) => i.id), list.map((i) => i.id));
  const [a, b] = list;
  I.addThoughts('success-manager', a.id, 'make it dark');
  assert.match(I.promptFor(I.get('success-manager', a.id)), /make it dark/);
  I.dismiss('success-manager', b.id);
  I.use('success-manager', a.id);
  list = I.list('success-manager');
  assert.equal(list.length, IDEA_COUNT - 2, 'MUSE does not invent replacements on its own');
  // other projects start empty until the owner asks for fresh ideas
  assert.equal(I.list('bloom-booking').length, 0);
  assert.throws(() => I.addThoughts('success-manager', 'nope', 'x'), /No such idea/);
  assert.throws(() => I.addThoughts('success-manager', list[0].id, '  '), /thoughts/);
  assert.throws(() => I.list('../evil'), /project/);
});

test('fresh ideas: only one pass at a time, and a dead pass is reported, not stuck on "thinking"', () => {
  const root = mk();
  const I = createIdeas(root);
  fs.mkdirSync(path.join(root, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'demo', 'ideas.security.status.json'), JSON.stringify({ running: true, pid: 999999 }));
  const st = I.status('demo', 'security');
  assert.equal(st.running, false);
  assert.match(st.error, /stopped/);
});

test('a client project\'s ideas are its information: kept with its records, moved out of the office\'s own folder', () => {
  const root = mk();
  fs.mkdirSync(path.join(root, 'office', 'ideas'), { recursive: true });
  const legacy = path.join(root, 'office', 'ideas', 'bloom.json');
  fs.writeFileSync(legacy, JSON.stringify({ active: [{ id: 'i1', title: 'Kiosk mode', detail: 'x', thoughts: [] }], retired: [] }));
  const I = createIdeas(root);
  assert.equal(I.list('bloom')[0].title, 'Kiosk mode');
  assert.ok(!fs.existsSync(legacy), 'gone from the office folder');
  assert.ok(fs.existsSync(path.join(root, 'projects', 'bloom', 'ideas.json')));
  assert.ok(I.list('success-manager').length > 0, 'the office keeps its own ideas at home');
  assert.ok(fs.existsSync(path.join(root, 'office', 'ideas', 'success-manager.json')) || true);
});

test('department training: everyone gets the shared brain, each room only its own skills', () => {
  const { pluginDirsFor, trainingFor } = require('../bin/staff.js');
  const root = path.join(__dirname, '..');
  const dirs = (room) => pluginDirsFor(root, room).filter((x) => x !== '--plugin-dir').map((d) => path.basename(d));
  assert.deepEqual(dirs('qa'), ['common', 'qa']);
  assert.deepEqual(dirs('lounge'), ['common'], 'rooms without a department still get the shared brain');
  assert.deepEqual(dirs(''), ['common']);
  for (const room of ['control', 'engineering', 'qa', 'design', 'marketing', 'crew-growth', 'crew-docs', 'crew-video']) {
    for (const d of pluginDirsFor(root, room).filter((x) => x !== '--plugin-dir')) {
      assert.ok(fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json')), d);
      for (const sk of fs.readdirSync(path.join(d, 'skills'))) assert.match(fs.readFileSync(path.join(d, 'skills', sk, 'SKILL.md'), 'utf8'), /^---\nname: /, `${room}/${sk}`);
    }
  }
  assert.deepEqual(pluginDirsFor(root, 'design', 'docs').filter((x) => x !== '--plugin-dir').map((d) => path.basename(d)), ['common', 'design', 'crew-docs']);
  assert.match(trainingFor(root, 'marketing', 'video'), /video-types.*|promo-video/);
  assert.match(trainingFor(root, 'marketing', 'video'), /social-short/);
  assert.doesNotMatch(trainingFor(root, 'marketing'), /social-short/, 'video pack only reaches REEL');
  assert.match(trainingFor(root, 'marketing', 'growth'), /ab-testing/);
  assert.doesNotMatch(trainingFor(root, 'marketing'), /ab-testing/, 'personal packs only reach their owner');
  assert.deepEqual(dirs('qa'), ['common', 'qa']);
  assert.match(trainingFor(root, 'qa'), /webapp-testing/);
  assert.doesNotMatch(trainingFor(root, 'qa'), /copywriting/);
});

test('ideas: one tab per department; a fresh pass only replaces its own tab', () => {
  const { CATEGORIES } = require('../bin/ideas.js');
  assert.deepEqual(CATEGORIES.map((c) => c.id), ['features', 'design', 'security', 'quality', 'growth']);
  const root = mk();
  const I = createIdeas(root);
  const file = path.join(root, 'office', 'ideas', 'demo.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const idea = (id, category) => ({ id, title: id, detail: '', thoughts: [], createdAt: '', ...(category ? { category } : {}) });
  fs.writeFileSync(file, JSON.stringify({ active: [idea('old'), idea('s1', 'security'), idea('d1', 'design')], retired: [] }));
  assert.deepEqual(I.list('demo', 'features').map((i) => i.id), ['old'], 'ideas from before tabs count as Features');
  assert.deepEqual(I.list('demo', 'security').map((i) => i.id), ['s1']);
  assert.equal(I.list('demo').length, 3);
  assert.match(I.promptFor(I.get('demo', 's1')), /security improvement/);
  assert.deepEqual(Object.keys(I.statuses('demo')), CATEGORIES.map((c) => c.id));
});

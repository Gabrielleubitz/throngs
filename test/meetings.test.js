const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMeetings, videosFromSubtasks, pdfsFromSubtasks } = require('../bin/meetings.js');
const { ownerRoute } = require('../bin/missions.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-meet-'));

test('only real video files reported by jobs become meeting videos', () => {
  const d = tmp();
  const mp4 = path.join(d, 'promo.mp4');
  fs.writeFileSync(mp4, 'x');
  fs.writeFileSync(path.join(d, 'empty.mp4'), '');
  const subs = [
    { assignee: 'video', result: { video: mp4 } },
    { assignee: 'builder', result: { video: '' } },
    { assignee: 'video', result: { video: path.join(d, 'missing.mp4') } },
    { assignee: 'video', result: { video: 'empty.mp4' } },
    { assignee: 'x', result: { video: path.join(d, 'notes.txt') } },
    { assignee: 'video', result: { video: 'promo.mp4' } }, // relative to the work root, same file → deduped
  ];
  assert.deepStrictEqual(videosFromSubtasks(subs, d), [{ path: mp4, by: 'video' }]);
});

test('a meeting calls, joins and ends; ended meetings leave the open list', () => {
  const d = tmp();
  const mp4 = path.join(d, 'a.mp4');
  fs.writeFileSync(mp4, 'video-bytes');
  const M = createMeetings(() => d);
  const m = M.call('p', { title: 'Launch promo', summary: 'REEL made it.', video: mp4, missionId: 'm-1' });
  assert.strictEqual(m.status, 'calling');
  assert.strictEqual(M.call('p', { title: 'again', missionId: 'm-1' }).id, m.id, 'one meeting per mission');
  assert.deepStrictEqual(M.open('p').map((x) => x.id), [m.id]);
  assert.strictEqual(M.join('p', m.id).status, 'in-meeting');
  const v = M.video('p', m.id);
  assert.strictEqual(v.file, mp4); assert.strictEqual(v.type, 'video/mp4'); assert.strictEqual(v.size, 11);
  assert.strictEqual(M.end('p', m.id).status, 'ended');
  assert.deepStrictEqual(M.open('p'), []);
  assert.throws(() => M.call('p', { title: 'x', video: path.join(d, 'nope.mp4') }), /No video file/);
  assert.throws(() => M.call('p', { title: '' }), /title/);
  assert.throws(() => M.end('p', 'mt-nope'), /No such meeting/);
});

test('"video:" prefix routes to the video lead', () => {
  assert.deepStrictEqual(ownerRoute('video: a 15s promo for the booking page'), { video: true, funnel: 'solo' });
  assert.strictEqual(ownerRoute('fix the video player').video, undefined);
});

test('layout merge adds the new room but keeps the owner\'s edits', () => {
  const { mergeLayout } = require('../office-layout/merge.js');
  const live = { cols: 3, rows: 1, tiles: [1, 255, 1], tileColors: [null, null, { h: 1 }], areaTiles: [null, null, null], areas: [{ label: 'A' }],
    furniture: [{ uid: 'f-owner', type: 'RACK', col: 0, row: 0 }, { uid: 'sm-f-3', type: 'PLANT', col: 2, row: 0 }] };
  const gen = { cols: 2, rows: 1, tiles: [7, 4], tileColors: [null, { h: 9 }], areaTiles: [null, 'Conference Room'], areas: [{ label: 'A' }, { label: 'Conference Room' }],
    furniture: [{ uid: 'sm-f-1', type: 'X', col: 1, row: 0 }, { uid: 'sm-conf-table', type: 'T', col: 1, row: 0 }, { uid: 'sm-seat-x', type: 'C', col: 0, row: 0 }] };
  const m = mergeLayout(live, gen);
  assert.deepStrictEqual(m.tiles, [1, 4, 1], 'only void tiles are filled');
  assert.strictEqual(m.areaTiles[1], 'Conference Room');
  assert.deepStrictEqual(m.areas.map((a) => a.label), ['A', 'Conference Room']);
  assert.deepStrictEqual(m.furniture.map((f) => f.uid), ['f-owner', 'sm-f-3', 'sm-conf-table'], 'positional uids and occupied spots skipped');
  assert.deepStrictEqual(mergeLayout(m, gen).furniture.length, 3, 'idempotent');
  // a door into the new room: live wall (0) next to newly added floor becomes the generated floor
  const door = mergeLayout({ cols: 1, rows: 3, tiles: [255, 0, 2], furniture: [] }, { cols: 1, rows: 3, tiles: [4, 2, 2], furniture: [] });
  assert.deepStrictEqual(door.tiles, [4, 2, 2]);
  const keep = mergeLayout({ cols: 1, rows: 2, tiles: [0, 2], furniture: [] }, { cols: 1, rows: 2, tiles: [2, 2], furniture: [] });
  assert.deepStrictEqual(keep.tiles, [0, 2], 'owner walls away from new floor stay');
  // a new room past the live layout's edge (the Studio): the grid grows, old tiles keep their place
  const wide = mergeLayout({ cols: 2, rows: 2, tiles: [1, 0, 1, 0], areaTiles: ['A', null, 'A', null], furniture: [{ uid: 'own', type: 'X', col: 0, row: 1 }] },
    { cols: 3, rows: 2, tiles: [1, 2, 5, 1, 0, 5], areaTiles: ['A', null, 'Studio', 'A', null, 'Studio'], areas: [{ label: 'Studio' }], furniture: [{ uid: 'sm-studio-lamp-1', type: 'LAMP', col: 2, row: 0 }] });
  assert.strictEqual(wide.cols, 3);
  assert.deepStrictEqual(wide.tiles, [1, 2, 5, 1, 0, 5], 'new floor added, door cut next to it, old wall elsewhere kept');
  assert.deepStrictEqual(wide.areaTiles, ['A', null, 'Studio', 'A', null, 'Studio']);
  assert.deepStrictEqual(wide.furniture.map((f) => `${f.uid}@${f.col},${f.row}`), ['own@0,1', 'sm-studio-lamp-1@2,0']);
});

test('notes are held until the meeting ends; questions are sent at once; nothing after eject', () => {
  const d = tmp();
  const M = createMeetings(() => d);
  const m = M.call('p', { title: 'Promo' });
  const n = M.addNote('p', m.id, { kind: 'note', text: 'cut the intro' });
  assert.strictEqual(n.note.sent, false);
  assert.strictEqual(M.addNote('p', m.id, { kind: 'question', text: 'why 5s?' }).note.sent, true);
  const n2 = M.addNote('p', m.id, { kind: 'note', text: 'bigger logo' });
  M.dropNote('p', m.id, n2.note.id);
  assert.throws(() => M.addNote('p', m.id, { kind: 'x', text: 'a' }), /kind/);
  assert.throws(() => M.addNote('p', m.id, { kind: 'note', text: ' ' }), /something/);
  M.end('p', m.id);
  assert.deepStrictEqual(M.takeHeld('p', m.id).map((x) => x.text), ['cut the intro']);
  assert.deepStrictEqual(M.takeHeld('p', m.id), [], 'handed out once');
  assert.throws(() => M.addNote('p', m.id, { kind: 'note', text: 'late' }), /over/);
});

test('a PDF a job reports becomes a meeting file served as application/pdf', () => {
  const d = tmp();
  const pdf = path.join(d, 'brief.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  assert.deepStrictEqual(pdfsFromSubtasks([{ assignee: 'pdf', result: { pdf } }, { assignee: 'x', result: { pdf: path.join(d, 'a.txt') } }], d), [{ path: pdf, by: 'pdf' }]);
  const M = createMeetings(() => d);
  const m = M.call('p', { title: 'Brief', pdf, by: 'pdf' });
  assert.strictEqual(M.pdf('p', m.id).type, 'application/pdf');
  assert.throws(() => M.video('p', m.id), /no video/i);
  assert.throws(() => M.call('p', { title: 'x', pdf: path.join(d, 'nope.pdf') }), /No PDF/);
});

/** node --test test/ — layered agent looks: option lists, validation, persistence, defaults and the pixel layers. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStaff, sanitizeLook, LOOK_OPTIONS } = require('../bin/staff.js');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-look-'));
const first = (S) => S.load().staff.find((s) => s.kind === 'engineer');

test('options: every category has a default plus new choices, ids unique', () => {
  assert.ok(LOOK_OPTIONS.hair.length >= 7 && LOOK_OPTIONS.outfit.length >= 6 && LOOK_OPTIONS.hat.length >= 7);
  for (const k of ['hair', 'outfit', 'hat', 'accessory']) assert.equal(new Set(LOOK_OPTIONS[k]).size, LOOK_OPTIONS[k].length, k);
  assert.ok(LOOK_OPTIONS.hair.includes('base') && LOOK_OPTIONS.outfit.includes('base') && LOOK_OPTIONS.hat.includes('none'));
  for (const hex of Object.values(LOOK_OPTIONS.colors)) assert.match(hex, /^#[0-9a-f]{6}$/);
});

test('defaults: existing agents have no look; the roster is unchanged', () => {
  const S = createStaff(mk());
  assert.ok(S.load().staff.every((s) => s.look === undefined));
});

test('persistence: a saved look round-trips and combines freely', () => {
  const root = mk();
  const S = createStaff(root);
  const id = first(S).id;
  S.update({ id, look: { hair: 'mohawk', hairColor: 'green', outfit: 'suit', outfitColor: 'navy', hat: 'crown', hatColor: 'yellow', accessory: 'glasses' } });
  const s = createStaff(root).load().staff.find((x) => x.id === id);
  assert.deepEqual(s.look, { hair: 'mohawk', hairColor: 'green', outfit: 'suit', outfitColor: 'navy', hat: 'crown', hatColor: 'yellow', accessory: 'glasses' });
  S.update({ id, name: first(S).name }); // unrelated edits keep the look
  assert.equal(S.load().staff.find((x) => x.id === id).look.hat, 'crown');
});

test('validation: unknown ids and junk are dropped; defaults / empty clear the look', () => {
  const S = createStaff(mk());
  const id = first(S).id;
  S.update({ id, look: { hair: 'long', hat: 'rocket', outfit: 7, hairColor: '#ff0000', hatColor: 'constructor', accessory: ['x'] } });
  assert.deepEqual(first(S).look, { hair: 'long' });
  assert.equal(sanitizeLook('nope'), null);
  S.update({ id, look: { hair: 'base', hat: 'none' } });
  assert.equal(first(S).look, undefined);
  S.update({ id, look: { hat: 'cap' } });
  S.update({ id, look: null });
  assert.equal(first(S).look, undefined);
});

test('layers: look pixels change the sprite; an empty look leaves it untouched', async () => {
  const L = await import('../pixel-office/webview-ui/src/office/sprites/layers.ts');
  const frame = Array.from({ length: 32 }, (_, y) => Array.from({ length: 16 }, (_, x) => (y >= 2 && y < 30 && x >= 1 && x < 15 ? (y >= 14 ? '#223344' : '#8f6439') : '')));
  const set = { walk: { 0: [frame], 1: [frame], 2: [frame], 3: [frame] }, typing: { 0: [frame] }, reading: { 0: [frame] } };
  assert.strictEqual(L.applyLookToSet(set, {}), set);
  assert.strictEqual(L.applyLookToSet(set, { hair: 'nonsense', hat: 'rocket' }), set); // unknown ids ignored
  assert.notDeepEqual(L.applyLookToSet(set, { hat: 'cap' }).walk[0][0], frame);
  assert.notDeepEqual(L.applyLookToSet(set, { outfit: 'hoodie' }).walk[2][0], frame);
  assert.equal(L.applyLookToSet(set, { hat: 'cap' }).walk[0][0].length, 32); // sprite size is preserved
  assert.deepEqual(frame[3].filter(Boolean).length, 14); // source never mutated
  for (const k of ['hair', 'outfit', 'hat', 'accessory']) for (const id of L.LOOK_OPTIONS[k]) for (const d of [0, 1, 2, 3]) {
    const r = L.applyLookToFrame(frame, { [k]: id }, d, '#e9a384', '#b18649');
    assert.equal(r.length, 32); assert.ok(r.every((row) => row.length === 16), `${k}:${id}:${d}`);
  }
});

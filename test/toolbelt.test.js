'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createToolbelt } = require('../bin/toolbelt.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
const ok = (j) => async () => ({ ok: true, json: async () => j });

test('convert uses the rate and rejects bad input', async () => {
  const T = createToolbelt(tmp(), { fetchFn: ok({ rates: { ILS: 3.5 } }) });
  assert.strictEqual((await T.convert('10', 'usd', 'ils')).result, 35);
  await assert.rejects(T.convert('x', 'usd', 'ils'));
});
test('weather line', async () => {
  const T = createToolbelt(tmp(), { fetchFn: async (u) => ({ ok: true, json: async () => (u.includes('geocoding') ? { results: [{ name: 'Haifa', latitude: 1, longitude: 2 }] } : { current: { temperature_2m: 20.4, weather_code: 0 }, daily: { temperature_2m_max: [25], temperature_2m_min: [15], precipitation_probability_max: [10] } }) }) });
  assert.match(T.weatherLine(await T.weather('Haifa')), /Haifa: 20° clear, 15–25°, 10% rain/);
});
test('shelf add/list/remove', () => {
  const r = tmp(); const T = createToolbelt(r); const f = path.join(tmp(), 'a.txt'); fs.writeFileSync(f, 'x');
  T.shelf.add(f); assert.deepStrictEqual(T.shelf.list().map((x) => x.name), ['a.txt']); T.shelf.remove('a.txt'); assert.strictEqual(T.shelf.list().length, 0);
});
test('clip keeps newest first, skips duplicates', async () => {
  let t = 'one'; const T = createToolbelt(tmp(), { run: async () => t });
  await T.clip.save(); await T.clip.save(); t = 'two'; await T.clip.save();
  assert.deepStrictEqual(T.clip.list().map((e) => e.text), ['two', 'one']);
});
test('link copies only the secret and url; daemon call sends it as Bearer', async () => {
  const r = tmp(); fs.writeFileSync(path.join(r, 'env'), 'OPENAI_API_KEY=nope\nWHATSAPP_SERVICE_SECRET=abc\nPUBLIC_SERVICE_URL=http://x:1\n');
  let seen; const T = createToolbelt(r, { fetchFn: async (u, o) => { seen = { u, h: o.headers }; return { ok: true, json: async () => ({ messages: [{ subject: 's' }] }) }; } });
  await assert.rejects(T.mailToday());
  T.link(path.join(r, 'env'));
  const saved = fs.readFileSync(path.join(r, 'office', 'jarvis.json'), 'utf8'); assert.ok(!saved.includes('nope'));
  assert.strictEqual((await T.mailToday(3)).length, 1); assert.strictEqual(seen.h.Authorization, 'Bearer abc'); assert.match(seen.u, /^http:\/\/x:1\/jarvis\/gmail\/today\?limit=3/);
});
test('calendar parses osascript output', async () => {
  const T = createToolbelt(tmp(), { run: async () => '2026-10-31T10:00:00|B\n2026-10-30T09:00:00|A|x\n' });
  assert.deepStrictEqual((await T.calendar()).map((e) => e.title), ['A|x', 'B']);
});

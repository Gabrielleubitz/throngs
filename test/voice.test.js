const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVoice, parseEnv } = require('../bin/voice.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voice-'));

test('parseEnv handles quotes, comments, export', () => {
  assert.deepStrictEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=x # tail\n'), { A: '1', B: 'two words', C: 'x' });
});

test('no key: disabled and speak says 503', async () => {
  const saved = process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_API_KEY;
  const v = createVoice(tmp());
  assert.strictEqual(v.status().enabled, false);
  await assert.rejects(v.speak({ text: 'hi' }), (e) => e.status === 503);
  if (saved) process.env.ELEVENLABS_API_KEY = saved;
});

test('key in .env: calls ElevenLabs with the key and returns audio', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=sk_test\n');
  let seen;
  const v = createVoice(dir, { fetchFn: async (url, init) => { seen = { url, init }; return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; } });
  assert.strictEqual(v.status().enabled, true);
  const r = await v.speak({ text: '  hello   there ' });
  assert.deepStrictEqual([...r.audio], [1, 2, 3]);
  assert.strictEqual(seen.init.headers['xi-api-key'], 'sk_test');
  assert.strictEqual(JSON.parse(seen.init.body).text, 'hello there');
  assert.ok(seen.url.includes('/v1/text-to-speech/'));
});

test('bad key maps to 401, empty text to 400, bad voice id ignored', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=bad\n');
  let url;
  const v = createVoice(dir, { fetchFn: async (u) => { url = u; return { ok: false, status: 401, json: async () => ({ detail: { message: 'Invalid API key' } }) }; } });
  await assert.rejects(v.speak({ text: 'x', voice: '../evil' }), (e) => e.status === 401 && /Invalid API key/.test(e.message));
  assert.ok(!url.includes('evil'));
  await assert.rejects(v.speak({ text: ' ' }), (e) => e.status === 400);
});

test('voiceover writes the mp3 file', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=k\n');
  const v = createVoice(dir, { fetchFn: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('mp3').buffer }) });
  const r = await v.voiceover('hello', path.join(dir, 'a', 'vo.mp3'));
  assert.strictEqual(fs.readFileSync(r.file, 'utf8'), 'mp3');
});

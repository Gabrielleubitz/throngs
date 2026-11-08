const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFirebase, encrypt, decrypt } = require('../bin/firebase.js');
const { createOnboarding } = require('../bin/onboarding.js');

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-fb-')); fs.mkdirSync(path.join(d, 'office')); return d; };
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = { type: 'service_account', project_id: 'demo-proj', client_email: 'sa@demo-proj.iam.gserviceaccount.com', private_key: privateKey };

test('encrypt/decrypt round trip, wrong passphrase fails', () => {
  const blob = encrypt('{"a":1}', 'correct horse');
  assert.ok(!blob.includes('"a"'));
  assert.strictEqual(decrypt(blob, 'correct horse'), '{"a":1}');
  assert.throws(() => decrypt(blob, 'wrong pass!!'), /wrong passphrase/);
  assert.throws(() => encrypt('x', 'short'), /at least 8/);
});

test('link rejects junk and stores only needed fields at mode 600', () => {
  const dir = tmp(); const F = createFirebase(dir);
  assert.throws(() => F.link('{nope'), /valid JSON/);
  assert.throws(() => F.link({ type: 'other' }), /service-account/);
  assert.strictEqual(F.status().linked, false);
  assert.strictEqual(F.link(KEY).projectId, 'demo-proj');
  const f = path.join(dir, 'office', 'firebase-link.json');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  F.unlink(); assert.strictEqual(F.status().linked, false);
});

test('push sends ciphertext only; pull restores it', async () => {
  const dir = tmp(); fs.writeFileSync(path.join(dir, 'office', 'integrations.json'), '{"slack":{"bot_token":"xoxb-secret"}}');
  let stored; const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET']);
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't' }) };
    if (init.method === 'PATCH') { stored = JSON.parse(init.body).fields.blob.stringValue; return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ fields: { blob: { stringValue: stored } } }) };
  };
  const F = createFirebase(dir, { fetch }); F.link(KEY);
  await F.push('my passphrase');
  assert.ok(!stored.includes('xoxb-secret'));
  fs.writeFileSync(path.join(dir, 'office', 'integrations.json'), '{}');
  await assert.rejects(F.pull('bad passphrase'), /wrong passphrase/);
  await F.pull('my passphrase');
  assert.match(fs.readFileSync(path.join(dir, 'office', 'integrations.json'), 'utf8'), /xoxb-secret/);
  assert.ok(calls.some(([u]) => u.includes('projects/demo-proj/databases')));
});

test('onboarding: not done until completed, reset reopens, video 404 when missing', () => {
  const dir = tmp(); const O = createOnboarding(dir);
  assert.strictEqual(O.status().done, false);
  assert.strictEqual(O.complete().done, true);
  assert.strictEqual(O.reset().done, false);
  assert.throws(() => O.video(), (e) => e.status === 404);
});

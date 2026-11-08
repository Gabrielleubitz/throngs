const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIntegrations, CATALOG } = require('../bin/integrations.js');

const mk = () => createIntegrations(fs.mkdtempSync(path.join(os.tmpdir(), 'integ-')));

test('catalog has one distinct animal per integration', () => {
  assert.strictEqual(new Set(CATALOG.map((c) => c.animal)).size, CATALOG.length);
  assert.ok(CATALOG.some((c) => c.id === 'whatsapp') && CATALOG.some((c) => c.id === 'google'));
});

test('save masks secrets, links when required fields set, get returns real values', () => {
  const I = mk();
  assert.strictEqual(I.promptLine(), '');
  I.save({ id: 'telegram', values: { bot_token: 'abc123456789' } });
  const t = I.list().find((x) => x.id === 'telegram');
  assert.ok(t.linked);
  assert.ok(!JSON.stringify(t).includes('abc123456789'));
  assert.strictEqual(I.get('telegram').bot_token, 'abc123456789');
  assert.match(I.promptLine(), /telegram/);
  I.save({ id: 'telegram', values: { bot_token: '' } }); // blank keeps old
  assert.strictEqual(I.get('telegram').bot_token, 'abc123456789');
  I.clear({ id: 'telegram' });
  assert.throws(() => I.get('telegram'), /not linked/);
});

test('unknown id rejected; optional field does not block linking', () => {
  const I = mk();
  assert.throws(() => I.save({ id: 'nope', values: {} }));
  I.save({ id: 'teams', values: { tenant_id: 't', client_id: 'c', client_secret: 's' } });
  assert.ok(I.list().find((x) => x.id === 'teams').linked);
});

test('click-to-sign-in: start needs the app, callback stores the tokens once', async () => {
  const calls = [];
  const I = createIntegrations(fs.mkdtempSync(path.join(os.tmpdir(), 'integ-')), {
    fetch: async (url, o) => { calls.push([url, o]); return { ok: true, status: 200, json: async () => ({ access_token: 'xoxb-new' }) }; },
  });
  await assert.rejects(I.oauthStart({ id: 'slack', redirect: 'http://localhost:1/cb' }), /first/);
  await assert.rejects(I.oauthStart({ id: 'telegram', redirect: 'http://localhost:1/cb' }), /no click-to-sign-in/);
  I.save({ id: 'slack', values: { client_id: 'cid', client_secret: 'sec' } });
  const s = I.list().find((x) => x.id === 'slack');
  assert.deepStrictEqual(s.oauth, { ready: true, signedIn: false, viaFirebase: false });
  assert.ok(!s.linked);
  const { url } = await I.oauthStart({ id: 'slack', redirect: 'http://localhost:1/cb' });
  const state = new URL(url).searchParams.get('state');
  assert.match(url, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
  await assert.rejects(I.oauthCallback({ state: 'bogus', code: 'c' }), /expired/);
  assert.deepStrictEqual(await I.oauthCallback({ state, code: 'abc' }), { id: 'slack', name: 'Slack the Monkey' });
  assert.match(calls[0][1].body, /code=abc/);
  assert.strictEqual(I.get('slack').bot_token, 'xoxb-new');
  assert.ok(I.list().find((x) => x.id === 'slack').linked);
  await assert.rejects(I.oauthCallback({ state, code: 'abc' }), /expired/); // one-time
});

test('check: google refresh token is really exchanged; a scope URL is flagged', async () => {
  const I = createIntegrations(fs.mkdtempSync(path.join(os.tmpdir(), 'integ-')), {
    fetch: async (url, o) => ({ ok: /refresh_token=good/.test(o.body), status: 400, json: async () => (/good/.test(o.body) ? { access_token: 'a' } : { error: 'invalid_grant' }) }),
  });
  assert.deepStrictEqual(await I.check('google'), { id: 'google', ok: false, detail: 'not linked' });
  I.save({ id: 'google', values: { client_id: 'c', client_secret: 's', refresh_token: 'https://mail.google.com/' } });
  assert.match((await I.check('google')).detail, /web address/);
  I.save({ id: 'google', values: { refresh_token: 'bad' } });
  assert.match((await I.check('google')).detail, /invalid_grant/);
  I.save({ id: 'google', values: { refresh_token: 'good' } });
  assert.strictEqual((await I.check('google')).ok, true);
});

test('google: with Firebase linked there is nothing to paste — the app comes from Firebase; an unlisted return address says how to fix it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
  const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fs.mkdirSync(path.join(root, 'office'));
  fs.writeFileSync(path.join(root, 'office', 'firebase-link.json'), JSON.stringify({ project_id: 'proj-1', client_email: 'sa@proj-1.iam.gserviceaccount.com', private_key: privateKey }));
  let listed = false;
  const mismatch = 'https://accounts.google.com/signin/oauth/error?authError=' + Buffer.from('\n\x15redirect_uri_mismatch').toString('base64');
  const I = createIntegrations(root, { fetch: async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return { ok: true, status: 200, json: async () => ({ access_token: 'sa-token' }) };
    if (/identitytoolkit/.test(url)) return { ok: true, status: 200, json: async () => ({ enabled: true, clientId: 'fb-client.apps.googleusercontent.com', clientSecret: 'fb-secret' }) };
    if (/accounts\.google\.com/.test(url)) return { ok: false, status: 302, headers: { get: () => (listed ? 'https://accounts.google.com/v3/signin/identifier' : mismatch) } };
    throw new Error(`unexpected ${url}`);
  } });
  const g = I.list().find((x) => x.id === 'google');
  assert.deepStrictEqual(g.oauth, { ready: true, signedIn: false, viaFirebase: true }, 'ready with no codes saved');
  const err = await I.oauthStart({ id: 'google', redirect: 'http://127.0.0.1:4777/sm/oauth/callback' }).catch((e) => e);
  assert.equal(err.status, 409);
  assert.match(err.message, /127\.0\.0\.1:4777\/sm\/oauth\/callback/);
  assert.equal(err.fixUrl, 'https://console.cloud.google.com/auth/clients/fb-client.apps.googleusercontent.com?project=proj-1');
  listed = true; // the owner added it
  const { url } = await I.oauthStart({ id: 'google', redirect: 'http://127.0.0.1:4777/sm/oauth/callback' });
  assert.equal(new URL(url).searchParams.get('client_id'), 'fb-client.apps.googleusercontent.com');
  assert.ok(!JSON.stringify(I.list()).includes('fb-secret'), 'the secret never reaches the browser');
});

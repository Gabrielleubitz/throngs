'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createTunnel, FALLBACK_URL } = require('../bin/tunnel.js');

function mk({ ready = 4, host = 'new-host.trycloudflare.com', voiceUrl = 'https://old.trycloudflare.com/ares/voice', running = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tun-'));
  const sms = { account_sid: 'AC1', auth_token: 't', from_number: 'PN1', public_url: 'https://old.trycloudflare.com' };
  const saved = []; const posts = []; const spawned = []; const killed = []; const said = [];
  const world = { ready, host, voiceUrl, pids: new Set(running ? [running] : []) };
  if (running) fs.mkdirSync(path.join(dir, 'office'), { recursive: true }), fs.writeFileSync(path.join(dir, 'office', 'tunnel.json'), JSON.stringify({ pid: running, port: 20242 }));
  const fetchFn = async (url, init = {}) => {
    const j = (o, ok = true) => ({ ok, json: async () => o });
    if (url.endsWith('/ready')) return j({ readyConnections: world.ready });
    if (url.endsWith('/quicktunnel')) return j({ hostname: world.host });
    if (url.includes('IncomingPhoneNumbers/PN1.json') && init.method === 'POST') { posts.push(Object.fromEntries(new URLSearchParams(init.body))); world.voiceUrl = posts.at(-1).VoiceUrl; return j({}); }
    if (url.includes('IncomingPhoneNumbers/PN1.json')) return j({ voice_url: world.voiceUrl, voice_fallback_url: world.fallback ?? FALLBACK_URL });
    throw new Error(`unexpected ${url}`);
  };
  const T = createTunnel(dir, {
    fetchFn, sleep: async () => {}, notify: (t) => said.push(t),
    integrations: { get: () => sms, save: (b) => { saved.push(b); Object.assign(sms, b.values); } },
    spawnFn: (bin, args) => { spawned.push(args); const pid = 5000 + spawned.length; world.pids.add(pid); return { pid, unref() {} }; },
    kill: (pid) => { killed.push(pid); world.pids.delete(pid); }, alive: (pid) => world.pids.has(pid),
  });
  return { T, sms, saved, posts, spawned, killed, said, world };
}

test('nothing running: start cloudflared, then point the office and the Twilio number at the new address', async () => {
  const x = mk(); x.world.fallback = '';
  const r = await x.T.check();
  assert.deepStrictEqual(x.spawned[0], ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20242', '--url', 'http://127.0.0.1:4781']);
  assert.strictEqual(r.hostname, 'new-host.trycloudflare.com');
  assert.strictEqual(x.sms.public_url, 'https://new-host.trycloudflare.com');
  assert.deepStrictEqual(x.posts, [{ VoiceUrl: 'https://new-host.trycloudflare.com/ares/voice', VoiceMethod: 'POST', VoiceFallbackUrl: FALLBACK_URL, VoiceFallbackMethod: 'GET', StatusCallback: 'https://new-host.trycloudflare.com/ares/status', StatusCallbackMethod: 'POST' }]);
  assert.match(decodeURIComponent(FALLBACK_URL), /^https:\/\/twimlets\.com\/echo\?Twiml=<Response><Say[^>]*>Hi, you've reached the office[\s\S]*<Record maxLength="120"[^>]*action="https:\/\/twimlets\.com\/echo/, 'if the office is unreachable, Twilio takes a voicemail itself');
  assert.strictEqual(x.said.length, 1, 'the owner hears the line came back');
});

test('healthy and already pointed: nothing is restarted or rewritten', async () => {
  const x = mk({ running: 777, host: 'old.trycloudflare.com', voiceUrl: 'https://old.trycloudflare.com/ares/voice' });
  const r = await x.T.check();
  assert.ok(r.ok);
  assert.deepStrictEqual([x.spawned.length, x.killed.length, x.saved.length, x.posts.length, x.said.length], [0, 0, 0, 0, 0]);
});

test('a dropped connection is given one more minute, then our tunnel is replaced and re-pointed', async () => {
  const x = mk({ running: 777, ready: 0, host: 'old.trycloudflare.com' });
  const first = await x.T.check();
  assert.strictEqual(first.ok, false); assert.strictEqual(x.spawned.length, 0, 'one miss: cloudflared may reconnect by itself');
  x.world.host = 'fresh.trycloudflare.com';
  x.world.ready = 0;
  const p = x.T.check(); x.world.ready = 3; const r = await p;
  assert.deepStrictEqual(x.killed, [777], 'only the tunnel the office started');
  assert.strictEqual(r.hostname, 'fresh.trycloudflare.com');
  assert.strictEqual(x.world.voiceUrl, 'https://fresh.trycloudflare.com/ares/voice');
});

test('a saved pid that is no longer cloudflared is never killed', async () => {
  const x = mk({ running: 777 });
  x.world.pids.delete(777); // e.g. after a reboot the pid belongs to something else: alive() says no
  await x.T.check();
  assert.deepStrictEqual(x.killed, []);
  assert.strictEqual(x.spawned.length, 1);
});

test('line switched off: Twilio rejects every call itself, no tunnel restarts', async () => {
  const { OFF_URL } = require('../bin/tunnel.js');
  const x = mk(); const T = createTunnel(fs.mkdtempSync(path.join(os.tmpdir(), 'tun-')), { fetchFn: async (url, init = {}) => {
    if (init.method === 'POST') { x.posts.push(Object.fromEntries(new URLSearchParams(init.body))); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ voice_url: 'https://old/ares/voice', voice_fallback_url: FALLBACK_URL }) };
  }, integrations: { get: () => x.sms, save() {} }, spawnFn: () => { throw new Error('must not start a tunnel'); }, isOff: () => true });
  const r = await T.check();
  assert.deepStrictEqual(r, { ok: true, off: true, twilio: true });
  assert.deepStrictEqual(x.posts, [{ VoiceUrl: OFF_URL, VoiceMethod: 'GET', VoiceFallbackUrl: OFF_URL, VoiceFallbackMethod: 'GET' }]);
  assert.match(decodeURIComponent(OFF_URL), /<Reject reason="busy"\/>/);
});

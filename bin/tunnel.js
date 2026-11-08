'use strict';
/**
 * The phone line's public address, kept alive by the office. Twilio reaches the phone server (127.0.0.1:4781) through
 * a Cloudflare quick tunnel; a quick tunnel's address dies when its connection drops (the Mac sleeps, the network
 * changes) and a restart gets a NEW random address. So the office owns the tunnel: it starts cloudflared (detached, so
 * an office restart keeps the same address), checks it every minute via cloudflared's metrics server (/ready,
 * /quicktunnel), restarts it when it has had no connection for two checks, and whenever the address changes it saves
 * the new public_url in the "sms" integration and points the Twilio number's voice webhook at it.
 * State: office/tunnel.json { pid, port, hostname, at } (only the pid WE started is ever stopped).
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = 4781;
const METRICS = 20242;
/**
 * What Twilio does when the office can't be reached at all (tunnel down, Mac asleep): take a voicemail itself.
 * Served by Twilio's own echo twimlet, so it needs nothing of ours to be up; the office picks the recording up later
 * (bin/missed-calls.js). The Record action is a second echo that just hangs up (without it Twilio replays the page).
 */
const echo = (twiml) => `https://twimlets.com/echo?Twiml=${encodeURIComponent(twiml)}`;
const xmlAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** The line is switched off (sm phone --off): Twilio itself rejects every call as busy; nothing of ours is reached. */
const OFF_URL = echo('<Response><Reject reason="busy"/></Response>');
const FALLBACK_URL = echo(`<Response><Say voice="Polly.Joanna-Neural">Hi, you've reached the office. Ivy can't pick up right now. Leave a message after the tone and she'll pass it on.</Say><Record maxLength="120" playBeep="true" action="${xmlAttr(echo('<Response><Say voice="Polly.Joanna-Neural">Thanks, I got it. Bye.</Say><Hangup/></Response>'))}"/></Response>`); // not 20241: a cloudflared someone started by hand may already hold the default

function createTunnel(root, { integrations, fetchFn = globalThis.fetch, spawnFn = spawn, kill = (pid) => process.kill(pid), alive = defaultAlive, notify, log = () => {}, now = () => Date.now(), bin = 'cloudflared', metricsPort = METRICS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isOff } = {}) {
  const I = integrations || require('./integrations.js').createIntegrations(root);
  const file = path.join(root, 'office', 'tunnel.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 1)); };
  const off = isOff || (() => { try { return !!JSON.parse(fs.readFileSync(path.join(root, 'office', 'secretary.json'), 'utf8')).phone?.off; } catch { return false; } });
  const metrics = async (p, port = read().port || metricsPort) => { const r = await fetchFn(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(4000) }); return r.json(); };
  let misses = 0; let timer = null; let busy = null;

  /** { up, hostname, connections } from the running tunnel (ours), or up:false. */
  async function health() {
    const s = read(); if (!s.pid || !alive(s.pid)) return { up: false, reason: 'not running' };
    try {
      const [ready, q] = await Promise.all([metrics('/ready', s.port), metrics('/quicktunnel', s.port)]);
      const n = Number(ready.readyConnections || 0);
      return { up: n > 0, hostname: q.hostname || '', connections: n, reason: n ? '' : 'no connection to Cloudflare' };
    } catch (e) { return { up: false, reason: `metrics unreachable (${e.message})` }; }
  }

  /** Stop our tunnel (never anyone else's) and start a fresh one; resolves once it has an address and a connection. */
  async function restart(why = '') {
    const s = read();
    if (s.pid && alive(s.pid)) { try { kill(s.pid); } catch { /* already gone */ } }
    log(`tunnel: starting cloudflared${why ? ` (${why})` : ''}`);
    const c = spawnFn(bin, ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`, '--url', `http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' });
    c.unref?.();
    write({ pid: c.pid, port: metricsPort, hostname: '', at: new Date(now()).toISOString() });
    for (let i = 0; i < 30; i++) { // up to ~60s for an address and a live connection
      await sleep(2000);
      const h = await health();
      if (h.up && h.hostname) { write({ ...read(), hostname: h.hostname }); return h; }
    }
    throw new Error('cloudflared started but never connected (is it installed: brew install cloudflared?)');
  }

  /** Make sure the sms integration and the Twilio number point at `hostname`. Returns what changed. */
  async function sync(hostname) {
    const c = I.get('sms') || {}; const pub = `https://${hostname}`;
    const changed = { publicUrl: false, twilio: false };
    if (String(c.public_url || '').replace(/\/+$/, '') !== pub) { I.save({ id: 'sms', values: { public_url: pub } }); changed.publicUrl = true; }
    changed.twilio = await point(c, `${pub}/ares/voice`, FALLBACK_URL, { StatusCallback: `${pub}/ares/status`, StatusCallbackMethod: 'POST' });
    return changed;
  }
  /** Point the Twilio number's voice webhook (and fallback) at these URLs; true when it changed. */
  async function point(c, want, fallback, extra = {}) {
    if (c.account_sid && c.auth_token && c.from_number) {
      const auth = `Basic ${Buffer.from(`${c.account_sid}:${c.auth_token}`).toString('base64')}`;
      const base = `https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}/IncomingPhoneNumbers`;
      let sid = /^PN/.test(c.from_number) ? c.from_number : '';
      if (!sid) { const j = await (await fetchFn(`${base}.json?PhoneNumber=${encodeURIComponent(c.from_number)}`, { headers: { Authorization: auth } })).json(); sid = j.incoming_phone_numbers?.[0]?.sid || ''; }
      if (sid) {
        const cur = await (await fetchFn(`${base}/${sid}.json`, { headers: { Authorization: auth } })).json();
        if (cur.voice_url !== want || cur.voice_fallback_url !== fallback) {
          const r = await fetchFn(`${base}/${sid}.json`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ VoiceUrl: want, VoiceMethod: want === OFF_URL ? 'GET' : 'POST', VoiceFallbackUrl: fallback, VoiceFallbackMethod: 'GET', ...extra }).toString() });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`Twilio refused the new webhook: ${j.message || r.status}`); }
          return true;
        }
      }
    }
    return false;
  }
  /** Line switched off: every call is rejected by Twilio itself (busy), whatever the office's state. */
  const park = () => point(I.get('sms') || {}, OFF_URL, OFF_URL);

  /** One check: healthy → make sure everything points at it; two misses in a row → restart and re-point. */
  function check() {
    if (busy) return busy;
    busy = (async () => {
      if (off()) return { ok: true, off: true, twilio: await park() }; // no tunnel restarts, no re-pointing while it's off
      let h = await health();
      if (h.up) misses = 0; else misses++;
      if (!h.up && (misses >= 2 || h.reason === 'not running')) { h = await restart(h.reason); misses = 0; }
      if (!h.up || !h.hostname) return { ok: false, reason: h.reason };
      const changed = await sync(h.hostname);
      if (changed.publicUrl || changed.twilio) { log(`tunnel: phone line now at ${h.hostname}`); notify?.('📞 Phone line reconnected: the office moved to a new address and updated Twilio. Calls work again.'); }
      return { ok: true, hostname: h.hostname, connections: h.connections, ...changed };
    })().finally(() => { busy = null; });
    return busy;
  }

  function start(everyMs = 60000) {
    if (timer) return;
    check().catch((e) => log(`tunnel: ${e.message}`));
    timer = setInterval(() => { check().catch((e) => log(`tunnel: ${e.message}`)); }, everyMs); timer.unref?.();
  }
  return { health, restart, sync, park, check, start, file };
}
/** Alive AND still cloudflared: after a reboot the saved pid may belong to something else, which we must never stop. */
function defaultAlive(pid) { try { process.kill(pid, 0); } catch { return false; } const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }); return /cloudflared/.test(r.stdout || ''); }

module.exports = { createTunnel, METRICS, FALLBACK_URL, OFF_URL };

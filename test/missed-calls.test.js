'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createMissedCalls } = require('../bin/missed-calls.js');

test('calls Twilio got but the office never saw are logged and sent to the owner, with the voicemail audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missed-'));
  const t0 = Date.parse('2026-10-30T07:00:00Z');
  const logged = []; const texts = []; const audio = [];
  const calls = [
    { sid: 'CAvm', direction: 'inbound', status: 'completed', from: '+1999', start_time: 'Fri, 30 Oct 2026 07:10:00 +0000', end_time: 'Fri, 30 Oct 2026 07:11:00 +0000', duration: '40' },
    { sid: 'CAbusy', direction: 'inbound', status: 'busy', from: '+972500000000', start_time: 'Fri, 30 Oct 2026 07:12:00 +0000', duration: '0' },
    { sid: 'CAknown', direction: 'inbound', status: 'completed', from: '+1999', start_time: 'Fri, 30 Oct 2026 07:13:00 +0000' },
    { sid: 'CAlive', direction: 'inbound', status: 'in-progress', from: '+1999', start_time: 'Fri, 30 Oct 2026 07:14:00 +0000' },
    { sid: 'CAout', direction: 'outbound-api', status: 'completed', from: '+1', start_time: 'Fri, 30 Oct 2026 07:15:00 +0000' },
    { sid: 'CAold', direction: 'inbound', status: 'busy', from: '+1', start_time: 'Fri, 30 Oct 2026 06:00:00 +0000' },
  ].reverse();
  const fetchFn = async (url) => {
    const j = (o) => ({ ok: true, json: async () => o, arrayBuffer: async () => new TextEncoder().encode('MP3').buffer });
    if (/\/Calls\.json/.test(url)) return j({ calls });
    if (/Calls\/CAvm\/Recordings/.test(url)) return j({ recordings: [{ sid: 'RE1', duration: '31' }] });
    if (/Recordings\.json/.test(url)) return j({ recordings: [] });
    if (/Recordings\/RE1\.mp3/.test(url)) return j({});
    throw new Error(url);
  };
  let now = t0;
  const M = createMissedCalls(dir, { fetchFn, now: () => now, integrations: { get: () => ({ account_sid: 'AC', auth_token: 't', owner_phone: '+972500000000' }) },
    callLog: { list: () => [{ callSid: 'CAknown' }], upsert: (r) => logged.push(r) }, notify: async (t) => texts.push(t), sendAudio: async (b, o) => audio.push([Buffer.from(b).toString(), o.caption]),
    recognise: (n) => (n === '+1999' ? { name: 'Maya' } : null) });
  assert.deepStrictEqual(await M.check(), { seeded: true });
  now = t0 + 20 * 60000;
  const r = await M.check();
  assert.deepStrictEqual(r.missed.map((x) => [x.sid, x.voicemail]), [['CAvm', true], ['CAbusy', false]]);
  assert.strictEqual(audio[0][0], 'MP3');
  assert.match(audio[0][1], /^📞 Missed call from Maya at \d\d:\d\d: the office line was down\. They left a voicemail is below\.|^📞 Missed call from Maya at \d\d:\d\d: the office line was down\. They left a voicemail/);
  assert.match(texts[0], /^📞 You called at \d\d:\d\d: the office line was down\.$/);
  assert.deepStrictEqual(logged.map((x) => [x.callSid, x.outcome]), [['CAvm', 'voicemail-left'], ['CAbusy', 'missed']]);
  assert.deepStrictEqual((await M.check()).missed, [], 'each call is reported once');
});

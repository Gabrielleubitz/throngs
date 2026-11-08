const test = require('node:test');
const assert = require('node:assert');
const { createPhone, twilioSignature, e164 } = require('../bin/ares-phone.js');

const sms = { account_sid: 'ACx', auth_token: 'tok', from_number: '+97211111111', owner_phone: '+972500000000', whatsapp_from: '+14155238886', public_url: 'https://x.example' };
const mk = (over = {}, extra = {}) => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: String(init.body || '') }); return { ok: true, json: async () => ({ sid: 'CA1' }) }; };
  const phone = createPhone('/nope', { fetchFn, callLog: null, wsModule: null, integrations: { get: () => ({ ...sms, ...over }) }, voice: { status: () => ({ enabled: true }), speak: async () => ({ audio: Buffer.from([1]) }) }, ...extra });
  return { phone, calls };
};

test('e164 cleans whatsapp: prefix and spaces', () => assert.strictEqual(e164('whatsapp:+972 50-000'), '+97250000'));

test('call with public_url plays ElevenLabs clip', async () => {
  const { phone, calls } = mk();
  const r = await phone.call('hello owner');
  assert.strictEqual(r.engine, 'elevenlabs');
  const p = new URLSearchParams(calls[0].body);
  assert.match(p.get('Twiml'), /<Play>https:\/\/x\.example\/ares\/audio\/[a-f0-9]{32}\.mp3<\/Play>/);
  assert.strictEqual(p.get('To'), '+972500000000');
});

test('call without public_url falls back to Twilio voice; escapes xml', async () => {
  const { phone, calls } = mk({ public_url: '' });
  assert.strictEqual((await phone.call('a < b')).engine, 'twilio');
  assert.match(new URLSearchParams(calls[0].body).get('Twiml'), /a &lt; b/);
});

test('call needs owner phone', async () => {
  const { phone } = mk({ owner_phone: '' });
  await assert.rejects(phone.call('hi'), (e) => e.status === 503);
});

test('whatsapp webhook: signature + owner only, then prompts ARES', async () => {
  const seen = [];
  const { phone } = mk({}, { onPrompt: async (t) => { seen.push(t); return 'ok'; } });
  const params = { From: 'whatsapp:+972500000000', Body: 'fix the login' };
  const sig = twilioSignature('tok', 'https://x.example/ares/whatsapp', params);
  assert.match(await phone.handleWhatsApp(params, sig), /<Message>ok<\/Message>/);
  assert.deepStrictEqual(seen, ['fix the login']);
  await assert.rejects(phone.handleWhatsApp(params, 'bad'), (e) => e.status === 403);
  const other = { ...params, From: 'whatsapp:+1999' };
  await assert.rejects(phone.handleWhatsApp(other, twilioSignature('tok', 'https://x.example/ares/whatsapp', other)), (e) => e.status === 403);
});

test('voice webhook: owner calls ARES, speech becomes a request; strangers refused', async () => {
  const seen = [];
  const { phone } = mk({}, { onPrompt: async (t) => { seen.push(t); return 'Filed'; } });
  const sign = (p) => twilioSignature('tok', 'https://x.example/ares/voice', p);
  const first = { From: '+972500000000', CallSid: 'CA9' };
  assert.match(await phone.handleVoice(first, sign(first)), /<Gather input="speech"[^>]*action="https:\/\/x\.example\/ares\/voice"/);
  const talk = { ...first, SpeechResult: 'fix the login' };
  assert.match(await phone.handleVoice(talk, sign(talk)), /<Say[^>]*>Filed<\/Say><\/Gather>/);
  assert.deepStrictEqual(seen, ['fix the login']);
  const bye = { ...first, SpeechResult: 'goodbye' };
  assert.match(await phone.handleVoice(bye, sign(bye)), /<Hangup\/>/);
  const stranger = { From: '+1999', CallSid: 'CA8' };
  assert.match(await phone.handleVoice(stranger, sign(stranger)), /How can I help/);
  await assert.rejects(phone.handleVoice(first, 'bad'), (e) => e.status === 403);
});

test('slow answer: WhatsApp webhook returns empty TwiML then texts the reply', async () => {
  const { phone, calls } = mk({}, { webhookBudgetMs: 20, onPrompt: () => new Promise((r) => setTimeout(() => r('late answer'), 80)) });
  const params = { From: 'whatsapp:+972500000000', Body: 'what is running?' };
  assert.strictEqual(await phone.handleWhatsApp(params, twilioSignature('tok', 'https://x.example/ares/whatsapp', params)), '<Response/>');
  await new Promise((r) => setTimeout(r, 150));
  assert.match(calls.map((c) => decodeURIComponent(c.body)).join('|'), /late[ +]answer/);
});

test('slow answer: voice says one moment, keeps the line, then reads the answer', async () => {
  const { phone } = mk({}, { webhookBudgetMs: 20, onPrompt: () => new Promise((r) => setTimeout(() => r('Two projects'), 60)) });
  const sign = (p) => twilioSignature('tok', 'https://x.example/ares/voice', p);
  const talk = { From: '+972500000000', CallSid: 'CA7', SpeechResult: 'what is running' };
  const a = await phone.handleVoice(talk, sign(talk));
  assert.match(a, /One sec[\s\S]*<Redirect[^>]*>https:\/\/x\.example\/ares\/voice<\/Redirect>/);
  const again = { From: '+972500000000', CallSid: 'CA7' };
  let b = await phone.handleVoice(again, sign(again));
  if (/<Redirect/.test(b)) b = await phone.handleVoice(again, sign(again));
  assert.match(b, /<Say[^>]*>Two projects<\/Say>/);
});

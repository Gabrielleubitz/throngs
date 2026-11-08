'use strict';
process.env.TZ = 'Asia/Jerusalem'; // spoken times in these tests are Israel time
const test = require('node:test');
const assert = require('node:assert');
const { createGoogle } = require('../bin/google.js');
const { createChat } = require('../bin/ares-chat.js');

const NOW = Date.parse('2026-11-01T12:00:00Z');
function fakeGoogle() {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    const j = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
    if (url.includes('oauth2.googleapis.com/token')) return j({ access_token: 'AT', expires_in: 3600 });
    if (url.includes('/calendarList')) return j({ items: [{ id: 'primary@x', primary: true, accessRole: 'owner' }, { id: 'hol', summary: 'Holidays', accessRole: 'reader', backgroundColor: '#0f0' }, { id: 'fb', summary: 'Busy only', accessRole: 'freeBusyReader' }] });
    if (url.includes('/calendars/primary%40x/events')) return j({ items: [{ id: 'e2', summary: 'Later', start: { dateTime: '2026-11-03T10:00:00+02:00' }, end: { dateTime: '2026-11-03T10:30:00+02:00' }, hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc', attendees: [{ email: 'me@x', self: true }, { email: 'dana@acme.co', displayName: 'Dana' }] }, { id: 'gone', status: 'cancelled', start: { dateTime: '2026-11-02T00:00:00Z' } }] });
    if (url.includes('/calendars/hol/events')) return j({ items: [{ id: 'h1', summary: 'Holiday', start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }] });
    if (url.includes('/calendars/primary/events?conferenceDataVersion=1')) { const b = JSON.parse(init.body); return j({ id: 'new1', summary: b.summary, hangoutLink: 'https://meet.google.com/new-meet-xyz', start: b.start, end: b.end, htmlLink: 'https://calendar/x' }); }
    if (url.includes('/freeBusy')) return j({ calendars: { primary: { busy: [{ start: '2026-11-03T08:00:00Z', end: '2026-11-03T08:30:00Z' }] } } });
    if (url.includes('gmail.googleapis.com/gmail/v1/users/me/messages/send')) return j({ id: 'm1' });
    if (url.includes('people:searchContacts')) return j({ results: /dana/i.test(url) ? [{ person: { names: [{ displayName: 'Dana Cole' }], emailAddresses: [{ value: 'dana@acme.co' }] } }] : [] });
    if (url.includes('otherContacts:search')) return j({ results: [] });
    return j({ error: { message: `unexpected ${url}` } }, false, 404);
  };
  return { G: createGoogle({ get: () => ({ client_id: 'c', client_secret: 's', refresh_token: 'r' }) }, { fetchFn, now: () => NOW }), calls };
}

test('events: every readable calendar, sorted, cancelled and busy-only left out; guests without the owner', async () => {
  const { G } = fakeGoogle();
  const ev = await G.events({ from: NOW, to: NOW + 14 * 86400000 });
  assert.deepStrictEqual(ev.map((e) => [e.title, e.calendar, e.allDay]), [['Holiday', 'Holidays', true], ['Later', 'primary', false]]);
  assert.strictEqual(ev[1].meet, 'https://meet.google.com/aaa-bbbb-ccc');
  assert.deepStrictEqual(ev[1].attendees.map((a) => a.email), ['dana@acme.co']);
});

test('createMeeting: a Meet link, guests invited by Google (sendUpdates=all); bad addresses and past times refused', async () => {
  const { G, calls } = fakeGoogle();
  const m = await G.createMeeting({ title: 'Kickoff', start: '2026-11-03T15:00:00+02:00', minutes: 45, attendees: ['Dana@Acme.co'] });
  assert.strictEqual(m.meet, 'https://meet.google.com/new-meet-xyz');
  const post = calls.find((c) => c.url.includes('conferenceDataVersion=1'));
  assert.match(post.url, /sendUpdates=all/);
  const b = JSON.parse(post.body);
  assert.deepStrictEqual([b.attendees, b.conferenceData.createRequest.conferenceSolutionKey.type, Date.parse(b.end.dateTime) - Date.parse(b.start.dateTime)], [[{ email: 'dana@acme.co' }], 'hangoutsMeet', 45 * 60000]);
  await assert.rejects(G.createMeeting({ start: '2026-11-03T15:00:00Z', attendees: ['not-an-email'] }), /Not an email address/);
  await assert.rejects(G.createMeeting({ start: '2026-10-01T15:00:00Z', attendees: [] }), /already passed/);
});

test('sendMail builds a UTF-8 message for Gmail', async () => {
  const { G, calls } = fakeGoogle();
  await G.sendMail({ to: ['dana@acme.co'], subject: 'Hello שלום', text: 'Body here' });
  const raw = Buffer.from(JSON.parse(calls.find((c) => c.url.includes('/messages/send')).body).raw, 'base64url').toString();
  assert.match(raw, /^To: dana@acme\.co\r\nSubject: =\?UTF-8\?B\?/);
  await assert.rejects(G.sendMail({ to: ['nobody'], subject: 'x', text: 'y' }), /email address/);
});

// ---- IVY: nothing is sent until the owner says yes ----
const mkIvy = (reply) => {
  const { G, calls } = fakeGoogle();
  const h = createChat({ file: async () => 'x', projects: () => [], google: G, now: () => NOW, turn: async () => reply });
  return { h, calls };
};

test('"send Dana a Meet link Tuesday at 3": read back with the clash, sent only after yes', async () => {
  const { h, calls } = mkIvy({ say: 'Sure, one sec.', action: 'meet', with: ['Dana'], title: '', start: '2026-11-03T10:00:00+02:00', minutes: 30 });
  const ask = await h('send dana a meet link for tuesday at 10', { thread: 'call:1' });
  assert.match(ask, /^A 30-minute Google Meet with Dana Cole, Tuesday 3 November at 10am\. You already have something then\. Send the invite\?$/);
  assert.ok(!calls.some((c) => c.url.includes('conferenceDataVersion=1')), 'nothing sent yet');
  const done = await h('Yes, send it.', { thread: 'call:1' });
  assert.match(done, /^Done\. The invite's gone to Dana with the Meet link, and it's on your calendar\.$/);
  assert.strictEqual(calls.filter((c) => c.url.includes('conferenceDataVersion=1')).length, 1);
});

test('"no" cancels; a different thread never confirms someone else\'s draft; unknown people are asked about', async () => {
  const a = mkIvy({ say: 'Sure.', action: 'email', with: ['dana'], title: 'Running late', body: "I'll be ten minutes late." });
  assert.match(await a.h('email dana that I am late', { thread: 'call:1' }), /^An email to Dana Cole, "Running late": I'll be ten minutes late\. Send it\?$/);
  assert.match(await a.h('yes', { thread: 'text' }), /.*/); // another conversation saying yes
  assert.ok(!a.calls.some((c) => c.url.includes('/messages/send')), 'a yes elsewhere sends nothing');
  assert.match(await a.h('no, cancel that', { thread: 'call:1' }), /won't send it/);
  assert.match(await a.h('yes', { thread: 'call:1' }), /.*/);
  assert.ok(!a.calls.some((c) => c.url.includes('/messages/send')));
  const b = mkIvy({ say: 'Sure.', action: 'meet', with: ['Bob'], start: '2026-11-03T10:00:00+02:00' });
  assert.match(await b.h('meet bob tuesday', { thread: 't' }), /I don't have an email for Bob\. What's the address\? You can spell it\./);
  const c = mkIvy({ say: 'Sure.', action: 'meet', with: ['dana at acme dot co'], start: '2026-11-03T10:00:00+02:00', minutes: 60 });
  assert.match(await c.h('meet dana at acme dot co', { thread: 't' }), /one-hour Google Meet with d, a, n, a at acme dot co,/);
});

test('the real call, replayed: unknown name → spelled address read by code → spelled back → yes → remembered for next time', async () => {
  const { G, calls } = fakeGoogle();
  const memory = new Map(); const drafts = [];
  const replies = [
    { say: 'Sure, one sec.', action: 'meet', with: ['Elon Roberts'], title: '', start: '2026-11-01T16:00:00+02:00', minutes: 30 },
    { say: 'Sure.', action: 'meet', with: ['Elon'], start: '2026-11-02T16:00:00+02:00', minutes: 30 },
  ];
  let i = 0;
  const h = createChat({ file: async () => 'x', projects: () => [], google: G, now: () => NOW, turn: async () => replies[i++],
    findContactEmail: (n) => memory.get(n.toLowerCase().split(' ')[0]) || null, onDraft: (d) => drafts.push(d),
    onSent: (d) => { for (const p of d.people) if (p.name && p.source !== 'memory') memory.set(p.name.toLowerCase().split(' ')[0], { name: p.name, email: p.email }); } });
  const T = { thread: 'call:9' };
  assert.match(await h('Can you send Elon Roberts an email with a Google Meet invite for four PM today?', T), /I don't have an email for Elon Roberts\. What's the address\? You can spell it\./);
  const read = await h('The address is igani lubitz at g mail dot com, a l e x r i v e r a at g mail dot com.', T);
  assert.match(read, /^A 30-minute Google Meet with Elon Roberts at a, l, e, x, r, i, v, e, r, a at gmail dot com, Sunday 1 November at 4pm\.( You already have something then\.)? Send the invite\?$/);
  assert.strictEqual(i, 1, 'the address answer never went to the model');
  assert.strictEqual(drafts.at(-1).people[0].email, 'alexrivera@gmail.com', 'the draft (mirrored to Telegram) has the exact address');
  assert.match(await h('Yep. Send it.', T), /^Done\. The invite's gone to Elon with the Meet link/);
  assert.deepStrictEqual(JSON.parse(calls.filter((c) => c.url.includes('conferenceDataVersion=1')).at(-1).body).attendees, [{ email: 'alexrivera@gmail.com' }]);
  // next time a name is enough, and it isn't spelled out again
  assert.match(await h('send elon a meet link for tomorrow at 4', T), /^A 30-minute Google Meet with Elon Roberts, Monday 2 November at 4pm\.( You already have something then\.)? Send the invite\?$/);
});

test('a wrong address is fixed by saying it again (or replying on Telegram), and Telegram can send or cancel by id', async () => {
  const { G, calls } = fakeGoogle();
  const drafts = [];
  const h = createChat({ file: async () => 'x', projects: () => [], google: G, now: () => NOW, onDraft: (d) => drafts.push(d), turn: async () => ({ say: 'Sure.', action: 'email', with: ['dana at acme dot co'], title: 'Hi', body: 'Running late.' }) });
  await h('email dana at acme dot co that I am running late', { thread: 'call:1' });
  assert.match(await h('no, it is d a n a 2 at acme dot co', { thread: 'call:1' }), /^Fixed\. An email to d, a, n, a, 2 at acme dot co/);
  assert.strictEqual(drafts.at(-1).people[0].email, 'dana2@acme.co');
  assert.match(await h.confirmDraft(drafts.at(-1).id, { address: 'dana3@acme.co' }), /^Fixed\./);
  assert.match(await h.confirmDraft(drafts.at(-1).id, { yes: true }), /^Sent to dana3/);
  const raw = Buffer.from(JSON.parse(calls.find((c) => c.url.includes('/messages/send')).body).raw, 'base64url').toString();
  assert.match(raw, /^To: dana3@acme\.co/);
  assert.match(await h.confirmDraft(drafts.at(-1).id, { yes: true }), /That draft is gone/, 'never sent twice');
});

test('bounced(): a mailer-daemon message about the address after the send', async () => {
  const fetchFn = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('token') ? { access_token: 'A', expires_in: 3600 } : url.includes('/messages?') ? { messages: [{ id: 'b1' }] } : { internalDate: String(NOW + 30000) }) });
  const G = createGoogle({ get: () => ({ client_id: 'c', client_secret: 's', refresh_token: 'r' }) }, { fetchFn, now: () => NOW });
  assert.strictEqual(await G.bounced('alexriveras@gmail.com', NOW), true);
  assert.strictEqual(await G.bounced('alexriveras@gmail.com', NOW + 3600000), false, 'an older bounce is not this send');
});

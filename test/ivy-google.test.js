const test = require('node:test');
const assert = require('node:assert');
const { createIvyGoogle } = require('../bin/ivy-google.js');

test('ivy-google: reads calendar + drive with the linked token', async () => {
  const urls = [];
  const fetchFn = async (u) => { urls.push(u); const j = u.includes('oauth2') ? { access_token: 'tok' } : u.includes('calendar') ? { items: [{ summary: 'Dentist', start: { dateTime: '2026-11-01T10:00:00Z' } }] } : { files: [{ name: 'Plan', modifiedTime: '2026-10-01T00:00:00Z' }] }; return { ok: true, json: async () => j }; };
  const g = createIvyGoogle({ get: () => ({ client_id: 'a', client_secret: 'b', refresh_token: 'c' }) }, { fetchFn });
  const r = await g.refresh();
  assert.strictEqual(r.events[0].title, 'Dentist'); assert.strictEqual(r.files[0].name, 'Plan'); assert.strictEqual(r.error, '');
});
test('ivy-google: not linked is empty, not a crash', async () => {
  const g = createIvyGoogle({ get: () => { throw new Error('no'); } });
  assert.strictEqual((await g.refresh()).error, 'Google is not linked');
});

'use strict';
/**
 * IVY's linked Google (Calendar + Drive): next 14 days of events and recent Drive files, read with the Zoo's Google
 * integration. Cached; `current()` is synchronous (what she has now) and refreshes in the background. Read-only.
 */
function createIvyGoogle(integrations, { fetchFn = globalThis.fetch, ttlMs = 5 * 60000, now = () => Date.now() } = {}) {
  let cache = { events: [], files: [], at: 0, error: '' };
  let busy = null;
  const linked = () => { try { return integrations.get('google'); } catch { return null; } };
  async function token(g) {
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, grant_type: 'refresh_token' }) });
    const j = await r.json(); if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `token ${r.status}`);
    return j.access_token;
  }
  const getJson = async (url, t) => { const r = await fetchFn(url, { headers: { Authorization: `Bearer ${t}` } }); const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`); return j; };
  function refresh() {
    if (busy) return busy;
    const g = linked();
    if (!g || !g.refresh_token) { cache = { events: [], files: [], at: now(), error: 'Google is not linked' }; return Promise.resolve(cache); }
    busy = (async () => {
      const out = { events: [], files: [], at: now(), error: '' };
      try {
        const t = await token(g);
        const min = new Date(now()).toISOString(), max = new Date(now() + 14 * 86400000).toISOString();
        try {
          const c = await getJson(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}`, t);
          out.events = (c.items || []).map((e) => ({ title: String(e.summary || '(no title)').slice(0, 100), when: (e.start && (e.start.dateTime || e.start.date)) || '', where: String(e.location || '').slice(0, 60) }));
        } catch (e) { out.error = `calendar: ${e.message}`; }
        try {
          const d = await getJson(`https://www.googleapis.com/drive/v3/files?pageSize=15&orderBy=modifiedTime%20desc&fields=files(name,modifiedTime)&q=${encodeURIComponent('trashed=false')}`, t);
          out.files = (d.files || []).map((f) => ({ name: String(f.name).slice(0, 80), modified: f.modifiedTime || '' }));
        } catch (e) { out.error = `${out.error ? out.error + '; ' : ''}drive: ${e.message}`; }
      } catch (e) { out.error = e.message; }
      cache = out; return out;
    })().finally(() => { busy = null; });
    return busy;
  }
  /** Sync view of the latest data; kicks off a background refresh when stale. */
  function current() { if (now() - cache.at > ttlMs) refresh().catch(() => {}); return cache; }
  return { current, refresh };
}
module.exports = { createIvyGoogle };

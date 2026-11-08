'use strict';
/**
 * Zoo integrations: each animal is one linked service (WhatsApp, Google, Teams...), not an AI.
 * The owner links them in the Zoo settings; the keys live in office/integrations.json (gitignored, mode 600),
 * never in the browser. Workers learn which are linked from promptLine() and fetch keys with `sm integration get`.
 */
const fs = require('fs');
const path = require('path');

const f = (key, label, secret = true, hint = '') => ({ key, label, secret, hint });

/**
 * Click-to-sign-in providers. The owner registers one OAuth app per service (client id/secret, saved in the fields below);
 * after that "Sign in" opens the provider's consent page and the tokens land here, no pasting. `map` = token response key -> stored field.
 */
const OAUTH = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/contacts', params: { access_type: 'offline', prompt: 'consent' }, map: { refresh_token: 'refresh_token' } },
  teams: { auth: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token', scope: 'offline_access Mail.Send Calendars.ReadWrite ChannelMessage.Send', params: {}, map: { refresh_token: 'refresh_token' } },
  slack: { auth: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access', scope: 'chat:write,files:write,channels:read,users:read', scopeParam: 'scope', params: {}, map: { access_token: 'bot_token' } },
  notion: { auth: 'https://api.notion.com/v1/oauth/authorize', token: 'https://api.notion.com/v1/oauth/token', scope: '', params: { owner: 'user' }, basic: true, json: true, map: { access_token: 'token' } },
  zoom: { auth: 'https://zoom.us/oauth/authorize', token: 'https://zoom.us/oauth/token', scope: '', params: {}, basic: true, map: { refresh_token: 'refresh_token' } },
  dropbox: { auth: 'https://www.dropbox.com/oauth2/authorize', token: 'https://api.dropboxapi.com/oauth2/token', scope: '', params: { token_access_type: 'offline' }, map: { access_token: 'access_token', refresh_token: 'refresh_token' } },
};
const appFields = [f('client_id', 'OAuth app client ID (for Sign in, optional)', false), f('client_secret', 'OAuth app client secret (for Sign in, optional)')];
const tokenField = f('refresh_token', 'Refresh token (filled by Sign in, optional)');

/** `animal` indexes the zoo sprites (zooAnimals.ts ANIMALS), in the same order. */
const CATALOG = [
  { id: 'whatsapp', animal: 0, name: 'WhatsApp the Lion', service: 'WhatsApp Business', does: 'Send and read WhatsApp messages and files; look up contacts.', docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api', fields: [f('access_token', 'Cloud API access token'), f('phone_number_id', 'Phone number ID', false), f('business_account_id', 'Business account ID (optional)', false)] },
  { id: 'teams', animal: 1, name: 'Teams the Elephant', service: 'Microsoft Teams + Outlook', does: 'Post to Teams channels, send Outlook mail, read the Microsoft calendar.', docs: 'https://learn.microsoft.com/graph', fields: [f('tenant_id', 'Tenant ID', false), f('client_id', 'Client ID', false), f('client_secret', 'Client secret'), f('webhook_url', 'Teams incoming-webhook URL (optional)'), tokenField] },
  { id: 'notion', animal: 2, name: 'Notion the Giraffe', service: 'Notion', does: 'Read and write pages and databases (notes, wikis, to-do lists).', docs: 'https://developers.notion.com', fields: [f('token', 'Integration token'), ...appFields] },
  { id: 'telegram', animal: 3, name: 'Telegram the Penguin', service: 'Telegram bot', does: 'Send messages and files to Telegram chats.', docs: 'https://core.telegram.org/bots/api', fields: [f('bot_token', 'Bot token'), f('default_chat_id', 'Default chat ID (optional)', false)] },
  { id: 'slack', animal: 4, name: 'Slack the Monkey', service: 'Slack', does: 'Post messages and upload files to Slack channels and people.', docs: 'https://api.slack.com/apps', fields: [f('bot_token', 'Bot token (xoxb-...)'), ...appFields] },
  { id: 'google', animal: 5, name: 'Google the Zebra', service: 'Google (Gmail, Calendar, Drive, Contacts)', does: 'Send email with attachments, look up contacts, read and add calendar events, share Drive files.', docs: 'https://console.cloud.google.com/apis/credentials', fields: [f('client_id', 'OAuth client ID', false), f('client_secret', 'OAuth client secret'), f('refresh_token', 'Refresh token')] },
  { id: 'zoom', animal: 6, name: 'Zoom the Owl', service: 'Zoom', does: 'Create and list Zoom meetings and send the join links.', docs: 'https://developers.zoom.us', fields: [f('account_id', 'Account ID', false), f('client_id', 'Client ID', false), f('client_secret', 'Client secret'), tokenField] },
  { id: 'dropbox', animal: 7, name: 'Dropbox the Bear', service: 'Dropbox', does: 'Upload files and make share links for big files.', docs: 'https://www.dropbox.com/developers/apps', fields: [f('access_token', 'Access token'), ...appFields, tokenField] },
  { id: 'sms', animal: 8, name: 'SMS the Fox', service: 'Twilio SMS and calls', does: 'Send text messages and place voice calls (ARES calls the owner and texts on WhatsApp).', docs: 'https://console.twilio.com', fields: [f('account_sid', 'Account SID', false), f('auth_token', 'Auth token'), f('from_number', 'From number', false), f('owner_phone', 'Your phone, +country code (for ARES calls, optional)', false), f('whatsapp_from', 'Twilio WhatsApp sender, +number (optional)', false), f('public_url', 'Public https address of this Mac for Twilio, no trailing slash (optional)', false)] },
  { id: 'discord', animal: 9, name: 'Discord the Duck', service: 'Discord', does: 'Post messages and files to Discord channels.', docs: 'https://discord.com/developers/applications', fields: [f('bot_token', 'Bot token'), f('default_channel_id', 'Default channel ID (optional)', false)] },
];

function createIntegrations(root, opts = {}) {
  const file = path.join(root, 'office', 'integrations.json');
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } };
  const entry = (id) => CATALOG.find((c) => c.id === id);
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const mask = (v) => (v.length <= 6 ? '••••' : `••••${v.slice(-3)}`);

  const signedIn = (c, d) => { const o = OAUTH[c.id]; return !!(o && d[c.id]?.[Object.values(o.map)[0]]); };
  const isLinked = (c, d) => signedIn(c, d) || c.fields.filter((x) => !/optional/i.test(x.label)).every((x) => d[c.id]?.[x.key]);
  const pending = new Map(); // state -> { id, redirect, at }
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  // Google: the office uses the Google sign-in app of the owner's linked Firebase project — nothing to paste.
  const firebase = () => require('./firebase.js').createFirebase(root, { fetch: doFetch });
  const viaFirebase = (c, d) => c.id === 'google' && !(d.google?.client_id && d.google?.client_secret && !d.google?.from_firebase) && firebase().status().linked;
  /** The client ID + secret for a sign-in: saved ones, or (Google) fetched from Firebase and remembered. */
  async function appFor(c, d) {
    const a = d[c.id] || {};
    if (a.client_id && a.client_secret) return a;
    if (!viaFirebase(c, d)) return a;
    const g = await firebase().googleClient().catch(() => null);
    if (!g) throw bad('Turn on Google sign-in in your Firebase project (Authentication → Sign-in method → Google), then try again.');
    d.google = { ...a, client_id: g.client_id, client_secret: g.client_secret, from_firebase: g.project_id };
    write(d);
    return d.google;
  }
  /** Google refuses return addresses its app doesn't list: find out before sending the owner there, and say how to fix it. */
  async function redirectProblem(url, a) {
    const r = await doFetch(url, { redirect: 'manual' }).catch(() => null);
    const loc = r?.headers?.get?.('location') || '';
    const err = (loc.match(/authError=([^&]+)/) || [])[1];
    let text = '';
    try { text = Buffer.from(decodeURIComponent(err || ''), 'base64').toString('latin1'); } catch { /* not ours to read */ }
    if (!/redirect_uri_mismatch/.test(text)) return null;
    // authuser: open it as the owner's Google account — Chrome's default account may be another client's, which can't see this project
    const owner = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'projects', 'success-manager', 'config.json'), 'utf8')).firebaseAccount || ''; } catch { return ''; } })();
    const q = new URLSearchParams({ ...(a.from_firebase ? { project: a.from_firebase } : {}), ...(owner ? { authuser: owner } : {}) });
    const fixUrl = `https://console.cloud.google.com/auth/clients/${encodeURIComponent(a.client_id)}${String(q) ? `?${q}` : ''}`;
    return Object.assign(bad('One-time setup: Google needs to know the office may receive sign-ins. Open your Google app (link below), add this under "Authorized redirect URIs", Save, wait a minute, then click Sign in again: ' + new URL(url).searchParams.get('redirect_uri'), 409), { fixUrl });
  }

  /** For the browser: never includes secret values, only a masked tail. */
  function list() {
    const d = load();
    return CATALOG.map((c) => ({
      id: c.id, animal: c.animal, name: c.name, service: c.service, does: c.does, docs: c.docs,
      linked: isLinked(c, d),
      oauth: OAUTH[c.id] ? { ready: viaFirebase(c, d) || !!(d[c.id]?.client_id && d[c.id]?.client_secret && (c.id !== 'teams' || d[c.id]?.tenant_id)), signedIn: signedIn(c, d), viaFirebase: viaFirebase(c, d) } : null,
      fields: c.fields.map((x) => {
        const v = d[c.id]?.[x.key] || '';
        return { key: x.key, label: x.label, secret: x.secret, set: !!v, value: x.secret ? (v ? mask(v) : '') : v };
      }),
    }));
  }

  /** Save only the fields given (blank/missing leaves the stored value; use clear() to unlink). */
  function save(body) {
    const c = entry(String(body?.id || ''));
    if (!c) throw bad('unknown integration');
    const d = load();
    const cur = { ...(d[c.id] || {}) };
    for (const x of c.fields) {
      const v = body?.values?.[x.key];
      if (typeof v === 'string' && v.trim()) cur[x.key] = v.trim().slice(0, 4000);
    }
    d[c.id] = cur;
    write(d);
    return { ok: true, linked: isLinked(c, d) };
  }

  function clear(body) {
    const c = entry(String(body?.id || ''));
    if (!c) throw bad('unknown integration');
    const d = load(); delete d[c.id]; write(d);
    return { ok: true };
  }

  function write(d) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Real values for one linked integration (CLI/workers only, never an HTTP route). */
  function get(id) {
    const c = entry(id);
    if (!c) throw bad(`unknown integration "${id}"`);
    const d = load();
    if (!isLinked(c, d)) throw bad(`${c.service} is not linked yet. The owner links it in the Zoo room settings.`, 404);
    return { id: c.id, service: c.service, ...d[c.id] };
  }

  const oauthUrl = (o, c, d, k) => o[k].replace('{tenant}', encodeURIComponent(d[c.id]?.tenant_id || 'common'));

  /** Begin Sign in: returns the provider consent URL (open it in a browser tab). `redirect` is this office's /sm/oauth/callback. */
  async function oauthStart(body) {
    const c = entry(String(body?.id || '')), o = c && OAUTH[c.id];
    if (!o) throw bad('this service has no click-to-sign-in');
    const d = load(), a = await appFor(c, d);
    const redirect = String(body?.redirect || '');
    if (!/^https?:\/\//.test(redirect)) throw bad('missing redirect');
    if (!a.client_id || !a.client_secret) throw bad(`Save the OAuth app client ID and secret for ${c.service} first (one time).`);
    for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
    const state = require('crypto').randomBytes(16).toString('hex');
    pending.set(state, { id: c.id, redirect, at: Date.now() });
    const q = new URLSearchParams({ client_id: a.client_id, redirect_uri: redirect, response_type: 'code', state, ...o.params });
    if (o.scope) q.set(o.scopeParam || 'scope', o.scope);
    const url = `${oauthUrl(o, c, d, 'auth')}?${q}`;
    if (c.id === 'google') { const why = await redirectProblem(url, a); if (why) { pending.delete(state); throw why; } }
    return { url, redirect };
  }

  /** Provider redirects back here with ?code&state: swap the code for tokens and store them. Returns the id signed in. */
  async function oauthCallback(query) {
    const st = pending.get(String(query?.state || ''));
    if (!st || Date.now() - st.at > 10 * 60 * 1000) throw bad('sign-in expired, start again');
    pending.delete(String(query.state));
    if (query.error || !query.code) throw bad(`sign-in refused: ${query.error_description || query.error || 'no code'}`);
    const c = entry(st.id), o = OAUTH[c.id], d = load(), a = d[c.id] || {};
    const form = { grant_type: 'authorization_code', code: String(query.code), redirect_uri: st.redirect };
    const headers = { Accept: 'application/json' };
    if (o.basic) headers.Authorization = `Basic ${Buffer.from(`${a.client_id}:${a.client_secret}`).toString('base64')}`;
    else Object.assign(form, { client_id: a.client_id, client_secret: a.client_secret });
    headers['Content-Type'] = o.json ? 'application/json' : 'application/x-www-form-urlencoded';
    const r = await doFetch(oauthUrl(o, c, d, 'token'), { method: 'POST', headers, body: o.json ? JSON.stringify(form) : new URLSearchParams(form).toString() });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || t.error || t.ok === false) throw bad(`${c.service} said no: ${t.error_description || (typeof t.error === 'string' ? t.error : '') || `HTTP ${r.status}`}`);
    const cur = { ...(d[c.id] || {}) };
    let got = 0;
    for (const [from, to] of Object.entries(o.map)) if (typeof t[from] === 'string' && t[from]) { cur[to] = t[from].slice(0, 4000); got++; }
    if (!got) throw bad(`${c.service} sent no token`);
    d[c.id] = cur; write(d);
    return { id: c.id, name: c.name };
  }

  /** Prove a linked OAuth service's stored refresh token still works (exchanges it, stores nothing). Others: only reports what is saved. */
  async function check(id) {
    const c = entry(id);
    if (!c) throw bad(`unknown integration "${id}"`);
    const d = load(), a = d[c.id] || {};
    if (!isLinked(c, d)) return { id: c.id, ok: false, detail: 'not linked' };
    if (c.id !== 'google') return { id: c.id, ok: true, detail: 'keys saved (no live test for this service)' };
    if (!a.client_id || !a.client_secret || !a.refresh_token) return { id: c.id, ok: false, detail: 'client ID, secret and refresh token are all needed' };
    if (/^https?:\/\//.test(a.refresh_token)) return { id: c.id, ok: false, detail: 'the saved "refresh token" is a web address (a scope), not a token. Click Sign in again.' };
    const r = await doFetch(OAUTH.google.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: a.client_id, client_secret: a.client_secret, refresh_token: a.refresh_token, grant_type: 'refresh_token' }).toString() });
    const t = await r.json().catch(() => ({}));
    return r.ok && t.access_token ? { id: c.id, ok: true, detail: 'token refresh works' } : { id: c.id, ok: false, detail: `Google said no: ${t.error_description || t.error || `HTTP ${r.status}`}. Click Sign in again.` };
  }

  /** One line for every worker's prompt so "send this to Dana" knows which doors are open. */
  function promptLine() {
    const d = load();
    const on = CATALOG.filter((c) => isLinked(c, d));
    if (!on.length) return '';
    return `Linked integrations (owner's accounts; use them when asked to send, share or look something up): ${on.map((c) => `${c.id} (${c.service}: ${c.does})`).join('; ')}. Get a key with \`node bin/sm.js integration get <id>\` from the success-manager folder; never print or commit it.`;
  }

  return { CATALOG, list, save, clear, get, check, promptLine, oauthStart, oauthCallback };
}

module.exports = { createIntegrations, CATALOG };

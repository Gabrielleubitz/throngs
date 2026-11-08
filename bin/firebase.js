'use strict';
/**
 * Firebase (Firestore) cloud sync for the zoo integrations: an encrypted backup of office/integrations.json so a second
 * machine (or a reinstall) gets every linked service back. Talks to Firestore's REST API with a service-account key,
 * no extra npm dependency. The blob is AES-256-GCM encrypted with a key derived (scrypt) from the owner's passphrase
 * BEFORE it leaves the machine, so Firebase only ever stores ciphertext.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const COLLECTION = 'sm_backups';
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const b64u = (b) => Buffer.from(b).toString('base64url');

function encrypt(plain, passphrase) {
  if (!passphrase || passphrase.length < 8) throw bad('passphrase must be at least 8 characters');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(blob, passphrase) {
  let o; try { o = JSON.parse(blob); } catch { throw bad('backup is not valid'); }
  try {
    const key = crypto.scryptSync(passphrase || '', Buffer.from(o.salt, 'base64'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
    d.setAuthTag(Buffer.from(o.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8');
  } catch { throw bad('wrong passphrase, or the backup is damaged'); }
}

function createFirebase(root, opts = {}) {
  const linkFile = path.join(root, 'office', 'firebase-link.json');
  const intFile = path.join(root, 'office', 'integrations.json');
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const load = () => { try { return JSON.parse(fs.readFileSync(linkFile, 'utf8')); } catch { return null; } };

  function status() {
    const l = load();
    return { linked: !!l, projectId: l?.project_id || null, clientEmail: l?.client_email || null };
  }

  /** Save a service-account key (object or JSON text) downloaded from Firebase console > Project settings > Service accounts. */
  function link(key) {
    let k = key;
    if (typeof key === 'string') { try { k = JSON.parse(key); } catch { throw bad('that is not valid JSON'); } }
    if (!k || k.type !== 'service_account' || !k.project_id || !k.client_email || !k.private_key) throw bad('not a Firebase service-account key (needs project_id, client_email, private_key)');
    fs.mkdirSync(path.dirname(linkFile), { recursive: true });
    fs.writeFileSync(linkFile, JSON.stringify({ project_id: k.project_id, client_email: k.client_email, private_key: k.private_key }, null, 2), { mode: 0o600 });
    return status();
  }

  function unlink() { try { fs.unlinkSync(linkFile); } catch { /* already gone */ } return status(); }

  async function accessToken(l, scope = SCOPE) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iss: l.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), l.private_key).toString('base64url');
    const r = await doFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw bad(`Firebase sign-in failed: ${j.error_description || j.error || r.status}`, 502);
    return j.access_token;
  }

  const docUrl = (l, id) => `https://firestore.googleapis.com/v1/projects/${l.project_id}/databases/(default)/documents/${COLLECTION}/${encodeURIComponent(id)}`;

  async function push(passphrase, id = 'default') {
    const l = load(); if (!l) throw bad('Firebase is not linked yet (sm firebase link <key.json>)');
    let plain; try { plain = fs.readFileSync(intFile, 'utf8'); } catch { throw bad('no linked integrations to back up yet'); }
    const blob = encrypt(plain, passphrase);
    const t = await accessToken(l);
    const r = await doFetch(docUrl(l, id), { method: 'PATCH', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { blob: { stringValue: blob }, updatedAt: { timestampValue: new Date().toISOString() } } }) });
    if (!r.ok) throw bad(`Firestore refused the backup (${r.status}). Is Firestore enabled for ${l.project_id}?`, 502);
    return { ok: true, projectId: l.project_id, id };
  }

  async function pull(passphrase, id = 'default') {
    const l = load(); if (!l) throw bad('Firebase is not linked yet (sm firebase link <key.json>)');
    const t = await accessToken(l);
    const r = await doFetch(docUrl(l, id), { headers: { Authorization: `Bearer ${t}` } });
    if (r.status === 404) throw bad('no backup found in this Firebase project yet', 404);
    if (!r.ok) throw bad(`Firestore refused the restore (${r.status})`, 502);
    const j = await r.json();
    const plain = decrypt(j.fields?.blob?.stringValue || '', passphrase);
    JSON.parse(plain);
    fs.mkdirSync(path.dirname(intFile), { recursive: true });
    fs.writeFileSync(intFile, plain, { mode: 0o600 });
    return { ok: true, projectId: l.project_id, id };
  }

  /**
   * The Google sign-in app Firebase made for this project (Authentication → Google): its client ID and secret, so
   * the office's "Sign in with Google" works without the owner pasting any codes. null when Firebase isn't linked
   * or Google sign-in is off there.
   */
  async function googleClient() {
    const l = load(); if (!l) return null;
    const t = await accessToken(l, 'https://www.googleapis.com/auth/cloud-platform');
    const r = await doFetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${l.project_id}/defaultSupportedIdpConfigs/google.com`, { headers: { Authorization: `Bearer ${t}`, 'x-goog-user-project': l.project_id } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j.enabled && j.clientId && j.clientSecret ? { client_id: j.clientId, client_secret: j.clientSecret, project_id: l.project_id } : null;
  }

  return { status, link, unlink, push, pull, googleClient };
}

module.exports = { createFirebase, encrypt, decrypt };

'use strict';
/**
 * Calls that never reached IVY. When the office can't be reached, Twilio answers with the voicemail fallback (see
 * bin/tunnel.js) or the caller just gets busy/no-answer, and the office never hears about it. Every couple of minutes
 * this asks Twilio for recent inbound calls; any call the call log doesn't have is logged as `missed` and the owner is
 * told on Telegram, with the voicemail audio when one was left. State: office/missed-calls.json { since, seen }.
 */
const fs = require('fs');
const path = require('path');

function createMissedCalls(root, { integrations, callLog, notify, sendAudio, recognise, fetchFn = globalThis.fetch, now = () => Date.now(), isOff = () => false } = {}) {
  const I = integrations || require('./integrations.js').createIntegrations(root);
  const file = path.join(root, 'office', 'missed-calls.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 1)); };
  const e164 = (s) => { const d = String(s || '').replace(/[^\d+]/g, ''); return d ? (d.startsWith('+') ? d : `+${d}`) : ''; };

  async function check() {
    const c = I.get('sms') || {}; if (!c.account_sid || !c.auth_token) return { skipped: 'twilio not linked' };
    if (isOff()) return { skipped: 'phone line off' };
    const st = read();
    if (!st) { write({ since: new Date(now()).toISOString(), seen: [] }); return { seeded: true }; } // only calls from now on
    const auth = `Basic ${Buffer.from(`${c.account_sid}:${c.auth_token}`).toString('base64')}`;
    const base = `https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}`;
    const get = async (p) => { const r = await fetchFn(`${base}${p}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`Twilio ${r.status}`); return r.json(); };
    const j = await get(`/Calls.json?PageSize=30&StartTime%3E=${encodeURIComponent(st.since.slice(0, 10))}`);
    const known = new Set((callLog ? callLog.list({ limit: 200 }) : []).map((x) => x.callSid));
    const seen = new Set(st.seen || []); const out = [];
    for (const call of (j.calls || []).reverse()) {
      if (call.direction !== 'inbound' || Date.parse(call.start_time || call.date_created) < Date.parse(st.since)) continue;
      if (known.has(call.sid) || seen.has(call.sid)) continue;
      if (['queued', 'ringing', 'in-progress'].includes(call.status)) continue; // not over yet
      seen.add(call.sid);
      const from = e164(call.from); const who = (recognise && recognise(from)?.name) || from || 'Unknown caller';
      const at = new Date(call.start_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      let rec = null; try { rec = ((await get(`/Calls/${call.sid}/Recordings.json`)).recordings || [])[0] || null; } catch { /* none */ }
      const summary = rec ? `Voicemail (${rec.duration}s) while the office line was down.` : `Missed: the office line was down (${call.status}).`;
      if (callLog) { try { callLog.upsert({ callSid: call.sid, direction: 'in', from, callerName: recognise?.(from)?.name || '', isOwner: from === e164(c.owner_phone), outcome: rec ? 'voicemail-left' : 'missed', summary, at: new Date(call.start_time).toISOString(), endedAt: new Date(call.end_time || call.start_time).toISOString(), durationSec: Number(call.duration) || 0 }); } catch { /* log is best effort */ } }
      const isOwner = from === e164(c.owner_phone);
      const text = `📞 ${isOwner ? 'You called' : `Missed call from ${who}`} at ${at}: the office line was down${rec ? `. ${isOwner ? 'Your' : 'They left a'} voicemail is below.` : '.'}${isOwner ? '' : `\nCall back: ${from}`}`;
      try {
        if (rec && sendAudio) {
          const a = await fetchFn(`${base}/Recordings/${rec.sid}.mp3`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30000) });
          await sendAudio(Buffer.from(await a.arrayBuffer()), { caption: text, filename: `voicemail-${at.replace(':', '')}.mp3` });
        } else if (notify) await notify(text);
      } catch { if (notify) await notify(text).catch(() => {}); }
      out.push({ sid: call.sid, from, voicemail: !!rec });
    }
    write({ since: st.since, seen: [...seen].slice(-200) });
    return { missed: out };
  }
  let timer = null;
  const start = (everyMs = 120000) => { if (timer) return; timer = setInterval(() => { check().catch(() => {}); }, everyMs); timer.unref?.(); setTimeout(() => check().catch(() => {}), 10000).unref?.(); };
  return { check, start, file };
}

module.exports = { createMissedCalls };

'use strict';
/**
 * Call records for the secretary: one entry per phone call in office/calls.json (newest last, capped).
 * { id, callSid, at, endedAt, direction: 'in'|'out', from, callerName, isOwner, outcome, summary, requests[], turns, stack, durationSec }
 * Outcomes: owner-chat | request-filed | message-taken | silent | hung-up-early | error | blocked |
 * calling (outbound, ringing) | delivered (outbound answered, nobody talked) | no-answer | busy | failed | voicemail
 * Also: interrupts (times the caller cut her off), lastInterrupted, answeredBy
 */
const fs = require('fs');
const path = require('path');

const MAX = 500;
const OUTCOMES = ['owner-chat', 'request-filed', 'message-taken', 'silent', 'hung-up-early', 'error', 'blocked', 'calling', 'delivered', 'no-answer', 'busy', 'failed', 'voicemail'];

function createCallLog(root) {
  const file = path.join(root, 'office', 'calls.json');
  const read = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } };
  const write = (d) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d.slice(-MAX), null, 2) + '\n'); fs.renameSync(tmp, file); };
  /** Insert or merge by callSid (a Gather call upserts every turn). */
  function upsert(rec) {
    const d = read();
    const i = rec.callSid ? d.findIndex((x) => x.callSid === rec.callSid) : -1;
    if (i >= 0) d[i] = { ...d[i], ...rec }; else d.push({ id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...rec });
    write(d);
    return d[i >= 0 ? i : d.length - 1];
  }
  return { upsert, list: ({ limit = 50 } = {}) => read().slice(-limit).reverse(), file };
}

module.exports = { createCallLog, OUTCOMES };

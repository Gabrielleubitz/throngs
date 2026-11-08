/**
 * Account watcher — no AI. Reads `cswap list --json`, keeps the latest 5h / 7d usage numbers for the office's top bar,
 * and rotates to an account with room when the active one is (nearly) out. Pure helpers so they are testable;
 * a missing/broken cswap degrades to { available: false }, never throws.
 * SM_CSWAP_BIN overrides the binary ('none' turns it off).
 */
const { spawnSync } = require('child_process');

const LIMIT_PCT = 95;      // switch away when the active account's 5h or 7d window reaches this
const WINDOWS = ['fiveHour', 'sevenDay'];

const pctOf = (a, w) => Number(a?.usage?.[w]?.pct ?? 0);
const worst = (a) => Math.max(...WINDOWS.map((w) => pctOf(a, w)));
/**
 * Usable = cswap could read its usage ('ok') AND it is under the limit. An account whose login died
 * (usageStatus 'relogin_required', usage null) once read as 0% and was picked every minute; `cswap switch` to it failed
 * and the office ran the active account to 100% (2026-11-01).
 */
const usable = (a) => a && a.usageStatus === 'ok' && !!a.usage;
const hasRoom = (a, limit = LIMIT_PCT) => usable(a) && worst(a) < limit;
const FAIL_SKIP_MS = 30 * 60000;

/** Compact, UI-ready view of a `cswap list --json` document. */
function summarize(doc, now = Date.now()) {
  const accounts = (doc?.accounts || []).map((a) => ({
    number: a.number, email: a.email, active: !!a.active, disabled: a.usageStatus === 'disabled', needsLogin: a.usageStatus === 'relogin_required',
    fiveHour: { pct: pctOf(a, 'fiveHour'), resetsAt: a.usage?.fiveHour?.resetsAt || null, countdown: a.usage?.fiveHour?.countdown || null },
    sevenDay: { pct: pctOf(a, 'sevenDay'), resetsAt: a.usage?.sevenDay?.resetsAt || null, countdown: a.usage?.sevenDay?.countdown || null },
    ageSeconds: a.usageAgeSeconds ?? null,
  }));
  const active = accounts.find((a) => a.active) || null;
  return { available: accounts.length > 0, at: new Date(now).toISOString(), active, accounts };
}

/** What to do now: { action: 'stay' | 'switch' | 'wait', to?, until? }. */
function decide(doc, limit = LIMIT_PCT, skip = new Set()) {
  const accs = doc?.accounts || [];
  const active = accs.find((a) => a.active);
  if (!active) return { action: 'stay' };
  if (usable(active) && worst(active) < limit) return { action: 'stay' };
  if (!usable(active) && active.usageStatus !== 'relogin_required') return { action: 'stay' }; // can't read it right now: don't flap
  const spare = accs.filter((a) => !a.active && !skip.has(a.number) && hasRoom(a, limit)).sort((a, b) => worst(a) - worst(b))[0];
  if (spare) return { action: 'switch', to: spare.number };
  const resets = accs.flatMap((a) => WINDOWS.filter((w) => pctOf(a, w) >= limit).map((w) => Date.parse(a.usage[w].resetsAt))).filter(Number.isFinite);
  return { action: 'wait', until: resets.length ? new Date(Math.min(...resets)).toISOString() : null };
}

/** One line for the crew member's bubble: live usage numbers + the last account switch. */
function describe(snap, now = Date.now()) {
  if (!snap?.available) return 'No cswap accounts found';
  const a = snap.active;
  let t = a ? `#${a.number} 5h ${Math.round(a.fiveHour.pct)}% · 7d ${Math.round(a.sevenDay.pct)}%` : 'No active account';
  if (snap.waitingUntil) t += ' · all accounts full';
  if (snap.needsLogin?.length) t += ` · #${snap.needsLogin.join(', #')} needs re-login`;
  if (snap.lastError) t += ` · ${snap.lastError}`;
  const sw = snap.lastSwitch;
  if (sw) { const m = Math.max(0, Math.round((now - Date.parse(sw.at)) / 60000)); t += ` · switched #${sw.from ?? '?'}→#${sw.to} ${m < 1 ? 'just now' : `${m}m ago`}`; }
  return t;
}

/** onEvent({ kind: 'switched'|'switch-failed'|'all-full'|'relogin', ... }) — e.g. a Telegram line to the owner. */
function createWatcher({ bin = process.env.SM_CSWAP_BIN || 'cswap', limit = LIMIT_PCT, run, onEvent, now = () => Date.now() } = {}) {
  const failed = new Map(); // account number -> retry after (ms)
  const told = new Set(); // events already reported (once each until the situation changes)
  const emit = (key, e) => { if (told.has(key)) return; told.add(key); try { onEvent?.(e); } catch { /* never break the watcher */ } };
  const exec = run || ((args) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60000 }); return { status: r.status, stdout: r.stdout || '' }; });
  let last = { available: false, at: null, active: null, accounts: [], lastSwitch: null, waitingUntil: null };
  let timer = null;
  const list = () => { try { const r = exec(['list', '--json']); return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };

  /** One poll: refresh numbers, switch when the active account is out, refresh again. */
  function tick() {
    if (bin === 'none') return last;
    let doc = list();
    if (!doc) return (last = { ...last, available: false, at: new Date().toISOString() });
    for (const [n, until] of failed) if (until <= now()) failed.delete(n);
    let lastSwitch = last.lastSwitch; let lastError = null;
    let d = decide(doc, limit, new Set(failed.keys()));
    for (let tries = 0; d.action === 'switch' && tries < 3; tries++) { // a failed switch never blocks the next good account
      const from = doc.accounts.find((a) => a.active)?.number;
      const r = exec(['switch', String(d.to)]);
      const after = r.status === 0 ? list() : null;
      if (r.status === 0 && (!after || after.accounts?.find((a) => a.active)?.number === d.to)) {
        lastSwitch = { at: new Date(now()).toISOString(), from, to: d.to }; doc = after || doc;
        told.clear(); emit(`sw:${from}>${d.to}`, { kind: 'switched', from, to: d.to, email: doc.accounts.find((a) => a.number === d.to)?.email || '' });
        break;
      }
      failed.set(d.to, now() + FAIL_SKIP_MS); lastError = `switch to #${d.to} failed`;
      emit(`fail:${d.to}`, { kind: 'switch-failed', to: d.to, detail: String(r.stdout || '').trim().slice(0, 200) });
      d = decide(doc, limit, new Set(failed.keys()));
    }
    if (d.action === 'wait') emit(`full:${d.until}`, { kind: 'all-full', until: d.until });
    const needsLogin = (doc.accounts || []).filter((a) => a.usageStatus === 'relogin_required').map((a) => a.number);
    for (const n of needsLogin) emit(`relogin:${n}`, { kind: 'relogin', number: n, email: doc.accounts.find((a) => a.number === n)?.email || '' });
    last = { ...summarize(doc), lastSwitch, waitingUntil: d.action === 'wait' ? d.until : null, needsLogin, lastError };
    return last;
  }
  return {
    tick,
    snapshot: () => last,
    start(everyMs = 60000) { if (!timer) { tick(); timer = setInterval(tick, everyMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createWatcher, describe, summarize, decide, LIMIT_PCT };

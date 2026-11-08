/**
 * TRACE, the office's error-log bot (no AI). Every error that happens in the office — a failed mission or step,
 * a critical finding from ARES's watch, a crash or failed request in the office server, a UI error — is recorded here
 * (office/errors.json, repeats are merged). TRACE reports each new error to ARES; ARES does NOT start a fix until the
 * owner approves it: `approve` opens a mission for ARES with the error as the request. Fixed errors become lessons
 * in the learning box so the office does better next time.
 */
const fs = require('fs');
const path = require('path');

const MAX_ERRORS = 200;
const SWEEP_MS = 2 * 60 * 1000;
const RECENT_MS = 12 * 3600 * 1000;
const DONE = ['done', 'filed', 'reported', 'complete', 'completed'];

/** Never keep keys in the log. */
const scrub = (s) => String(s || '').replace(/(sk-[\w-]{12,}|Bearer\s+[\w.-]{12,}|AC[0-9a-f]{32}|(?:token|key|secret|password)["']?\s*[:=]\s*["']?[\w./+-]{8,})/gi, '[hidden]');
const fingerprint = (source, title) => `${source}:${String(title).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120)}`;

function createErrorLog(sm, { missions, learning } = {}) {
  const { ROOT } = sm;
  const file = path.join(ROOT, 'office', 'errors.json');
  let timer = null;
  const load = () => { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(d.errors) ? d.errors : []; } catch { return []; } };
  const save = (errors) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ errors }, null, 2) + '\n'); };

  /** Log one error. Same source+title again bumps the count (and re-opens a fixed one that came back). */
  function record({ source = 'office', title, detail = '', project = '', key = '' } = {}) {
    const t = scrub(title).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t) return null;
    const errors = load();
    const fp = key ? `${source}:${key}` : fingerprint(source, t);
    const at = new Date().toISOString();
    const hit = errors.find((e) => e.fp === fp);
    if (hit && key) return hit; // one-off event (a specific mission): logged once, in any status, never reopened
    if (hit) {
      hit.count += 1; hit.last = at; hit.detail = scrub(detail).slice(0, 2000) || hit.detail;
      if (hit.status === 'fixed') { hit.status = 'open'; hit.missionId = null; }
      save(errors); return hit;
    }
    const e = { id: `e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, fp, source: String(source).slice(0, 30), project: String(project || '').slice(0, 60), title: t, detail: scrub(detail).slice(0, 2000), status: 'open', count: 1, first: at, last: at, missionId: null };
    save([e, ...errors].slice(0, MAX_ERRORS));
    return e;
  }

  /** Mission ids that finished, per project, so approved errors can be marked fixed. */
  function missionStatus(project, id) { try { return (missions.snapshot(project) || []).find((m) => m.id === id)?.status || null; } catch { return null; } }

  function list() {
    const errors = load(); let changed = false;
    for (const e of errors) {
      if (e.status !== 'approved' || !e.missionId) continue;
      const st = missionStatus(e.project, e.missionId);
      if (st && (DONE.includes(st) || st === 'failed')) {
        e.status = st === 'failed' ? 'open' : 'fixed'; e.missionId = st === 'failed' ? null : e.missionId; changed = true;
        if (e.status === 'fixed' && learning) { try { learning.add(`Error "${e.title}" (${e.source}) was fixed by ARES after approval — check for it first if it comes back.`, { kind: 'error', source: 'trace' }); } catch { /* best effort */ } }
      }
    }
    if (changed) save(errors);
    return errors;
  }

  /** The owner said yes: ARES gets the error as a request and starts the fix. */
  function approve(id, project) {
    const errors = load();
    const e = errors.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error('No such error.'), { status: 404 });
    if (e.status === 'approved') throw Object.assign(new Error('ARES is already on this one.'), { status: 409 });
    const target = e.project || project || sm.listProjects().includes('success-manager') && 'success-manager' || sm.listProjects()[0];
    const prompt = [
      'For ARES (Floor Manager): TRACE, the office error-log bot, caught this error and the owner approved fixing it.',
      `Source: ${e.source}. Seen ${e.count}x, last ${e.last}.`,
      `Error: ${e.title}`,
      e.detail ? `Details:\n${e.detail}` : '',
      'Find the root cause and fix it in the office (smallest correct change, test it). Then save the lesson so it does not happen again: node bin/sm.js learn "<one-line lesson>" --kind error',
    ].filter(Boolean).join('\n');
    const m = missions.create(target, prompt);
    e.status = 'approved'; e.project = target; e.missionId = m.id;
    save(errors);
    return e;
  }

  function dismiss(id) {
    const errors = load();
    const e = errors.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error('No such error.'), { status: 404 });
    e.status = 'dismissed'; save(errors); return e;
  }

  /** Pick up errors the office produced on its own: failed/stalled missions and ARES's critical findings. */
  function sweep(watchFindings = []) {
    const cutoff = Date.now() - RECENT_MS;
    for (const name of sm.listProjects()) {
      let snap = []; try { snap = missions.snapshot(name) || []; } catch { /* skip */ }
      for (const m of snap) {
        if (!['failed', 'stalled'].includes(m.status) || (Date.parse(m.updatedAt || m.createdAt || 0) || 0) < cutoff) continue;
        const bad = (m.subtasks || []).find((s) => s.status === 'failed');
        record({ source: 'mission', key: m.id, project: name, title: `Mission ${m.status}: ${String(m.title || m.prompt || m.id).slice(0, 80)}`, detail: m.error || bad?.error || `Mission ${m.id} ${m.status}.` });
      }
    }
    for (const f of watchFindings) if (f.severity === 'critical') record({ source: 'watch', title: f.title, detail: f.detail });
  }

  function start(getWatch) {
    if (timer) return;
    const tick = () => { try { sweep(getWatch ? getWatch() : []); } catch { /* never crash the office */ } };
    setTimeout(tick, 5000).unref?.();
    timer = setInterval(tick, SWEEP_MS); timer.unref?.();
    // crashes in this process: the monitor event only observes, it does not change how the process dies
    process.on('uncaughtExceptionMonitor', (err) => { try { record({ source: 'server', title: `Crash: ${err?.message || err}`, detail: err?.stack }); } catch { /* ignore */ } });
  }

  /** One line for ARES's status bubble. */
  function summary() {
    const open = load().filter((e) => e.status === 'open').length;
    return open ? `TRACE reports ${open} error${open > 1 ? 's' : ''} — waiting for your OK in HEALTH` : '';
  }

  return { record, list, approve, dismiss, sweep, start, summary };
}

module.exports = { createErrorLog, scrub, fingerprint };

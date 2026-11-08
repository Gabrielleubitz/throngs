'use strict';
/**
 * Wellbeing, ported from jarvis-notch (CaffeinateService + EyeBreakService), no AI.
 * Keep-awake: a detached `caffeinate -d -i` so long missions run while the owner is away (auto-expires, pid in office/awake.json).
 * Break nudges: during work hours IVY texts a short "look away / stretch" at most every N minutes, only while the owner is
 * actively using the Mac is not checked: it is plain time-based, off by default. State: office/wellbeing.json (personal, gitignored).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULTS = { breaksOn: false, everyMin: 60, from: 9, to: 18, lastAt: 0 };

function createWellbeing(root, { now = () => Date.now(), spawnFn = spawn, alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, kill = (pid) => process.kill(pid) } = {}) {
  const sFile = path.join(root, 'office', 'wellbeing.json');
  const aFile = path.join(root, 'office', 'awake.json');
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
  const settings = () => ({ ...DEFAULTS, ...readJ(sFile, {}) });

  function awake() {
    const a = readJ(aFile, null);
    if (!a || !a.pid || !alive(a.pid) || (a.until && a.until <= now())) return { on: false };
    return { on: true, pid: a.pid, until: a.until || null };
  }
  /** Keep the Mac (and screen) awake for `hours` (default 8, max 24). */
  function awakeOn(hours = 8) {
    const h = Math.min(24, Math.max(0.1, Number(hours) || 8));
    if (awake().on) awakeOff();
    const child = spawnFn('caffeinate', ['-d', '-i', '-t', String(Math.round(h * 3600))], { detached: true, stdio: 'ignore' });
    child.unref?.();
    writeJ(aFile, { pid: child.pid, until: now() + h * 3600000 });
    return awake();
  }
  function awakeOff() {
    const a = readJ(aFile, null);
    if (a && a.pid && alive(a.pid)) { try { kill(a.pid); } catch { /* already gone */ } }
    try { fs.unlinkSync(aFile); } catch { /* none */ }
    return { on: false };
  }

  function setBreaks({ on, everyMin, from, to } = {}) {
    const s = settings();
    if (typeof on === 'boolean') s.breaksOn = on;
    if (everyMin != null) { const n = Math.round(Number(everyMin)); if (!(n >= 5 && n <= 480)) throw new Error('every must be 5-480 minutes'); s.everyMin = n; }
    if (from != null) s.from = Math.min(23, Math.max(0, Math.round(Number(from))));
    if (to != null) s.to = Math.min(24, Math.max(1, Math.round(Number(to))));
    if (s.from >= s.to) throw new Error('"from" hour must be before "to"');
    if (on === true) s.lastAt = now(); // first nudge a full interval from now
    writeJ(sFile, s); return s;
  }
  /** The nudge text if one is due (and marks it sent), else null. Mon-Fri not enforced: the owner sets the hours. */
  function breakDue() {
    const s = settings(); if (!s.breaksOn) return null;
    const hr = new Date(now()).getHours();
    if (hr < s.from || hr >= s.to) return null;
    if (now() - s.lastAt < s.everyMin * 60000) return null;
    writeJ(sFile, { ...s, lastAt: now() });
    return '👀 Break: look at something 20 feet away for 20 seconds, roll your shoulders, drink some water.';
  }
  const state = () => ({ awake: awake(), breaks: settings() });
  return { awake, awakeOn, awakeOff, setBreaks, breakDue, state };
}
module.exports = { createWellbeing };

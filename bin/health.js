/**
 * Project health board — one record per project from LATEST.md, history.log and the task store.
 * Pure parsers + rank so they are testable; missing/garbled files degrade to "unknown", never throw.
 */
const fs = require('fs');
const path = require('path');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

/** history.log run lines: `<iso>  iter=N  verdict=...  qa=a:pass,b:fail  open=N` (AUDIT lines are not runs). */
function parseHistory(text) {
  const runs = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\S+)\s+iter=(\d+)\s+verdict=(.*?)\s{2}qa=(\S*)\s+open=(\d+)/);
    if (!m) continue;
    const qa = m[4] === 'none' ? [] : m[4].split(',').filter(Boolean).map((c) => { const [name, res] = c.split(':'); return { name, pass: res === 'pass' }; });
    runs.push({ at: m[1], iter: Number(m[2]), verdict: m[3].trim(), qa, open: Number(m[5]) });
  }
  return runs;
}

/** LATEST.md: `- Time:`, `- Verdict: **X**`, and `- ✅/❌ \`cmd\`` QA lines. */
function parseLatest(text) {
  const t = String(text || '');
  const verdict = (t.match(/^- Verdict: \*\*(.+?)\*\*/m) || [])[1] || null;
  const at = (t.match(/^- Time: (\S+)/m) || [])[1] || null;
  const qa = [...t.matchAll(/^- (✅|❌) `([^`]+)`/gm)].map((m) => ({ name: m[2], pass: m[1] === '✅' }));
  return { verdict, at, qa };
}

const qaState = (qa) => (!qa || !qa.length ? 'unknown' : qa.every((c) => c.pass) ? 'pass' : 'fail');

/** GAVE UP first, then QA failing, then P0/P1 tasks, then the rest (rank 0 = look first). */
function attentionRank({ gaveUp, lastQa, openTasks }) {
  if (gaveUp) return 0;
  if (lastQa === 'fail') return 1;
  if ((openTasks?.[0] || 0) + (openTasks?.[1] || 0) > 0) return 2;
  return 3;
}

/** Count open tasks by priority 0-4. Beads issues carry `priority`; TASKS.md lines end `_(P2, from x)_`. */
function countByPriority(items) {
  const c = [0, 0, 0, 0, 0];
  for (const i of items) { const n = Number.isInteger(i) ? i : 2; c[Math.min(4, Math.max(0, n))]++; }
  return c;
}
function markdownPriorities(text) {
  return [...String(text || '').matchAll(/^\s*[-*] \[ \] (.+)$/gm)].map((m) => { const p = m[1].match(/_\(P([0-4])/); return p ? Number(p[1]) : 2; });
}

function buildRecord(name, { latestText, historyText, priorities }) {
  const runs = parseHistory(historyText);
  const lastRun = runs[runs.length - 1] || null;
  const latest = parseLatest(latestText);
  const verdict = lastRun?.verdict || latest.verdict || null;
  const qa = lastRun ? lastRun.qa : latest.qa;
  const lastQa = qaState(qa.length ? qa : latest.qa);
  const openTasks = countByPriority(priorities || []);
  const gaveUp = Boolean(verdict && verdict.startsWith('GAVE UP'));
  return { name, lastQa, qaFailing: qa.filter((c) => !c.pass).map((c) => c.name), openTasks, openTotal: openTasks.reduce((a, b) => a + b, 0),
    lastRun: lastRun?.at || latest.at || null, verdict, gaveUp, rank: attentionRank({ gaveUp, lastQa, openTasks }) };
}

const sortBoard = (rows) => [...rows].sort((a, b) => a.rank - b.rank || (b.lastRun || '').localeCompare(a.lastRun || '') || a.name.localeCompare(b.name));

/** `taskPriorities(name)` returns open-task priorities, or null to fall back to TASKS.md (api passes its cached beads snapshot). */
function createHealth(sm, { taskPriorities } = {}) {
  const { PROJECTS, listProjects } = sm;
  return function board() {
    return sortBoard(listProjects().map((name) => {
      const dir = path.join(PROJECTS, name);
      let priorities = [];
      try { priorities = (taskPriorities && taskPriorities(name)) || markdownPriorities(read(path.join(dir, 'TASKS.md'))); } catch { /* task store unreadable → zero counts */ }
      return buildRecord(name, { latestText: read(path.join(dir, 'LATEST.md')), historyText: read(path.join(dir, 'history.log')), priorities });
    }));
  };
}

module.exports = { parseHistory, parseLatest, qaState, attentionRank, countByPriority, markdownPriorities, buildRecord, sortBoard, createHealth };

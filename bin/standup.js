/**
 * Daily standup — the Floor Manager's "yesterday / today / blocked" note, built from REAL state only:
 * beads issues (closedAt / open / human labels), mission records, and each project's last QA verdict.
 * Writes standup/YYYY-MM-DD.md (one per local day, never overwritten unless forced) and standup/latest.md.
 */
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 3600 * 1000;
const ACTIVE = ['queued', 'planning', 'working', 'reviewing'];
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clip = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function createStandup(sm, { dir } = {}) {
  const { ROOT, loadProject, listProjects, usesBeads, bd, readJSON } = sm;
  const outDir = dir || path.join(ROOT, 'standup');

  /** Gather raw facts for one project. Each source is independent so one failure never hides the rest. */
  function collectProject(name, since) {
    const p = loadProject(name);
    const f = { name, closed: [], missionsDone: [], working: [], missionsActive: [], human: [], gaveUp: null, awaiting: false, notes: [] };
    try {
      if (usesBeads(p)) {
        const j = JSON.parse(bd(p, ['list', '--all', '--json', '--limit', '0']) || '[]');
        const all = (Array.isArray(j) ? j : j.issues || []).filter((i) => !(i.labels || []).includes('mission'));
        for (const i of all) {
          const labels = i.labels || [];
          const row = `${i.id}: ${i.title}`;
          if (i.status === 'closed') { const at = i.closed_at || i.closedAt; if (at && new Date(at).getTime() >= since) f.closed.push(row); continue; }
          if (labels.includes('human') || labels.includes('escalated')) f.human.push(row);
          else if (labels.includes('suggestion')) continue;
          else f.working.push(i.status === 'in_progress' ? `${row} (in progress)` : row);
        }
      } else {
        const t = sm.readTasks(p);
        f.working.push(...t.open);
        f.human.push(...(t.human || []));
      }
    } catch (e) { f.notes.push(`could not read tasks (${clip(e.message, 80)})`); }
    try {
      const md = path.join(p.dir, 'missions');
      for (const file of fs.existsSync(md) ? fs.readdirSync(md).filter((x) => /^m-[\w-]+\.json$/.test(x)) : []) {
        const m = readJSON(path.join(md, file), null);
        if (!m) continue;
        if (m.status === 'done' && m.finishedAt && new Date(m.finishedAt).getTime() >= since) f.missionsDone.push(`${clip(m.prompt, 70)} — ${m.report?.verdict || 'finished'}`);
        else if (ACTIVE.includes(m.status)) f.missionsActive.push(clip(m.prompt, 70));
        else if (m.status === 'waiting_human') f.human.push(`Mission waiting on you: ${clip(m.prompt, 70)}`);
      }
    } catch (e) { f.notes.push(`could not read missions (${clip(e.message, 80)})`); }
    const verdict = p.state?.lastVerdict;
    if (verdict && String(verdict).startsWith('GAVE UP')) f.gaveUp = verdict;
    try {
      f.awaiting = sm.overallStatus(p, p.state?.lastResults || [], { open: f.working, human: f.human }, verdict) === 'AWAITING_HUMAN_INPUT';
    } catch { /* status is optional colour, not a fact we need */ }
    return f;
  }

  function collect(now = new Date()) {
    const since = now.getTime() - DAY_MS;
    return listProjects().map((n) => { try { return collectProject(n, since); } catch (e) { return { name: n, error: e.message }; } });
  }

  /** Pure: facts → markdown. */
  function render(facts, now = new Date()) {
    const yesterday = [], today = [], blocked = [];
    for (const f of facts) {
      if (f.error) { blocked.push(`**${f.name}**: could not be read (${clip(f.error, 80)})`); continue; }
      f.closed.forEach((x) => yesterday.push(`**${f.name}**: closed ${x}`));
      f.missionsDone.forEach((x) => yesterday.push(`**${f.name}**: mission finished — ${x}`));
      f.missionsActive.forEach((x) => today.push(`**${f.name}**: mission running — ${x}`));
      f.working.forEach((x) => today.push(`**${f.name}**: ${x}`));
      f.human.forEach((x) => blocked.push(`**${f.name}**: needs you — ${x}`));
      if (f.gaveUp) blocked.push(`**${f.name}**: GAVE UP — ${f.gaveUp.replace(/^GAVE UP\s*/, '') || 'see LATEST.md'}`);
      if (f.awaiting && !f.human.length && !f.gaveUp) blocked.push(`**${f.name}**: AWAITING_HUMAN_INPUT`);
      f.notes.forEach((x) => blocked.push(`**${f.name}**: ${x}`));
    }
    const section = (title, rows, empty) => [`## ${title}`, ...(rows.length ? rows.map((r) => `- ${r}`) : [`- ${empty}`]), ''];
    return [
      `# Standup — ${dayKey(now)}`, '',
      ...section('Yesterday', yesterday, 'Nothing was closed or finished in the last 24 hours.'),
      ...section('Today', today, 'Nothing queued or running.'),
      ...section('Blocked', blocked, 'Nothing is blocked.'),
    ].join('\n');
  }

  const fileFor = (now) => path.join(outDir, `${dayKey(now)}.md`);
  const latestFile = () => path.join(outDir, 'latest.md');

  /** Write today's note unless it already exists (or force). Returns { file, text, created }. */
  function generate({ now = new Date(), force = false } = {}) {
    const file = fileFor(now);
    if (!force && fs.existsSync(file)) return { file, text: fs.readFileSync(file, 'utf8'), created: false };
    const text = render(collect(now), now);
    fs.mkdirSync(outDir, { recursive: true });
    for (const [target, body] of [[file, text], [latestFile(), text]]) {
      fs.writeFileSync(`${target}.tmp`, body);
      fs.renameSync(`${target}.tmp`, target);
    }
    return { file, text, created: true };
  }

  /** The latest note (for the office/dashboard), or null before the first one. */
  function latest() {
    try { return { text: fs.readFileSync(latestFile(), 'utf8') }; } catch { return null; }
  }

  /** Morning trigger: from `hour` local time on, make sure today's note exists. Safe to call repeatedly. */
  function startDaily({ hour = 7, everyMs = 15 * 60 * 1000 } = {}) {
    const tick = () => { try { if (new Date().getHours() >= hour) generate(); } catch (e) { console.error(`[standup] ${e.message}`); } };
    tick();
    const t = setInterval(tick, everyMs);
    t.unref();
    return t;
  }

  return { collect, render, generate, latest, startDaily, dayKey };
}

module.exports = { createStandup, dayKey };

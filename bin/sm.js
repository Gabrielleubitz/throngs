#!/usr/bin/env node
/**
 * Success Manager — keeps a Claude Code session working on a project until it is actually done.
 *
 * How it works (per managed project):
 *   - SessionStart hook  → tells Claude where its task list (TASKS.md) lives and how to use it.
 *   - Stop hook          → every time Claude stops, run the project's QA commands (plain scripts, no AI),
 *                          read TASKS.md, write a report, and if QA fails or tasks remain, block the stop
 *                          and hand the results back to the same Claude session so it keeps going.
 *   - PreToolUse guard   → Claude may edit its TASKS.md, but never its QA config, reports or hook settings.
 *
 * The project is "done" only when every QA command exits 0 AND TASKS.md has no unchecked "- [ ]" items.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const { isWorkerEditable, realish } = require('./guard-paths.js');
const PROJECTS = path.join(ROOT, 'projects');
const SELF = path.join(ROOT, 'bin', 'sm.js');
const HOOK_MARK = 'success-manager/bin/sm.js';

// ---------- helpers ----------
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => { const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(tmp, f); };
const projDir = (name) => path.join(PROJECTS, name);
const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, '-');

function loadProject(name) {
  // names come straight from HTTP query/body values: never let one walk out of projects/
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw Object.assign(new Error(`Unknown project "${name}". Run: sm list`), { status: 404 });
  const dir = projDir(name);
  const config = readJSON(path.join(dir, 'config.json'), null);
  if (!config) throw new Error(`Unknown project "${name}". Run: sm list`);
  const state = readJSON(path.join(dir, 'state.json'), {});
  return { name, dir, config, state };
}
function saveState(p) {
  // QA runs take minutes; never let a slow writer drop a newer audit saved meanwhile.
  const file = path.join(p.dir, 'state.json');
  const cur = readJSON(file, {});
  if (cur.lastAudit && (!p.state.lastAudit || cur.lastAudit.at > p.state.lastAudit.at)) p.state.lastAudit = cur.lastAudit;
  writeJSON(file, p.state);
}

function notify(title, message) {
  if (process.platform !== 'darwin') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  spawnSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]);
}

function tail(text, lines) {
  const arr = String(text || '').trimEnd().split('\n');
  return arr.length > lines ? ['…', ...arr.slice(-lines)].join('\n') : arr.join('\n');
}

// ---------- QA detection ----------
const hasLat = (projectPath) => fs.existsSync(path.join(projectPath, 'lat.md')) && fs.statSync(path.join(projectPath, 'lat.md')).isDirectory();
const latNote = (projectPath) => (hasLat(projectPath)
  ? `This project keeps its specs and design decisions in a lat.md knowledge graph (\`lat.md/\` folder, [[wiki-links]], \`// @lat:\` code annotations). Read the relevant sections there first (\`lat locate\`, \`lat section\`, \`lat search\` if available).`
  : '');
const hasTool = (bin) => spawnSync('/bin/zsh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;

function detectQA(projectPath, nested = false) {
  const cmds = [];
  const pkg = readJSON(path.join(projectPath, 'package.json'), null);
  if (pkg) {
    const pm = fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml')) ? 'pnpm'
      : fs.existsSync(path.join(projectPath, 'yarn.lock')) ? 'yarn' : 'npm';
    const s = pkg.scripts || {};
    for (const key of ['typecheck', 'type-check', 'lint', 'test', 'build']) {
      if (!s[key]) continue;
      if (key === 'test' && /no test specified/.test(s[key])) continue;
      const run = pm === 'npm' ? (key === 'test' ? 'npm test' : `npm run ${key}`) : `${pm} ${key}`;
      cmds.push({ name: key, run: key === 'test' && pm === 'npm' ? 'CI=1 npm test' : run, timeoutSec: 900 });
    }
  }
  const entries = fs.readdirSync(projectPath);
  const xcodeproj = entries.find((e) => e.endsWith('.xcodeproj'));
  if (xcodeproj && !pkg) {
    const scheme = xcodeproj.replace(/\.xcodeproj$/, '');
    cmds.push({
      name: 'xcode-test',
      run: `xcodebuild test -project "${xcodeproj}" -scheme "${scheme}" -destination 'platform=iOS Simulator,name=iPhone 16' -quiet`,
      timeoutSec: 2400,
    });
  }
  // Only tools that are actually installed — a QA command that can never run would fail every mission.
  const missing = [];
  const want = (cond, bin, cmd) => { if (!cond) return; if (hasTool(bin)) cmds.push(cmd); else missing.push(bin); };
  want(entries.includes('Cargo.toml'), 'cargo', { name: 'cargo-test', run: 'cargo test', timeoutSec: 1200 });
  want(entries.includes('pyproject.toml') || entries.includes('pytest.ini'), 'pytest', { name: 'pytest', run: 'python3 -m pytest -q', timeoutSec: 1200 });
  want(entries.includes('go.mod'), 'go', { name: 'go-test', run: 'go test ./...', timeoutSec: 1200 });
  if (missing.length && !nested) console.log(`   (skipped QA for ${missing.join(', ')} — not installed on this Mac)`);
  // lat.md knowledge graph (github.com/vercel-labs/lat.md): `lat check` verifies links and that specs which
  // require code references actually have them — a deterministic, non-AI gate.
  if (hasLat(projectPath)) cmds.push({ name: 'lat-check', run: 'lat check', timeoutSec: 300 });
  // A folder that holds several apps (web/, api/, …): give each app its own QA command.
  if (!cmds.length && !nested) {
    for (const e of fs.readdirSync(projectPath, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      for (const c of detectQA(path.join(projectPath, e.name), true)) {
        cmds.push({ ...c, name: `${e.name}:${c.name}`, run: `cd ${JSON.stringify(e.name)} && ${c.run}` });
      }
      if (cmds.length >= 8) break;
    }
  }
  return cmds;
}

// ---------- QA run ----------
function fingerprint(projectPath) {
  try {
    const head = execFileSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const diff = execFileSync('git', ['-C', projectPath, 'diff', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    const untracked = execFileSync('git', ['-C', projectPath, 'ls-files', '--others', '--exclude-standard'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const h = crypto.createHash('sha1').update(head).update(diff).update(untracked);
    for (const f of untracked.split('\n').filter(Boolean)) {
      try { h.update(fs.readFileSync(path.join(projectPath, f))); } catch {}
    }
    return h.digest('hex');
  } catch {
    return null; // not a git repo → always re-run QA
  }
}

function runQA(p) {
  const results = [];
  for (const c of p.config.qa) {
    const started = Date.now();
    const r = spawnSync('/bin/zsh', ['-lc', c.run], {
      cwd: p.config.path,
      encoding: 'utf8',
      timeout: (c.timeoutSec || 900) * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    results.push({
      name: c.name,
      run: c.run,
      ok: r.status === 0 && !timedOut,
      code: timedOut ? 'TIMEOUT' : r.status,
      seconds: Math.round((Date.now() - started) / 1000),
      output: tail(`${r.stdout || ''}\n${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, ''), 80),
    });
  }
  return results;
}

const usesBeads = (p) => p.config.tracker === 'beads';
let _missions = null;
const missions = () => (_missions ||= require('./missions.js').createMissions(module.exports));

/** `sm office --check [--screenshot /tmp/x.png]`: is the LIVE office healthy and current? Exit 1 if not. */
/** Is Playwright's own "Chrome for Testing" installed (so test browsers don't use the owner's Chrome app)? */
function hasTestBrowser() {
  const cache = path.join(require('os').homedir(), 'Library', 'Caches', 'ms-playwright');
  try { return fs.readdirSync(cache).some((d) => /^chromium-\d+$/.test(d) && fs.existsSync(path.join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app'))); } catch { return false; }
}

async function officeCheck(port, screenshot, waitSec = 8) {
  const os = require('os');
  let token = '';
  try { token = fs.readFileSync(path.join(os.homedir(), '.pixel-agents', 'standalone-token'), 'utf8').trim(); } catch { /* none */ }
  const base = `http://127.0.0.1:${port}`;
  const get = async (p) => { const r = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → HTTP ${r.status} ${j.error || ''}`); return j; };
  let failed = 0;
  const ok = (label) => console.log(`ok   ${label}`);
  const bad = (label, e) => { failed++; console.log(`FAIL ${label}: ${e.message || e}`); };
  try { await get('/api/health'); ok('office is running'); } catch (e) { bad('office is running', e); console.log('→ start it with: sm office --build --restart --no-open'); process.exitCode = 1; return; }
  // the running server must be the CURRENT build (a stale process once hid every change)
  const pid = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const started = pid ? new Date(spawnSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8' }).stdout.trim()) : null;
  const built = fs.statSync(path.join(ROOT, 'pixel-office', 'dist', 'cli.js')).mtime;
  if (started && started < built) bad('running server is current', new Error(`started ${started.toLocaleTimeString()} but built ${built.toLocaleTimeString()} — run sm office --build --restart --no-open`));
  else ok('running server is the current build');
  try { await get('/sm/enabled'); ok('Success Manager bridge'); } catch (e) { bad('Success Manager bridge', e); }
  for (const name of listProjects()) {
    try {
      const s = await get(`/sm/state?project=${encodeURIComponent(name)}`);
      for (const k of ['agents', 'tasks', 'missions', 'staff', 'ideas']) if (!(k in s)) throw new Error(`missing "${k}"`);
      ok(`state(${name}) · ${s.agents.length} crew · ${s.missions.length} missions`);
    } catch (e) { bad(`state(${name})`, e); }
  }
  // The phone line: tunnel connected, Twilio pointing at it (with the voicemail fallback), reachable from outside.
  try {
    const T = require('./tunnel.js'); const h = await T.createTunnel(ROOT).health();
    if (!h.up) throw new Error(`${h.reason} — the office restarts it within 2 minutes, or run sm tunnel --fix`);
    const c = require('./integrations.js').createIntegrations(ROOT).get('sms') || {};
    const auth = `Basic ${Buffer.from(`${c.account_sid}:${c.auth_token}`).toString('base64')}`;
    const n = await (await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}/IncomingPhoneNumbers/${c.from_number}.json`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(10000) })).json();
    if (n.voice_url !== `https://${h.hostname}/ares/voice`) throw new Error(`Twilio still points at ${String(n.voice_url).replace(/^https:\/\//, '')}`);
    const probe = await fetch(`https://${h.hostname}/ares/voice`, { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000) });
    if (probe.status !== 403) throw new Error(`public address answered ${probe.status}, expected the office (403 to an unsigned test)`);
    ok(`phone line · ${h.hostname} · Twilio points here${n.voice_fallback_url === T.FALLBACK_URL ? ' · voicemail fallback on' : ' · NO voicemail fallback yet'}`);
  } catch (e) { bad('phone line', e); }
  // IVY's day: the dev pulse, the desk with reminders + brief settings, and a brief preview
  try { const pl = await get('/sm/pulse'); if (!Array.isArray(pl.repos) || !Array.isArray(pl.attention)) throw new Error('bad shape'); ok(`dev pulse · ${pl.repos.length} repos · ${pl.attention.filter((x) => x.level <= 2).length} need attention${pl.github?.error ? ` · ${pl.github.error}` : ''}`); } catch (e) { bad('dev pulse', e); }
  try { const sec = await get('/sm/secretary'); if (!sec.brief || !Array.isArray(sec.reminders)) throw new Error('no brief/reminders'); ok(`IVY desk · brief ${sec.brief.briefOn ? `daily ${sec.brief.briefTime}` : 'off'} · ${sec.reminders.length} reminder(s)`); } catch (e) { bad('IVY desk', e); }
  try { const r = await fetch(`${base}/sm/secretary/previewBrief`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: '{}', signal: AbortSignal.timeout(15000) }); const b = await r.json(); if (!r.ok || !/^Good morning/.test(b.text || '')) throw new Error(b.error || 'no brief'); ok('morning brief renders'); } catch (e) { bad('morning brief', e); }
  if (screenshot) {
    const sess = `sm-check-${process.pid}`;
    const pw = (a) => spawnSync('playwright-cli', [`-s=${sess}`, ...a], { encoding: 'utf8', timeout: 60000 });
    pw(['open', `${base}/?token=${encodeURIComponent(token)}`]);
    pw(['resize', '1600', '960']);
    await new Promise((r) => setTimeout(r, Math.min(120, Math.max(1, Number(waitSec) || 8)) * 1000)); // --wait N: let the crew settle
    pw(['screenshot', '--filename', path.resolve(String(screenshot))]);
    const errs = pw(['--raw', 'console', 'error']).stdout.split('\n').filter((l) => l.startsWith('[ERROR]') && !/favicon/.test(l));
    pw(['close']);
    if (errs.length) bad('browser console', new Error(errs.slice(0, 3).join(' | '))); else ok('browser console has no errors');
    console.log(`screenshot: ${path.resolve(String(screenshot))} (open it with the Read tool to look at the office)`);
  }
  console.log(failed ? `\n${failed} problem(s)` : '\nThe live office is healthy.');
  process.exitCode = failed ? 1 : 0;
}

// "Explain it like I'm 5" for human tasks — read by sm-api.js and shown in the office.
function saveAsk(p, id, ask) {
  const file = path.join(p.dir, 'asks.json');
  const all = readJSON(file, {});
  all[id] = { ...ask, updatedAt: now() };
  writeJSON(file, all);
}

function bd(p, args) {
  const r = spawnSync('bd', args, { cwd: p.config.path, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`bd ${args.join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
  return r.stdout;
}

// Tasks labelled "human" (beads label, or "#human" in TASKS.md) need a person — e.g. testing on a real device.
// They're shown in reports but never block completion and Claude is told not to close them.
const HUMAN = 'human';
// Tasks labelled "suggestion" are subjective reviewer opinions (P3-4): listed, optional, never block "done".
const SUGGESTION = 'suggestion';

function readTasks(p) {
  if (usesBeads(p)) {
    const rows = (out) => { const j = JSON.parse(out || '[]'); return Array.isArray(j) ? j : j.issues || []; };
    // Floor Manager mission issues are tracked by their mission, not the project backlog.
    const notMission = (i) => !(i.labels || []).includes('mission');
    const all = rows(bd(p, ['list', '--all', '--json', '--limit', '0'])).filter(notMission);
    const ready = rows(bd(p, ['ready', '--json', '--limit', '0'])).filter(notMission);
    const has = (l) => (i) => (i.labels || []).includes(l);
    // "escalated" = the builder says it's blocked on something only a person can provide (it adds a bd note why).
    const isHuman = (i) => has(HUMAN)(i) || has('escalated')(i), isSuggestion = has(SUGGESTION);
    const blocking = (i) => !isHuman(i) && !isSuggestion(i);
    const label = (i) => `${i.id}: ${i.title}${i.status !== 'open' ? ` (${i.status})` : ''}`;
    const notClosed = all.filter((i) => i.status !== 'closed');
    return {
      open: notClosed.filter(blocking).map(label),
      human: notClosed.filter(isHuman).map(label),
      suggestions: notClosed.filter((i) => isSuggestion(i) && !isHuman(i)).map(label),
      done: all.filter((i) => i.status === 'closed').map(label),
      closedIds: all.filter((i) => i.status === 'closed').map((i) => i.id),
      ready: ready.filter(blocking).map(label),
      titles: all.map((i) => i.title),
      openTitles: notClosed.map((i) => i.title),
    };
  }
  const file = path.join(p.dir, 'TASKS.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const unchecked = [...text.matchAll(/^\s*[-*] \[ \] (.+)$/gm)].map((m) => m[1].trim());
  const done = [...text.matchAll(/^\s*[-*] \[[xX]\] (.+)$/gm)].map((m) => m[1].trim());
  return {
    open: unchecked.filter((t) => !t.includes(`#${HUMAN}`) && !t.includes(`#${SUGGESTION}`)),
    human: unchecked.filter((t) => t.includes(`#${HUMAN}`)),
    suggestions: unchecked.filter((t) => t.includes(`#${SUGGESTION}`) && !t.includes(`#${HUMAN}`)),
    done,
    closedIds: done,
    titles: [...unchecked, ...done].map((t) => t.replace(/ _\(P\d.*$/, '')),
    openTitles: unchecked.map((t) => t.replace(/ _\(P\d.*$/, '')),
  };
}

function addTask(p, { title, priority = 2, description, source = 'manual', human = false, labels: extra = [] }) {
  if (usesBeads(p)) {
    const labels = [`src:${source}`, ...(human ? [HUMAN] : []), ...extra].join(',');
    const args = ['create', title, '-p', String(priority), '--labels', labels, '--json'];
    if (description) args.push('--description', description);
    return JSON.parse(bd(p, args)).id;
  }
  const file = path.join(p.dir, 'TASKS.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# ${p.name} — tasks\n\n## Tasks\n\n## Log\n`;
  const line = `- [ ] ${title} _(P${priority}, from ${source})_${human ? ` #${HUMAN}` : ''}${extra.map((l) => ` #${l}`).join('')}${description ? `\n  ${description.replace(/^(\s*[-*]) \[([ xX])\]/gm, '$1 ($2)').replace(/\n/g, '\n  ')}` : ''}`; // a checklist inside a description must not become real tasks
  const at = text.indexOf('\n## Log');
  fs.writeFileSync(file, at === -1 ? `${text.trimEnd()}\n${line}\n` : `${text.slice(0, at).trimEnd()}\n${line}\n${text.slice(at)}`);
  return title;
}

function writeReport(p, results, tasks, verdict) {
  const lines = [
    `# QA report — ${p.name}`,
    ``,
    `- Time: ${now()}`,
    `- Verdict: **${verdict}**`,
    `- Iteration: ${p.state.iterations || 0} / ${p.config.maxIterations}`,
    `- Tasks: ${tasks.done.length} done, ${tasks.open.length} open for Claude, ${tasks.human?.length || 0} waiting on a human`,
    ``,
    `## QA commands`,
    ...results.map((r) => `- ${r.ok ? '✅' : '❌'} \`${r.name}\` (exit ${r.code}, ${r.seconds}s)`),
  ];
  for (const r of results.filter((x) => !x.ok)) {
    lines.push('', `### ❌ ${r.name}`, '```', `$ ${r.run}`, r.output, '```');
  }
  if (tasks.ready?.length) lines.push('', '## Ready now (unblocked)', ...tasks.ready.map((t) => `- ${t}`));
  if (tasks.open.length) lines.push('', '## Open tasks', ...tasks.open.map((t) => `- [ ] ${t}`));
  if (tasks.closedThisRound?.length) lines.push('', '## Closed since last check (audit these)', ...tasks.closedThisRound.map((t) => `- ${t}`));
  if (tasks.human?.length) lines.push('', '## Waiting on a human (not Claude\'s to close)', ...tasks.human.map((t) => `- ${t}`));
  if (tasks.suggestions?.length) lines.push('', '## Optional suggestions (reviewer opinions — do after required work, never blocking)', ...tasks.suggestions.map((t) => `- ${t}`));
  const md = lines.join('\n') + '\n';
  const reports = path.join(p.dir, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, `${stamp()}.md`), md);
  fs.writeFileSync(path.join(p.dir, 'LATEST.md'), md);
  fs.appendFileSync(path.join(p.dir, 'history.log'),
    `${now()}  iter=${p.state.iterations || 0}  verdict=${verdict}  qa=${results.map((r) => `${r.name}:${r.ok ? 'pass' : 'FAIL'}`).join(',') || 'none'}  open=${tasks.open.length}\n`);
  // keep the last 50 reports
  const all = fs.readdirSync(reports).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 50))) fs.rmSync(path.join(reports, f));
  return md;
}

// ---------- hooks ----------
async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

// Reviewer Claudes run inside the project folder too; the supervisor hooks must ignore them.
const IS_AUDITOR = process.env.SM_ROLE === 'auditor';
// Mission builders: QA still gates their stop, but the project's task list is not theirs to finish.
const IS_MISSION = process.env.SM_ROLE === 'mission';
// Launched by the success manager (sm run / dispatch / missions / reviewers)? Only those are policed by
// the guard — your own interactive Claude sessions never are.
const IS_SM_WORKER = Boolean(process.env.SM_ROLE);
// Never supervise the supervisor: a project that contains success-manager itself (e.g. your Projects
// folder) gets no Stop/SessionStart enforcement for interactive sessions.
const containsSupervisor = (p) => { const a = path.resolve(p.config.path) + path.sep; return (ROOT + path.sep).startsWith(a); };

/**
 * Registered projects can nest (e.g. the whole Projects folder AND success-manager inside it). Claude Code runs the
 * hooks of every enclosing folder, so the OUTER project's guard/QA used to fire for work inside the inner one — and
 * one refusal wins. The most specific project containing the session's folder is the one in charge; others stand aside.
 */
function deferToInnerProject(p, cwd) {
  let here; try { here = realish(cwd || process.cwd()); } catch { return false; }
  let mine; try { mine = realish(p.config.path); } catch { return false; }
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  if (!inside(here, mine)) return false;
  for (const name of listProjects()) {
    if (name === p.name) continue;
    let q; try { q = realish(loadProject(name).config.path); } catch { continue; }
    if (q !== mine && inside(q, mine) && inside(here, q)) return true; // a deeper project owns this folder
  }
  return false;
}

async function hookSessionStart(name) {
  const input = await readStdin();
  const p = loadProject(name);
  if (!p.config.active || IS_AUDITOR || IS_MISSION) return; // mission workers get their job in the prompt
  if (deferToInnerProject(p, input.cwd)) return;
  if (!IS_SM_WORKER && containsSupervisor(p)) return;
  const tasksFile = path.join(p.dir, 'TASKS.md');
  const latest = path.join(p.dir, 'LATEST.md');
  const qa = p.config.qa.map((c) => `  - ${c.name}: \`${c.run}\``).join('\n') || '  - (none configured)';
  const taskRules = usesBeads(p)
    ? [
      `- Tasks are tracked with beads (\`bd\`) in this repo. They are the source of truth for what "done" means.`,
      `  - \`bd ready --json\` → pick the highest-priority unblocked issue; \`bd update <id> --status in_progress\` before starting.`,
      `  - Skip issues labelled "${HUMAN}" — they need a person (e.g. real-device testing). Never close them.`,
      `  - Issues labelled "${SUGGESTION}" are optional reviewer opinions: only after all other work, and close with a reason if you decide against one.`,
      `  - When it is truly finished: \`bd close <id> --reason "<what you changed>"\`. Never close unfinished work.`,
      `  - Issues labelled src:* came from the user or their tools. Don't delete, retitle or reprioritise them.`,
      `  - Truly blocked on something only a person can provide (real-device data, credentials, a product decision)? Write the ask like the user is 5 years old, as a note, then label it and move on:`,
      `    \`bd note <id> $'ASK:\\nwhat: <one sentence>\\nwhy: <why only a human can>\\nstep: <tiny step>\\nstep: <tiny step>\\ndone: <how they know it is done>\\nreply: <what to type back>'\` then \`bd label add <id> escalated\`.`,
      `    Never use it to dodge hard work — the user reviews every escalation.`,
      `  - New necessary work you discover: \`bd create "<title>" -p <0-4> --deps discovered-from:<id> --json\`.`,
      `  - Big tasks: break them into smaller issues linked with --deps so blocked work is explicit.`,
    ]
    : [
      `- Your task list is ${tasksFile}. It is the source of truth for what "done" means.`,
      `  - When you finish a task, tick it ("- [x]") and add one line under "## Log" saying what you changed.`,
      `  - If you discover necessary new work, add it as a new "- [ ]" item. Never tick an item that isn't truly finished.`,
      `  - Skip items tagged #${HUMAN} — they need a person. Never tick them. Don't delete or reword items you didn't add.`,
    ];
  process.stdout.write([
    `## Success Manager is supervising this project ("${p.name}")`,
    ...taskRules,
    `- Whenever you stop, an independent QA script runs automatically:`,
    qa,
    `- If QA fails or tasks remain unchecked, you will be sent the results and must keep working.`,
    hasLat(p.config.path) ? `- ${latNote(p.config.path)} When you change behaviour, update the matching lat.md section and its links in the same change — \`lat check\` is part of QA.` : '',
    `- Do not edit anything else in ${p.dir} (config, reports) — those belong to the QA supervisor.`,
    fs.existsSync(latest) ? `- Last QA report: ${latest}` : '',
  ].filter(Boolean).join('\n') + '\n');
}

async function hookStop(name) {
  const input = await readStdin();
  const p = loadProject(name);
  if (!p.config.active || IS_AUDITOR) return; // paused → behave like normal Claude
  if (deferToInnerProject(p, input.cwd)) return;
  if (!IS_SM_WORKER && containsSupervisor(p)) return;

  if (IS_MISSION) return missionStop(p, input);
  const tasks = readTasks(p);
  const prevClosed = new Set(p.state.closedIds || tasks.closedIds);
  tasks.closedThisRound = tasks.done.filter((t, i) => !prevClosed.has(tasks.closedIds[i]));
  p.state.closedIds = tasks.closedIds;
  const fp = fingerprint(p.config.path);
  let results;
  if (fp && fp === p.state.lastFingerprint && p.state.lastResults) {
    results = p.state.lastResults; // nothing changed since last QA run
  } else {
    results = runQA(p);
  }
  const qaOk = results.every((r) => r.ok);
  p.state.iterations = (p.state.iterations || 0) + 1;
  p.state.lastFingerprint = fp;
  p.state.lastResults = results;
  p.state.lastSession = input.session_id || p.state.lastSession;
  p.state.lastRun = now();

  // Detect "stuck": identical failure signature N times in a row.
  const sig = crypto.createHash('sha1').update(JSON.stringify([results.map((r) => [r.name, r.ok, r.output]), tasks.open])).digest('hex');
  p.state.sameCount = sig === p.state.lastSig ? (p.state.sameCount || 0) + 1 : 1;
  p.state.lastSig = sig;

  let verdict;
  if (qaOk && tasks.open.length === 0) verdict = 'COMPLETE';
  else if (p.state.iterations >= p.config.maxIterations) verdict = 'GAVE UP (iteration limit)';
  else if (p.state.sameCount >= p.config.maxSameResult) verdict = 'GAVE UP (no progress)';
  else verdict = 'CONTINUE';

  const report = writeReport(p, results, tasks, verdict);
  p.state.lastVerdict = verdict;
  if (verdict !== 'CONTINUE') p.state.iterations = 0, p.state.sameCount = 0;
  writeStatus(p, results, tasks, verdict);
  saveState(p);

  if (verdict === 'COMPLETE') {
    notify(`✅ ${p.name}`, `Claude's work is done, QA green${tasks.human.length ? ` — ${tasks.human.length} task(s) waiting on you` : ''}`);
    return;
  }
  if (verdict.startsWith('GAVE UP')) {
    notify(`⚠️ ${p.name} needs you`, `${verdict}. See success-manager/projects/${p.name}/LATEST.md`);
    return;
  }

  const where = usesBeads(p) ? '`bd ready --json`' : path.join(p.dir, 'TASKS.md');
  const reason = [
    `[Success Manager] Not done yet — keep working. Independent QA result:`,
    '',
    report,
    qaOk
      ? `QA is green. Continue with the next open task from ${where} and mark it done when finished.`
      : `Fix the failing QA command(s) above first (find the root cause; do not weaken, skip or delete tests to make them pass). Then continue with the open tasks from ${where}.`,
  ].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/**
 * Stop hook for a mission worker: QA only. It must NOT touch the project's own status, verdict, report or
 * closed-task bookkeeping — a mission job knows nothing about the project's task list, so writing those
 * (as if open=[]) used to flip the project to "COMPLETE" behind the owner's back.
 */
function missionStop(p, input) {
  const fp = fingerprint(p.config.path);
  const results = fp && fp === p.state.lastFingerprint && p.state.lastResults ? p.state.lastResults : runQA(p);
  const fresh = loadProject(p.name); // only cache the QA facts; everything else stays as the project had it
  fresh.state.lastFingerprint = fp;
  fresh.state.lastResults = results;
  const failed = results.filter((r) => !r.ok);
  const sig = failed.length ? crypto.createHash('sha1').update(JSON.stringify(failed.map((r) => [r.name, r.output]))).digest('hex') : '';
  const key = input.session_id || 'mission';
  const tries = (fresh.state.missionStops ||= {});
  tries[key] = sig && tries[key]?.sig === sig ? { sig, n: tries[key].n + 1, at: now() } : { sig, n: 1, at: now() };
  for (const [k, v] of Object.entries(tries)) if (Date.now() - Date.parse(v.at) > 86_400_000) delete tries[k];
  saveState(fresh);
  if (!failed.length) return;
  if (tries[key].n > (p.config.maxSameResult || 3)) return; // same failure again and again: stop and let the mission's review report it
  const reason = [
    '[Success Manager] Independent QA is failing — fix it before you finish (find the root cause; never weaken, skip or delete tests):',
    '', ...failed.map((r) => `✗ ${r.name}: ${r.run}\n${tail(r.output || '', 40)}`),
  ].join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

const gitTop = (dir) => { const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }); return r.status === 0 ? fs.realpathSync(r.stdout.trim()) : null; };
const within = (dir, base) => dir === base || dir.startsWith(base + path.sep);
/**
 * May this `git push` run? Only into the repo of the folder the owner selected (or a repo inside it), to that
 * repo's own configured remote, never forced — plus any repo the owner named in the request
 * (SM_PUSH_EXTRA, set by the mission runner) or listed in the project's `pushRepos`.
 * Returns the reason to deny, or '' to allow.
 */
/** The few office tools any worker may call: one plain `[node …/]sm[.js] terminal|voiceover …`, nothing chained. */
const OWNER_TOOLS = /^\s*(node\s+\S*\/)?(sm|sm\.js|\S*\/bin\/sm\.js)\s+(terminal|voiceover)\s[^;&|`$]*$/;
/** Interactive sign-ins `sm terminal` may open for the owner — nothing else. */
const LOGIN_CMD = /^(npx\s+)?(firebase\s+login(:add)?|gcloud\s+auth\s+(application-default\s+)?login|gh\s+auth\s+login|vercel\s+login|eas\s+login|expo\s+login|npm\s+login|stripe\s+login|supabase\s+login|cswap\s+add|claude\s+\/?login)(\s+[\w@.:=\/-]+)*$/;

function pushVerdict(c, cwd, p) {
  if (p.config.fullAccess !== true && p.config.allowPush !== true) return 'pushing needs full access for this project (Team access → yes), or: sm set <project> allowPush true.';
  if (p.config.allowPush === false) return 'the owner turned pushing off for this project (sm set <project> allowPush true to turn it back on).';
  if (/\s(-f|--force|--force-with-lease|--mirror|--delete|-d)\b|\s\+\S+:/.test(c)) return 'force-push / mirror / deleting remote branches can destroy published history — reserved for the owner.';
  // which repo does this push run in? `git -C <dir> push`, `cd <dir> && … git push`, else the tool's cwd
  const unq = (x) => x.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/|$)/, require('os').homedir());
  const cdM = [...c.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)/g)].pop();
  const gM = c.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  let dir = cwd;
  if (cdM) dir = path.resolve(dir, unq(cdM[1]));
  if (gM) dir = path.resolve(dir, unq(gM[1]));
  const top = gitTop(dir);
  if (!top) return `could not tell which git repo "${dir}" is — run the push from inside the project's repo.`;
  const bases = [process.env.SM_PUSH_ROOT || p.config.path, ...(p.config.pushRepos || []), ...String(process.env.SM_PUSH_EXTRA || '').split(path.delimiter)]
    .filter(Boolean).map((b) => { try { return fs.realpathSync(b); } catch { return null; } }).filter(Boolean);
  const ok = bases.some((b) => top === gitTop(b) || within(top, b));
  if (!ok) return `you may only push the repo of the selected folder (${process.env.SM_PUSH_ROOT || p.config.path}); ${top} is a different repo. The owner has to name it in the request to allow it.`;
  // the remote must be one this repo already has configured — no pushing the code to some other URL
  const args = c.slice(c.search(/\bpush\b/) + 4).split(/[;&|]/)[0].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
  const remotes = spawnSync('git', ['-C', top, 'remote'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  if (args[0] && !remotes.includes(args[0])) return `"${args[0]}" is not a remote of ${top} (it has: ${remotes.join(', ') || 'none'}). Push only to the repo's own remote.`;
  return '';
}

/**
 * May this Firebase CLI call run? The CLI's default login is whatever the owner last signed in with (once the
 * bloom-booking account), so a project that sets `firebaseAccount` must name it on every call: `--account <it>`.
 * Signing in/out or switching the CLI's account is the owner's. Returns the reason to deny, or '' to allow.
 */
function firebaseVerdict(c, p) {
  const calls = [...c.matchAll(/(?:^|[;&|(]\s*|\bnpx\s+(?:-y\s+)?)(?:firebase(?:-tools)?)\s+([^;&|]*)/g)].map((m) => m[1]);
  if (!calls.length) return '';
  if (calls.some((a) => /^(login(?!:list)|logout)\b/.test(a))) return 'signing the Firebase CLI in or out (or switching its account) is the owner\'s job.';
  const acct = p.config.firebaseAccount;
  if (!acct) return '';
  const bad = calls.find((a) => !/^(--version|-V|help|login:list)\b/.test(a) && (a.match(/--account[=\s]+(\S+)/) || [])[1] !== acct);
  return bad === undefined ? '' : `this project's Firebase account is ${acct} — add \`--account ${acct}\` to every firebase command (the CLI's default login may be another client's).`;
}

/** rtk's rewrite of a shell command (e.g. `git status` → `rtk git status`), or null when rtk is absent / has nothing to add. */
function rtkRewrite(command) {
  if (process.env.SM_NO_RTK || !/\S/.test(command)) return null;
  try {
    // exit 0 = rewrite (allowed), 3 = rewrite (approval left to the host — our guard already checked it); 1/2 = leave it
    const r = spawnSync('rtk', ['rewrite', command], { encoding: 'utf8', timeout: 3000 });
    const out = (r.status === 0 || r.status === 3 ? r.stdout : '').trim();
    return out && out !== command.trim() && out.includes('rtk') ? out : null;
  } catch { return null; }
}

async function hookGuard(name) {
  const input = await readStdin();
  if (!IS_SM_WORKER) return;
  const p = loadProject(name);
  if (deferToInnerProject(p, input.cwd)) return;
  const ti = input.tool_input || {};
  const deny = (why) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Success Manager: ${why}` },
  }));

  // The selected project IS the office (success-manager itself): that is office work, whatever flags the session got.
  const officeProject = (() => { try { return realish(p.config.path) === realish(ROOT); } catch { return false; } })();
  const officeEdit = Boolean(process.env.SM_OFFICE_EDIT) || (officeProject && !IS_AUDITOR);
  if (typeof ti.command === 'string') {
    // Shell: keep the worker from rewriting its own scorecard.
    const c = ti.command;
    if (process.env.SM_OFFICE_MISSION || officeEdit || officeProject) {
      // Office mission: the office's code is fair game, its records and QA settings are not.
      if (/success-manager\/projects\/|(^|[\s'"])projects\/[^\s]*\/(config|state)\.json|\bsm(\.js)?\s+(set|set-qa|pause|resume|remove|reinstall|ask|hook|add)\b/.test(c)) return deny('mission records and QA settings are off-limits, even on office missions.');
      // Live testing goes through `sm office --build --restart --no-open` and `sm office --check` only. Launching
      // or killing office processes by hand once grabbed the port and silently hid every later change.
      if (/\bsm(\.js)?\s+office\b/.test(c) && !/--check\b|--restart\b|--browse\b/.test(c)) return deny('use `sm office --build --restart --no-open` to restart, `sm office --browse <session>` to click through it, and `sm office --check` to test the live office.');
      // Only hand-launching or killing the office SERVER is off-limits (a stray server once held the port and hid
      // every later change). Anything else that mentions pixel-agents, ports or processes is fine.
      if (/node\s+\S*dist\/cli\.js|npx\s+pixel-agents|(kill|pkill)\b.*(4777|cli\.js|pixel-agents)/.test(c)) return deny('restart the office only with `sm office --build --restart --no-open` (then `sm office --check`).');
      if (/standalone-token/.test(c)) return deny('the office login token stays private — open the office with `sm office --browse <session>` instead.');
    } else if (/success-manager|\bsm\.js\b|(^|[;&|]\s*)sm\s/.test(c) && !OWNER_TOOLS.test(c)) return deny('the supervisor (success-manager / sm) is off-limits to the worker (except `sm terminal` and `sm voiceover`).');
    if (/\bbd\s+(delete|compact|purge|admin)\b/.test(c)) return deny('deleting issues is reserved for the user.');
    const full = p.config.fullAccess === true; // the owner said "yes" to full access for this project
    if (!full && /\bbd\s+close\b.*--force/.test(c)) return deny('force-closing a blocked issue is not allowed; finish its blockers first.');
    if (/\bbd\s+(update|label)\b.*\b(human|src:)/.test(c)) return deny('human/source labels are set by the user, not the worker.');
    // Git: commit only your own files, by name. The user's uncommitted work-in-progress is off-limits.
    // Even with full access: stash / clean / hard reset would wipe the OWNER's uncommitted work, so those stay theirs.
    // Pushing publishes (often = deploys to production) — allowed only when the owner set allowPush for the project.
    if (/\bgit\b[^;&|]*\bpush\b/.test(c)) { const why = pushVerdict(c, input.cwd || p.config.path, p); if (why) return deny(why); }
    { const why = firebaseVerdict(c, p); if (why) return deny(why); }
    if (/\bgit\s+(stash|clean|reset\s+--hard)/.test(c)) return deny('stash / clean / hard reset could wipe the owner\'s own uncommitted work — reserved for the owner.');
    if (!full && /\bgit\s+(rebase|checkout\s+--|restore\b(?!.*--staged))/.test(c)) return deny('rebase / discarding changes is reserved for the user (or turn on full access).');
    if (/\bgit\s+add\s+(.*\s)?(-A|--all|-u|--update|\.(\s|$)|\*)/.test(c) || /\bgit\s+commit\s+(.*\s)?-[a-zA-Z]*a/.test(c)) {
      return deny('stage files explicitly by path (git add path/to/file …). Bulk staging could sweep in the user\'s uncommitted work.');
    }
    const wip = p.config.protectedFiles || [];
    const hit = /\bgit\s+(add|commit|checkout|restore)\b/.test(c) && wip.find((f) => c.includes(f));
    if (hit) return deny(`${hit} has the user's uncommitted work-in-progress — don't stage, commit or revert it. If you had to edit it, leave it unstaged and mention it in the task's close reason.`);
    // Token saving (github.com/rtk-ai/rtk): office agents' shell commands go through rtk, which trims test logs,
    // git output, installs… before the agent reads them. Only for full-access projects (the rewrite is approved
    // outright), only when rtk is installed, and never for the owner's own sessions (this hook polices workers only).
    const rewritten = rtkRewrite(c);
    if (rewritten && full) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'rtk: compact output', updatedInput: { ...ti, command: rewritten } } }));
    return;
  }

  const target = ti.file_path || ti.notebook_path;
  if (!target) return;
  const abs = path.resolve(input.cwd || p.config.path, target);
  const allowed = path.join(p.dir, 'TASKS.md');
  const protectedPaths = [officeEdit ? path.join(ROOT, 'projects') + path.sep : ROOT + path.sep, path.join(p.config.path, '.claude', 'settings.local.json'), path.join(p.config.path, '.beads') + path.sep,
    path.join(p.config.path, 'task_status.json'), path.join(p.config.path, 'tasks.md')];
  // bin/, test/, pixel-office/ are editable ONLY on office missions — never by workers on other projects.
  if (officeEdit && isWorkerEditable(ROOT, abs)) return;
  if (abs !== allowed && protectedPaths.some((x) => abs === x || abs.startsWith(x))) {
    deny(`${abs} is owned by the QA supervisor. You may only edit ${allowed}${usesBeads(p) ? ' and use the bd CLI' : ''}.`);
  }
}

// ---------- status artifacts (task_status.json + tasks.md in the project root, git-excluded) ----------
const STATUS_MARK = '<!-- generated by success-manager; edits are overwritten -->';

function excludeFromGit(projectPath, entries) {
  const file = path.join(projectPath, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(file))) return;
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !text.split('\n').includes(e));
  if (missing.length) fs.appendFileSync(file, `${text.endsWith('\n') || !text ? '' : '\n'}# success-manager\n${missing.join('\n')}\n`);
}

function overallStatus(p, results, tasks, verdict) {
  const qaOk = results.length > 0 && results.every((r) => r.ok);
  const a = p.state.lastAudit;
  const auditClean = Boolean(a) && a.newBlocking === 0 && a.complete !== false; // older audits have no flag
  if (verdict?.startsWith('GAVE UP')) return 'AWAITING_HUMAN_INPUT';
  if (qaOk && tasks.open.length === 0 && auditClean) return tasks.human.length ? 'AWAITING_HUMAN_INPUT' : 'PRODUCTION_READY';
  return 'IN_PROGRESS'; // includes "QA green + tasks done but never audited"
}

function writeStatus(p, results = p.state.lastResults || [], tasks = readTasks(p), verdict = p.state.lastVerdict) {
  const status = overallStatus(p, results, tasks, verdict);
  const failing = results.filter((r) => !r.ok);
  const byAgent = {};
  for (const f of p.state.lastAudit?.findings || []) (byAgent[f.agent] ||= []).push(`P${f.priority} ${f.title}${f.file ? ` (${f.file})` : ''}`);
  const json = {
    project: p.name,
    status,
    updated_at: now(),
    qa: results.map((r) => ({ name: r.name, ok: r.ok, exit: r.code, seconds: r.seconds })),
    critical_errors: failing.map((r) => ({ check: r.name, command: r.run, output_tail: r.output.split('\n').slice(-25).join('\n') })),
    agent_feedback: byAgent,
    last_audit: p.state.lastAudit ? { at: p.state.lastAudit.at, new_blocking: p.state.lastAudit.newBlocking, new_suggestions: p.state.lastAudit.newSuggestions } : null,
    next_actions: [...failing.map((r) => `Fix failing QA check "${r.name}" (root cause; never weaken tests)`), ...(tasks.ready || tasks.open)],
    awaiting_human: tasks.human,
    optional_suggestions: tasks.suggestions || [],
    done: tasks.done.length,
  };
  writeJSON(path.join(p.config.path, 'task_status.json'), json);
  const md = path.join(p.config.path, 'tasks.md');
  const mine = !fs.existsSync(md) || fs.readFileSync(md, 'utf8').startsWith(STATUS_MARK);
  if (mine) {
    const sect = (title, items) => (items.length ? [`## ${title}`, ...items.map((i) => `- ${i}`), ''] : []);
    fs.writeFileSync(md, [
      STATUS_MARK, `# ${p.name} — **${status}**`, '', `Updated ${json.updated_at}. Full QA report: ${path.join(p.dir, 'LATEST.md')}`, '',
      ...sect('Critical errors (fix first)', failing.map((r) => `❌ ${r.name}: \`${r.run}\``)),
      ...sect('Next actions', json.next_actions),
      ...Object.entries(byAgent).flatMap(([a, items]) => sect(`Last audit — ${a}`, items)),
      ...sect('Waiting on you', tasks.human),
      ...sect('Optional suggestions', json.optional_suggestions),
    ].join('\n'));
  }
  excludeFromGit(p.config.path, ['task_status.json', ...(mine ? ['tasks.md'] : [])]);
  return status;
}

// ---------- live web preview (playwright-cli, github.com/microsoft/playwright-cli) ----------
// config.preview = { url: "http://localhost:5199", command?: "npm run dev -- --port 5199", paths?: ["/", "/login"] }
async function isUp(url) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.status < 500; } catch { return false; }
}

async function startPreview(p) {
  const pv = p.config.preview;
  if (!pv?.url) return null;
  if (await isUp(pv.url)) return { stop() {} }; // already running (e.g. your own dev server)
  if (!pv.command) throw new Error(`Preview ${pv.url} is not reachable and no preview command is configured.`);
  const child = require('child_process').spawn('/bin/zsh', ['-lc', pv.command], { cwd: p.config.path, detached: true, stdio: 'ignore' });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
  for (let i = 0; i < 60; i++) {
    if (await isUp(pv.url)) return { stop };
    await new Promise((r) => setTimeout(r, 2000));
  }
  stop();
  throw new Error(`Preview never came up at ${pv.url} (command: ${pv.command})`);
}

function pw(session, args, cwd) {
  const r = spawnSync('playwright-cli', [`-s=${session}`, ...args], { cwd, encoding: 'utf8', timeout: 90000 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

// Deterministic browser smoke test: every configured page must load without console errors or failed requests.
async function smoke(p) {
  const pv = p.config.preview;
  if (!pv?.url) throw new Error(`No preview configured. Set one: sm preview ${p.name} --url http://localhost:PORT [--cmd "npm run dev"]`);
  const dir = path.join(p.dir, 'browser');
  fs.mkdirSync(dir, { recursive: true });
  const server = await startPreview(p);
  const session = `sm-${p.name}-smoke`;
  const problems = [];
  try {
    for (const route of pv.paths || ['/']) {
      const url = new URL(route, pv.url).href;
      pw(session, ['open', url], dir);
      const consoleOut = pw(session, ['--raw', 'console', 'error'], dir);
      for (const l of consoleOut.split('\n').filter((x) => x.startsWith('[ERROR]') && !/favicon\.ico/.test(x))) problems.push(`${route} console: ${l.slice(8)}`);
      const reqs = pw(session, ['--raw', 'requests'], dir);
      for (const l of reqs.split('\n').filter((x) => /=> \[(4|5)\d\d\]/.test(x) && !/favicon\.ico/.test(x))) problems.push(`${route} request: ${l.replace(/^\d+\.\s*/, '')}`);
      const slug = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'home';
      for (const [label, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
        pw(session, ['resize', String(w), String(h)], dir);
        pw(session, ['screenshot', '--filename', path.join(dir, `${slug}-${label}.png`)], dir);
      }
      pw(session, ['close'], dir);
    }
  } finally {
    pw(session, ['close'], dir);
    server?.stop();
  }
  return problems;
}

// ---------- multi-agent audit (read-only reviewer Claudes; they FILE tasks, they never judge pass/fail) ----------
const AGENTS_DIR = path.join(ROOT, 'agents');
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Imperative, specific task title, <= 100 chars' },
          priority: { type: 'integer', minimum: 0, maximum: 4 },
          file: { type: 'string', description: 'path[:line] where the problem is' },
          evidence: { type: 'string', description: 'What in the code proves this (quote or describe precisely)' },
          fix: { type: 'string', description: 'Concrete suggested fix' },
          needs_human: { type: 'boolean', description: 'true only if it needs a person: credentials, real device, business/design decision' },
          human_ask: {
            type: 'object',
            description: 'Only when needs_human: explain to the owner like they are 5 years old — plain words, no jargon.',
            properties: {
              what: { type: 'string', description: 'One sentence: what you need them to do.' },
              why: { type: 'string', description: 'One sentence: why only a human can do it.' },
              steps: { type: 'array', items: { type: 'string' }, description: 'Tiny numbered actions, each one click/tap/thing.' },
              done_when: { type: 'string', description: 'How they know they are finished.' },
              reply: { type: 'string', description: 'Exactly what to type back.' },
            },
            required: ['what', 'why', 'steps', 'done_when', 'reply'],
          },
        },
        required: ['title', 'priority', 'file', 'evidence', 'fix', 'needs_human'],
      },
    },
  },
  required: ['findings'],
};

const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function isDuplicate(title, existing) {
  const a = words(title);
  return existing.some((t) => {
    const b = words(t);
    const inter = [...a].filter((w) => b.has(w)).length;
    return inter / Math.max(1, Math.min(a.size, b.size)) >= 0.7;
  });
}

const BROWSER_AGENTS = ['ui', 'ux', 'functionality', 'marketing'];

function runAuditor(p, agent, brief, tasks, previewUrl) {
  const browser = previewUrl && BROWSER_AGENTS.includes(agent);
  const session = `sm-${p.name}-${agent}`;
  const max = p.config.maxFindingsPerAgent || 6;
  const prompt = [
    `You are an independent, read-only reviewer for the project in the current directory. You did not write this code`,
    `and you are not fixing it — another agent will. Report only problems you can prove from the files.`,
    '', brief, '',
    `Rules:`,
    `- At most ${max} findings, most important first. Zero findings is a valid, good answer — don't pad.`,
    `- Priority: 0 = crashes/data loss/security in normal use · 1 = a core feature is broken · 2 = real bug or gap a user would hit · 3 = polish · 4 = nice-to-have.`,
    `- Skip anything already tracked (titles below), anything the docs say is deliberate, and generated/vendored code.`,
    `- needs_human = true only for credentials/keys, real-device or hardware testing, or business/design decisions.`,
    `  Then ALSO fill human_ask, written for a 5-year-old: what to do, why only they can, tiny steps, how they know it's done, what to reply.`,
    `- Start from README / docs to learn what the product is meant to do.`,
    browser ? `- The app is running at ${previewUrl}. Inspect it live with the playwright-cli skill, ALWAYS with \`-s=${session}\` (e.g. \`playwright-cli -s=${session} open ${previewUrl}\`, then snapshot / click / fill / resize 390 844 / set-color-scheme dark / console error / requests). Report what you actually saw, citing the page and element. Don't submit real data, sign up, pay, or send anything.` : '',
    latNote(p.config.path) && `- ${latNote(p.config.path)} Specs there are the requirements: flag code that contradicts them.`,
    '', `Already tracked (do not repeat):`, ...tasks.openTitles.slice(0, 200).map((t) => `- ${t}`),
  ].filter((l) => l !== '').join('\n');
  const room = (() => { try { return require('./staff.js').createStaff(ROOT).load().staff.find((x) => x.id === agent)?.room; } catch { return ''; } })();
  const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(FINDINGS_SCHEMA),
    ...require('./staff.js').pluginDirsFor(ROOT, room, agent), // department training (skills) + shared brain
    '--model', p.config.auditModel || 'sonnet', '--max-budget-usd', String(p.config.auditBudgetUsd || 0.6), '--effort', 'medium',
    ...(p.config.fullAccess === true
      // full access: reviewers may run anything to investigate (they still report, not fix)
      ? ['--permission-mode', 'bypassPermissions', '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
      : ['--allowedTools', 'Read', 'Grep', 'Glob', 'Skill', ...(browser ? ['Bash(playwright-cli:*)'] : []),
        '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', ...(browser ? [] : ['Bash']), 'WebFetch', 'WebSearch', 'Agent'])];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = require('child_process').spawn('claude', args, {
      cwd: p.config.path, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SM_ROLE: 'auditor' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), (p.config.auditTimeoutSec || 1200) * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (browser) pw(session, ['close'], p.config.path);
      try {
        const j = JSON.parse(out);
        const findings = (j.structured_output?.findings || []).slice(0, max).map((f) => ({ ...f, agent }));
        resolve({ agent, ok: !j.is_error, findings, cost: j.total_cost_usd || 0, seconds: Math.round((Date.now() - started) / 1000) });
      } catch {
        resolve({ agent, ok: false, findings: [], cost: 0, error: (err || out || `exit ${code}`).slice(-500) });
      }
    });
  });
}

async function runAudit(p, only) {
  // Reviewers = every read-only specialist on the roster (office/staff.json); hires join automatically.
  const S = require('./staff.js').createStaff(ROOT);
  const roster = S.load();
  const reviewers = roster.staff.filter((x) => x.kind === 'reviewer');
  const available = reviewers.map((x) => x.id);
  const agents = (only || p.config.auditAgents || available).filter((a) => available.includes(a));
  const tasks = readTasks(p);
  console.log(`🔎 Auditing ${p.name} with ${agents.join(', ')} (${p.config.auditModel || 'sonnet'}, read-only, in parallel)…`);
  let server = null;
  if (p.config.preview?.url) {
    try { server = await startPreview(p); console.log(`   🌐 live preview ${p.config.preview.url} → reviewers get a browser`); }
    catch (e) { console.log(`   ⚠️  ${e.message} — reviewing code only`); }
    excludeFromGit(p.config.path, ['.playwright-cli/']);
  }
  let runs;
  try {
    runs = await Promise.all(agents.map((a) => runAuditor(p, a, S.promptFor(reviewers.find((x) => x.id === a), roster), tasks, server && p.config.preview.url)));
  } finally { server?.stop(); }

  const seen = [...tasks.openTitles];
  const filed = [];
  for (const run of runs) {
    console.log(`   ${run.ok ? '✓' : '✗'} ${run.agent}: ${run.findings.length} finding(s)${run.seconds ? `, ${run.seconds}s` : ''}${run.cost ? `, $${run.cost.toFixed(2)}` : ''}${run.error ? ` — ${run.error}` : ''}`);
    for (const f of run.findings.sort((a, b) => a.priority - b.priority)) {
      if (isDuplicate(f.title, seen)) continue;
      seen.push(f.title);
      const suggestion = f.priority >= 3 && !f.needs_human;
      const id = addTask(p, {
        title: f.title, priority: f.priority, source: `audit-${f.agent}`, human: Boolean(f.needs_human),
        labels: suggestion ? [SUGGESTION] : [],
        description: `${f.file}\nEvidence: ${f.evidence}\nSuggested fix: ${f.fix}`,
      });
      if (f.needs_human && f.human_ask?.what) saveAsk(p, id, { what: f.human_ask.what, why: f.human_ask.why, steps: f.human_ask.steps || [], doneWhen: f.human_ask.done_when, reply: f.human_ask.reply });
      filed.push({ ...f, id, suggestion });
    }
  }
  const audit = {
    at: now(),
    agents: runs.map(({ agent, ok, findings, cost, seconds, error }) => ({ agent, ok, found: findings.length, cost, seconds, error })),
    findings: filed,
    newBlocking: filed.filter((f) => !f.suggestion && !f.needs_human).length,
    newSuggestions: filed.filter((f) => f.suggestion).length,
    // a reviewer that crashed / ran out of budget found nothing because it didn't look — not because it's clean
    failedAgents: runs.filter((r) => !r.ok).map((r) => r.agent),
    complete: runs.length > 0 && runs.every((r) => r.ok),
    cost: runs.reduce((s, r) => s + r.cost, 0),
  };
  fs.mkdirSync(path.join(p.dir, 'audits'), { recursive: true });
  writeJSON(path.join(p.dir, 'audits', `${stamp()}.json`), audit);
  fs.appendFileSync(path.join(p.dir, 'history.log'), `${now()}  AUDIT new_blocking=${audit.newBlocking} suggestions=${audit.newSuggestions} human=${filed.filter((f) => f.needs_human).length} cost=$${audit.cost.toFixed(2)}\n`);
  const fresh = loadProject(p.name); // the stop hook may have written state meanwhile
  fresh.state.lastAudit = audit;
  saveState(fresh);
  p.state = fresh.state;
  for (const f of filed) console.log(`   ➕ ${f.id} P${f.priority} [${f.agent}${f.suggestion ? ', suggestion' : ''}${f.needs_human ? ', human' : ''}] ${f.title}`);
  console.log(`   → ${audit.newBlocking} new required task(s), ${audit.newSuggestions} suggestion(s), cost ≈ $${audit.cost.toFixed(2)}`);
  if (!audit.complete) console.log(`   ⚠️  incomplete audit — ${audit.failedAgents.join(', ')} failed, so this is NOT a clean bill of health`);
  return audit;
}

// ---------- install into a project's .claude/settings.local.json ----------
function hookSettingsPath(projectPath) { return path.join(projectPath, '.claude', 'settings.local.json'); }

function stripOurHooks(settings) {
  for (const ev of Object.keys(settings.hooks || {})) {
    settings.hooks[ev] = settings.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_MARK)) }))
      .filter((g) => g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function installHooks(p) {
  const file = hookSettingsPath(p.config.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const settings = stripOurHooks(readJSON(file, {}));
  const cmd = (sub) => `node "${SELF}" hook ${sub} ${p.name}`;
  const longest = Math.max(600, ...p.config.qa.map((c) => c.timeoutSec || 900)) * Math.max(1, p.config.qa.length) + 60;
  settings.hooks = settings.hooks || {};
  (settings.hooks.SessionStart ||= []).push({ hooks: [{ type: 'command', command: cmd('session-start') }] });
  (settings.hooks.Stop ||= []).push({ hooks: [{ type: 'command', command: cmd('stop'), timeout: longest }] });
  (settings.hooks.PreToolUse ||= []).push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: cmd('guard') }] });
  settings.permissions = settings.permissions || {};
  const dirs = new Set(settings.permissions.additionalDirectories || []);
  dirs.add(p.dir);
  settings.permissions.additionalDirectories = [...dirs];
  if (usesBeads(p)) {
    const allow = new Set(settings.permissions.allow || []);
    allow.add('Bash(bd:*)');
    settings.permissions.allow = [...allow];
  }
  writeJSON(file, settings);
  return file;
}

function uninstallHooks(p) {
  const file = hookSettingsPath(p.config.path);
  if (!fs.existsSync(file)) return;
  const settings = stripOurHooks(readJSON(file, {}));
  if (settings.permissions?.additionalDirectories) {
    settings.permissions.additionalDirectories = settings.permissions.additionalDirectories.filter((d) => d !== p.dir);
    if (!settings.permissions.additionalDirectories.length) delete settings.permissions.additionalDirectories;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  writeJSON(file, settings);
}

// ---------- CLI ----------
// Switches never take a value, so `sm task --human "Fix it"` keeps "Fix it" as the title.
const BOOL_FLAGS = new Set(['on', 'no-pin', 'fix', 'menu', 'test', 'no-call', 'refresh', 'all', 'send', 'list', 'call', 'human', 'off', 'beads', 'force', 'check', 'build', 'restart', 'fix', 'json', 'dry-run', 'no-audit', 'no-open', 'no-terminal']);
// Text flags always take the next word, even when it starts with "-" (e.g. --desc "-5% on checkout").
const TEXT_FLAGS = new Set(['desc', 'what', 'why', 'done', 'reply', 'prompt', 'goal', 'title', 'source', 'project', 'name', 'cmd', 'url', 'task', 'say', 'video', 'pdf']);
function parseFlags(args) {
  const flags = { qa: [] }, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { flags.passthrough = args.slice(i + 1); break; }
    if (a === '--qa') flags.qa.push(args[++i]);
    else if (a === '--step') (flags.steps ||= []).push(args[++i]);
    else if (a === '-p') flags.priority = args[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) flags[k] = true;
      else if (TEXT_FLAGS.has(k) && args[i + 1] !== undefined) flags[k] = args[++i];
      else flags[k] = args[i + 1] !== undefined && !/^-/.test(args[i + 1]) ? args[++i] : true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function isRunning(p) {
  if (!p.state.runPid) return false;
  try { process.kill(p.state.runPid, 0); return true; } catch { return false; }
}

function listProjects() {
  if (!fs.existsSync(PROJECTS)) return [];
  return fs.readdirSync(PROJECTS).filter((n) => fs.existsSync(path.join(PROJECTS, n, 'config.json')));
}

const commands = {
  add(args) {
    const { flags, rest } = parseFlags(args);
    if (!rest[0]) throw new Error('Usage: sm add <project-path> [--name n] [--qa "cmd"]... [--goal "text"]');
    const projectPath = path.resolve(process.cwd(), rest[0]);
    if (!fs.statSync(projectPath).isDirectory()) throw new Error(`${projectPath} is not a folder`);
    const name = flags.name || path.basename(projectPath).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const dir = projDir(name);
    if (fs.existsSync(path.join(dir, 'config.json'))) throw new Error(`"${name}" is already managed. Use: sm qa ${name}`);
    fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
    const qa = flags.qa.length
      ? flags.qa.map((run, i) => ({ name: `qa${i + 1}`, run, timeoutSec: 1200 }))
      : detectQA(projectPath);
    const beads = Boolean(flags.beads) || fs.existsSync(path.join(projectPath, '.beads'));
    if (beads && spawnSync('bd', ['--version']).status !== 0) throw new Error('beads (bd) is not installed: brew install beads');
    // A half-made .beads (e.g. from an earlier failed init) must not count as set up.
    const beadsWorks = () => spawnSync('bd', ['list', '--json', '--limit', '1'], { cwd: projectPath, encoding: 'utf8' }).status === 0;
    if (beads && fs.existsSync(path.join(projectPath, '.beads')) && !beadsWorks()) fs.rmSync(path.join(projectPath, '.beads'), { recursive: true, force: true });
    if (beads && !fs.existsSync(path.join(projectPath, '.beads'))) {
      // --stealth keeps beads out of the repo's git; --skip-agents stops it writing CLAUDE.md/AGENTS.md/.cursor etc.
      // beads names its database after the folder unless told otherwise — "My App" etc. is not a valid name
      const prefix = (name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^[^a-z_]+/i, '').replace(/-+$/, '') || 'project').slice(0, 40);
      const r = spawnSync('bd', ['init', '--quiet', '--non-interactive', '--skip-agents', '--skip-hooks', '--stealth', '--prefix', prefix], { cwd: projectPath, encoding: 'utf8' });
      if (r.status !== 0 || !beadsWorks()) throw new Error(`bd init failed: ${r.stderr || r.stdout || 'the task tracker did not start'}`);
    }
    const config = { path: projectPath, active: true, tracker: beads ? 'beads' : 'markdown', maxIterations: 30, maxSameResult: 3, qa };
    writeJSON(path.join(dir, 'config.json'), config);
    if (beads && flags.goal) {
      spawnSync('bd', ['create', `Break down goal into issues: ${flags.goal}`, '-p', '0', '--json'], { cwd: projectPath });
    }
    writeJSON(path.join(dir, 'state.json'), {});
    const tasks = path.join(dir, 'TASKS.md');
    if (!beads && !fs.existsSync(tasks)) {
      fs.writeFileSync(tasks, [
        `# ${name} — tasks`,
        '',
        flags.goal ? `**Goal:** ${flags.goal}` : '**Goal:** (describe what "complete" means for this project)',
        '',
        '## Tasks',
        flags.goal ? '- [ ] Break the goal down into concrete tasks in this list' : '- [ ] (add tasks here)',
        '',
        '## Log',
        '',
      ].join('\n'));
    }
    const p = loadProject(name);
    const settingsFile = installHooks(p);
    console.log(`✅ Managing "${name}" (${projectPath})`);
    console.log(`   Tasks:   ${config.tracker === "beads" ? "beads (bd ready / bd list) in " + projectPath : tasks}`);
    console.log(`   Config:  ${path.join(dir, 'config.json')}`);
    console.log(`   Hooks:   ${settingsFile}`);
    console.log(`   QA:      ${qa.length ? qa.map((c) => c.run).join('  &&  ') : 'NONE detected — add with: sm set-qa ' + name + ' "<cmd>"'}`);
  },

  remove([name]) {
    const p = loadProject(name);
    uninstallHooks(p);
    p.config.active = false;
    writeJSON(path.join(p.dir, 'config.json'), p.config);
    console.log(`Removed hooks from ${p.config.path}. History kept in ${p.dir} (delete the folder to forget it).`);
  },

  // Configure a live web preview → adds a browser smoke test to QA and gives reviewers a browser.
  preview(args) {
    const { flags, rest } = parseFlags(args);
    const p = loadProject(rest[0]);
    if (flags.off) {
      delete p.config.preview;
      p.config.qa = p.config.qa.filter((c) => c.name !== 'web-smoke');
    } else {
      if (!flags.url) throw new Error('Usage: sm preview <name> --url http://localhost:PORT [--cmd "npm run dev -- --port PORT"] [--paths /,/login]  |  --off');
      p.config.preview = { url: flags.url, ...(flags.cmd ? { command: flags.cmd } : {}), paths: flags.paths ? String(flags.paths).split(',') : ['/'] };
      if (!p.config.qa.some((c) => c.name === 'web-smoke')) p.config.qa.push({ name: 'web-smoke', run: `node "${SELF}" smoke ${p.name}`, timeoutSec: 600 });
    }
    writeJSON(path.join(p.dir, 'config.json'), p.config);
    installHooks(p);
    console.log(flags.off ? `Preview removed for ${p.name}.` : `🌐 ${p.name}: preview ${flags.url}${flags.cmd ? ` (started with: ${flags.cmd})` : ' (must already be running)'}; web-smoke added to QA.`);
  },

  async smoke([name]) {
    const p = loadProject(name);
    const problems = await smoke(p);
    console.log(`Screenshots: ${path.join(p.dir, 'browser')}`);
    if (problems.length) { console.log(`❌ ${problems.length} problem(s):\n${problems.map((x) => `  - ${x}`).join('\n')}`); process.exitCode = 1; }
    else console.log(`✅ All pages loaded without console errors or failed requests.`);
  },

  // project_inbox/: drop a symlink (or folder path in a .txt) to enroll a project.
  ingest() {
    const inbox = path.join(ROOT, 'project_inbox');
    fs.mkdirSync(inbox, { recursive: true });
    const known = new Set(listProjects().map((n) => fs.realpathSync(loadProject(n).config.path)));
    for (const entry of fs.readdirSync(inbox).filter((e) => !e.startsWith('.') && e !== 'README.md')) {
      const full = path.join(inbox, entry);
      let target;
      try {
        target = entry.endsWith('.txt') ? fs.readFileSync(full, 'utf8').trim().replace(/^~/, process.env.HOME) : fs.realpathSync(full);
        target = fs.realpathSync(target);
      } catch { console.log(`⚠️  project_inbox/${entry}: can't resolve`); continue; }
      if (known.has(target)) continue;
      if (!fs.statSync(target).isDirectory()) { console.log(`⚠️  project_inbox/${entry}: not a folder`); continue; }
      console.log(`📦 New project from inbox: ${target}`);
      try { commands.add([target, '--beads']); known.add(target); } catch (e) { console.log(`⚠️  ${e.message}`); }
    }
  },

  reinstall([name]) { const p = loadProject(name); console.log(`Hooks refreshed: ${installHooks(p)}`); },

  pause([name]) { const p = loadProject(name); p.config.active = false; writeJSON(path.join(p.dir, 'config.json'), p.config); console.log(`⏸  ${name} paused — Claude stops normally there.`); },
  resume([name]) { const p = loadProject(name); p.config.active = true; p.state.iterations = 0; p.state.sameCount = 0; saveState(p); writeJSON(path.join(p.dir, 'config.json'), p.config); console.log(`▶️  ${name} supervised again.`); },

  /** sm set <project> <allowPush|fullAccess|maxFixRounds> <value> — the owner's switches (workers can't run it). */
  set([name, key, value]) {
    const SWITCHES = { allowPush: 'bool', fullAccess: 'bool', maxFixRounds: 'int', missionBudgetUsd: 'int', firebaseAccount: 'email' };
    if (!name || !SWITCHES[key] || value === undefined) { console.error(`Usage: sm set <project> <${Object.keys(SWITCHES).join('|')}> <value>`); process.exit(1); }
    const p = loadProject(name);
    if (SWITCHES[key] === 'email' && !/^(none|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(value)) { console.error(`${key} must be an email address (or "none")`); process.exit(1); }
    const v = SWITCHES[key] === 'email' ? (value === 'none' ? undefined : value)
      : SWITCHES[key] === 'bool' ? /^(true|yes|on|1)$/i.test(value) : Math.max(0, Math.min(key === 'missionBudgetUsd' ? 200 : 10, parseInt(value, 10) || 0));
    p.config[key] = v;
    fs.writeFileSync(path.join(p.dir, 'config.json'), JSON.stringify(p.config, null, 2) + '\n');
    console.log(`${p.name}: ${key} = ${v}`);
  },
  'set-qa'(args) {
    const [name, ...cmds] = args;
    const p = loadProject(name);
    if (!cmds.length) throw new Error('Usage: sm set-qa <name> "<cmd>" ["<cmd>"...]');
    p.config.qa = cmds.map((run, i) => ({ name: `qa${i + 1}`, run, timeoutSec: 1200 }));
    writeJSON(path.join(p.dir, 'config.json'), p.config);
    p.state.lastFingerprint = null; saveState(p);
    installHooks(p); // refresh hook timeout
    console.log(`QA for ${name}:\n${cmds.map((c) => '  ' + c).join('\n')}`);
  },

  qa([name]) {
    const p = loadProject(name);
    console.log(`Running QA for ${name}…`);
    const results = runQA(p);
    const tasks = readTasks(p);
    const verdict = results.every((r) => r.ok) ? (tasks.open.length ? 'QA GREEN, TASKS OPEN' : 'COMPLETE') : 'QA FAILING';
    console.log(writeReport(p, results, tasks, `${verdict} (manual run)`));
    p.state = loadProject(p.name).state; // reload: an audit may have saved state while QA ran
    p.state.lastResults = results; p.state.lastFingerprint = fingerprint(p.config.path); p.state.lastRun = now(); saveState(p);
    console.log(`Status: ${writeStatus(p, results, tasks, verdict)}`);
  },

  async audit(args) {
    const { flags, rest } = parseFlags(args);
    const p = loadProject(rest[0]);
    await runAudit(p, flags.agents ? String(flags.agents).split(',') : undefined);
    console.log(`Status: ${writeStatus(p)}`);
  },

  // The full loop: audit → builder Claude (kept going by the Stop hook until QA green + tasks done) → re-audit → …
  // until PRODUCTION_READY, or it needs a human, or a round limit is hit.
  async run(args) {
    const { flags, rest } = parseFlags(args);
    let p = loadProject(rest[0]);
    if (isRunning(p)) throw new Error(`${p.name} already has a supervised run going (pid ${p.state.runPid}).`);
    if (!p.config.active) commands.resume([p.name]);
    // --task <id>: the Fix button — one builder run aimed at a single task, no reviewer rounds.
    const taskId = typeof flags.task === 'string' ? flags.task : null;
    if (taskId && !/^[\w.-]+$/.test(taskId)) throw new Error(`Bad task id: ${taskId}`);
    const autoAudit = !taskId && !flags['no-audit'] && p.config.autoAudit !== false;
    const maxAudits = p.config.maxAuditRounds || 3;
    const maxBuilds = taskId ? 1 : p.config.maxBuilderRuns || 6;
    const claudeFlags = flags.passthrough || (p.config.fullAccess === true ? ['--permission-mode', 'bypassPermissions'] : p.config.claudeFlags || ['--permission-mode', 'acceptEdits']);
    const where = usesBeads(p) ? 'the beads issues (`bd ready --json`)' : path.join(p.dir, 'TASKS.md');
    const prompt = flags.prompt || (taskId ? [
      `You are the builder for this project, supervised by Success Manager.`,
      `Fix ONLY the task ${taskId} (${usesBeads(p) ? `\`bd show ${taskId} --json\`` : where}). Read it, fix it in the code, and close it when it is truly done.`,
      `Do not work on any other task.`,
    ].join(' ') : [
      `You are the builder for this project, supervised by Success Manager.`,
      `Read ${path.join(p.config.path, 'task_status.json')} and ${where}.`,
      `Resolve critical_errors first, then work the open tasks in priority order (0 = most urgent).`,
      `Update code directly, close each task when it's truly done, and keep going until none are left.`,
      `Skip "human" tasks; "suggestion" tasks are optional and come last.`,
    ].join(' '));
    p.state.runPid = process.pid; p.state.runStartedAt = now(); p.state.iterations = 0; p.state.sameCount = 0; saveState(p);
    // Snapshot the user's uncommitted files so the guard keeps the builder's commits away from them.
    const dirty = spawnSync('git', ['-C', p.config.path, 'status', '--porcelain'], { encoding: 'utf8' });
    if (dirty.status === 0) {
      p.config.protectedFiles = dirty.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''))
        .filter((f) => !['task_status.json', 'tasks.md'].includes(f));
      writeJSON(path.join(p.dir, 'config.json'), p.config);
    }
    const log = (m) => console.log(`[${now()}] ${m}`);
    if (p.config.protectedFiles?.length) log(`Protecting ${p.config.protectedFiles.length} uncommitted file(s) of yours from the builder's commits.`);
    let audits = 0, builds = 0, stopReason = '';
    try {
      if (!p.state.lastResults) { log('Baseline QA…'); commands.qa([p.name]); p = loadProject(p.name); }
      if (autoAudit && !p.state.lastAudit) { await runAudit(p); audits++; p = loadProject(p.name); }
      for (;;) {
        const tasks = readTasks(p);
        const qaOk = (p.state.lastResults || []).every((r) => r.ok);
        const work = (usesBeads(p) ? tasks.ready.length : tasks.open.length) + (qaOk ? 0 : 1);
        if (!work) {
          if (tasks.open.length) { stopReason = 'remaining tasks are blocked by human tasks'; break; }
          if (!autoAudit) { stopReason = 'tasks done, QA green (audit off)'; break; }
          if (audits >= maxAudits) { stopReason = `audit round limit (${maxAudits}) reached`; break; }
          const a = await runAudit(p); audits++; p = loadProject(p.name);
          if (a.complete === false) { stopReason = `audit incomplete — reviewer(s) failed: ${a.failedAgents.join(', ')}`; break; }
          if (a.newBlocking === 0) { stopReason = 'audit found nothing new that blocks release'; break; }
          continue;
        }
        if (builds >= maxBuilds) { stopReason = `builder run limit (${maxBuilds}) reached`; break; }
        writeStatus(p);
        builds++;
        log(`Builder run ${builds}: ${work} item(s) of work → headless Claude in ${p.config.path}`);
        const r = spawnSync('claude', ['-p', prompt, ...require('./staff.js').pluginDirsFor(ROOT, 'engineering'), ...claudeFlags], { cwd: p.config.path, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, SM_ROLE: 'builder' } });
        p = loadProject(p.name);
        log(`Builder exited (${r.status}); supervisor verdict: ${p.state.lastVerdict || 'none'}`);
        if (p.state.lastVerdict?.startsWith('GAVE UP')) { stopReason = p.state.lastVerdict; break; }
      }
    } finally {
      p = loadProject(p.name);
      delete p.state.runPid; saveState(p);
    }
    const status = writeStatus(p);
    log(`Finished: ${status} — ${stopReason}`);
    notify(`${status === 'PRODUCTION_READY' ? '✅' : '⚠️'} ${p.name}: ${status}`, stopReason);
  },

  // Intake: anything (you, Slack, Calendar, another Claude) adds work through here.
  task(args) {
    const { flags, rest } = parseFlags(args);
    const title = rest.join(' ').trim();
    if (!title) throw new Error('Usage: sm task "<title>" [--project name] [-p 0-4] [--desc "..."] [--source slack|calendar|...] [--human]');
    const source = flags.source || 'manual';
    let name = flags.project;
    if (!name) {
      const text = `${title} ${flags.desc || ''}`.toLowerCase();
      const hits = listProjects().filter((n) => {
        const c = loadProject(n).config;
        return [n, ...(c.keywords || [])].some((k) => new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
      });
      if (hits.length === 1) name = hits[0];
      else {
        fs.appendFileSync(path.join(ROOT, 'INBOX.md'),
          `- [ ] ${title}${flags.desc ? ` — ${flags.desc}` : ''} _(from ${source}, ${now()}${hits.length ? `, could be: ${hits.join('/')}` : ''})_\n`);
        console.log(`📥 Couldn't tell which project${hits.length ? ` (${hits.join(' or ')})` : ''} → added to INBOX.md. Route it with: sm triage`);
        return;
      }
    }
    const p = loadProject(name);
    const priority = flags.priority === undefined ? 2 : Number(flags.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) { console.error(`Priority must be 0-4 (0 = broken in production … 4 = someday), got "${flags.priority}".`); process.exit(1); }
    const id = addTask(p, { title, priority, description: flags.desc, source, human: Boolean(flags.human) });
    console.log(`➕ ${name}: ${id} — ${title} (P${priority}, from ${source}${flags.human ? ', needs a human' : ''})`);
    if (flags.human) console.log(`   Add the explain-like-I'm-5 version: sm ask ${name} ${id} --what "…" --why "…" --step "…" --done "…" --reply "…"`);
  },

  // Floor Manager missions
  manage(args) {
    const { flags, rest } = parseFlags(args);
    const project = flags.project || listProjects()[0];
    const m = missions().create(project, rest.join(' '));
    console.log(`🧑‍💼 Mission ${m.id} for ${project}: the floor manager is planning it. Watch it in \`sm office\`.`);
  },
  async 'mission-run'([project, id]) { await missions().run(project, id); },
  /** MUSE's one-shot "fresh ideas" pass (started from the office). */
  /** sm learn "<lesson>" [--kind prompt|error|info] | sm learn --list | sm learn --remove <id> — the office's learning box. */
  learn(args) {
    const { flags, rest: positional } = parseFlags(args);
    const L = require('./learning.js').createLearning(ROOT);
    if (flags.list) { const ls = L.list(); console.log(ls.length ? ls.map((l) => `${l.id}  [${l.kind}]  ${l.text}`).join('\n') : 'Nothing learned yet.'); return; }
    if (flags.remove) { L.remove(String(flags.remove)); console.log('Removed.'); return; }
    const l = L.add(positional.join(' '), { kind: flags.kind || 'info', source: flags.source || 'crew' });
    console.log(`Learned (${l.id}): ${l.text}`);
  },
  /** sm errors [--approve <id>] [--dismiss <id>] | sm error "<title>" [--detail ..] — TRACE's error log. */
  errors(args) {
    const { flags, rest: positional } = parseFlags(args);
    const E = require('./errorlog.js').createErrorLog(module.exports, { missions: missions(), learning: require('./learning.js').createLearning(ROOT) });
    if (flags.approve) { const e = E.approve(String(flags.approve), flags.project); console.log(`ARES is on it: mission ${e.missionId} (${e.project}).`); return; }
    if (flags.dismiss) { E.dismiss(String(flags.dismiss)); console.log('Dismissed.'); return; }
    if (positional.length) { const e = E.record({ source: flags.source || 'cli', title: positional.join(' '), detail: flags.detail || '', project: flags.project || '' }); console.log(`Logged ${e.id} (${e.count}x). Waiting for the owner to approve the fix.`); return; }
    const es = E.list();
    console.log(es.length ? es.map((e) => `${e.id}  ${e.status.padEnd(9)} ${e.count}x  [${e.source}] ${e.title}`).join('\n') : 'No errors logged.');
  },
  /** sm ares [--fix] [--json] — ARES's checks on missions, processes and the office (see bin/watchdog.js). */
  /**
   * sm terminal "<login command>" [--cwd dir]: open Terminal.app running an interactive sign-in for the owner (agents
   * run headless and can't type passwords). Only sign-in commands, so it can't be used to run anything past the guard.
   */
  terminal(args) {
    const { flags, rest } = parseFlags(args);
    const cmd = rest.join(' ').trim();
    if (!LOGIN_CMD.test(cmd)) throw new Error(`sm terminal only opens sign-ins (firebase login, gcloud auth login, gh auth login, vercel login, eas login, npm login, stripe login, supabase login, cswap add …), not "${cmd}"`);
    const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
    const q = (x) => `'${x.replace(/'/g, `'\\''`)}'`;
    const script = `cd ${q(cwd)} && ${cmd}`;
    const r = spawnSync('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not open Terminal: ${(r.stderr || '').trim()}`);
    console.log(`🖥️  Opened Terminal for the owner: ${cmd} — they finish the sign-in there.`);
  },

  ares(args) {
    const { flags } = parseFlags(args);
    const r = require('./watchdog.js').createWatchdog(module.exports).run({ fix: Boolean(flags.fix) });
    if (flags.json) { console.log(JSON.stringify(r, null, 2)); return; }
    if (!r.findings.length) { console.log('✅ ARES: everything looks healthy.'); return; }
    const mark = { critical: '🔴', warn: '🟠', info: '⚪' };
    for (const f of r.findings) console.log(`${mark[f.severity]} ${f.title}\n   ${f.detail}${f.fix ? `\n   → ${f.fix}${flags.fix && /^(stop|mark)/.test(f.fix) ? ' (done)' : ''}` : ''}`);
  },
  /** Call the owner into the conference room: the crew sits down, ARES explains, the video plays. */
  meeting(args) {
    const { flags, rest } = parseFlags(args);
    const [project, ...words] = rest;
    if (!project) throw new Error('Usage: sm meeting <project> "<title>" [--video file.mp4] [--pdf file.pdf] [--say "what we did"] | sm meeting <project> --list | --end <id>');
    loadProject(project);
    const M = require('./meetings.js').createMeetings((name) => loadProject(name).dir);
    if (flags.end) { const m = M.end(project, String(flags.end)); console.log(`✔ Meeting ${m.id} ended.`); return; }
    if (flags.list) { for (const m of M.list(project)) console.log(`${m.id}  ${m.status.padEnd(10)} ${m.title}${m.video ? `  🎬 ${m.video}` : ''}`); return; }
    const video = typeof flags.video === 'string' ? path.resolve(flags.video) : undefined;
    const pdf = typeof flags.pdf === 'string' ? path.resolve(flags.pdf) : undefined;
    const m = M.call(project, { title: words.join(' '), summary: typeof flags.say === 'string' ? flags.say : '', video, pdf });
    console.log(`📞 The conference room is calling you (${m.id}) — open the office to join.`);
  },
  async 'ideas-fresh'([project, category = 'features']) {
    const p = loadProject(project);
    const S = require('./staff.js').createStaff(ROOT);
    const roster = S.load();
    const muse = roster.staff.find((x) => x.kind === 'ideas');
    const r = await require('./ideas.js').createIdeas(ROOT).runFresh(p.name, {
      projectPath: p.config.path, musePrompt: muse ? S.promptFor(muse, roster) : 'You are MUSE, Head of Future Ideas.', model: p.config.auditModel,
      // shared brain + the tab's department skills (e.g. Security tab → engineering's security skills)
      pluginFlags: require('./staff.js').pluginDirsFor(ROOT, (require('./ideas.js').CATEGORIES.find((c) => c.id === category) || {}).room || ''),
      category,
    });
    console.log(r.ok ? `MUSE: ${r.ideas.length} fresh ${category} ideas for ${p.name}` : `MUSE failed: ${r.error}`);
  },
  'mission-list'([project]) {
    for (const m of missions().snapshot(project || listProjects()[0])) console.log(`${m.id}  ${m.status.padEnd(14)} $${(m.cost || 0).toFixed(2)}  ${m.prompt.slice(0, 70)}`);
  },

  // Plain-language ask for a human task: sm ask <project> <id> --what ".." --why ".." --step ".." --step ".." --done ".." --reply ".."
  ask(args) {
    const { flags, rest } = parseFlags(args);
    const [name, id] = rest;
    const p = loadProject(name);
    if (!id || !flags.what) {
      const cur = readJSON(path.join(p.dir, 'asks.json'), {})[id];
      if (cur) return console.log(JSON.stringify(cur, null, 2));
      throw new Error('Usage: sm ask <project> <task-id> --what "…" --why "…" --step "…" [--step "…"] --done "…" --reply "…"');
    }
    saveAsk(p, id, { what: flags.what, why: flags.why || '', steps: flags.steps || [], doneWhen: flags.done || '', reply: flags.reply || '' });
    console.log(`🧒 Saved the plain-language ask for ${id}.`);
  },

  triage(args) {
    const file = path.join(ROOT, 'INBOX.md');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- [ ] ')) : [];
    const [n, project] = args;
    if (!n) {
      if (!lines.length) return console.log('Inbox empty.');
      lines.forEach((l, i) => console.log(`${i + 1}. ${l.slice(6)}`));
      return console.log(`\nRoute one: sm triage <number> <project>   (projects: ${listProjects().join(', ')})`);
    }
    const line = lines[Number(n) - 1];
    if (!line || !project) throw new Error('Usage: sm triage <number> <project>');
    const m = line.slice(6).match(/^(.*?)(?: — (.*?))? _\(from ([^,]+),/);
    addTask(loadProject(project), { title: m ? m[1] : line.slice(6), description: m?.[2], source: m?.[3] || 'inbox' });
    fs.writeFileSync(file, lines.filter((l) => l !== line).join('\n') + (lines.length > 1 ? '\n' : ''));
    console.log(`➕ moved to ${project}`);
  },

  // Firebase cloud backup of the zoo integrations: link <key.json> | status | push | pull | unlink (passphrase: --passphrase or SM_FIREBASE_PASSPHRASE).
  async firebase(args) {
    const { flags, rest } = parseFlags(args);
    const [sub, file] = rest;
    const F = require('./firebase.js').createFirebase(ROOT);
    const pass = typeof flags.passphrase === 'string' ? flags.passphrase : process.env.SM_FIREBASE_PASSPHRASE;
    if (sub === 'link') { if (!file) throw new Error('usage: sm firebase link <service-account-key.json>'); const s = F.link(fs.readFileSync(path.resolve(file), 'utf8')); console.log(`🔥 linked to ${s.projectId}`); return; }
    if (sub === 'unlink') { F.unlink(); console.log('unlinked'); return; }
    if (sub === 'push') { const r = await F.push(pass); console.log(`☁️  integrations backed up (encrypted) to ${r.projectId}`); return; }
    if (sub === 'pull') { const r = await F.pull(pass); console.log(`☁️  integrations restored from ${r.projectId}`); return; }
    const s = F.status();
    console.log(s.linked ? `🔥 linked: ${s.projectId} (${s.clientEmail})` : '⚪ not linked. Create a Firebase project, enable Firestore, download a service-account key, then: sm firebase link key.json');
  },

  // Install check: everything a new machine needs, with the exact fix for anything missing.
  doctor() {
    const S = require('./setup-check.js').createSetupCheck(ROOT).summary();
    const title = { required: 'Needed to run', recommended: 'Recommended', optional: 'Optional features' };
    for (const g of ['required', 'recommended', 'optional']) {
      console.log(`\n${title[g]}`);
      for (const i of S.items.filter((x) => x.group === g)) console.log(`  ${i.ok ? '✅' : g === 'required' ? '❌' : '⚪'} ${i.label}${i.ok ? '' : `  → ${i.fix}`}${!i.ok && i.unlocks ? `  (${i.unlocks})` : ''}`);
    }
    const left = S.required.total - S.required.done;
    console.log(left ? `\n${left} thing(s) to fix before the crew can work.` : '\nAll set. Start the office with ./start.sh');
    if (left) process.exitCode = 1;
  },

  // ElevenLabs narration for videos: REEL runs this, drops the mp3 into the Remotion project and plays it with <Audio>.
  async voiceover(args) {
    const { flags, rest } = parseFlags(args);
    const text = rest.join(' ');
    if (!text || !flags.out) throw new Error('usage: sm voiceover "<narration text>" --out <file.mp3> [--voice <elevenlabs voice id>]');
    const r = await require('./voice.js').createVoice(ROOT).voiceover(text, flags.out, typeof flags.voice === 'string' ? flags.voice : undefined);
    console.log(`🔊 ${r.file} (${r.bytes} bytes)`);
  },

  // ARES phones the owner: `sm call "<what to say>" [--to +972…]` (ElevenLabs voice when public_url is set), `sm call --whatsapp "<text>"`, `sm call --status`.
  async call(args) {
    const { flags, rest } = parseFlags(args);
    const P = require('./ares-phone.js').createPhone(ROOT);
    if (flags.status) { console.log(JSON.stringify(P.status())); return; }
    const text = rest.join(' ').trim();
    if (!text) throw new Error('usage: sm call "<what ARES says>" [--to +number] [--whatsapp] | sm call --status');
    const to = typeof flags.to === 'string' ? flags.to : undefined;
    const r = flags.whatsapp ? await P.whatsapp(text, { to }) : await P.call(text, { to });
    console.log(flags.whatsapp ? `💬 WhatsApp sent (${r.sid})` : `📞 calling ${r.to} (${r.engine} voice, ${r.sid})`);
  },

  // The owner's developer day (bin/devpulse.js): every local repo + GitHub, ranked. No AI.
  async pulse(args) {
    const { flags } = parseFlags(args);
    const P = require('./devpulse.js').createDevPulse(ROOT);
    const d = flags.refresh ? await P.refresh() : await P.fresh();
    if (flags.json) { console.log(JSON.stringify({ ...d, attention: P.attention(d) }, null, 1)); return; }
    const icon = ['🔴', '🟠', '🟡', '⚪'];
    const att = P.attention(d);
    console.log(`Dev pulse — ${d.repos.length} local repos, ${(d.github.repos || []).length} on GitHub${d.github.error ? ` (${d.github.error})` : ''}`);
    for (const a of att.filter((x) => flags.all || x.level <= 2)) console.log(`${icon[a.level]} ${a.text}`);
    const quiet = att.filter((x) => x.level > 2).length; if (quiet && !flags.all) console.log(`   (+${quiet} in dormant repos: sm pulse --all)`);
    if (!att.length) console.log('✅ all pushed, all green');
    const y = P.yesterday(d); if (y.length) { console.log('\nLast 24h:'); for (const r of y) console.log(`  ${r.repo}: ${r.commits.length} commit${r.commits.length > 1 ? 's' : ''} — ${r.commits[0]}`); }
  },

  // The phone line's public address (bin/tunnel.js): sm tunnel shows it; --fix restarts/re-points it now.
  async tunnel(args) {
    const { flags } = parseFlags(args);
    const T = require('./tunnel.js').createTunnel(ROOT, { log: (m) => console.log(m) });
    if (flags.fix) { const r = await T.check(); console.log(r.ok ? `✅ phone line at ${r.hostname} (${r.connections} connection${r.connections > 1 ? 's' : ''})${r.publicUrl || r.twilio ? ' — updated the office and Twilio' : ''}` : `❌ ${r.reason}`); return; }
    const h = await T.health(); console.log(h.up ? `✅ phone line up at ${h.hostname} (${h.connections} connections)` : `❌ phone line down: ${h.reason} — run sm tunnel --fix`);
  },

  // IVY's phone settings: sm phone [--pin 1234 | --no-pin] [--owner-name Alex] [--transfer contacts|urgent|never]
  async phone(args) {
    const { flags } = parseFlags(args);
    const S = require('./secretary.js').createSecretary(ROOT);
    const b = {}; if (typeof flags.pin === 'string' || typeof flags.pin === 'number') b.pin = String(flags.pin); if (flags['no-pin']) b.pin = '';
    if (typeof flags['owner-name'] === 'string') b.ownerName = flags['owner-name']; if (typeof flags.transfer === 'string') b.transfer = flags.transfer; if (typeof flags.model === 'string') b.voiceModel = flags.model;
    if (flags.off) b.off = true; if (flags.on) b.off = false;
    const s = S.phoneSettings(Object.keys(b).length ? b : undefined);
    if (flags.off || flags.on) { // takes effect at Twilio right away, office running or not
      const T = require('./tunnel.js').createTunnel(ROOT, { log: () => {} });
      if (flags.off) { await T.park(); console.log('📵 Phone line OFF: every call to the number gets a busy signal. IVY places no calls (callouts, call reminders, urgent calls); Telegram still works. Turn it back on: sm phone --on'); }
      else { const r = await T.check(); console.log(r.ok ? `📞 Phone line ON at ${r.hostname}: IVY answers again.` : `❌ Phone line switched on, but it isn't reachable yet: ${r.reason}. Run: sm tunnel --fix`); }
      return;
    }
    console.log(`Phone: ${s.off ? 'OFF (sm phone --on) · ' : ''}owner "${s.ownerName || '(from git: first name)'}" · PIN ${s.pinSet ? 'set (say "it\'s me" from any phone)' : 'not set'} · put through: ${({ contacts: 'known contacts + urgent callers', urgent: 'urgent callers only', never: 'nobody' })[s.transfer]} · voice brain: ${s.voiceModel}`);
  },

  // IVY's Telegram line: status/test, send a message, urgent-call settings.
  async telegram(args) {
    const { flags, rest } = parseFlags(args);
    const T = require('./telegram.js').createTelegram(ROOT);
    const G = require('./ivy-telegram.js').createIvyTelegram(ROOT, { tg: T });
    const s = G.settings({ ...(flags.escalate !== undefined ? { escalateMin: flags.escalate } : {}), ...(flags.quiet !== undefined ? { quiet: flags.quiet === true ? '' : flags.quiet } : {}), ...(flags['no-call'] ? { callOnUrgent: false } : {}), ...(flags.call ? { callOnUrgent: true } : {}) });
    if (!T.linked()) throw new Error('Link Telegram first: Zoo → Telegram the Penguin (bot_token + default_chat_id).');
    if (flags.menu) { await G.sendMenu(); await T.setCommands(require('./ivy-telegram.js').COMMANDS); console.log('📲 sent the quick buttons and set the / menu'); }
    if (flags.test) { const me = await T.api('getMe'); await T.send("Hi, it's Ivy. Telegram line test: you can talk to me here."); console.log(`✅ @${me.username} sent a test message to your chat`); }
    const text = rest.join(' ').trim(); if (text) { await T.send(text); console.log('💬 sent'); }
    console.log(`Telegram: linked · urgent questions ${s.callOnUrgent ? `call you after ${s.escalateMin} min without a reply` : 'never call'}${s.quiet ? ` (quiet ${s.quiet})` : ''}`);
  },

  // IVY's morning brief: `sm today` prints it, `--send` WhatsApps it now.
  async today(args) {
    const { flags } = parseFlags(args);
    const api = require('./sm-api.js').createApi(module.exports);
    await api.ivyDay.prepare();
    if (flags.send) { const r = await api.ivyDay.sendBrief(); console.log(`💬 sent:\n${r.sent}`); return; }
    const b = api.ivyDay.brief(); console.log(b.text); console.log(`\n🗣  ${b.spoken}`);
  },

  // A reminder IVY sends on WhatsApp (or calls with --call) when the office is running: sm remind "Call Dana" --at 09:45
  remind(args) {
    const { flags, rest } = parseFlags(args);
    const S = require('./secretary.js').createSecretary(ROOT);
    if (flags.list) { for (const r of S.reminders()) console.log(`${r.id}  ${new Date(r.at).toLocaleString('en-GB')}  ${r.via}  ${r.text}`); return; }
    if (typeof flags.cancel === 'string') { S.removeReminder(flags.cancel); console.log('cancelled'); return; }
    const text = rest.join(' ').trim(); let at = String(flags.at || '');
    if (!text || !at) throw new Error('usage: sm remind "<text>" --at <HH:MM | ISO date-time> [--call] | --list | --cancel <id>');
    if (/^\d{1,2}:\d{2}$/.test(at)) { const [h, m] = at.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); at = d.toISOString(); }
    const r = S.addReminder({ text, at, via: flags.call ? 'call' : 'whatsapp' });
    console.log(`⏰ ${r.via === 'call' ? 'IVY will call you' : 'IVY will WhatsApp you'} at ${new Date(r.at).toLocaleString('en-GB')}: ${r.text}`);
  },

  // Ported from jarvis-notch: keep the Mac awake for long missions, and gentle break nudges from IVY.
  awake(args) {
    const { flags, rest } = parseFlags(args); const W = require('./wellbeing.js').createWellbeing(ROOT); const sub = rest[0] || 'status';
    if (sub === 'on') { const a = W.awakeOn(flags.hours); console.log(`☕ Mac kept awake until ${new Date(a.until).toLocaleTimeString('en-GB')}`); return; }
    if (sub === 'off') { W.awakeOff(); console.log('😴 keep-awake off'); return; }
    const a = W.awake(); console.log(a.on ? `☕ awake until ${new Date(a.until).toLocaleTimeString('en-GB')}` : 'keep-awake is off');
  },
  // Ported from jarvis-notch: everyday utilities (no Swift, no AI). Personal state is gitignored under office/.
  async convert(args) { const T = require('./toolbelt.js').createToolbelt(ROOT); const r = await T.convert(args[0], args[1], args[2]); console.log(`💱 ${r.amount} ${r.from} = ${r.result} ${r.to}  (rate ${r.rate})`); },
  async weather(args) { const T = require('./toolbelt.js').createToolbelt(ROOT); const w = await T.weather(args.join(' ') || undefined); console.log(`🌤  ${T.weatherLine(w)} · feels ${Math.round(w.feels)}° · wind ${w.wind} km/h`); },
  async shelf(args) {
    const T = require('./toolbelt.js').createToolbelt(ROOT); const [sub, arg] = args;
    if (sub === 'add') console.log('📎 shelved →', T.shelf.add(arg));
    else if (sub === 'rm') { T.shelf.remove(arg); console.log('removed', arg); }
    else { const l = T.shelf.list(); console.log(l.length ? l.map((f) => `📎 ${f.name} (${f.size} B)`).join('\n') : 'shelf is empty — sm shelf add <file>  (files live in office/shelf)'); }
  },
  async clip(args) {
    const T = require('./toolbelt.js').createToolbelt(ROOT);
    if (args[0] === 'save') { const e = await T.clip.save(); console.log(e ? `📋 saved: ${e.text.slice(0, 80)}` : 'clipboard empty'); return; }
    const h = T.clip.list(); console.log(h.length ? h.map((e, i) => `${i + 1}. ${e.at.slice(11, 16)} ${e.text.replace(/\s+/g, ' ').slice(0, 90)}`).join('\n') : 'no history — `sm clip save` snapshots the clipboard');
  },
  async cal(args) { const T = require('./toolbelt.js').createToolbelt(ROOT); const ev = await T.calendar(args[0]); console.log(ev.length ? ev.map((e) => `📅 ${e.when.replace('T', ' ').slice(0, 16)}  ${e.title}`).join('\n') : 'nothing on Apple Calendar in that window'); },
  // The whatsapp-mcp-ai daemon glance (Gmail today, tracked packages). `link` copies only its WHATSAPP_SERVICE_SECRET.
  async jarvis(args) {
    const T = require('./toolbelt.js').createToolbelt(ROOT); const sub = args[0] || 'status';
    if (sub === 'link') { const r = T.link(); console.log(`🔗 linked to ${r.url} (secret copied from ../whatsapp-mcp-ai/.env into office/jarvis.json, gitignored)`); return; }
    if (sub === 'mail') { const m = await T.mailToday(args[1]); console.log(m.length ? m.map((x) => `✉️  ${x.from || x.sender || ''} — ${x.subject || ''}`).join('\n') : 'no mail today'); return; }
    if (sub === 'tracking') { const t = await T.tracking(); console.log(`📦 ${t.packages.length} package(s) · ${t.subscriptions.length} subscription(s) · ${t.flights.length} flight(s)`); for (const p of t.packages) console.log('  ', p.carrier || '', p.trackingNumber || p.title || '', p.status || ''); return; }
    console.log(T.linked() ? '🟢 linked to the jarvis daemon (sm jarvis mail | tracking)' : '⚪ not linked — run `sm jarvis link`');
  },
  breaks(args) {
    const { flags, rest } = parseFlags(args); const W = require('./wellbeing.js').createWellbeing(ROOT); const sub = rest[0] || 'status';
    const s = sub === 'on' || sub === 'off' || flags.every || flags.from || flags.to ? W.setBreaks({ on: sub === 'on' ? true : sub === 'off' ? false : undefined, everyMin: flags.every, from: flags.from, to: flags.to }) : W.state().breaks;
    console.log(`👀 break nudges ${s.breaksOn ? 'ON' : 'off'} · every ${s.everyMin} min · ${s.from}:00-${s.to}:00 (IVY texts you; the office must be running)`);
  },

  // Zoo integrations: `sm integration` lists, `sm integration get <id>` prints the stored keys as JSON (for workers).
  async integration([sub, id]) {
    const I = require('./integrations.js').createIntegrations(ROOT);
    if (sub === 'test') {
      let bad = 0;
      for (const c of I.list().filter((x) => x.linked && (!id || x.id === id))) { const r = await I.check(c.id); if (!r.ok) bad++; console.log(`${r.ok ? '✅' : '❌'} ${c.id.padEnd(9)} ${r.detail}`); }
      if (bad) process.exitCode = 1;
      return;
    }
    if (sub === 'get') { console.log(JSON.stringify(I.get(id), null, 2)); return; }
    for (const c of I.list()) console.log(`${c.linked ? '🟢' : '⚪'} ${c.id.padEnd(9)} ${c.name} — ${c.service}`);
  },

  keywords([name, ...words]) {
    const p = loadProject(name);
    if (words.length) { p.config.keywords = words; writeJSON(path.join(p.dir, 'config.json'), p.config); }
    console.log(`${name} routing keywords: ${(p.config.keywords || []).join(', ') || '(none — only its name)'}`);
  },

  // Start a background supervised run in every active project that has work for Claude and isn't already running.
  dispatch(args) {
    const { flags } = parseFlags(args);
    commands.ingest();
    for (const n of listProjects()) {
      const p = loadProject(n);
      if (!p.config.active || p.config.autoDispatch === false) { console.log(`⏸  ${n}: skipped (paused / autoDispatch off)`); continue; }
      if (isRunning(p)) { console.log(`🏃 ${n}: already running (pid ${p.state.runPid})`); continue; }
      const t = readTasks(p);
      const work = usesBeads(p) ? t.ready.length : t.open.length;
      if (!work) { console.log(`✅ ${n}: nothing for Claude${t.human.length ? ` (${t.human.length} waiting on you)` : ''}`); continue; }
      if (flags['dry-run']) { console.log(`→ ${n}: would start (${work} task(s) ready)`); continue; }
      fs.mkdirSync(path.join(p.dir, 'runs'), { recursive: true });
      const log = path.join(p.dir, 'runs', `${stamp()}.log`);
      const fd = fs.openSync(log, 'a');
      const child = require('child_process').spawn(process.execPath, [SELF, 'run', n], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      console.log(`🚀 ${n}: started (${work} task(s) ready) → log ${log}`);
    }
  },

  // Daily standup note (yesterday / today / blocked) → standup/YYYY-MM-DD.md + latest.md. --force rewrites today's.
  standup(args) {
    const { flags } = parseFlags(args);
    const r = require('./standup.js').createStandup(module.exports).generate({ force: Boolean(flags.force) });
    console.log(r.text);
    console.log(`${r.created ? '📝 wrote' : '📄 already written today:'} ${path.relative(ROOT, r.file)}`);
  },

  list() { commands.status([]); },

  status([name]) {
    if (!name) commands.ingest();
    const names = name ? [name] : listProjects();
    if (!names.length) return console.log('No projects yet. Add one: sm add ../fuel-app');
    for (const n of names) {
      const p = loadProject(n);
      let t;
      try { t = readTasks(p); } catch (e) { console.log(`⚠️  ${n}: ${e.message}`); continue; }
      const r = p.state.lastResults || [];
      const qa = r.length ? (r.every((x) => x.ok) ? '✅ green' : `❌ ${r.filter((x) => !x.ok).map((x) => x.name).join(', ')}`) : '— not run';
      const flag = isRunning(p) ? '🏃' : p.config.active ? '▶️ ' : '⏸ ';
      const st = overallStatus(p, r, t, p.state.lastVerdict);
      console.log(`${flag} ${n.padEnd(16)} ${st.padEnd(20)} QA ${qa.padEnd(14)} required ${t.done.length}/${t.done.length + t.open.length} done  human ${t.human.length}  suggestions ${t.suggestions.length}  audited ${p.state.lastAudit?.at || 'never'}`);
    }
    const inbox = path.join(ROOT, 'INBOX.md');
    const waiting = fs.existsSync(inbox) ? fs.readFileSync(inbox, 'utf8').split('\n').filter((l) => l.startsWith('- [ ] ')).length : 0;
    if (waiting && !name) console.log(`📥 ${waiting} unrouted item(s) in INBOX.md — sm triage`);
  },

  async hook([event, name]) {
    try {
      if (event === 'session-start') await hookSessionStart(name);
      else if (event === 'stop') await hookStop(name);
      else if (event === 'guard') await hookGuard(name);
    } catch (e) {
      // Never break the user's Claude session because of a supervisor bug.
      process.stderr.write(`[success-manager] ${e.message}\n`);
    }
  },

  // Pixel Agents (github.com/pixel-agents-hq/pixel-agents): every Claude session — builders and reviewers —
  // becomes a pixel character. Watch-only (--no-terminal); its hooks need approval in its own UI.
  async watch(args) {
    const { flags } = parseFlags(args);
    const port = Number(flags.port || 4777);
    const home = require('os').homedir();
    const up = async () => { try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
    if (!(await up())) {
      if (spawnSync('pixel-agents', ['--help']).status !== 0) throw new Error('pixel-agents is not installed: npm install -g pixel-agents');
      const log = fs.openSync(path.join(ROOT, '.pixel-agents.log'), 'a');
      require('child_process').spawn('pixel-agents', ['--port', String(port), '--no-terminal'], { cwd: path.dirname(ROOT), detached: true, stdio: ['ignore', log, log] }).unref();
      for (let i = 0; i < 30 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    let token = '';
    try { token = fs.readFileSync(path.join(home, '.pixel-agents', 'standalone-token'), 'utf8').trim(); } catch {}
    const url = `http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    console.log(`👾 Pixel Agents on 127.0.0.1:${port} — opened in your browser (the URL carries a private token; don't share it).`);
    console.log(`   Tip: Settings → "Watch All Sessions" so builders/reviewers in every project folder show up.`);
  },

  // The main UI: our Pixel Agents fork (pixel-office/) with the crew, Tasks and Terminal dock built in.
  async office(args) {
    const { flags } = parseFlags(args);
    const port = Number(flags.port || 4777);
    if (flags.check) return officeCheck(port, flags.screenshot, flags.wait);
    if (flags.browse) {
      // Opens the LIVE office in a playwright-cli session so agents can click through it like the owner does.
      // The private token goes straight to the browser — never printed, so it never lands in logs or the live feed.
      const sess = String(flags.browse === true ? 'office' : flags.browse).replace(/[^\w.-]/g, '').slice(0, 40) || 'office';
      let token = '';
      try { token = fs.readFileSync(path.join(require('os').homedir(), '.pixel-agents', 'standalone-token'), 'utf8').trim(); } catch { /* none */ }
      // Chrome for Testing (if installed) is a separate app — a test browser must never take over the owner's Chrome
      const r = spawnSync('playwright-cli', [`-s=${sess}`, 'open', `http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`, ...(hasTestBrowser() ? ['--browser=chromium'] : [])], { encoding: 'utf8', timeout: 90000 });
      if (r.status !== 0) { console.error(`Could not open the office in a browser: ${(r.stderr || r.stdout || '').replace(/token=[^\s&"']+/g, 'token=…').slice(-300)}`); process.exit(1); }
      spawnSync('playwright-cli', [`-s=${sess}`, 'resize', '1600', '960'], { encoding: 'utf8', timeout: 30000 });
      console.log(`The live office is open in browser session "${sess}". Drive it with: playwright-cli -s=${sess} snapshot | click <ref> | fill <ref> <text> | screenshot --filename /tmp/x.png | console error | close`);
      return;
    }
    const dir = path.join(ROOT, 'pixel-office');
    const cli = path.join(dir, 'dist', 'cli.js');
    // Several teammates may rebuild/restart at once on a big mission: take turns, or builds and restarts collide.
    const lockDir = path.join(ROOT, '.office-build.lock');
    const lockAlive = () => { try { const pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    if (flags.build || flags.restart) {
      for (let waited = 0; ; waited += 2) {
        try { fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid)); break; } catch { /* held */ }
        if (!lockAlive()) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; } // holder died
        if (waited === 0) console.log('⏳ A teammate is rebuilding the office — waiting for my turn…');
        if (waited > 900) throw new Error('Waited 15 minutes for another office rebuild to finish.');
        await new Promise((r) => setTimeout(r, 2000));
      }
      process.on('exit', () => { try { if (fs.readFileSync(path.join(lockDir, 'pid'), 'utf8') === String(process.pid)) fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* gone */ } });
    }
    if (flags.build || !fs.existsSync(cli)) {
      console.log('🔨 Building the office (server + webview)…');
      for (const [cwd, cmd] of [[dir, ['node', 'esbuild.js']], [path.join(dir, 'webview-ui'), ['npm', 'run', 'build']]]) {
        const r = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
        if (r.status !== 0) throw new Error(`build failed in ${cwd}`);
      }
    }
    const up = async () => { try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
    // Stop whatever office holds the port — decided by who LISTENS on it, not by a health check: right after a heavy
    // build a busy server can miss the health timeout, and "not up" then skipped the kill and left the old server
    // running (the new build never went live). Only node processes running a Pixel Agents cli.js are touched.
    const listeners = () => spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    if (flags.restart && listeners().length) {
      for (const pid of listeners()) {
        const cmd = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).stdout;
        if (/node/.test(cmd) && /cli\.js/.test(cmd)) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
      }
      for (let i = 0; i < 40 && listeners().length; i++) await new Promise((r) => setTimeout(r, 250));
      if (listeners().length) throw new Error(`Something else is still using port ${port}; stop it and run sm office again.`);
    }
    if (!listeners().length && !(await up())) {
      const log = fs.openSync(path.join(ROOT, '.pixel-office.log'), 'a');
      // Terminals on: "+ Agent" launches a real Claude session you can type to from the office (token-gated).
      spawn(process.execPath, [cli, '--port', String(port), ...(flags['no-terminal'] ? ['--no-terminal'] : [])], {
        cwd: path.dirname(ROOT), detached: true, stdio: ['ignore', log, log], env: { ...process.env, SM_ROOT: ROOT },
      }).unref();
      for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    let token = '';
    try { token = fs.readFileSync(path.join(require('os').homedir(), '.pixel-agents', 'standalone-token'), 'utf8').trim(); } catch {}
    const url = `http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    if (process.platform === 'darwin' && !flags['no-open']) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    console.log(`🏢 Office on 127.0.0.1:${port} — opened in your browser (the URL has a private token; don't share it).`);
    console.log(`   Rebuild after changing pixel-office/: sm office --build --restart`);
  },

  // Mac app: ~/Applications/AI Office.app + Dock icon (see office-app.js). `--uninstall` removes both.
  app(args) { require('./office-app.js').main(parseFlags(args).flags); },

  dashboard(args) { require('./dashboard-server.js').start({ ...parseFlags(args).flags, sm: module.exports }); },

  help() {
    console.log(`Success Manager
  sm add <path> [--beads] [--name n] [--goal "..."] [--qa "cmd"]...  start managing a project
  sm status [name]                                           overview of all projects
  sm qa <name>                                               run QA now and print the report
  sm set-qa <name> "<cmd>" ["<cmd>"...]                      replace QA commands
  sm set <name> allowPush|fullAccess|maxFixRounds|missionBudgetUsd|firebaseAccount <value>   owner switches (e.g. firebaseAccount you@gmail.com)
  sm convert <amount> <FROM> <TO>                           currency conversion (from jarvis-notch)
  sm weather [city]                                          weather now + today's range (default Tel Aviv)
  sm shelf [add <file>|rm <name>]                            file shelf: park files in office/shelf
  sm clip [save]                                             clipboard history (save snapshots the current clipboard)
  sm cal [hours]                                             upcoming Apple Calendar events (default 24h)
  sm jarvis [link|mail|tracking]                             Gmail today + tracked packages via the whatsapp-mcp-ai daemon
  sm awake [on [--hours n]|off|status]                       keep the Mac awake for long missions (from jarvis-notch)
  sm breaks [on|off] [--every min] [--from h] [--to h]       IVY's 20-20-20 break nudges during work hours (from jarvis-notch)
  sm app [--no-dock] [--uninstall]                           install the office as a Mac app (AI Office.app) pinned to the Dock
  sm office --browse <session>                               open the live office in a playwright-cli session
  sm terminal "<sign-in command>" [--cwd dir]              open Terminal with a sign-in for the owner (firebase login, gh auth login …)
  sm errors [--approve <id>|--dismiss <id>]                 TRACE's error log; approving opens a fix mission for ARES
  sm learn "<lesson>" [--kind prompt|error|info] [--list]   the learning box every teammate reads
  sm ares [--fix] [--json]                                   ARES's health checks (missions, servers, clones, secrets, flow)
  sm run <name> [--no-audit] [--prompt ".."] [-- <claude flags>]  full loop: audit → build → re-audit until ready
  sm audit <name> [--agents code,ui,ux,functionality,marketing]  read-only reviewer agents file tasks
  sm preview <name> --url URL [--cmd "dev server"] [--paths /,/x]  live web app: browser smoke QA + reviewers get a browser
  sm smoke <name>                                            load each page headless: console errors / failed requests = fail
  sm task "<title>" [--project n] [-p 0-4] [--desc ".."] [--source s] [--human]   add work (auto-routed)
  sm ask <project> <id> --what .. --why .. --step .. --done .. --reply ..   explain a human task like you're 5
  sm manage "<request>" [--project p]                       give the Floor Manager a mission
  sm meeting <project> "<title>" [--video f.mp4] [--pdf f.pdf] [--say ".."]   call you into the conference room (--list, --end <id>)
  sm mission-list [project]                                  recent missions
  sm triage [<number> <project>]                             route unrouted INBOX.md items
  sm call "<text>" [--to +n] [--whatsapp] | --status        ARES phones (or WhatsApps) the owner via Twilio + ElevenLabs
  sm pulse [--refresh] [--all] [--json]                     your dev day: every local repo + GitHub (failing CI, unpushed, uncommitted, alerts)
  sm tunnel [--fix]                                         the phone line's public address (Cloudflare tunnel); --fix restarts it and re-points Twilio
  sm phone [--off|--on] [--pin 1234|--no-pin] [--owner-name N] [--transfer contacts|urgent|never] [--model haiku|sonnet]   IVY's phone settings (PIN for calling from other phones)
  sm telegram [--test] [--menu] ["<text>"] [--escalate <min>] [--quiet HH:MM-HH:MM] [--no-call|--call]   IVY's Telegram line
  sm today [--send]                                         IVY's morning brief (calendar, needs-you, code, overnight); --send WhatsApps it
  sm remind "<text>" --at <HH:MM|ISO> [--call] | --list     IVY reminds you on WhatsApp (or calls) at that time
  sm integration [get <id>|test [id]]                       Zoo integrations (WhatsApp, Google, ...): list / print linked keys / live-test them
  sm doctor                                                 check this machine is ready (Node, Claude CLI, build, .env)
  sm firebase [link f.json|push|pull|unlink]                encrypted Firebase backup of your linked integrations
  sm voiceover "<text>" --out f.mp3 [--voice id]            ElevenLabs narration mp3 for a video
  sm keywords <name> [word...]                               routing keywords for sm task
  sm ingest                                                  enroll projects symlinked into project_inbox/
  sm office [--build] [--restart] [--no-terminal] [--port 4777]  THE office: Pixel Agents + crew + Tasks/Terminal dock
  sm office --check [--screenshot /tmp/office.png]           test the LIVE office (current build, every project, browser)
  sm watch [--port 4777]                                     stock Pixel Agents (no Success Manager)
  sm dashboard [--port 4321] [--no-open]                     task queue, QA, costs, logs + trigger reviewers
  sm dispatch [--dry-run]                                    start Claude in every project with ready work
  sm pause <name> | sm resume <name>                         toggle supervision
  sm remove <name>                                           uninstall hooks from the project`);
  },
};

module.exports = { LOGIN_CMD, OWNER_TOOLS, hasTestBrowser, parseFlags, pushVerdict, firebaseVerdict, ROOT, PROJECTS, SELF, AGENTS_DIR, loadProject, listProjects, readTasks, isRunning, overallStatus, usesBeads, bd, readJSON, now, runQA, fingerprint, saveState };

if (require.main === module) (async () => {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) { commands.help(); process.exit(1); }
  try { await fn(args); } catch (e) { console.error(`✖ ${e.message}`); if (process.env.SM_DEBUG) console.error(e.stack); process.exit(1); }
})();

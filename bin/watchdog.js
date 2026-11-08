/**
 * ARES's watch — the floor manager supervising the office the way a careful engineer would: after every mission
 * and every few minutes he checks that missions, processes and the office itself are healthy, finds flow bugs
 * (wasted rounds, flaky checks, guard fights, unchecked UI work, uncommitted work, leaked secrets) and fixes what
 * is safe to fix. Every check is a plain script — no AI tokens — so it can run all the time.
 *
 * findings: { id, severity: 'critical'|'warn'|'info', title, detail, fix? }  (title/detail in plain English)
 * fix mode only does safe things: stop stray office servers and duplicate mission runners that the office itself
 * started, and mark missions whose runner died as stalled (so Resume appears). Everything else is reported.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAIN_PORT = 4777;
const RECENT_MS = 12 * 3600 * 1000; // flow checks look at missions that finished in the last 12 h
const ACTIVE = ['queued', 'planning', 'working', 'checking', 'paused', 'reviewing'];
const CLONE_LIMIT = 10;

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts });
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

/** Every running process: [{ pid, started, cmd }]. */
function processes() {
  const out = sh('ps', ['-axo', 'pid=,lstart=,command=']).stdout || '';
  return out.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    return m ? { pid: Number(m[1]), started: new Date(m[2]), cmd: m[3] } : null;
  }).filter(Boolean);
}

function isHeadless(jsonl) {
  try {
    const fd = fs.openSync(jsonl, 'r'); const buf = Buffer.alloc(16384); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    return /"entrypoint"\s*:\s*"sdk-cli"/.test(buf.subarray(0, n).toString('utf8'));
  } catch { return false; }
}

function createWatchdog(sm) {
  const { ROOT, listProjects, loadProject } = sm;
  const officeDir = path.join(ROOT, 'pixel-office');
  const missionsOf = (name) => {
    const dir = path.join(ROOT, 'projects', name, 'missions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^m-[\w-]+\.json$/.test(f)).map((f) => ({ file: path.join(dir, f), m: readJSON(path.join(dir, f), null) })).filter((x) => x.m);
  };

  // ── checks ────────────────────────────────────────────────────────────────
  function checkRunners(procs, findings, fix) {
    const runners = procs.filter((p) => /bin\/sm\.js mission-run /.test(p.cmd));
    const byMission = new Map();
    for (const r of runners) { const id = r.cmd.trim().split(/\s+/).pop(); byMission.set(id, [...(byMission.get(id) || []), r]); }
    for (const name of listProjects()) for (const { file, m } of missionsOf(name)) {
      const mine = byMission.get(m.id) || [];
      const extra = mine.filter((r) => r.pid !== m.runnerPid);
      if (extra.length && alive(m.runnerPid)) {
        findings.push({ id: `dup-runner:${m.id}`, severity: 'critical', title: `${extra.length + 1} copies of one mission are running`, detail: `Mission "${m.prompt.slice(0, 60)}" has extra runners (pids ${extra.map((r) => r.pid).join(', ')}) besides its real one (${m.runnerPid}). They spend usage and overwrite each other.`, fix: 'stop the extra copies' });
        if (fix) for (const r of extra) { try { process.kill(r.pid, 'SIGTERM'); } catch { /* gone */ } }
      }
      if ([...ACTIVE, 'waiting_human'].includes(m.status) && m.runnerPid && !alive(m.runnerPid)) {
        findings.push({ id: `dead-runner:${m.id}`, severity: m.status === 'waiting_human' ? 'warn' : 'critical', title: 'A mission lost its runner', detail: `"${m.prompt.slice(0, 60)}" says "${m.status}" but nothing is running it, so answers and cancels go nowhere.`, fix: 'mark it stalled so Resume / Cancel work' });
        if (fix) { m.status = 'stalled'; m.updatedAt = new Date().toISOString(); fs.writeFileSync(`${file}.tmp`, JSON.stringify(m, null, 2)); fs.renameSync(`${file}.tmp`, file); }
      }
    }
  }

  function checkServers(procs, findings, fix) {
    // office servers only: node running pixel-office's dist/cli.js (also when started as a relative `node dist/cli.js`)
    const cwdOf = (pid) => ((sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout || '').split('\n').find((l) => l.startsWith('n')) || '').slice(1);
    const servers = procs.filter((p) => {
      const [bin, script] = p.cmd.split(/\s+/);
      if (path.basename(bin || '') !== 'node' || !/(^|\/)dist\/cli\.js$/.test(script || '')) return false;
      return script.includes('pixel-office/dist/cli.js') || cwdOf(p.pid) === officeDir;
    });
    const listening = (sh('lsof', ['-nP', `-iTCP:${MAIN_PORT}`, '-sTCP:LISTEN', '-t']).stdout || '').split('\n').filter(Boolean).map(Number);
    const strays = servers.filter((p) => !listening.includes(p.pid));
    if (strays.length) {
      findings.push({ id: 'stray-server', severity: 'critical', title: `${strays.length} extra office server${strays.length > 1 ? 's are' : ' is'} running`, detail: `Started outside "sm office" (${strays.map((p) => `pid ${p.pid}: ${p.cmd.slice(0, 60)}`).join('; ')}). An old server keeps adopting sessions and overwriting the office's saved state.`, fix: 'stop them' });
      if (fix) for (const p of strays) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
    }
    const main = servers.find((p) => listening.includes(p.pid));
    if (!main) { findings.push({ id: 'office-down', severity: 'warn', title: 'The office is not running', detail: 'Nothing is serving the office.', fix: 'sm office --build --restart --no-open' }); return; }
    try {
      const built = fs.statSync(path.join(officeDir, 'dist', 'cli.js')).mtime;
      if (main.started < built) findings.push({ id: 'stale-server', severity: 'warn', title: 'The office is running an old build', detail: `Server started ${main.started.toLocaleTimeString()}, build is from ${built.toLocaleTimeString()} — the newest changes are not live.`, fix: 'sm office --restart --no-open' });
    } catch { /* not built */ }
  }

  /**
   * Test browsers left open after a mission. playwright-cli drives the owner's REAL Google Chrome app by default;
   * while such a hidden copy runs and the owner's own Chrome is closed, macOS hands every "open Chrome" (Dock,
   * links) to the hidden copy — Chrome seems not to open at all. Close them once no mission is running.
   */
  function checkBrowsers(findings, fix, missionRunning) {
    const out = sh('playwright-cli', ['list']).stdout || '';
    const open = [...out.matchAll(/^- ([\w.-]+):\s*\n\s*- status: open/gm)].map((m) => m[1]);
    if (!open.length) return;
    findings.push({ id: 'browser-sessions', severity: missionRunning ? 'info' : 'warn', title: `${open.length} test browser${open.length > 1 ? 's were' : ' was'} left open`, detail: `playwright-cli session${open.length > 1 ? 's' : ''} ${open.join(', ')}. Left open, a hidden test browser can stop your own Chrome from opening.`, fix: missionRunning ? 'close after the running mission' : 'close them' });
    if (fix && !missionRunning) for (const name of open) sh('playwright-cli', [`-s=${name}`, 'close']);
  }

  function checkClones(findings) {
    const state = readJSON(path.join(os.homedir(), '.pixel-agents', 'standalone-state.json'), {});
    const agents = Array.isArray(state.agents) ? state.agents : Object.values(state.agents || {});
    const headless = agents.filter((a) => a.isExternal && a.jsonlFile && isHeadless(a.jsonlFile));
    if (headless.length > CLONE_LIMIT || agents.length > 40) findings.push({ id: 'clones', severity: 'warn', title: `The office is crowded with ${agents.length} extra characters`, detail: `${headless.length} of them are scripted runs (headless sessions) that should never show up as characters.`, fix: 'stop stray servers, then sm office --restart --no-open (restore drops headless runs)' });
  }

  function checkUncommitted(findings) {
    const dirty = (dir, rel = '.') => (sh('git', ['-C', dir, 'status', '--porcelain', '--', rel]).stdout || '').split('\n').filter((l) => l && !/^\?\? .*\.(log|lock)$/.test(l));
    const outer = dirty(ROOT).filter((l) => !/office\/staff\.json$/.test(l)); // looks edited in the panel are the owner's
    const inner = fs.existsSync(path.join(officeDir, '.git')) ? dirty(officeDir) : [];
    const n = outer.length + inner.length;
    if (n) findings.push({ id: 'uncommitted', severity: 'info', title: `${n} uncommitted change${n > 1 ? 's' : ''} in the office's code`, detail: [...outer.map((l) => l.slice(3)), ...inner.map((l) => `pixel-office/${l.slice(3)}`)].slice(0, 8).join(', '), fix: 'commit them (pixel-office/ is its own repo)' });
  }

  function checkSecrets(findings) {
    let token = '';
    try { token = fs.readFileSync(path.join(os.homedir(), '.pixel-agents', 'standalone-token'), 'utf8').trim(); } catch { return; }
    if (token.length < 16) return;
    const hits = [];
    for (const dir of [ROOT, officeDir]) {
      const files = (sh('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard']).stdout || '').split('\n').filter(Boolean);
      for (const f of files.slice(0, 500)) {
        const full = path.join(dir, f);
        try { if (fs.statSync(full).size < 1e6 && fs.readFileSync(full, 'utf8').includes(token)) hits.push(path.relative(ROOT, full)); } catch { /* skip */ }
      }
    }
    if (hits.length) findings.push({ id: 'secret', severity: 'critical', title: 'The office login token is written into a file', detail: `${hits.join(', ')} contains the private office token (likely an agent's test script).`, fix: 'delete the file (only the owner should)' });
  }

  /**
   * Home vs workplace: the office is the team's home; a client project's material (its videos, screenshots, scripts,
   * notes) belongs in that project's folder. Flags office files named after a project or pointing into its folder.
   * The office's records about projects (projects/), its docs and its skills may name them; those are skipped.
   */
  function checkProjectLeaks(findings) {
    const real = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(d); } };
    const home = real(ROOT);
    const clients = listProjects().map((name) => { try { return { name, dir: real(loadProject(name).config.path) }; } catch { return null; } })
      .filter((x) => x && x.dir !== home && !home.startsWith(x.dir + path.sep));
    if (!clients.length) return;
    const files = [...new Set(['ls-files', 'ls-files --others --exclude-standard'].flatMap((a) => (sh('git', ['-C', ROOT, ...a.split(' ')]).stdout || '').split('\n')))]
      .filter((f) => f && !/^(projects|lat\.md|office\/departments|office\/watch|test|node_modules)\/|\/node_modules\//.test(f) && !/\.(md)$/.test(f));
    const hits = new Map();
    for (const c of clients) {
      const stem = c.name.split(/[-_.]/)[0];
      const named = new RegExp(`(^|[/_.-])(${c.name}${stem.length >= 4 ? `|${stem}` : ''})([/_.-]|$)`, 'i');
      for (const f of files) {
        let why = named.test(f) ? 'named after it' : '';
        if (!why && /\.(m?[jt]sx?|json|sh|py)$/.test(f)) {
          try { const full = path.join(ROOT, f); if (fs.statSync(full).size < 2e5 && fs.readFileSync(full, 'utf8').includes(c.dir + '/')) why = 'points into its folder'; } catch { /* skip */ }
        }
        if (why) hits.set(f, `${c.name} (${why})`);
      }
    }
    if (!hits.size) return;
    const list = [...hits].slice(0, 12).map(([f, w]) => `${f} → ${w}`);
    findings.push({ id: 'project-in-office', severity: 'warn', title: `${hits.size} file(s) in the office belong to a project`, detail: `The office is home; project material belongs in the project's folder: ${list.join('; ')}${hits.size > 12 ? ' …' : ''}`, fix: 'move them into that project (and out of the office repo)' });
  }

  function checkFlow(findings) {
    const since = Date.now() - RECENT_MS;
    for (const name of listProjects()) for (const { file, m } of missionsOf(name)) {
      if (!m.finishedAt || Date.parse(m.finishedAt) < since) continue;
      const base = file.replace(/\.json$/, '');
      const streams = (() => { try { return fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${m.id}.`) && f.endsWith('.stream.jsonl')).map((f) => fs.readFileSync(path.join(path.dirname(file), f), 'utf8')).join('\n'); } catch { return ''; } })();
      const label = `"${m.prompt.replace(/\s+/g, ' ').slice(0, 50)}"`;
      // a fix round sent by the QA script that changed nothing = a flaky check, not a real bug
      for (const h of m.loop?.history || []) {
        if (h.by !== 'the QA script') continue;
        const rework = (m.subtasks || []).find((s) => s.kind === 'rework' && s.title.startsWith(`Fix round ${h.round}:`));
        if (rework?.result && !(rework.result.files_changed || []).length) findings.push({ id: `flaky-qa:${m.id}:${h.round}`, severity: 'warn', title: 'A QA failure wasted a fix round', detail: `${label}: the QA script failed (${h.issues.join('; ')}) but the fix changed nothing — likely a flaky check. Cost ~$${(rework.cost || 0).toFixed(2)}.`, fix: 'make that QA step reliable' });
      }
      const denials = (streams.match(/Success Manager: [^"\\]{0,80}/g) || []);
      if (denials.length >= 3) findings.push({ id: `guard-fights:${m.id}`, severity: 'warn', title: 'Agents kept hitting the guard', detail: `${label}: ${denials.length} blocked commands, e.g. "${denials[0].replace('Success Manager: ', '')}". Either the guard is wrong or the agents need a clearer instruction.`, fix: 'adjust the guard rule or the work prompt' });
      const uiFiles = (m.report?.changedFiles || []).some((f) => /webview-ui\/src\/|\.tsx/.test(f));
      const gates = (m.subtasks || []).filter((s) => s.kind === 'gate' && s.gate?.pass);
      if (uiFiles && gates.length && !/office --browse|playwright-cli|preview/.test(streams)) findings.push({ id: `unseen-ui:${m.id}`, severity: 'warn', title: 'A UI change passed without anyone opening it', detail: `${label} changed the interface but no check used the app in a browser.`, fix: 'send it back for a live check' });
      const cap = m.route ? { answer: 0.5, quick: 1.5, solo: 6 }[m.route.funnel] : null;
      if (cap && m.cost > cap * 0.8) findings.push({ id: `cost:${m.id}`, severity: 'info', title: 'A mission came close to its spending cap', detail: `${label} cost $${m.cost.toFixed(2)} of a $${cap} ${m.route.funnel} cap.`, fix: 'check whether it looped' });
      void base;
    }
  }

  /** Run every check; `fix` applies the safe fixes. Saves office/watch/latest.json and returns the result. */
  function run({ fix = false } = {}) {
    const findings = [];
    const procs = processes();
    const missionRunning = procs.some((p) => /bin\/sm\.js mission-run /.test(p.cmd));
    for (const c of [() => checkRunners(procs, findings, fix), () => checkServers(procs, findings, fix), () => checkBrowsers(findings, fix, missionRunning), () => checkClones(findings), () => checkUncommitted(findings), () => checkSecrets(findings), () => checkProjectLeaks(findings), () => checkFlow(findings)]) {
      try { c(); } catch (e) { findings.push({ id: `watch-error:${findings.length}`, severity: 'info', title: 'One of my checks broke', detail: String(e.message || e).slice(0, 200) }); }
    }
    const order = { critical: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const result = { at: new Date().toISOString(), fixed: fix, findings };
    const dir = path.join(ROOT, 'office', 'watch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
    fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify({ at: result.at, fixed: fix, n: findings.length, ids: findings.map((f) => f.id) }) + '\n');
    return result;
  }
  const latest = () => readJSON(path.join(ROOT, 'office', 'watch', 'latest.json'), { at: null, findings: [] });
  let timer = null;
  return {
    run, latest,
    /** Every `everyMs`, run the checks with safe fixes on (the office server calls this). */
    start(everyMs = 10 * 60 * 1000) { if (!timer) { timer = setInterval(() => { try { run({ fix: true }); } catch { /* keep going */ } }, everyMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}

module.exports = { createWatchdog, isHeadless };

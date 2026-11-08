/**
 * MUSE — Head of Future Ideas. Keeps up to IDEA_COUNT ideas PER PROJECT AND PER DEPARTMENT TAB
 * (features, design, security, quality, growth) in office/ideas/<project>.json.
 * It does NOT keep inventing: a tab stays as it is until the owner clicks "Fresh ideas" on it, which runs ONE
 * short read-only Claude pass over that project through that department's lens and skills (Sonnet, low
 * effort, small $ cap) and replaces that tab with 5 new ideas. Each idea can be refined with the owner's
 * thoughts or handed to the Planner as a mission.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IDEA_COUNT = 5;
/** Idea tabs: each is a department lens. `room` picks the skill pack MUSE borrows for that pass. */
const CATEGORIES = [
  { id: 'features', label: 'Features', room: '', focus: 'new capabilities or workflows real users of this product would ask for next' },
  { id: 'design', label: 'Design', room: 'design', focus: 'UI and UX: clearer screens, better flows, empty/loading/error states, mobile, accessibility, visual polish' },
  { id: 'security', label: 'Security', room: 'engineering', focus: 'security and privacy hardening: auth and permissions, input validation, secrets, unsafe defaults, dependency risk' },
  { id: 'quality', label: 'Bugs & quality', room: 'qa', focus: 'reliability: likely bugs, missing tests, edge cases, error handling, performance and speed' },
  { id: 'growth', label: 'Growth & copy', room: 'marketing', focus: 'copy, onboarding, SEO, sharing and anything that helps more people try and keep using it' },
];
const catOf = (c) => (CATEGORIES.some((x) => x.id === c) ? c : 'features');
const FRESH_BUDGET_USD = 0.3;

// Seed for the office itself (project "success-manager") so its list is never empty on day one.
const OFFICE_SEED = [
  ['Mission replay timeline', 'A scrubbable timeline on each finished mission showing who did what, when, and at what cost.'],
  ['Daily standup summary', 'Every morning the Floor Manager leaves a short "yesterday / today / blocked" note on the owner\'s desk.'],
  ['Cost budget alerts', 'Set a spend cap per project or per day; the office warns before a mission would exceed it.'],
  ['Mission templates', 'Save a plan (e.g. "ship a bugfix") as a reusable template the Planner can start from.'],
  ['Quick-reply chips', 'One-click answers ("yes", "skip", "do both") for common questions workers ask the owner.'],
];

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array', minItems: IDEA_COUNT, maxItems: IDEA_COUNT,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, concrete, max 60 chars.' },
          detail: { type: 'string', description: 'One or two plain sentences: what it is and why it helps.' },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['ideas'],
};

function createIdeas(root) {
  const dir = path.join(root, 'office', 'ideas');
  const now = () => new Date().toISOString();
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const safe = (project) => { const p = String(project || ''); if (!/^[\w.-]+$/.test(p)) throw bad('Choose a project first.'); return p; };
  // The office's own ideas live in office/ideas/. A client project's ideas are that project's information: they live
  // with the office's records for it (projects/<name>/), never in the office's own files.
  const HOME = 'success-manager';
  const dirOf = (project) => (safe(project) === HOME ? dir : path.join(root, 'projects', safe(project)));
  const fileOf = (project) => path.join(dirOf(project), safe(project) === HOME ? `${HOME}.json` : 'ideas.json');
  const statusOf = (project, category) => path.join(dirOf(project), `${safe(project) === HOME ? `${HOME}.` : 'ideas.'}${catOf(category)}.status.json`);
  const legacyOf = (project) => path.join(dir, `${safe(project)}.json`); // where client ideas used to be kept
  const make = (title, detail, extra = {}) => ({ id: `i-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title: clean(title, 80), detail: clean(detail, 400), thoughts: [], createdAt: now(), ...extra });

  function read(project) {
    try { const d = JSON.parse(fs.readFileSync(fileOf(project), 'utf8')); if (Array.isArray(d.active)) return { active: d.active, retired: d.retired || [] }; } catch { /* none yet */ }
    if (safe(project) !== HOME) { // move a list kept in the office's folder out to the project's records
      try {
        const old = JSON.parse(fs.readFileSync(legacyOf(project), 'utf8'));
        if (Array.isArray(old.active)) { const d = { active: old.active, retired: old.retired || [] }; write(project, d); fs.rmSync(legacyOf(project), { force: true }); return d; }
      } catch { /* nothing to move */ }
    }
    // migrate the old single office list, or seed the office's own project
    if (project === 'success-manager') {
      try { const old = JSON.parse(fs.readFileSync(path.join(root, 'office', 'ideas.json'), 'utf8')); if (old.active?.length) return { active: old.active.slice(0, IDEA_COUNT), retired: old.retired || [] }; } catch { /* no old list */ }
      return { active: OFFICE_SEED.map(([t, d]) => make(t, d)), retired: [] };
    }
    return { active: [], retired: [] };
  }
  function write(project, d) {
    fs.mkdirSync(dirOf(project), { recursive: true });
    const f = fileOf(project);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(d, null, 2) + '\n');
    fs.renameSync(`${f}.tmp`, f);
  }
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  function status(project, category = 'features') {
    try {
      const s = JSON.parse(fs.readFileSync(statusOf(project, category), 'utf8'));
      if (s.running && !alive(s.pid)) return { ...s, running: false, error: s.error || 'MUSE stopped unexpectedly — try again.' };
      return s;
    } catch { return { running: false }; }
  }

  /** Active ideas (every tab, or one), each tagged with its category; older ideas count as "features". */
  function list(project, category) {
    const d = read(project);
    if (!fs.existsSync(fileOf(project)) && d.active.length) write(project, d); // persist seeds so ids stay stable
    const all = d.active.map((i) => ({ ...i, category: catOf(i.category) }));
    return category ? all.filter((i) => i.category === catOf(category)) : all;
  }
  /** Fresh-ideas status for every tab: { features: {running…}, design: {…}, … } */
  const statuses = (project) => Object.fromEntries(CATEGORIES.map((c) => [c.id, status(project, c.id)]));
  const find = (d, id) => d.active.find((i) => i.id === id) || (() => { throw bad('No such idea', 404); })();
  function retire(project, id, how) {
    const d = read(project);
    const idea = find(d, id);
    d.active = d.active.filter((i) => i !== idea);
    d.retired.push({ ...idea, retiredAt: now(), how });
    write(project, d);
    return idea;
  }
  function addThoughts(project, id, text) {
    const t = clean(text, 2000);
    if (!t) throw bad('Write your thoughts first.');
    const d = read(project);
    const idea = find(d, id);
    idea.thoughts.push({ text: t, at: now() });
    write(project, d);
    return idea;
  }
  function promptFor(idea) {
    const cat = CATEGORIES.find((c) => c.id === catOf(idea.category));
    return [`Build this ${cat.id === 'features' ? 'improvement' : `${cat.label.toLowerCase()} improvement`}: ${idea.title}.`, idea.detail,
      ...(idea.thoughts?.length ? ['Owner\'s thoughts:', ...idea.thoughts.map((x) => `- ${x.text}`)] : [])].join('\n').slice(0, 4000);
  }

  /** Start ONE fresh-ideas pass in the background (returns immediately). */
  function requestFresh(project, { self, cwd, category = 'features' }) {
    const cat = catOf(category);
    const st = status(project, cat);
    if (st.running) return { ok: true, already: true };
    fs.mkdirSync(dirOf(project), { recursive: true });
    fs.writeFileSync(statusOf(project, cat), JSON.stringify({ running: true, startedAt: now(), pid: 0 }));
    const log = fs.openSync(path.join(dirOf(project), safe(project) === HOME ? `${HOME}.log` : 'ideas.log'), 'a');
    const child = spawn(process.execPath, [self, 'ideas-fresh', project, cat], { cwd, detached: true, stdio: ['ignore', log, log] });
    fs.writeFileSync(statusOf(project, cat), JSON.stringify({ running: true, startedAt: now(), pid: child.pid }));
    child.unref();
    return { ok: true };
  }

  /** The actual pass (run by `sm ideas-fresh <project>`): read the project, return 5 new ideas. */
  async function runFresh(project, { projectPath, musePrompt, model, pluginFlags = [], category = 'features' }) {
    const cat = CATEGORIES.find((c) => c.id === catOf(category));
    const d = read(project);
    const avoid = [...d.active, ...d.retired].filter((i) => catOf(i.category) === cat.id).map((i) => `- ${i.title}${i.thoughts?.length ? ` (owner said: ${i.thoughts.map((t) => t.text).join('; ')})` : ''}`).slice(-40);
    const prompt = [
      musePrompt,
      `Project: "${project}" (current directory). You are filling the "${cat.label}" tab: ${cat.focus}.`,
      `Skim it quickly (README, the main folders, the parts that matter for this tab) and propose exactly ${IDEA_COUNT} NEW, concrete, small-to-medium ${cat.label.toLowerCase()} ideas the owner would actually want, each tied to something real you saw in this project. Plain words, no jargon.`,
      pluginFlags.length > 2 ? 'Use your department training (the Skill tool) for this lens.' : '',
      avoid.length ? `Do not repeat these (already suggested):\n${avoid.join('\n')}` : '',
      'Be quick: a few file reads at most. Return only the five ideas.',
    ].filter(Boolean).join('\n\n');
    const args = ['-p', prompt, ...pluginFlags, '--output-format', 'json', '--json-schema', JSON.stringify(IDEAS_SCHEMA), '--model', model || 'sonnet',
      '--max-budget-usd', String(FRESH_BUDGET_USD), '--effort', 'low', '--allowedTools', 'Read', 'Grep', 'Glob', 'Skill',
      '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Agent'];
    const out = await new Promise((resolve) => {
      const c = spawn('claude', args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SM_ROLE: 'auditor' } });
      let o = '', e = '';
      c.stdout.on('data', (x) => (o += x));
      c.stderr.on('data', (x) => (e += x));
      c.on('close', () => resolve({ o, e }));
    });
    let res = null;
    try { res = JSON.parse(out.o); } catch { /* below */ }
    const fresh = res?.structured_output?.ideas;
    if (!fresh?.length) {
      const error = (res?.result || out.e || 'MUSE could not come up with ideas').toString().slice(0, 300);
      fs.writeFileSync(statusOf(project, cat.id), JSON.stringify({ running: false, error, at: now() }));
      return { ok: false, error };
    }
    const cur = read(project);
    const mine = (i) => catOf(i.category) === cat.id; // only this tab is replaced; the other tabs stay as they are
    cur.retired.push(...cur.active.filter(mine).map((i) => ({ ...i, retiredAt: now(), how: 'replaced' })));
    const added = fresh.slice(0, IDEA_COUNT).map((i) => make(i.title, i.detail, { category: cat.id }));
    cur.active = [...cur.active.filter((i) => !mine(i)), ...added];
    write(project, cur);
    fs.writeFileSync(statusOf(project, cat.id), JSON.stringify({ running: false, at: now(), cost: res.total_cost_usd || 0 }));
    return { ok: true, ideas: added };
  }

  return {
    list, status, statuses, get: (project, id) => find(read(project), id),
    dismiss: (project, id) => retire(project, id, 'dismissed'), use: (project, id) => retire(project, id, 'used'),
    addThoughts, promptFor, requestFresh, runFresh, IDEA_COUNT,
  };
}

module.exports = { createIdeas, IDEA_COUNT, CATEGORIES };

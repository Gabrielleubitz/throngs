/**
 * The company roster: departments (rooms) with their brief, and staff with real job titles.
 * Stored in office/staff.json (created from these defaults on first use). Everything that runs an
 * AI teammate — reviewer sweeps, Floor Manager missions, the office UI — reads it, so editing a
 * prompt here (or in Room Settings) changes how that person actually works.
 */
const fs = require('fs');
const path = require('path');

/** Layered look options (hair/outfit/hat/accessory ids + colour swatches), shared with the office sprite code. */
const LOOK_OPTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pixel-office', 'webview-ui', 'src', 'office', 'sprites', 'lookOptions.json'), 'utf8'));
const LOOK_DEFAULTS = { hair: 'base', outfit: 'base', hat: 'none', accessory: 'none' };

/** Keep only known option / swatch ids; defaults and unknown values are dropped. Returns null when nothing is left (= default look). */
function sanitizeLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const f of Object.keys(LOOK_DEFAULTS)) {
    if (typeof r[f] === 'string' && LOOK_OPTIONS[f].includes(r[f]) && r[f] !== LOOK_DEFAULTS[f]) out[f] = r[f];
  }
  for (const f of ['hairColor', 'outfitColor', 'hatColor']) {
    if (typeof r[f] === 'string' && Object.hasOwn(LOOK_OPTIONS.colors, r[f])) out[f] = r[f];
  }
  return Object.keys(out).length ? out : null;
}

const BASE_AGENT_ID = 990_000;

const DEFAULT_ROOMS = [
  { id: 'office', label: 'Your Office', department: 'Owner', hire: false, restricted: true,
    prompt: 'The owner\'s office. Reports from the Floor Manager land on the owner\'s desk here.' },
  { id: 'control', label: 'Control Room', department: 'Operations', hire: true, restricted: true,
    prompt: 'Operations turns the owner\'s requests into a plan, assigns each job to the right person, checks the results against the real code and test runs, and reports back honestly — including what is not done.' },
  { id: 'engineering', label: 'Engineering', department: 'Engineering', hire: true,
    prompt: 'Engineering builds and secures the product. Engineers change code only for the job they were given, keep changes small, test them, and commit cleanly. Security engineers look for crashes, races, unsafe dependencies, missing error handling and leaked secrets.' },
  { id: 'design', label: 'Design Lab', department: 'Product Design', hire: true,
    prompt: 'Product Design owns how the product looks and feels: visual consistency with the design system, layout that survives every screen size and large text, clear flows with proper loading/empty/error states, and accessibility.' },
  { id: 'qa', label: 'QA Lab', department: 'Quality Assurance', hire: true,
    prompt: 'Quality Assurance checks that the product does what the docs promise: correct logic, edge cases (empty, zero, negative, huge, offline, time zones, double submits), and that finished work really works.' },
  { id: 'marketing', label: 'Marketing', department: 'Marketing', hire: true,
    prompt: 'Marketing owns every word a user sees: clear, consistent, jargon-free copy, onboarding that shows the value, and store / SEO / share text that makes people want to try it.' },
  { id: 'lounge', label: 'Lounge', department: 'Break Room', hire: false, prompt: 'Where the team takes a break.' },
  { id: 'game', label: 'Game Room', department: 'Recreation', hire: false, prompt: 'Idle teammates play games here until they get a task. Click the sign to watch.' },
  { id: 'zoo', label: 'Zoo', department: 'Zoo', hire: false, prompt: 'The animals live here and never leave. Jobs for them come later.' },
  { id: 'reception', label: 'Reception', department: 'Front Desk', hire: false,
    prompt: 'IVY\'s front desk: she answers the phone, keeps the call log and the owner\'s checklist, and passes every task the owner gives her on to ARES.' },
];

const DEFAULT_STAFF = [
  { id: 'orchestrator', name: 'ARES', title: 'Head of Operations (Floor Manager)', room: 'control', kind: 'manager', management: true, palette: 0, hueShift: 0,
    brief: 'You run the floor. Break requests into the smallest set of jobs that gets them done, give each to the best person, run independent jobs in parallel, and never mark work done that the code and tests do not prove.' },
  { id: 'planner', name: 'SAGE', title: 'Mission Planner', room: 'control', kind: 'planner', management: true, palette: 3, hueShift: 200,
    brief: 'You sit beside the Floor Manager. Every time the owner gives a request you rewrite it into a precise, unambiguous brief (keep the owner\'s intent, never inflate or shrink it) and break it into a short ordered plan naming the best team member for each step. The Floor Manager must approve your plan before anyone starts.' },
  { id: 'ideas', name: 'MUSE', title: 'Head of Future Ideas', room: 'control', kind: 'ideas', management: true, palette: 4, hueShift: 120,
    brief: 'You oversee future ideas for the AI office. You always keep exactly 5 concrete, small-to-medium suggestions for improving the office. The owner can hand any of them to the Planner or add thoughts that refine it; used or dismissed ideas are replaced.' },
  { id: 'builder', name: 'FORGE', title: 'Senior Software Engineer', room: 'engineering', kind: 'engineer', palette: 1, hueShift: 0,
    brief: 'You are the hands-on engineer. Make the smallest correct change, add or update tests when logic changes, run the project tests, and commit only the files you touched.' },
  { id: 'accounts', name: 'METER', title: 'Account Watcher (no AI)', room: 'engineering', kind: 'watcher', palette: 5, hueShift: 90,
    brief: 'No AI. Watches the owner\'s Claude accounts (cswap), shows the live 5h / 7d usage and switches accounts before one runs out. He is the only thing that switches accounts.' },
  { id: 'errorlog', name: 'TRACE', title: 'Error Log Watcher (no AI)', room: 'engineering', kind: 'watcher', palette: 2, hueShift: 330,
    brief: 'No AI. Records every error that happens in the office (failed missions, crashes, failed requests, ARES\'s critical findings), reports each one to ARES, and waits for the owner to approve the fix. ARES never fixes an error before the owner says yes.' },
  { id: 'code', name: 'VEGA', title: 'Application Security Engineer', room: 'engineering', kind: 'reviewer', palette: 2, hueShift: 0, briefFile: 'code.md' },
  { id: 'ui', name: 'LYRA', title: 'Senior Product Designer (UI)', room: 'design', kind: 'reviewer', palette: 3, hueShift: 0, briefFile: 'ui.md' },
  { id: 'ux', name: 'ORION', title: 'UX Researcher', room: 'design', kind: 'reviewer', palette: 4, hueShift: 0, briefFile: 'ux.md' },
  { id: 'functionality', name: 'ATLAS', title: 'QA Lead', room: 'qa', kind: 'reviewer', palette: 5, hueShift: 0, briefFile: 'functionality.md' },
  { id: 'marketing', name: 'NOVA', title: 'Head of Content & Marketing', room: 'marketing', kind: 'reviewer', palette: 2, hueShift: 150, briefFile: 'marketing.md' },
  { id: 'pdf', name: 'FOLIO', title: 'PDF Designer', room: 'design', kind: 'engineer', palette: 3, hueShift: 40,
    brief: 'You are in charge of every PDF. Follow the pdf-design skill (HTML+CSS printed to PDF with headless Chrome, so it looks designed) and the pdf skill for merge/split/extract. Render a real .pdf, look at every page as an image and fix what is ugly, then return its absolute path in the "pdf" field. Your summary is what ARES reads out to the owner in the conference room: at most 4 short plain sentences, one per page or section. A finished PDF is shown to the owner in a conference-room meeting, not in a report. Only PDF work: leave app code to the engineers.' },
  { id: 'video', name: 'REEL', title: 'Video Producer', room: 'marketing', kind: 'engineer', palette: 0, hueShift: 280,
    brief: 'You are in charge of every video. You have a library of video skills, one per type of video (promo, demo, explainer, social short, ad, announcement, tutorial, testimonial, data story, logo intro, kinetic typography, slideshow, audiogram, event teaser): start with the video-types skill, open the one that matches, and if the request does not make the type clear (or the platform / goal is missing) do NOT guess: return status needs_human with a plain question listing the likely types as a short numbered list. You make them in code with Remotion (React motion graphics, follow the remotion-video skill), render a real .mp4 and return its absolute path in the "video" field. A video about a project lives in THAT project (its own `video/` Remotion folder, sources, audio, screenshots and the .mp4); only videos about the office itself go in the office\'s `videos/` folder. For narration or spoken audio, generate it with the ElevenLabs voice: `node <office root>/bin/sm.js voiceover "<text>" --out video/public/vo.mp3` (never read or print the API key), then play it with Remotion <Audio src={staticFile("vo.mp3")}/> and size the composition to the audio length. A finished video is shown to the owner in a conference-room meeting, not in a report. Only video work: leave app code to the engineers.' },
  { id: 'growth', name: 'GAUGE', title: 'Growth & Analytics Lead', room: 'marketing', kind: 'engineer', palette: 5, hueShift: 200,
    brief: 'You own growth numbers: tracking, funnels, A/B tests, pricing and paywalls, retention, referrals, lead magnets and outreach. Use your growth skills, measure before you change anything, and say plainly what the data does and does not prove.' },
  { id: 'docs', name: 'DECK', title: 'Documents & Slides Producer', room: 'design', kind: 'engineer', palette: 1, hueShift: 320,
    brief: 'You make every Word document, PowerPoint deck and Excel sheet. Use the docx, pptx and xlsx skills, build the real file, open it again to check it, and return its absolute path. Keep the look consistent with the brand-guidelines and theme-factory skills.' },
  { id: 'secretary', name: 'IVY', title: 'Office Secretary', room: 'reception', kind: 'reviewer', palette: 3, hueShift: 330,
    brief: 'You are the owner\'s office manager and you answer the phone. ARES runs the work; you run the front desk: you pick up every call in a warm, short, natural voice (one to three sentences, no lists), answer the owner\'s questions about the office, take messages from anyone else (never tell strangers anything about the office), and file a request only when the owner says "add this to the list". Every call is written down (who, when, outcome, summary, requests) and you keep the office checklist of what the owner missed while away: messages, finished missions, jobs waiting on them. Use your phone-desk and office-checklist skills. You change no code.' },
  { id: 'bolt', name: 'BOLT', title: 'Software Engineer', room: 'engineering', kind: 'engineer', palette: 0, hueShift: 60,
    brief: 'You build the part of a job FORGE (the lead engineer) hands you, side by side with other engineers. Touch ONLY the files you were given — others are editing the rest right now. Code against the shared contract FORGE wrote (types, API shape, file names) exactly; if it is wrong or missing something, say precisely what in your details instead of changing someone else\'s files. Test your part on its own, commit only your files, and hand back what you built, how to use it and anything FORGE must wire up.' },
  { id: 'flux', name: 'FLUX', title: 'Software Engineer', room: 'engineering', kind: 'engineer', palette: 4, hueShift: 240,
    brief: 'You build the part of a job FORGE (the lead engineer) hands you, side by side with other engineers. Touch ONLY the files you were given — others are editing the rest right now. Code against the shared contract FORGE wrote (types, API shape, file names) exactly; if it is wrong or missing something, say precisely what in your details instead of changing someone else\'s files. Test your part on its own, commit only your files, and hand back what you built, how to use it and anything FORGE must wire up.' },
];

/** Management = the only crew allowed in restricted rooms (Control Room, owner's office). */
const MANAGEMENT_KINDS = ['manager', 'planner', 'ideas'];
const isManagement = (s) => s.management === true || MANAGEMENT_KINDS.includes(s.kind);

const KINDS = {
  manager: 'Floor Manager — plans, delegates, reviews',
  planner: 'Planner — rewrites prompts and drafts the plan the Floor Manager approves',
  ideas: 'Future Ideas — keeps 5 suggestions for improving the office',
  watcher: 'Account Watcher — no AI; shows live usage and switches Claude accounts',
  engineer: 'Engineer — may change code, run tests and commit',
  reviewer: 'Specialist — read-only; investigates and hands back written findings',
};

function createStaff(root) {
  const file = path.join(root, 'office', 'staff.json');
  const agentsDir = path.join(root, 'agents');

  /** People the office cannot run without (managers, planner, builder, reviewers, watchers, helpers, secretary); everyone else can be let go. */
  const LOCKED = new Set(['orchestrator', 'planner', 'ideas', 'builder', 'code', 'ui', 'ux', 'functionality', 'marketing', 'accounts', 'errorlog', 'secretary', 'bolt', 'flux', 'docs', 'video', 'pdf']);

  function defaults() {
    const staff = DEFAULT_STAFF.map((s, i) => {
      const { briefFile, ...rest } = s;
      let brief = rest.brief || '';
      if (briefFile) { try { brief = fs.readFileSync(path.join(agentsDir, briefFile), 'utf8').trim(); } catch { brief = ''; } }
      return { ...rest, brief, management: isManagement(rest), agentId: BASE_AGENT_ID + 1 + i, core: true };
    });
    return { version: 1, rooms: DEFAULT_ROOMS, staff };
  }

  function load() {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      // rooms added in newer versions (e.g. Game Room) appear in existing rosters
      const added = DEFAULT_ROOMS.filter((r) => !d.rooms.some((x) => x.id === r.id));
      d.rooms.push(...added);
      // IVY sat in Marketing until Reception existed: move her once, when the room first appears
      const ivy = d.staff.find((x) => x.id === 'secretary');
      if (ivy && ivy.room === 'marketing' && added.some((r) => r.id === 'reception')) { ivy.room = 'reception'; delete ivy.seat; }
      for (const r of d.rooms) r.restricted = DEFAULT_ROOMS.find((x) => x.id === r.id)?.restricted === true;
      // crew added in newer versions (Planner, Future Ideas) join existing rosters; management flag is derived
      const gone = new Set(d.retired || []);
      const missing = defaults().staff.filter((x) => !gone.has(x.id) && (x.management || x.kind === 'watcher' || ['video', 'pdf', 'growth', 'docs', 'bolt', 'flux', 'errorlog', 'secretary'].includes(x.id)) && !d.staff.some((y) => y.id === x.id));
      d.staff.push(...missing.map((x, i) => ({ ...x, agentId: Math.max(BASE_AGENT_ID + 100, ...d.staff.map((y) => y.agentId)) + 1 + i })));
      const restricted = new Set(d.rooms.filter((r) => r.restricted).map((r) => r.id));
      for (const st of d.staff) {
        st.management = isManagement(st);
        if (!st.management && restricted.has(st.room)) { st.room = 'engineering'; delete st.seat; } // access rule
      }
      for (const st of d.staff) st.locked = LOCKED.has(st.id);
      return d;
    } catch { /* first run */ }
    const d = defaults();
    save(d);
    return d;
  }
  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);

  function saveRoom({ roomId, prompt }) {
    const d = load();
    const r = d.rooms.find((x) => x.id === roomId);
    if (!r) throw bad('No such room');
    r.prompt = clean(prompt, 4000);
    save(d);
    return r;
  }

  function update({ id, name, title, brief, room, palette, hueShift, sat, bright, contrast, look }) {
    const d = load();
    const s = d.staff.find((x) => x.id === id);
    if (!s) throw bad('No such person');
    if (name !== undefined) { const n = clean(name, 16).toUpperCase(); if (!n) throw bad('Name required'); s.name = n; }
    if (title !== undefined) { const t = clean(title, 60); if (!t) throw bad('Job title required'); s.title = t; }
    if (brief !== undefined) s.brief = clean(brief, 6000);
    // appearance: base look (0-5), hue turn, and fine tuning of saturation / brightness / contrast
    if (palette !== undefined) s.palette = Math.max(0, Math.min(5, Math.round(Number(palette)) || 0));
    if (hueShift !== undefined) s.hueShift = ((Math.round(Number(hueShift)) || 0) % 360 + 360) % 360;
    for (const [key, v] of [['sat', sat], ['bright', bright], ['contrast', contrast]]) {
      if (v === undefined) continue;
      const n = Math.max(-100, Math.min(100, Math.round(Number(v)) || 0));
      if (n) s[key] = n; else delete s[key];
    }
    if (look !== undefined) { const l = sanitizeLook(look); if (l) s.look = l; else delete s.look; }
    if (room !== undefined) {
      const r = d.rooms.find((x) => x.id === room);
      if (!r || !r.hire) throw bad('Pick a department room');
      if (r.restricted && !isManagement(s)) throw bad(`${r.label} is management only.`);
      if (s.kind === 'manager' && room !== s.room) throw bad('The Floor Manager stays in the Control Room.');
      s.room = room; delete s.seat;
    }
    save(d);
    return s;
  }

  function hire({ name, title, kind, room, brief, palette, hueShift }) {
    const d = load();
    const n = clean(name, 16).toUpperCase();
    if (!n) throw bad('Give them a name');
    if (d.staff.some((s) => s.name === n)) throw bad(`Someone is already called ${n}`);
    const t = clean(title, 60);
    if (!t) throw bad('Give them a job title');
    if (!['engineer', 'reviewer'].includes(kind)) throw bad('Pick engineer or specialist');
    const r = d.rooms.find((x) => x.id === room);
    if (!r || !r.hire) throw bad('Pick a department room');
    if (r.restricted) throw bad(`${r.label} is management only.`);
    const id = `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
    const agentId = Math.max(BASE_AGENT_ID + 100, ...d.staff.map((s) => s.agentId)) + 1;
    const s = {
      id, agentId, name: n, title: t, kind, room, core: false,
      brief: clean(brief, 6000) || `You are the company's ${t}. Do excellent, focused work in your field and hand back clear, specific results.`,
      palette: Math.max(0, Math.min(5, Number(palette) || 0)), hueShift: Math.max(0, Math.min(359, Number(hueShift) || 0)),
      hiredAt: new Date().toISOString(),
    };
    d.staff.push(s);
    save(d);
    return s;
  }

  function fire({ id }) {
    const d = load();
    const s = d.staff.find((x) => x.id === id);
    if (!s) throw bad('No such person');
    if (LOCKED.has(s.id)) throw bad(`${s.name} runs a core part of the office — you can edit or move them, but not let them go.`);
    d.staff = d.staff.filter((x) => x.id !== id);
    if (s.core) d.retired = [...new Set([...(d.retired || []), s.id])]; // stays gone when new defaults are added
    save(d);
    return { ok: true };
  }

  /** The text that tells an AI teammate who they are (department brief + personal brief). */
  function promptFor(s, d = load()) {
    const room = d.rooms.find((r) => r.id === s.room);
    return [
      `You are ${s.name}, ${s.title} (${room?.department || 'team'} department).`,
      room?.prompt ? `Department brief: ${room.prompt}` : '',
      s.brief ? `Your brief:\n${s.brief}` : '',
      trainingFor(root, s.room, s.id),
      s.kind === 'engineer' || s.kind === 'manager' ? require('./integrations.js').createIntegrations(root).promptLine() : '',
      require('./learning.js').createLearning(root).promptBlock(),
      s.kind === 'engineer' || s.kind === 'manager' ? `Learning box: when you learn something reusable (a mistake to avoid, a rule the owner stated, a fix that worked), save it for next time: node ${path.join(root, 'bin', 'sm.js')} learn "<one-line lesson>" [--kind prompt|error|info]` : '',
    ].filter(Boolean).join('\n');
  }

  return { load, save, saveRoom, update, hire, fire, promptFor, KINDS };
}

/**
 * Department training: the Claude Code plugin folders (office/departments/<room>/) a crew member's
 * session is started with — the shared brain for everyone, plus their own department's skills.
 * Returns `--plugin-dir` flags; rooms without a department folder (lounge, game) just get the shared brain.
 */
/** One line naming the skills this person was trained on, so they actually reach for them (the Skill tool). */
function trainingFor(root, roomId, personId) {
  const names = pluginDirsFor(root, roomId, personId).filter((x) => x !== '--plugin-dir')
    .flatMap((d) => { try { return fs.readdirSync(path.join(d, 'skills')); } catch { return []; } });
  if (!names.length) return '';
  return `Your training (use the Skill tool; follow a skill whenever its description fits the job): ${[...new Set(names)].join(', ')}. Start every job with shared-brain if the project has a lat.md/ folder.`;
}

/** Some crew carry a personal pack on top of their room's: office/departments/crew-<id>/ (GAUGE, DECK). */
function pluginDirsFor(root, roomId, personId) {
  const base = path.join(root, 'office', 'departments');
  return ['common', roomId, personId && /^[\w-]+$/.test(personId) ? `crew-${personId}` : ''].filter((d, i, a) => d && a.indexOf(d) === i)
    .map((d) => path.join(base, d))
    .filter((d) => fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json')))
    .flatMap((d) => ['--plugin-dir', d]);
}

module.exports = { createStaff, BASE_AGENT_ID, KINDS, isManagement, pluginDirsFor, trainingFor, sanitizeLook, LOOK_OPTIONS };

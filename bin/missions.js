/**
 * Missions — tasks you give the Floor Manager in the office.
 *
 *   you ──prompt──▶ Floor Manager plans (read-only Claude, JSON plan) ──▶ subtasks for specialists
 *        specialists work in parallel where safe (read-only experts) and one-at-a-time where not (the
 *        builder is the only one who edits code; its sessions still run under the QA Stop hook + git guard)
 *        anyone stuck asks the Floor Manager first; only owner-only questions (keys, money, devices, open product
 *        calls) reach YOU, explained like you're 5; your answer resumes them
 *   built ──▶ hand-off loop: QA script → QA lead (gate job) → security engineer (gate job). Anything that fails,
 *        crashes, changes nothing, or is left "for the owner" becomes a job for whoever can fix it, then the
 *        loop runs again (max maxFixRounds). Only then:
 *   ──▶ Floor Manager reviews the real diff + a fresh QA run ──▶ report on your desk 🎉
 *
 * Files (projects/<name>/missions/):  <id>.json   mission state — written ONLY by the runner
 *                                     <id>.inbox.jsonl  answers / cancel from the UI (append-only)
 *                                     <id>.log    runner log
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { createStaff, isManagement, pluginDirsFor } = require('./staff.js');
const { createMeetings, videosFromSubtasks, pdfsFromSubtasks } = require('./meetings.js');
/** Live roster (office/staff.json): who can be assigned, what they're called, and who may edit code. */
function rosterNow(root) {
  const S = createStaff(root);
  const d = S.load();
  const roles = {};
  for (const st of d.staff) {
    if (st.kind === 'watcher') continue; // no AI: never assigned jobs
    if (isManagement(st)) continue; // management plans and approves; they are never assigned jobs
    const room = d.rooms.find((r) => r.id === st.room);
    roles[st.id] = { name: st.name, title: st.title, room: st.room, department: room?.department || '', readOnly: st.kind !== 'engineer', prompt: S.promptFor(st, d) };
  }
  const manager = d.staff.find((x) => x.kind === 'manager');
  const planner = d.staff.find((x) => x.kind === 'planner');
  return { roles, managerPrompt: manager ? S.promptFor(manager, d) : '', plannerPrompt: planner ? S.promptFor(planner, d) : '', planner: planner ? { id: planner.id, name: planner.name } : null };
}
/** The crew member in charge of videos: video requests go to them, and a finished video becomes a conference-room meeting. */
const VIDEO_LEAD = 'video';
/** The crew member in charge of PDFs (FOLIO): PDF requests go to them and a finished PDF becomes a conference-room meeting too. */
const PDF_LEAD = 'pdf';
const MAX_PARALLEL_READERS = 3;
const MAX_PARALLEL_WRITERS = 3;
/**
 * Delegation: on a solo mission the lead engineer (FORGE) may split a big job instead of doing it alone —
 * her own part + up to MAX_HELPERS parts for helper engineers (BOLT, FLUX), each owning files nobody else
 * touches. The parts run side by side, then she integrates and verifies the whole in her own session.
 */
const MAX_HELPERS = 2;
/** The owner should rarely be asked: after DIAGNOSE_AFTER owner answers a job must investigate itself; at MAX_OWNER_ASKS it stops. */
const DIAGNOSE_AFTER = 2;
const MAX_OWNER_ASKS = 4;
const ownerAsks = (s) => (s.answers || []).filter((a) => !a.by).length;
const PART_BUDGET = 2.5; // $ per helper part / her own part
const INTEGRATE_BUDGET = 2.5; // $ for her wire-up + whole-feature check
/** Helpers = general engineers in Engineering other than the lead (not the video / PDF / docs specialists). */
const helpersFor = (roles, lead) => Object.entries(roles).filter(([id, r]) => id !== lead && !r.readOnly && r.room === 'engineering').map(([id]) => id).slice(0, MAX_HELPERS);
const cleanOwns = (list) => (Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter((x) => x && !x.startsWith('/') && !x.includes('..')).slice(0, 40);
/** Is a split usable? Every part owns files, and no two parts' files overlap. Returns the reason it isn't, or ''. */
function splitProblem(parts) {
  if (parts.some((x) => !x.owns.length)) return 'every part must list the files it owns';
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    if (ownershipClash(parts[i], parts[j])) return `"${parts[i].title}" and "${parts[j].title}" own overlapping files`;
  }
  return '';
}

/** Do two writing jobs collide? Same folder AND (either owns "everything" OR their file lists overlap). */
function ownershipClash(a, b) {
  if ((a.workdir || '.') !== (b.workdir || '.')) return false;
  const A = a.owns || [], B = b.owns || [];
  if (!A.length || !B.length) return true;
  const norm = (x) => x.replace(/^\.\//, '').replace(/\/+$/, '');
  return A.some((x) => B.some((y) => { const p = norm(x), q = norm(y); return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`); }));
}
const ASK_SCHEMA = {
  type: 'object',
  description: 'Only when status is needs_human. Written for a 5-year-old: plain words, no jargon.',
  properties: {
    what: { type: 'string', description: 'One sentence: what you need them to do or decide.' },
    why: { type: 'string', description: 'Why only a human can do it.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Tiny steps, if they need to do something.' },
    done_when: { type: 'string' },
    reply: { type: 'string', description: 'Exactly what they should type back (e.g. "A or B").' },
  },
  required: ['what', 'why', 'steps', 'done_when', 'reply'],
};
const plannerSchema = {
  type: 'object',
  properties: {
    bubble: { type: 'string', description: 'What you say out loud, max 60 chars.' },
    rewritten_prompt: { type: 'string', description: 'The owner\'s request rewritten as a clear, specific brief. Same intent: do not add or drop scope.' },
    steps: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', description: 'One concrete step, naming the best team member where obvious.' } },
    risks: { type: 'string', description: 'Open questions or risks, or empty.' },
  },
  required: ['bubble', 'rewritten_prompt', 'steps'],
};
const planSchema = (assignees) => ({
  type: 'object',
  properties: {
    bubble: { type: 'string', description: 'What you say out loud to the user, max 60 chars, friendly.' },
    summary: { type: 'string', description: 'Your plan in 1-2 plain sentences.' },
    approval: { type: 'string', enum: ['approved', 'amended'], description: 'When a Planner draft is given: approved = you accept it as is; amended = you changed it (explain in approval_note).' },
    approval_note: { type: 'string', description: 'One sentence on why you approved or what you changed in the Planner\'s plan.' },
    about_office: { type: 'boolean', description: 'true if the request is about THIS AI office itself (Floor Manager, crew, rooms, reports, missions, the office app/dashboard) rather than the selected project.' },
    size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'small = one focused change or answer; medium = a feature touching a few files; large = multi-part work.' },
    subtasks: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short imperative, max 70 chars.' },
          assignee: { type: 'string', enum: assignees },
          workdir: { type: 'string', description: 'Optional sub-folder (relative to the project root) this job works in, e.g. "fuel-app". Use when the project holds several apps.' },
          instructions: { type: 'string', description: 'Exactly what to do and what to hand back. Name files where known.' },
          depends_on: { type: 'array', items: { type: 'integer' }, description: '1-based numbers of subtasks that must finish first.' },
          changes_files: { type: 'boolean', description: 'true if this job must create or change files/code (it then gets write access, whoever does it).' },
          owns_files: { type: 'array', items: { type: 'string' }, description: 'For changes_files jobs: the files/folders (relative paths) ONLY this job may edit. Jobs with non-overlapping owns_files work at the same time. Empty = needs the whole folder (runs alone).' },
        },
        required: ['title', 'assignee', 'instructions', 'depends_on', 'changes_files'],
      },
    },
  },
  required: ['bubble', 'summary', 'size', 'subtasks'],
});
const WORK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'needs_human', 'failed', 'split'], description: '"split" only if your job told you that you may delegate, and you filled "delegate".' },
    bubble: { type: 'string', description: 'What you say out loud, max 40 chars (e.g. "Fixed it!", "Need your help!").' },
    summary: { type: 'string', description: 'What you did / found, 1-4 plain sentences.' },
    details: { type: 'string', description: 'Full findings, text, or change notes for the team and the report.' },
    files_changed: { type: 'array', items: { type: 'string' } },
    verified_by: { type: 'string', description: 'How you checked it worked (tests run, results). Empty if read-only.' },
    applied: { type: 'boolean', description: 'true only if your changes are actually saved in the files right now. false if you only wrote a patch/suggestion.' },
    owner_action_needed: { type: 'string', description: 'Anything the owner must still do for this to work (install, copy a file, restart…). Empty string if nothing.' },
    video: { type: 'string', description: 'Absolute path of the finished video file (.mp4/.webm/.mov) if this job rendered one — the owner is then called into the conference room to watch it. Empty otherwise.' },
    pdf: { type: 'string', description: 'Absolute path of the finished .pdf file if this job made one — the owner is then called into the conference room and ARES walks them through it. Empty otherwise.' },
    question: ASK_SCHEMA,
    delegate: {
      type: 'object',
      description: 'Only with status "split": how you divide the job. Every part owns files no other part touches.',
      properties: {
        contract: { type: 'string', description: 'The shared contract every part codes against: names, types, API routes and shapes, file layout. Precise.' },
        my_part: { type: 'object', properties: { title: { type: 'string' }, instructions: { type: 'string' }, owns_files: { type: 'array', items: { type: 'string' } } }, required: ['title', 'instructions', 'owns_files'] },
        helpers: {
          type: 'array', maxItems: MAX_HELPERS,
          items: { type: 'object', properties: {
            title: { type: 'string' },
            instructions: { type: 'string', description: 'Everything they need: what to build, where, how to test it alone, what not to touch.' },
            owns_files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files/folders only this helper edits.' },
            model: { type: 'string', enum: ['haiku', 'sonnet'], description: 'haiku for mechanical work, sonnet otherwise.' },
          }, required: ['title', 'instructions', 'owns_files', 'model'] },
        },
        integrate: { type: 'string', description: 'What you will do once every part is in: wiring, the whole-feature test, the live check.' },
      },
      required: ['contract', 'my_part', 'helpers', 'integrate'],
    },
  },
  required: ['status', 'bubble', 'summary', 'details', 'files_changed', 'verified_by', 'applied', 'owner_action_needed'],
};
const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Max 80 chars.' },
    verdict: { type: 'string', enum: ['success', 'partial', 'failed'] },
    summary: { type: 'string', description: '2-4 sentences, plain English, for a non-engineer.' },
    completed: { type: 'array', items: { type: 'object', properties: { job: { type: 'string' }, by: { type: 'string' }, result: { type: 'string' } }, required: ['job', 'by', 'result'] } },
    changes: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, what: { type: 'string' } }, required: ['file', 'what'] } },
    checks: { type: 'object', properties: { qa_passed: { type: 'boolean' }, notes: { type: 'string' } }, required: ['qa_passed', 'notes'] },
    concerns: { type: 'array', items: { type: 'string' }, description: 'Anything wrong, risky, unverified or skipped. Be honest.' },
    next_steps: { type: 'array', items: { type: 'string' } },
    for_you: { type: 'string', description: 'What the user should do now, explained like they are 5. "Nothing" is fine. Only owner-only things (their keys, money, a device, a decision only they can make).' },
    send_back: {
      type: 'array', description: 'Anything the owner asked for that is NOT done, NOT verified working, or broken — the team fixes these before the owner sees the report. Empty only when it truly works.',
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string', description: 'What is missing/wrong and what "done" looks like, incl. how to verify it.' }, file: { type: 'string' }, fix_by: { type: 'string', description: 'Teammate id best placed to fix it.' } }, required: ['title', 'detail', 'file', 'fix_by'] },
    },
  },
  required: ['headline', 'verdict', 'summary', 'completed', 'changes', 'checks', 'concerns', 'next_steps', 'for_you', 'send_back'],
};
const MAX_REPLY = 4000;
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'Your answer to the owner in the report thread. Plain English, 1-5 sentences.' },
    follow_up: { type: 'boolean', description: 'true only if the owner is asking the team to do MORE WORK (change, fix, build, investigate). A question, thanks or opinion is false.' },
    follow_up_prompt: { type: 'string', description: 'When follow_up is true: the new request for the team in one short paragraph. Empty otherwise.' },
  },
  required: ['answer', 'follow_up', 'follow_up_prompt'],
};

/** Cost controls. Every role defaults to Sonnet (override per project: managerModel / builderModel /
 *  auditModel), and every Claude run gets a hard $ cap sized to the task. */
const DEFAULT_MODEL = 'sonnet';
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'Max 80 chars.' },
    answer: { type: 'string', description: 'The answer, plain English for a non-engineer, as short as it can be while complete.' },
    next_steps: { type: 'array', items: { type: 'string' }, description: 'Optional follow-ups the owner could ask for (max 3).' },
  },
  required: ['headline', 'answer', 'next_steps'],
};
/** QA for missions that change the office itself: it must still compile and type-check. */
const OFFICE_QA = [
  { name: 'office-engine', run: 'for f in bin/*.js; do node --check "$f" || exit 1; done', timeoutSec: 60 },
  { name: 'office-runs', run: 'node bin/office-smoke.js', timeoutSec: 120 },          // the office must actually work, not just compile
  { name: 'office-tests', run: 'node --test test/*.test.js', timeoutSec: 300 },
  { name: 'office-brain', run: 'command -v lat >/dev/null || exit 0; lat check', timeoutSec: 60 }, // shared brain (lat.md/) links must stay true
  { name: 'office-server-types', run: 'cd pixel-office && npx tsc --noEmit', timeoutSec: 300 },
  { name: 'office-app-types', run: 'cd pixel-office/webview-ui && npx tsc --noEmit -p tsconfig.app.json', timeoutSec: 300 },
  // Last: really build it, put it live, and check the live office — QA then clicks through the NEW version, a broken
  // build goes back to engineering, and the owner's open tab reloads onto it by itself.
  { name: 'office-live', run: 'node bin/sm.js office --build --restart --no-open && node bin/sm.js office --check', timeoutSec: 900 },
];
const BUDGET = {
  plan: 0.4, review: 0.6, reply: 0.4,
  small: { engineer: 1.0, specialist: 0.5 },
  medium: { engineer: 2.5, specialist: 1.0 },
  large: { engineer: 5.0, specialist: 2.0 },
};

// ── Hand-off loop: build → QA → security, and anything that fails goes back to someone who can fix it. ──
// The owner's desk only gets the result once it has passed every stage (or the loop truly ran out of rounds).
const MAX_FIX_ROUNDS = 2;   // QA/security sending work back to engineering, per mission (config: maxFixRounds)
// Hard spending cap per mission (API-equivalent $, i.e. the owner's usage). Reached → no new jobs, report what's there.
// One mission once burned $16 mostly on re-verification loops; the cap makes that impossible. Config: missionBudgetUsd.
const MISSION_BUDGET = { small: 3, medium: 8, large: 15 };
const MAX_ARES_SENDBACKS = 1; // the final review may send work back once — then it reports
// "Open it and check" is verification (the QA lead's job), not an action someone must take.
const VERIFY_ONLY = /^\s*(please\s+)?(open|check|look|verify|test|try|confirm|reload|refresh|see|click|visit|go to|view|watch|make sure|browser[- ]check|walk through)\b/i;
const PREEMPT_RESUME = 'You were paused so a more urgent request could go first. It is done now. Continue YOUR JOB from where you stopped (check what is already done in the files first) and return the result in the same format.';
const MAX_RETRIES = 2;      // a job that crashed or gave up is retried this many times before it counts as failed
const MAX_TRIAGE = 2;       // questions ARES may answer for a teammate before the owner is asked
const GATE_BUDGET = { small: 0.6, medium: 1.0, large: 1.8 }, TRIAGE_BUDGET = 0.3; // gates drive a browser on big features
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true only if nothing below blocks release.' },
    bubble: { type: 'string', description: 'What you say out loud, max 40 chars (e.g. "Looks good!", "Back to FORGE").' },
    summary: { type: 'string', description: '1-3 plain sentences: what you checked and the outcome.' },
    checked: { type: 'string', description: 'Exactly what you ran / read to check it.' },
    issues: {
      type: 'array', description: 'ONLY problems that block release. Empty when pass is true.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' }, detail: { type: 'string', description: 'What is wrong, how to see it, what "fixed" looks like.' },
          file: { type: 'string' }, fix_by: { type: 'string', description: 'Id of the teammate best placed to fix it (from the list given).' },
        },
        required: ['title', 'detail', 'file', 'fix_by'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Non-blocking polish ideas, max 3.' },
  },
  required: ['pass', 'bubble', 'summary', 'checked', 'issues', 'notes'],
};
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    owner_only: { type: 'boolean', description: 'true ONLY if it needs something no teammate can provide: credentials/keys/accounts, payment, a real device, legal sign-off, or a product decision the request leaves genuinely open.' },
    answer: { type: 'string', description: 'If owner_only is false: the concrete answer/decision the teammate should act on.' },
    why: { type: 'string' },
  },
  required: ['owner_only', 'answer', 'why'],
};

// ── Funnels: not every request needs a team. The router (a cheap Haiku call, or the owner's own words) picks one:
//   answer — a question: one read-only call, no QA.
//   quick  — one small, clear change: one agent, then the QA script only. No planner, no checkers, no review.
//   solo   — the default for real work: ONE lead agent owns it end to end (like a person in the CLI), then the QA
//            script + one combined QA/security check; a fix goes back to the SAME session, so nothing is re-learned.
//   team   — big work that splits into parallel parts: planner, manager, team, QA, security, final review.
const FUNNELS = ['answer', 'quick', 'solo', 'team'];
const MODELS = ['haiku', 'sonnet', 'opus'];
/** Spending cap per funnel ($, API-equivalent). Team missions use MISSION_BUDGET by size. */
const FUNNEL_BUDGET = { answer: 0.5, quick: 1.5, solo: 6 };
/** Per-job budget for the one agent in a quick / solo mission. */
const JOB_BUDGET = { answer: 0.4, quick: 1.2, solo: 4 };
const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    funnel: { type: 'string', enum: FUNNELS },
    model: { type: 'string', enum: MODELS, description: 'Cheapest model that will do it right: haiku = trivial edits / simple questions, sonnet = normal features and fixes, opus = hard debugging, architecture, large or subtle work.' },
    about_office: { type: 'boolean', description: 'true if the request is about this AI office itself (its crew, missions, panel, 3D view, the office app) rather than the selected project.' },
    title: { type: 'string', description: 'A short title for the job, max 60 chars.' },
    video: { type: 'boolean', description: 'true only if the owner asks the team to MAKE a video (render a clip, animation, promo, explainer). false for changes to the office or app code, even ones about video features.' },
    pdf: { type: 'boolean', description: 'true only if the owner asks the team to MAKE a PDF (report, one-pager, brochure, designed document). false for changes to the office or app code, even ones about PDF features.' },
    reason: { type: 'string', description: 'One short sentence: why this funnel and model.' },
  },
  required: ['funnel', 'model', 'about_office', 'title', 'reason'],
};

/** The owner's own words win: "quick: …", "team: …", "question: …", "use opus", "with haiku". */
function ownerRoute(prompt) {
  const t = String(prompt || '');
  const out = {};
  const pre = t.match(/^\s*(quick|small|tiny|solo|team|big|ask|question)\s*[:!—-]/i);
  if (pre) out.funnel = { quick: 'quick', small: 'quick', tiny: 'quick', solo: 'solo', team: 'team', big: 'team', ask: 'answer', question: 'answer' }[pre[1].toLowerCase()];
  if (/^\s*video\s*[:!—-]/i.test(t)) { out.video = true; out.funnel = out.funnel || 'solo'; }
  if (/^\s*pdf\s*[:!—-]/i.test(t)) { out.pdf = true; out.funnel = out.funnel || 'solo'; }
  const mdl = t.match(/\b(?:use|with|on|using)\s+(opus|sonnet|haiku)\b/i);
  if (mdl) out.model = mdl[1].toLowerCase();
  return out;
}
/** Does the request ask someone to DO something (vs. only explain)? Questions ("how do I…?", "what is…") don't. */
function asksForAction(prompt) {
  const verbs = /\b(start|run|open|launch|install|set ?up|setup|configure|connect|link|log ?in|login|sign ?in|deploy|fix|add|make|build|create|update|change|remove|delete|enable|turn on|check|verify|test)\b/;
  // a sentence that opens as a question ("how do I add…?") asks for an explanation; any other sentence with a verb asks for action
  return String(prompt || '').toLowerCase().split(/[?.!\n]+/).map((x) => x.trim()).filter(Boolean)
    .some((x) => !/^(what|why|how|where|which|who|when|is|are|does|do|did|can|could|should|explain)\b/.test(x) && verbs.test(x));
}
/** A folder's real path (symlinks resolved), or its plain absolute path if it is gone. */
const realish = (d) => { try { return fs.realpathSync(d); } catch { return path.resolve(String(d)); } };
const nextModel = (m) => MODELS[Math.min(MODELS.length - 1, MODELS.indexOf(m) + 1)] || 'sonnet';

/** "You've hit your session limit · resets 11:10pm" → when to try again (local time, +2 min); null if not a limit. */
function usageLimitUntil(text, nowMs = Date.now()) {
  const t = String(text || '');
  if (!/(hit|reached|exceeded)\s+your\s+(\w+\s+)?(usage|session|weekly|daily|rate)?\s*limit|usage limit|session limit/i.test(t)) return null;
  const m = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const d = new Date(nowMs);
  if (!m) return new Date(nowMs + 30 * 60000);
  let h = Number(m[1]) % 12; if ((m[3] || '').toLowerCase() === 'pm') h += 12; if (!m[3] && Number(m[1]) === 12) h = 12;
  d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
  return new Date(d.getTime() + 2 * 60000);
}

/**
 * Several Claude accounts (claude-swap / `cswap`, github.com/realiti4/claude-swap)? When the active one is at its
 * limit, rotate to one with room and carry on instead of waiting. Returns { ready, account } when an account with
 * room is now active, { until } (earliest reset) when every account is out, or null when cswap is not available.
 * SM_CSWAP_BIN overrides the binary ('none' turns it off — the tests do that).
 */
function accountRescue() {
  const bin = process.env.SM_CSWAP_BIN || 'cswap';
  if (bin === 'none') return null;
  const run = (args) => spawnSync(bin, args, { encoding: 'utf8', timeout: 60000 });
  const list = () => { try { const r = run(['list', '--json']); return r.status === 0 ? JSON.parse(r.stdout) : null; } catch { return null; } };
  // usable only when cswap could read its usage: a dead login (usage null) once read as 0% and was always picked (2026-11-01)
  const room = (a) => a.usageStatus === 'ok' && !!a.usage && ['fiveHour', 'sevenDay'].every((w) => (a.usage?.[w]?.pct ?? 0) < 98);
  let d = list();
  if (!d?.accounts?.length) return null;
  let active = d.accounts.find((a) => a.active);
  if (active && room(active)) return { ready: true, account: active.number, switched: false };
  const spares = d.accounts.filter((a) => !a.active && room(a)).sort((a, b) => (a.usage?.fiveHour?.pct ?? 0) - (b.usage?.fiveHour?.pct ?? 0));
  for (const spare of spares) { // one failing switch never stops the next good account
    if (run(['switch', String(spare.number)]).status !== 0) continue;
    const after = list(); const now = after?.accounts?.find((a) => a.active);
    if (now && room(now)) return { ready: true, account: now.number, switched: true };
    if (after) d = after;
  }
  const resets = d.accounts.flatMap((a) => ['fiveHour', 'sevenDay'].filter((w) => (a.usage?.[w]?.pct ?? 0) >= 98).map((w) => Date.parse(a.usage[w].resetsAt)))
    .filter((t) => Number.isFinite(t));
  return { until: resets.length ? new Date(Math.min(...resets) + 2 * 60000) : null };
}

function createMissions(sm) {
  const { SELF, ROOT, loadProject, readJSON, runQA, fingerprint, usesBeads, bd } = sm;
  const meetings = createMeetings((name) => loadProject(name).dir);
  let ROLES = rosterNow(ROOT).roles;
  const refreshRoster = () => { const r = rosterNow(ROOT); ROLES = r.roles; return r; };
  /** May this job write? Engineers always; anyone else only when the job changes files. */
  const writes = (s) => !roleOf(s.assignee).readOnly || s.changesFiles === true;
  /** Where this mission's work happens: the project the request is about, else the selected one (never "the office" unless it is office work). */
  const projectPath = (p, m) => { if (m.workProject) { try { return loadProject(m.workProject).config.path; } catch { /* unregistered since */ } } return p.config.path; };
  /** The one other registered project a request names ("a video for /bloom-booking"), when asked from the office. */
  const namedProject = (prompt, selected) => {
    const t = String(prompt || '');
    const hits = (sm.listProjects ? sm.listProjects() : []).filter((name) => {
      if (name === selected) return false;
      let dir; try { dir = loadProject(name).config.path; } catch { return false; }
      if (realish(dir) === realish(ROOT) || realish(ROOT).startsWith(realish(dir) + path.sep)) return false; // the office itself, or a folder that holds it
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[\\s/"'(])${esc}(?=$|[\\s/"'),.!?:;])`, 'i').test(t) || t.includes(dir);
    });
    return hits.length === 1 ? hits[0] : null;
  };
  /** Home vs workplace: the office (ROOT) is where the team lives; a project folder is only where it works today. */
  const homeRule = (p, m) => (m.officeMission
    ? `This job is on the office itself (${ROOT}) — the team's home. Keep only office code and office records here; never copy a client project's material (its videos, screenshots, assets, notes, data) into the office.`
    : `HOME vs WORKPLACE: the office (${ROOT}) is the team's home; you are only visiting "${m.workProject || p.name}" (${projectPath(p, m)}) to work on it. Everything you make for this project — code, docs, videos and their source, audio, screenshots, images, scripts, notes — is saved INSIDE ${projectPath(p, m)}, never in the office folder. The office's tools (sm voiceover, sm terminal) may write their output into this project.`);
  /** May this job split? Only the lead's first job on a solo mission, once, when a helper engineer exists (not video / PDF work). */
  const canSplit = (m, s) => m.route?.funnel === 'solo' && !s.kind && s.id === 's1' && !m.split && !m.route.video && !m.route.pdf && helpersFor(ROLES, s.assignee).length > 0;
  const roleOf = (id) => ROLES[id] || { name: String(id).toUpperCase(), title: 'teammate', department: '', readOnly: true, prompt: `You are ${id}.` };

  /** Beads mirror of the mission: an epic + one child issue per job, with real dependencies and the
   *  crew member as assignee. The runner keeps statuses in sync; failures here never stop a mission. */
  function beads(p, fn) {
    if (!usesBeads(p)) return null;
    try { return fn(); } catch (e) { console.log(`[beads] ${e.message}`); return null; }
  }
  function fileInBeads(p, m) {
    beads(p, () => {
      const epic = JSON.parse(bd(p, ['create', `Mission: ${m.prompt.replace(/\s+/g, ' ').slice(0, 90)}`, '-t', 'epic', '-p', '1',
        '-l', `mission,mission:${m.id},src:floor-manager`, '--description', `${m.prompt}\n\nPlan: ${m.plan.summary}`, '--json']));
      m.beadsEpic = epic.id;
      for (const s of m.subtasks) {
        const deps = s.dependsOn.map((d) => m.subtasks.find((x) => x.id === d)?.beadsId).filter(Boolean);
        const args = ['create', s.title, '-t', 'task', '-p', '1', '--parent', epic.id, '-a', roleOf(s.assignee).name,
          '-l', `mission,mission:${m.id},crew:${s.assignee}`, '--description', s.instructions, '--json'];
        if (deps.length) args.push('--deps', deps.map((d) => `blocked-by:${d}`).join(','));
        s.beadsId = JSON.parse(bd(p, args)).id;
      }
    });
  }
  function syncBeads(p, s, how, text) {
    if (!s.beadsId) return;
    beads(p, () => {
      if (how === 'start') bd(p, ['update', s.beadsId, '--status', 'in_progress']);
      if (how === 'blocked') { bd(p, ['update', s.beadsId, '--status', 'blocked']); if (text) bd(p, ['note', s.beadsId, `Waiting on the owner: ${text}`]); }
      if (how === 'done') bd(p, ['close', s.beadsId, '--force', '--reason', String(text || 'done').slice(0, 400)]); // assignee is the crew member, not you
      if (how === 'failed') { bd(p, ['update', s.beadsId, '--status', 'blocked']); bd(p, ['note', s.beadsId, `Failed: ${String(text || '').slice(0, 400)}`]); }
      if (how === 'cancel') bd(p, ['close', s.beadsId, '--force', '--reason', String(text || 'cancelled')]);
    });
  }
  const dirOf = (p) => path.join(p.dir, 'missions');
  const fileOf = (p, id) => path.join(dirOf(p), `${id}.json`);
  const inboxOf = (p, id) => path.join(dirOf(p), `${id}.inbox.jsonl`);
  const now = () => new Date().toISOString();

  function load(p, id) { return readJSON(fileOf(p, id), null); }
  function save(p, m) {
    fs.mkdirSync(dirOf(p), { recursive: true });
    const tmp = `${fileOf(p, m.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, fileOf(p, m.id));
  }
  function list(p, limit = 20) {
    if (!fs.existsSync(dirOf(p))) return [];
    return fs.readdirSync(dirOf(p)).filter((f) => /^m-[\w-]+\.json$/.test(f)).map((f) => readJSON(path.join(dirOf(p), f), null))
      .filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit);
  }
  const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

  // ── the queue: one mission runs per project; the owner can reorder the waiting ones or send one now ──
  const queueFile = (p) => path.join(dirOf(p), 'queue.json');
  const queueOrder = (p) => (readJSON(queueFile(p), {}).order || []).map(String);
  const ACTIVE = ['queued', 'planning', 'working', 'checking', 'paused', 'reviewing'];
  /** Running = past its turn in the queue (a waiting mission is 'queued' and has no dequeuedAt). */
  const isRunning = (x) => x.status !== 'queued' || Boolean(x.dequeuedAt);
  /** Waiting missions go in the owner's order (queue.json), then oldest first. */
  const queueKey = (order, x) => { const i = order.indexOf(x.id); return i >= 0 ? [0, i, ''] : [1, 0, String(x.createdAt)]; };
  const before = (order, a, b) => { const ka = queueKey(order, a), kb = queueKey(order, b); return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]); };
  /** The mission that has to finish before `m` may start: a running one, or a waiting one ahead of it in the queue. */
  function aheadOf(p, m) {
    const order = queueOrder(p);
    const live = list(p, 50).filter((x) => x.id !== m.id && ACTIVE.includes(x.status) && alive(x.runnerPid));
    return live.find(isRunning) || live.filter((x) => before(order, x, m) < 0).sort((a, b) => before(order, a, b))[0] || null;
  }
  /** Missions waiting their turn, in the order they will run. */
  function queued(p) {
    const order = queueOrder(p);
    return list(p, 50).filter((x) => x.status === 'queued' && !x.dequeuedAt && alive(x.runnerPid)).sort((a, b) => before(order, a, b));
  }
  /** The owner dragged the queue into a new order (ids of waiting missions, first = runs next). */
  function reorder(project, ids) {
    const p = loadProject(project);
    const waiting = queued(p).map((x) => x.id);
    const want = (Array.isArray(ids) ? ids : []).map(String).filter((id) => waiting.includes(id));
    const order = [...new Set([...want, ...waiting])];
    fs.mkdirSync(dirOf(p), { recursive: true });
    fs.writeFileSync(queueFile(p), JSON.stringify({ order, at: now() }, null, 2));
    return { ok: true, order };
  }
  /** "Send now": pause what is running (its jobs keep their sessions), run this one, then the paused one carries on. */
  function sendNow(project, id) {
    const p = loadProject(project);
    const t = load(p, id);
    if (!t) throw Object.assign(new Error('No such mission'), { status: 404 });
    if (t.status !== 'queued' || t.dequeuedAt || !alive(t.runnerPid)) throw Object.assign(new Error('Only a mission waiting in the queue can be sent now.'), { status: 409 });
    const live = list(p, 50).filter((x) => x.id !== id && ACTIVE.includes(x.status) && alive(x.runnerPid));
    const paused = live.filter(isRunning);
    const order = [id, ...paused.map((x) => x.id), ...queued(p).map((x) => x.id).filter((x) => x !== id)];
    fs.mkdirSync(dirOf(p), { recursive: true });
    fs.writeFileSync(queueFile(p), JSON.stringify({ order, at: now() }, null, 2));
    for (const x of paused) post(project, x.id, { type: 'preempt', by: id });
    return { ok: true, paused: paused.map((x) => x.id), order };
  }

  /** Called by the UI/CLI. Writes the mission and starts its runner in the background. */
  function create(project, prompt, link = {}) {
    const p = loadProject(project);
    const text = String(prompt || '').trim();
    if (!text) throw Object.assign(new Error('Tell the floor manager what you need.'), { status: 400 });
    if (text.length > 4000) throw Object.assign(new Error('Keep it under 4000 characters.'), { status: 400 });
    const id = `m-${Date.now().toString(36)}`;
    const m = { id, project: p.name, prompt: text, status: 'queued', createdAt: now(), subtasks: [], events: [], cost: 0 };
    if (link.parentId) { m.parentId = link.parentId; m.context = String(link.context || '').slice(0, 12000); }
    say(m, 'orchestrator', m.parentId ? 'Follow-up from your reply — let me think…' : 'Got it! Let me think…');
    save(p, m);
    fs.mkdirSync(path.join(p.dir, 'runs'), { recursive: true });
    const fd = fs.openSync(path.join(dirOf(p), `${id}.log`), 'a');
    const child = spawn(process.execPath, [SELF, 'mission-run', p.name, id], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    return m;
  }

  function post(project, id, msg) {
    const p = loadProject(project);
    if (!load(p, id)) throw Object.assign(new Error('No such mission'), { status: 404 });
    fs.appendFileSync(inboxOf(p, id), JSON.stringify({ ...msg, ts: now() }) + '\n');
    return { ok: true };
  }
  const answer = (project, id, subtask, text) => {
    if (!String(text || '').trim()) throw Object.assign(new Error('Type your answer first.'), { status: 400 });
    return post(project, id, { type: 'answer', subtask: String(subtask), text: String(text).trim().slice(0, 4000) });
  };
  const cancel = (project, id) => post(project, id, { type: 'cancel' });

  /** The owner replies to a filed report. Stored on the mission as m.replies; ARES then answers in the
   *  thread (async, in this process) and, when the reply asks for more work, starts a linked follow-up
   *  mission through the normal create/run path. `answerOnly` = the owner wants an answer, never new work. */
  function reply(project, id, text, opts = {}) {
    const p = loadProject(project);
    const m = load(p, id);
    if (!m) throw Object.assign(new Error('No such mission'), { status: 404 });
    if (!m.report) throw Object.assign(new Error('This mission has no report yet.'), { status: 409 });
    const t = String(text || '').trim();
    if (!t) throw Object.assign(new Error('Type your reply first.'), { status: 400 });
    if (t.length > MAX_REPLY) throw Object.assign(new Error(`Keep it under ${MAX_REPLY} characters.`), { status: 400 });
    if (replyPending(m)) throw Object.assign(new Error('ARES is still answering your last reply.'), { status: 409 });
    m.replies = m.replies || [];
    const entry = { id: `r${m.replies.length + 1}`, from: 'owner', text: t, at: now(), ...(opts.answerOnly ? { answerOnly: true } : {}) };
    m.replies.push(entry);
    say(m, 'owner', t, 'reply');
    m.replyPid = process.pid; // answered by this process (the office server); a restart frees the thread
    save(p, m);
    answerReply(p.name, id, entry.id).catch((e) => {
      fs.appendFileSync(path.join(dirOf(p), `${id}.log`), `[${now()}] reply ${entry.id} failed: ${e.message}\n`);
      const fresh = load(p, id);
      if (fresh) { fresh.replies.push({ id: `${entry.id}-a`, from: 'orchestrator', inReplyTo: entry.id, at: now(), text: `Sorry, something broke while answering (${e.message.slice(0, 200)}). Try again.`, error: true }); save(p, fresh); }
    });
    return { ok: true, reply: entry };
  }
  const replyPending = (m) => m.replies?.at(-1)?.from === 'owner' && alive(m.replyPid);

  function say(m, who, text, kind = 'say') {
    m.events.push({ ts: now(), who, kind, text: String(text || '').slice(0, 120) });
    if (m.events.length > 300) m.events.splice(0, m.events.length - 300);
  }

  // ── Claude runs ──
  /** One-line, human description of a stream event — what the agent is doing right now. */
  function describe(ev, cwd) {
    const rel = (f) => { const r = path.relative(cwd, String(f || '')); return r && !r.startsWith('..') ? r : path.basename(String(f || '')); };
    if (ev.type === 'assistant') {
      const out = [];
      for (const c of ev.message?.content || []) {
        if (c.type === 'thinking') out.push({ kind: 'think', text: (c.thinking || '').trim().slice(0, 400) || 'Thinking…' });
        else if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'say', text: c.text.trim().slice(0, 600) });
        else if (c.type === 'tool_use') {
          const i = c.input || {};
          const map = {
            Read: () => `Reading ${rel(i.file_path)}`, Edit: () => `Editing ${rel(i.file_path)}`, MultiEdit: () => `Editing ${rel(i.file_path)}`,
            Write: () => `Writing ${rel(i.file_path)}`, Bash: () => `$ ${String(i.command || '').slice(0, 160)}`, Grep: () => `Searching for “${String(i.pattern || '').slice(0, 60)}”`,
            Glob: () => `Looking for ${i.pattern}`, StructuredOutput: () => 'Writing up the result', TodoWrite: () => 'Updating my to-do list',
          };
          out.push({ kind: c.name === 'Bash' ? 'run' : c.name === 'StructuredOutput' ? 'done' : 'tool', text: (map[c.name] || (() => `Using ${c.name}`))() });
        }
      }
      return out;
    }
    if (ev.type === 'user') {
      for (const c of ev.message?.content || []) {
        if (c.type === 'tool_result' && c.is_error) return [{ kind: 'error', text: String(Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content || 'error').slice(0, 300) }];
      }
    }
    return [];
  }

  /**
   * One Claude call — but when the owner's plan hits its usage/session limit, wait for the reset and carry on
   * (resuming the same session) instead of failing. A big mission must survive a limit, not burn its retries on it.
   */
  const kids = new Set(); // live claude processes of this runner (killed when the mission is paused by "Send now")
  async function claudeJSON(opts) {
    let o = opts, quickRetries = 0;
    for (let waits = 0; ; waits++) {
      const r = await claudeOnce(o);
      let until = !r.ok && usageLimitUntil(r.error);
      if (!until || waits >= 8 || opts.isCancelled?.()) return r;
      // Another account with room? Switch to it and carry straight on.
      const rescue = accountRescue();
      // (usage figures can be minutes old: "room" without an actual switch is trusted twice, then we wait)
      if (rescue?.ready && (rescue.switched || quickRetries++ < 2)) {
        opts.onSwitch?.(rescue);
        o = r.sessionId ? { ...opts, resume: r.sessionId, prompt: 'You were interrupted by a usage limit (now switched to an account with room). Continue YOUR JOB from where you stopped (check what is already done in the files first) and return the result in the same format.' } : opts;
        continue;
      }
      if (rescue?.until && rescue.until < until) until = rescue.until; // every account is out: wait for the first reset
      opts.onLimit?.(until);
      const step = Number(process.env.SM_LIMIT_POLL_MS || 20000);
      const wakeAt = process.env.SM_LIMIT_WAIT_MS ? Date.now() + Number(process.env.SM_LIMIT_WAIT_MS) : until.getTime(); // tests shorten the wait
      let lastCheck = Date.now();
      while (Date.now() < wakeAt && !opts.isCancelled?.()) {
        await new Promise((res) => setTimeout(res, Math.min(step, Math.max(50, wakeAt - Date.now()))));
        // an account may free up early (METER the account watcher, or the owner switches by hand) — check every few minutes
        if (Date.now() - lastCheck > Number(process.env.SM_RESCUE_EVERY_MS || 180000)) { lastCheck = Date.now(); if (accountRescue()?.ready) break; }
      }
      opts.onLimit?.(null);
      if (opts.isCancelled?.()) return r;
      o = r.sessionId
        ? { ...opts, resume: r.sessionId, prompt: 'You were interrupted by a usage limit. Continue YOUR JOB from where you stopped (check what is already done in the files first) and return the result in the same format.' }
        : opts;
    }
  }

  function claudeOnce({ cwd, prompt, schema, readOnly, resume, model, timeoutSec, extraFlags, role, runnable, full, budget, effort, officeEdit, officeMission, streamFile, onAction, onSession, room = 'control', person, pushEnv }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema)];
    args.push(...pluginDirsFor(ROOT, room, person)); // department training: shared brain + this person's department skills
    if (resume) args.push('--resume', resume);
    args.push('--model', model || DEFAULT_MODEL);
    if (budget) args.push('--max-budget-usd', String(budget));
    if (effort) args.push('--effort', effort);
    // Full access (granted once by the owner): no permission prompts, every tool — like an interactive Claude.
    if (full) {
      args.push('--permission-mode', 'bypassPermissions');
      // checkers / specialists may run anything (tests, the app, a browser) but never change the work they judge
      if (readOnly) args.push('--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit');
    }
    else if (readOnly) {
      args.push('--allowedTools', 'Read', 'Grep', 'Glob', 'Skill', ...(runnable || []), '--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent');
      if (!(runnable || []).length) args.push('Bash');
    }
    else args.push(...(extraFlags || []));
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SM_ROLE: role, ...(officeMission ? { SM_OFFICE_MISSION: '1' } : {}), ...(officeEdit ? { SM_OFFICE_EDIT: '1' } : {}), ...(pushEnv || {}) } });
      kids.add(child);
      let buf = '', err = '', result = null;
      const record = (items) => {
        if (!items.length) return;
        if (streamFile) fs.appendFileSync(streamFile, items.map((x) => JSON.stringify({ ts: now(), ...x })).join('\n') + '\n');
        const last = [...items].reverse().find((x) => x.kind !== 'think' && x.kind !== 'say') || items[items.length - 1];
        onAction?.(last.kind === 'think' ? 'Thinking…' : last.text.split('\n')[0].slice(0, 90));
      };
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'system' && ev.session_id) onSession?.(ev.session_id);
          if (ev.type === 'result') result = ev; else record(describe(ev, cwd));
        }
      });
      child.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => child.kill('SIGTERM'), (timeoutSec || 1800) * 1000);
      child.on('close', (code) => {
        clearTimeout(timer); kids.delete(child);
        if (!result && buf.trim()) { try { const ev = JSON.parse(buf); if (ev.type === 'result') result = ev; } catch { /* partial */ } }
        if (result) {
          const ok = !result.is_error && Boolean(result.structured_output);
          record([{ kind: ok ? 'finish' : 'error', text: ok ? 'Finished.' : String(result.result || result.subtype || 'error').slice(0, 300) }]);
          resolve({ ok, data: result.structured_output, sessionId: result.session_id, cost: result.total_cost_usd || 0, seconds: Math.round((Date.now() - started) / 1000), error: result.is_error ? String(result.result || result.subtype || 'error') : null });
        } else {
          resolve({ ok: false, data: null, cost: 0, error: (err || `claude exited ${code}`).slice(-600) });
        }
      });
    });
  }

  function roster() {
    return Object.entries(ROLES).map(([id, r]) => `- ${id} — ${r.name}, ${r.title} (${r.department}) — ${r.readOnly ? 'read-only specialist' : 'ENGINEER: may change code'}`).join('\n');
  }

  function plannerPrompt(p, m, repo = '') {
    return [
      rosterNow(ROOT).plannerPrompt || 'You are the Planner.',
      `The company works on the project in the current directory ("${p.name}"). Read only what you need (README, a quick grep).`,
      'The owner asked the Floor Manager:',
      `"""${m.prompt}"""`,
      m.context ? `\n${m.context}\n` : '',
      repo ? `\n${repo}\nPlan from this real state: build on uncommitted work instead of redoing it, and if CI is failing say whether this request should fix it first.\n` : '',
      'Rewrite the request into a precise brief and break it into a short ordered plan. Keep the owner\'s intent exactly; do not invent work. Available team:',
      roster(),
    ].join('\n');
  }

  function planPrompt(p, m, repo = '') {
    return [
      rosterNow(ROOT).managerPrompt || 'You are ARES, the Floor Manager.',
      `You lead a small AI company working on the project in the current directory ("${p.name}").`,
      `The owner just asked you:`,
      `"""${m.prompt}"""`,
      m.context ? `\n${m.context}\n` : '',
      repo ? `\n${repo}\n` : '',
      m.planner ? `\nYour Planner ${m.planner.name} drafted this for you. Review it; you must approve it (approval="approved") or fix it (approval="amended") before it goes to the team:\nRewritten brief: ${m.planner.rewrittenPrompt}\nSteps:\n${m.planner.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}${m.planner.risks ? `\nRisks: ${m.planner.risks}` : ''}\n` : '',
      '',
      'Read enough of the repo (README, relevant files) to plan well, then split the request into 1-6 subtasks for your team:',
      roster(),
      '',
      'Rules:',
      '- Set changes_files=true on every job that must create or change files. Prefer giving those to an ENGINEER; if the owner asks for someone else, that person gets write access for the job. Jobs with changes_files=false are read-only and hand back written output.',
      '- If the directory holds several separate apps, set "workdir" on each job to the app folder it touches. Engineers in DIFFERENT workdirs can work at the same time; in the same folder they take turns.',
      '- USE THE TEAM. For medium/large requests split the work by area so several people build AT THE SAME TIME, each owning different files (owns_files must not overlap):',
      '  core logic / API / data → an engineer · UI components & styling → the UI designer · flows, empty/error states, accessibility → the UX researcher · copy & text → marketing · tests → QA. Specialists get write access for their part (changes_files=true).',
      '  Then ONE short integration job for an engineer (depends_on the parts) that wires them together and runs the tests — only if glue is needed.',
      '- Independent read-only investigations have no depends_on so they run in parallel.',
      '- COST MATTERS. size "small" (one focused change) = EXACTLY ONE job for the best person. medium = 2-4 jobs, large = up to 6. Never pad the plan.',
      '- Do NOT plan QA-verification or security-review jobs: after the build, every change automatically goes QA script → QA lead → security engineer, and anything they reject goes back to whoever can fix it.',
      '- Plan quickly: read only what you need to route the work (README, a quick grep). The assignee will do the deep reading.',
      '- Do not invent work the owner did not ask for.',
      `- If the request is about this AI office itself (you, the crew, rooms, reports, missions, the office app), set about_office=true: the team will then work in the office's own code at ${ROOT} (pixel-office/ = the office app, bin/ = the engine). Otherwise it is about the selected project.`,
      '- If the request is ambiguous, still plan; a teammate will ask the owner a specific question when they hit it.',
    ].join('\n');
  }

  /** The router's question: which funnel + model is the cheapest that will still do it right? */
  function routePrompt(p, m) {
    return [
      `You route requests in an AI office. The owner asked, about project "${p.name}":`,
      `"""${m.prompt.slice(0, 3000)}"""`,
      '',
      'Pick the cheapest way that will still get it fully done. Do not use any tools — decide from the request alone.',
      '- answer: ONLY a question or explanation where nothing should be done. Any request to start, run, open, install, set up, log in, connect, fix, check or verify something is NOT an answer — someone has to act.',
      '- quick: ONE small, clear change (wording, a colour, a config value, a tiny bug) touching a file or two.',
      '- solo: a real feature or fix that one capable engineer can do end to end. Most requests are this.',
      '- team: genuinely big, multi-area work that clearly splits into parallel parts (rare — when in doubt, solo).',
      'Model: haiku for trivial edits and simple questions; sonnet for normal work; opus for hard debugging, architecture or subtle, large changes.',
      'about_office = the request is about this AI office itself (crew, missions, panel, 3D view, the office app).',
    ].join('\n');
  }
  function answerPrompt(p, m) {
    return [
      `Answer the owner's question about project "${p.name}" (current directory). Read only what you need; do not change anything.`,
      `Question: """${m.prompt}"""`,
      fs.existsSync(path.join(m.route?.about_office ? ROOT : projectPath(p, m), 'lat.md')) ? 'Start from lat.md/lat.md (the shared brain index) and open only the files it points to.' : '',
      'Plain English, short, complete. The owner is not an engineer.',
    ].filter(Boolean).join('\n');
  }

  function workPrompt(p, m, s) {
    const r = roleOf(s.assignee);
    const done = m.subtasks.filter((x) => x.status === 'done' && x.result);
    const wip = (loadProject(p.name).config.protectedFiles || []).slice(0, 60);
    return [
      r.prompt,
      `You are on a team run by the Floor Manager. Project: "${p.name}"${s.workdir ? ` — you work in its "${s.workdir}" folder (your current directory)` : ' (current directory)'}.`,
      `The owner's request (the whole mission): """${m.prompt}"""`,
      homeRule(p, m),
      m.context || '',
      `The manager's plan: ${m.plan?.summary || ''}`,
      '',
      m.officeMission ? [
        'This job changes the AI OFFICE ITSELF (current directory). pixel-office/ = the office app (Pixel Agents fork: webview-ui/src/sm/* is our React UI, server/src/sm/* our routes); bin/ = the engine (missions.js, sm-api.js, staff.js, sm.js).',
        'pixel-office/ is its OWN git repo (nested): commit changes there with `git -C pixel-office add <paths> && git -C pixel-office commit -m …`, and engine changes in the outer repo. Never push pixel-office (its remote is the upstream project).',
        'Check your work with: cd pixel-office/webview-ui && npx tsc --noEmit -p tsconfig.app.json (and npx eslint src/sm), node --check on changed bin/*.js, and node --test test/*.test.js.',
        'TEST IT LIVE: `node bin/sm.js office --build --restart --no-open` rebuilds and restarts the real office, then `node bin/sm.js office --check --screenshot /tmp/office-<your-name>.png` checks every project through the live API and the browser — Read the screenshot to see the result.',
        `CLICK THROUGH IT like the owner: \`node bin/sm.js office --browse ${s.assignee}\` opens the live office in browser session "${s.assignee}"; drive it with \`playwright-cli -s=${s.assignee} snapshot | click <ref> | fill <ref> <text> | screenshot --filename /tmp/x.png\`. After saving anything, wait ~10s (the office polls every few seconds) and confirm it did not jump back. Run any new \`sm\` command against real data too. Never start/kill office processes any other way. When you are done, CLOSE your browser: \`playwright-cli -s=${s.assignee} close\` (a test browser left open can stop the owner's own Chrome from opening).`,
      ].join('\n') : '',
      `YOUR JOB (#${s.n}${s.beadsId ? `, beads issue ${s.beadsId}` : ''}): ${s.title}`,
      s.instructions,
      '',
      done.length ? `Teammates already finished:\n${done.map((x) => `- #${x.n} ${roleOf(x.assignee).name}: ${x.title}\n  ${x.result.summary}\n  ${String(x.result.details || '').slice(0, 2500)}${(x.answers || []).map((a) => `\n  The owner answered their question "${x.question?.what || ''}": "${a.text}"`).join('')}`).join('\n')}` : '',
      '',
      s.kind === 'part' ? [
        `You are building ONE PART of a bigger job. ${roleOf(m.lead).name} leads it: they split the work, and after every part is in they wire it together and check the whole thing.`,
        m.split?.contract ? `The shared contract (code against it exactly):\n${m.split.contract}` : '',
        'Build your part completely, test it on its own, commit only your files. Anything outside your files that your part needs: describe it exactly in "details" for the lead.',
      ].filter(Boolean).join('\n') : '',
      m.route && m.route.funnel !== 'team' && s.kind !== 'part' ? [
        'YOU OWN THIS REQUEST END TO END — there is no planner and no team behind you. Work like a senior engineer in a terminal:',
        '0) list every distinct thing the owner asked for, taking their words literally ("another agent" = a new crew member in the office) — deliver ALL of them,',
        '1) read only what you need (shared brain first), 2) make the change, 3) run it and USE it the way the owner will (tests, the app, a browser for anything visible),',
        '4) fix whatever you find, 5) only then report. Never hand work back to the owner that you can do yourself (build, install, restart, migrate).',
        m.route.funnel === 'quick' ? 'This is a QUICK change: keep it small and direct — no refactors, no extras.' : '',
        canSplit(m, s) ? [
          `YOU MAY DELEGATE. Helper engineers are free: ${helpersFor(ROLES, s.assignee).map((h) => `${ROLES[h].name} (${h})`).join(', ')}. Use them ONLY when, after reading the code, the job is genuinely big`,
          'and splits into pieces that live in DIFFERENT files (e.g. a server route + a UI panel + a CLI command). Small, tightly coupled or unclear work: do it yourself — a split costs more.',
          'To split: (1) read enough to design it, (2) write and commit any shared groundwork every piece needs (types, interfaces, empty stubs), (3) return status "split" with "delegate":',
          'a precise contract, your own part, one part per helper, and your integration plan. Every part owns files no other part touches. Do not build the parts before you return.',
          'You get your session back for your part, and again once every part is in — then YOU wire it together, run everything, use it like the owner and fix what is off. The helpers\' work is yours to check.',
        ].join('\n') : '',
      ].filter(Boolean).join('\n') : '',
      'Work tersely (caveman skill): no narration between tool calls, no recaps. The JSON you return goes to the owner — keep its summary plain, short English.',
      '',
      'Rules:',
      '- Do ONLY your job. Stay focused and efficient.',
      fs.existsSync(path.join(m.officeMission ? ROOT : projectPath(p, m), 'lat.md')) ? '- Save tokens: read lat.md/lat.md (the shared brain index) first and open only the files it points you to, before any broad Grep/Glob.' : '',
      !writes(s)
        ? '- You are read-only: you may READ files and RUN the project\'s test/inspection commands to verify things, but never edit, commit or delete. Hand back findings/text in "details".'
        : [
          '- Make the smallest correct change. Add/adjust tests where the logic is testable and run the project tests.',
          s.owns?.length ? `- TEAMWORK: teammates are editing other files right now. You own ONLY: ${s.owns.join(', ')}. Do not edit anything else; if your part needs a change elsewhere, describe it exactly in "details" for the integrator.` : '',
          '- Commit your work: `git add <only the files you changed, by path>` then `git commit -m "<summary> (mission ' + m.id + ')"`. Never bulk-add. If git says index.lock exists, a teammate is committing at the same moment: wait a few seconds and retry (never delete the lock).',
          wip.length ? `- The owner has uncommitted work in these files — do not stage, commit or revert them: ${wip.join(', ')}` : '',
          '- When you stop, an independent QA script runs; if it fails you will be told and must fix it.',
          fs.existsSync(path.join(m.officeMission ? ROOT : projectPath(p, m), 'lat.md')) ? '- Shared brain: if you changed behaviour that a lat.md/ section describes (or added a new area), update that section in the same commit and run `lat check`.' : '',
        ].filter(Boolean).join('\n'),
      '- If you truly cannot finish without the owner (a decision, credentials, real-device testing, unclear requirement), return status "needs_human" with a question explained like they are 5 years old. Never guess on something that matters.',
      '- "bubble" is what you say out loud in the office — short and human ("On it!", "Found it!", "Need your help!").',
    ].filter((l) => l !== '').join('\n');
  }

  /** What a QA / security checker sees: the request, what the team says it did, and the REAL diff. */
  function gatePrompt(p, m, s) {
    const root = m.officeMission ? ROOT : projectPath(p, m);
    const snap = m.baseSnap?.length ? diffSnapshots(m.baseSnap, snapshotAll(m.workDirs)) : null;
    const diff = snap ? snap.patch : '';
    const team = Object.entries(ROLES).map(([id, r]) => `${id} = ${r.name}, ${r.title}`).join('; ');
    const qa = s.stage === 'qa';
    return [
      roleOf(s.assignee).prompt,
      `You are the ${qa ? 'QA' : 'security'} hand-off for the owner's request on project "${p.name}" (current directory: ${root}). The work is not shown to the owner until you pass it.`,
      `Request: """${m.planner?.rewrittenPrompt || m.prompt}"""`,
      `Plan: ${m.plan?.summary || ''}`,
      '',
      'What the team says it did:',
      ...m.subtasks.filter((x) => x.kind !== 'gate' && x.result).map((x) => `- #${x.n} ${roleOf(x.assignee).name}: ${x.title}\n  ${x.result.summary}${x.result.verified_by ? `\n  checked by: ${x.result.verified_by}` : ''}`),
      m.loop?.history?.length ? `\nEarlier rounds sent back: ${m.loop.history.map((h) => `round ${h.round} (${h.by}): ${h.issues.join('; ')}`).join(' | ')}. Confirm those are really fixed.` : '',
      m.loop?.lastQa?.length ? `\nThe independent QA script just passed: ${m.loop.lastQa.map((x) => x.name).join(', ')}.` : '',
      '',
      `Files changed: ${snap ? snap.files.join(', ').slice(0, 3000) : 'see git'}`,
      'The real diff (may be truncated — read the files for more):',
      (diff || '(no diff available — use git diff / read the files)').slice(0, 50000),
      '',
      m.route?.funnel === 'solo' ? 'This is the ONLY check before the owner sees it: cover both QA (it really works) and security (nothing unsafe was introduced in the diff).' : '',
      qa
        ? [
          'YOUR JOB: prove the change does what the owner asked, by USING it the way the owner will. Use your training (owner-eye-check first, then verification-before-completion, webapp-testing). Anything that opens links, pop-ups or sign-ins must work in the owner\'s Mac app too, and cloud commands must use the project\'s own account.',
          'FIRST, list every distinct thing the owner asked for, taking their words literally (e.g. "another agent" = a new crew member you can see in the office; "at the top of my screen" = visible there; "he switches accounts" = it really switches). Put the list in `checked`. Anything on it that is missing or only partly there is a BLOCKING issue — "it works" is not enough if it is not what they asked for.',
          m.officeMission
            ? `For anything visible in the office: \`node bin/sm.js office --browse ${s.assignee}\` opens the LIVE office in browser session "${s.assignee}"; then \`playwright-cli -s=${s.assignee} snapshot\` / click / fill / screenshot --filename /tmp/${s.assignee}.png (Read the PNG to see it). Do the owner's real steps (e.g. open the panel, change the setting, SAVE), then WAIT ~10 seconds (the office refreshes every few seconds) and check the change is still there, then reload and check again. Close the session when done.`
            : `For anything with a UI: run the app (the project's dev/preview command${p.config.preview?.url ? `; it serves ${p.config.preview.url}` : ''}) and drive it with playwright-cli the way a user would — change things, save, wait, reload, check it stuck.${sm.hasTestBrowser?.() ? ' Open it with `--browser=chromium` (the separate test browser, never the owner\'s Chrome).' : ''}`,
          `Close your browser session when you are done (\`playwright-cli -s=${s.assignee} close\`) — a hidden test browser left open can stop the owner's own Chrome from opening.`,
          'Also run the relevant tests and check the obvious edge cases (empty, error, loading, small screen).',
          'A check you did not actually do is NOT a pass: if you could not use the feature for real (it would not start, the page would not load, a tool was blocked), set pass=false with an issue saying exactly what stopped you, fix_by the engineer.',
          'FAIL for real problems: it does not do what was asked, it is broken, a change does not stick, or it broke something else.',
        ].join('\n')
        : 'YOUR JOB: security review of THIS diff (use your training: differential-review, sharp-edges). Look for what it introduced: injection (shell/SQL/HTML), path traversal, auth or permission bypass, secrets in code or logs, cloud/CLI commands run under the wrong account, keys / service accounts / OAuth clients created or deleted without the owner asking, unsafe defaults, missing input validation at trust boundaries, SSRF, risky new dependencies. FAIL only for real, exploitable or high-risk problems in the changed code — not style, not theoretical issues in untouched code.',
      `Every blocking issue needs fix_by = the id of the teammate best placed to fix it. Team: ${team}. Code problems usually go to the engineer who wrote it; wording to marketing; look-and-feel to design.`,
      'Non-blocking polish goes in notes, never in issues. You are read-only: do not edit anything.',
    ].filter(Boolean).join('\n');
  }

  function reviewPrompt(p, m, diff, qa) {
    return [
      `You are ARES, the Floor Manager. Your team finished the owner's request on project "${p.name}". Review the REAL work before it goes on the owner's desk.`,
      `Request: """${m.prompt}"""`,
      `Plan: ${m.plan?.summary || ''}`,
      '',
      'What each teammate reported:',
      ...m.subtasks.map((s) => [
        `- #${s.n} ${roleOf(s.assignee).name} [${s.status}] ${s.title}`,
        `  ${s.result?.summary || s.error || ''}`,
        `  verified_by: ${s.result?.verified_by || '-'}`,
        ...(s.answers || []).map((a) => `  ASKED THE OWNER: "${s.question?.what || ''}" — OWNER ANSWERED: "${a.text}"`),
      ].join('\n')),
      '',
      `Independent QA run just now: ${qa.length ? qa.map((r) => `${r.name}: ${r.ok ? 'PASS' : 'FAIL'}`).join(', ') : 'no QA commands configured'}`,
      '',
      'Actual diff since the mission started (may be truncated):',
      diff || '(no code changes)',
      '',
      'The owner only wants FINISHED work on their desk. If something they asked for is not done, was never actually tried the way the owner would use it (e.g. a UI nobody clicked through in a browser), or looks wrong in the diff, put it in send_back with fix_by — the team will fix and re-check it before the owner sees anything. Use concerns only for small notes that do not stop it working.',
      `Team ids for fix_by: ${Object.entries(ROLES).map(([id, x]) => `${id} = ${x.name}, ${x.title}`).join('; ')}.`,
      'Do not send back unrelated older changes in the diff, style nits, or things only the owner can do (their keys, payments, devices) — those go in concerns / for_you.',
      'Do NOT send back "verify / check / test it again" when the QA lead already used it live and passed it — that is not a defect, and re-verification loops waste the owner\'s budget. Send back only things that are missing or broken, with evidence. You get ONE send-back per mission.',
      'Write the report honestly. Do not trust teammates\' claims over the diff and QA.',
      'You may read files to double-check. Plain English — the owner is not an engineer.',
    ].join('\n');
  }

  function replyPrompt(p, m, entry) {
    const r = m.report;
    const thread = (m.replies || []).filter((x) => x.id !== entry.id).map((x) => `${x.from === 'owner' ? 'OWNER' : 'YOU'}: ${x.text}`);
    return [
      `You are ARES, the Floor Manager. You filed a report on project "${p.name}" and the owner replied to it.`,
      `Original request: """${m.prompt}"""`,
      '',
      'Your report:',
      `- ${String(r.verdict).toUpperCase()}: ${r.headline}`,
      `- Summary: ${r.summary}`,
      r.concerns?.length ? `- Concerns: ${r.concerns.join(' | ')}` : '',
      r.next_steps?.length ? `- Next steps: ${r.next_steps.join(' | ')}` : '',
      `- For the owner: ${r.for_you}`,
      r.commits?.length ? `- Commits: ${r.commits.join(', ')}` : '',
      r.qa?.length ? `- QA: ${r.qa.map((q) => `${q.name} ${q.ok ? 'PASS' : 'FAIL'}`).join(', ')}` : '',
      thread.length ? `\nThread so far:\n${thread.join('\n')}` : '',
      '',
      `The owner's reply: """${entry.text}"""`,
      '',
      'Answer them honestly in plain English (they are not an engineer). You may read files to check; you cannot change anything here.',
      entry.answerOnly
        ? 'The owner asked for an answer only: set follow_up to false.'
        : 'If the reply asks the team to do more work, set follow_up to true and describe the new request in follow_up_prompt — a new mission will start. Questions, thanks or opinions are follow_up false. Do not invent work they did not ask for.',
    ].filter((l) => l !== '').join('\n');
  }

  /** Background half of reply(): ARES answers in the thread; a work request starts a linked follow-up mission. */
  async function answerReply(project, id, replyId) {
    const p = loadProject(project);
    const m0 = load(p, id);
    const entry = m0?.replies?.find((x) => x.id === replyId && x.from === 'owner');
    if (!entry) throw new Error(`no reply ${replyId} on mission ${id}`);
    const r = await claudeJSON({ cwd: p.config.path, prompt: replyPrompt(p, m0, entry), schema: REPLY_SCHEMA, readOnly: true, model: p.config.managerModel, timeoutSec: 900, role: 'auditor', budget: BUDGET.reply, effort: 'low' });
    const m = load(p, id); // re-read: the UI may have written while ARES was thinking
    m.cost = (m.cost || 0) + r.cost;
    const ans = { id: `${replyId}-a`, from: 'orchestrator', inReplyTo: replyId, at: now(),
      text: r.ok ? r.data.answer : `Sorry, I could not answer just now (${String(r.error || 'error').slice(0, 200)}). Try again.`, ...(r.ok ? {} : { error: true }) };
    if (r.ok && r.data.follow_up && !entry.answerOnly) {
      const r0 = m.report;
      const context = [
        `This is a FOLLOW-UP to mission ${m.id}. The owner replied to its report.`,
        `Original request: """${m.prompt}"""`,
        `Report (${r0.verdict}): ${r0.headline} — ${r0.summary}`,
        r0.concerns?.length ? `Concerns: ${r0.concerns.join(' | ')}` : '',
        r0.next_steps?.length ? `Next steps it listed: ${r0.next_steps.join(' | ')}` : '',
        r0.commits?.length ? `Commits: ${r0.commits.join(', ')}` : '',
        `The owner's reply (the new request): """${entry.text}"""`,
        `How ARES read it: ${r.data.follow_up_prompt}`,
      ].filter(Boolean).join('\n');
      const child = create(p.name, entry.text, { parentId: m.id, context });
      ans.followUpId = child.id;
      m.followUpId = child.id;
    }
    m.replies.push(ans);
    say(m, 'orchestrator', ans.followUpId ? 'On it — follow-up mission started!' : ans.text, ans.followUpId ? 'assign' : 'say');
    save(p, m);
    return ans;
  }

  // ── Runner (one process per mission) ──
  async function run(project, id) {
    const p = loadProject(project);
    let m = load(p, id);
    if (!m) throw new Error(`no mission ${id}`);
    const cfg = p.config;
    const builderFlags = cfg.claudeFlags || ['--permission-mode', 'acceptEdits'];
    const hasFull = () => loadProject(m.workProject || p.name).config.fullAccess === true; // read fresh: you can toggle it any time
    const wp = () => { if (m.workProject) { try { return loadProject(m.workProject); } catch { /* gone */ } } return p; }; // the project the work is in
    // Specialists may RUN things (tests, the app's CLI) to verify — but never change the repo.
    const runnable = builderFlags.filter((f) => /^Bash\(/.test(f) && !/git (add|commit|push|reset|checkout|stash|clean|rebase)|\bbd\b|\brm\b|npm (install|i |publish)/.test(f));
    const running = new Map(); // subtaskId -> promise
    let consumed = m.inboxConsumed || 0;
    const persist = () => { m.updatedAt = now(); save(p, m); };
    let persistTimer = null;
    const throttledPersist = () => { if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 1500); };
    const log = (...a) => console.log(`[${now()}]`, ...a);
    // One runner per mission: if another live runner already owns it (double-clicked Resume), bow out.
    if (m.runnerPid && m.runnerPid !== process.pid && alive(m.runnerPid) && process.env.SM_MISSION_TAKEOVER !== '1') {
      const owner = spawnSync('ps', ['-o', 'command=', '-p', String(m.runnerPid)], { encoding: 'utf8' }).stdout;
      if (owner.includes('mission-run') && owner.includes(id)) { log(`another runner (pid ${m.runnerPid}) owns this mission — exiting`); return; }
    }
    m.runnerPid = process.pid;
    m.preempting = null; // a pause for "Send now" belongs to the runner that was paused
    m.limitUntil = null; // a "paused until…" left by an earlier runner means nothing to this one
    if (m.status === 'paused') m.status = 'working';
    const workRoot = () => (m.officeMission ? ROOT : wp().config.path);
    // Usage limit: every Claude call in this mission waits for the reset instead of failing (see claudeJSON).
    let pausedFrom = null, waitingOnLimit = 0;
    const limitOpts = {
      isCancelled: () => m.cancelRequested === true || Boolean(m.preempting),
      onSwitch: (x) => { if (x.switched) { say(m, 'orchestrator', `Hit the usage limit — switched to account ${x.account} and carrying on.`); persist(); } },
      onLimit: (until) => {
        if (until) {
          waitingOnLimit++;
          if (!m.limitUntil) { pausedFrom = m.status; say(m, 'orchestrator', `We hit your usage limit — pausing until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, then we carry on.`); }
          m.limitUntil = until.toISOString(); m.status = 'paused';
        } else if (--waitingOnLimit <= 0) {
          waitingOnLimit = 0; m.limitUntil = null; if (m.status === 'paused') m.status = pausedFrom || 'working';
          say(m, 'orchestrator', 'Usage is back — carrying on.');
        }
        persist();
      },
    };
    const cj = (o) => claudeJSON({ ...o, ...limitOpts });
    /** Push scope for the guard: the selected folder, plus any other registered project / folder the owner named
     *  in a request that talks about pushing ("…and push it to fuel-app too"). */
    const pushEnvFor = (mm) => {
      const extra = [];
      if (/\bpush/i.test(mm.prompt)) {
        for (const name of sm.listProjects ? sm.listProjects() : []) {
          if (name !== p.name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(mm.prompt)) { try { extra.push(loadProject(name).config.path); } catch { /* not a project */ } }
        }
        for (const x of mm.prompt.match(/(?:~|\/)[\w./-]+/g) || []) { const d = x.replace(/^~/, require('os').homedir()); if (fs.existsSync(d)) extra.push(d); }
      }
      return { SM_PUSH_ROOT: workRoot(), ...(extra.length ? { SM_PUSH_EXTRA: extra.join(path.delimiter) } : {}) };
    };

    // 0) One mission per project at a time. Two missions editing the same code fight over files and the edit lock,
    //    and pay twice for the same context — a new request waits for the one already running.
    /** Wait until nothing runs and nobody waiting is ahead of this mission. False = cancelled while waiting. */
    const waitTurn = async (paused) => {
      let announced = null;
      for (;;) {
        const ahead = aheadOf(p, m);
        if (!ahead) break;
        if (fs.existsSync(inboxOf(p, id)) && fs.readFileSync(inboxOf(p, id), 'utf8').split('\n').slice(consumed).some((l) => l.includes('"type":"cancel"'))) return false;
        if (announced !== ahead.id) {
          if (!announced && !paused) say(m, 'orchestrator', `Queued — I'll start once "${ahead.prompt.slice(0, 50)}" is finished, so the two don't collide.`);
          announced = ahead.id; m.status = 'queued'; m.dequeuedAt = null; m.waitingFor = ahead.id; persist();
        }
        await new Promise((r) => setTimeout(r, Number(process.env.SM_QUEUE_POLL_MS || 10000)));
      }
      m.waitingFor = null; m.dequeuedAt = now(); persist();
      return true;
    };
    if (!m.plan && !(await waitTurn())) { m.status = 'cancelled'; say(m, 'orchestrator', 'Mission cancelled.'); persist(); return; }

    // 0b) route: pick the funnel + model (owner's words first, then one cheap Haiku call)
    const officeProject = (() => { try { return fs.realpathSync(cfg.path) === fs.realpathSync(ROOT); } catch { return false; } })();
    if (!m.plan && !m.route) {
      const own = ownerRoute(m.prompt);
      let r = { funnel: own.funnel || 'solo', model: own.model || 'sonnet', about_office: officeProject, title: m.prompt.replace(/\s+/g, ' ').slice(0, 60), reason: 'default' };
      if (!own.funnel || !own.model) {
        const rr = await cj({ cwd: cfg.path, prompt: routePrompt(p, m), schema: ROUTE_SCHEMA, readOnly: true, model: 'haiku', timeoutSec: 180, role: 'auditor', budget: 0.1, effort: 'low', room: '' });
        m.cost += rr.cost;
        if (rr.ok) r = { ...r, ...rr.data, funnel: own.funnel || rr.data.funnel, model: own.model || rr.data.model, about_office: rr.data.about_office || officeProject };
      }
      if (!FUNNELS.includes(r.funnel)) r.funnel = 'solo';
      // "start the firebase cli and i'll log in" once got a read-only answer: a request to DO something never does
      if (r.funnel === 'answer' && !own.funnel && asksForAction(m.prompt)) { r.funnel = 'quick'; r.reason = `${r.reason} (it asks for an action, so someone acts)`.slice(0, 200); }
      if (!MODELS.includes(r.model)) r.model = 'sonnet';
      // Asked from the office about another project ("a video for /bloom-booking"): the team goes to work in THAT
      // project's folder and everything it makes is saved there. The office is home, not the workplace.
      const named = officeProject ? namedProject(m.prompt, p.name) : null;
      if (named) { m.workProject = named; r.about_office = false; say(m, 'orchestrator', `This is for ${named} — we'll work in its folder, not in the office.`, 'plan'); }
      m.route = { funnel: r.funnel, model: r.model, about_office: r.about_office === true, video: own.video === true || (r.video === true && r.about_office !== true), pdf: own.pdf === true || (r.pdf === true && r.about_office !== true), title: String(r.title || '').slice(0, 80), reason: String(r.reason || '').slice(0, 200), owner: own };
      say(m, 'orchestrator', { answer: 'A question — answering it directly.', quick: `Small one — ${r.model} will just do it.`, solo: `One person can own this end to end (${r.model}).`, team: 'This is big — getting the team on it.' }[r.funnel], 'plan');
      log('route', JSON.stringify(m.route));
      persist();
    }

    // answer: one read-only call; the answer is the report
    if (m.route?.funnel === 'answer' && !m.report) {
      m.status = 'working'; persist();
      const ar = await cj({ cwd: m.route.about_office ? ROOT : wp().config.path, prompt: answerPrompt(p, m), schema: ANSWER_SCHEMA, readOnly: true, full: hasFull(), runnable, model: m.route.model, timeoutSec: 900, role: 'auditor', budget: JOB_BUDGET.answer, effort: m.route.model === 'haiku' ? 'low' : undefined, streamFile: path.join(dirOf(p), `${m.id}.answer.stream.jsonl`) });
      m.cost += ar.cost;
      m.report = ar.ok
        ? { headline: String(ar.data.headline || m.route.title).slice(0, 80), verdict: 'success', summary: ar.data.answer, completed: [], changes: [], checks: { qa_passed: true, notes: 'A question — nothing was changed, so no QA was needed.' }, concerns: [], next_steps: ar.data.next_steps || [], for_you: 'Nothing — reply to this report to follow up.' }
        : { headline: 'Could not answer', verdict: 'failed', summary: String(ar.error || 'error').slice(0, 300), completed: [], changes: [], checks: { qa_passed: false, notes: '' }, concerns: [], next_steps: [], for_you: 'Ask again, or add more detail.' };
      Object.assign(m.report, { at: now(), cost: m.cost, route: m.route });
      m.status = 'done'; m.finishedAt = now();
      say(m, 'orchestrator', 'Answer is on your desk.', 'report');
      persist();
      return;
    }

    // quick / solo: no planner, no manager plan — one job for one lead engineer
    if (!m.plan && m.route && m.route.funnel !== 'team') {
      m.officeMission = m.route.about_office || (officeProject && !m.workProject);
      if (m.officeMission) say(m, 'orchestrator', 'This one is about our office — working on our own code.');
      // video requests go to the one crew member in charge of videos (REEL)
      const lead = (m.route.video && ROLES[VIDEO_LEAD] ? VIDEO_LEAD : null) || (m.route.pdf && ROLES[PDF_LEAD] ? PDF_LEAD : null) || Object.entries(ROLES).find(([, r]) => !r.readOnly)?.[0] || 'builder';
      m.plan = { summary: `${m.route.funnel === 'quick' ? 'Quick change' : 'One owner, end to end'}: ${m.route.title}`, bubble: 'On it!', size: m.route.funnel === 'quick' ? 'small' : 'medium' };
      m.subtasks = [{ id: 's1', n: 1, title: m.route.title || 'Do the request', assignee: lead, instructions: m.prompt, workdir: '', dependsOn: [], status: 'queued', cost: 0, changesFiles: true, owns: [], model: m.route.model }];
      fileInBeads(p, m);
      m.workDirs = [workRoot()];
      m.baseSnap = snapshotAll(m.workDirs);
      say(m, lead, `Assigned: ${m.subtasks[0].title}`, 'assign');
      m.status = 'working'; persist();
    }

    // 1) plan (team funnel only)
    if (!m.plan) {
      m.status = 'planning'; persist();
      log('planning');
      refreshRoster();
      // the repo's live state (branch, uncommitted work, recent commits, CI) so the plan starts from where the code really is
      let repo = ''; try { repo = await require('./devpulse.js').createDevPulse(ROOT).forProject(wp().config.path); } catch { /* optional */ }
      // 0) the Planner rewrites the prompt and drafts the plan; the Floor Manager approves it below
      const pl = rosterNow(ROOT).planner;
      if (pl && !m.planner) {
        say(m, pl.id, 'Rewriting the request and drafting a plan…', 'plan');
        persist();
        const pr = await cj({ cwd: wp().config.path, prompt: plannerPrompt(p, m, repo), schema: plannerSchema, readOnly: true, full: hasFull(), runnable, model: cfg.managerModel, timeoutSec: 600, role: 'auditor', budget: BUDGET.plan, effort: 'low' });
        m.cost += pr.cost;
        if (pr.ok) {
          m.planner = { by: pl.id, name: pl.name, rewrittenPrompt: String(pr.data.rewritten_prompt || m.prompt).slice(0, 4000), steps: (pr.data.steps || []).map((x) => String(x).slice(0, 300)), risks: String(pr.data.risks || '').slice(0, 500), at: now() };
          say(m, pl.id, pr.data.bubble || 'Plan drafted — over to ARES.', 'plan');
        } else { log('planner failed (the Floor Manager plans alone):', pr.error); say(m, pl.id, 'I could not draft it — ARES will plan directly.'); }
        persist();
      }
      const r = await cj({ cwd: wp().config.path, prompt: planPrompt(p, m, repo), schema: planSchema(Object.keys(ROLES)), readOnly: true, full: hasFull(), runnable, model: cfg.managerModel, timeoutSec: 900, role: 'auditor', budget: BUDGET.plan, effort: 'low' });
      m.cost += r.cost;
      if (!r.ok) { m.status = 'failed'; m.error = `Planning failed: ${r.error}`; say(m, 'orchestrator', 'I could not make a plan. See the details.'); persist(); return; }
      m.plan = { summary: r.data.summary, bubble: r.data.bubble, size: r.data.size || 'medium' };
      if (m.planner) { // nothing reaches the team without the Floor Manager's sign-off
        m.approval = { by: 'orchestrator', status: r.data.approval === 'amended' ? 'amended' : 'approved', note: String(r.data.approval_note || '').slice(0, 300), at: now() };
        say(m, 'orchestrator', m.approval.status === 'approved' ? 'Plan approved — handing it to the team.' : `Plan amended and approved: ${m.approval.note}`, 'plan');
      }
      // Requests about the office itself are worked in the office's own code, whatever project is selected.
      m.officeMission = r.data.about_office === true && !m.workProject;
      if (m.officeMission) say(m, 'orchestrator', 'This one is about our office — working on our own code.');
      if (m.plan.size === 'small' && r.data.subtasks.length > 1) r.data.subtasks = [r.data.subtasks.find((x) => !roleOf(x.assignee).readOnly) || r.data.subtasks[0]].map((x) => ({ ...x, depends_on: [] }));
      m.subtasks = r.data.subtasks.map((s, i) => ({
        id: `s${i + 1}`, n: i + 1, title: s.title, assignee: s.assignee, instructions: s.instructions, workdir: safeWorkdir(r.data.about_office === true ? ROOT : wp().config.path, s.workdir),
        dependsOn: (s.depends_on || []).filter((d) => d >= 1 && d <= r.data.subtasks.length && d !== i + 1).map((d) => `s${d}`),
        status: 'queued', cost: 0, changesFiles: s.changes_files === true,
        owns: (Array.isArray(s.owns_files) ? s.owns_files : []).map((x) => String(x).trim()).filter((x) => x && !x.startsWith('/') && !x.includes('..')).slice(0, 40),
      }));
      fileInBeads(p, m);
      // "before" picture for the report's diff: every repo the jobs can touch
      m.workDirs = [...new Set([workRoot(), ...m.subtasks.filter((x) => x.workdir).map((x) => path.join(workRoot(), x.workdir))])];
      m.baseSnap = snapshotAll(m.workDirs);
      say(m, 'orchestrator', r.data.bubble || `Split it into ${m.subtasks.length} jobs!`);
      for (const s of m.subtasks) say(m, s.assignee, `Assigned: ${s.title}`, 'assign');
      m.status = 'working'; persist();
    }

    // Selected project = the office itself → it is an office mission, even if the plan didn't flag it
    // (also fixes missions that were planned before this rule, when they resume).
    if (!m.officeMission && !m.workProject && (() => { try { return fs.realpathSync(cfg.path) === fs.realpathSync(ROOT); } catch { return false; } })()) {
      m.officeMission = true;
      if (m.subtasks?.length) m.workDirs = [...new Set([ROOT, ...m.subtasks.filter((x) => x.workdir).map((x) => path.join(ROOT, x.workdir))])];
      persist();
    }
    // "before" commit of the repo the work happens in (known only now: office or project, which project)
    m.baseCommit = m.baseCommit || spawnSync('git', ['-C', workRoot(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || null;

    const start = (s, resumeText) => {
      const reader = !writes(s);
      const cwd = s.workdir ? path.join(workRoot(), s.workdir) : workRoot();
      s.status = 'working'; s.startedAt = s.startedAt || now();
      syncBeads(p, s, 'start');
      const wasPaused = s.preempted; s.preempted = false;
      say(m, s.assignee, wasPaused ? 'Back on it!' : resumeText ? 'Thanks! Back on it.' : ['On it!', 'Let me look…', 'Starting now!'][s.n % 3]);
      persist();
      log('start', s.id, s.assignee, resumeText ? '(resume)' : '');
      const answeredBy = s.answers?.length ? s.answers[s.answers.length - 1].by : null;
      if (s.kind === 'integrate' && !resumeText) integrateBrief(s);
      // a fix for work this person already did continues THEIR session: they remember the code, and the cached context is cheap
      const continuing = !resumeText && s.resumeFrom;
      const prompt = wasPaused && resumeText ? resumeText : resumeText ? `${answeredBy ? `${roleOf(answeredBy).name} (your manager)` : 'The owner'} answered your question: """${resumeText}"""\nContinue YOUR JOB with this and return the result in the same format.`
        : continuing && (s.kind === 'part' || s.kind === 'integrate') ? s.instructions
          : continuing ? `${s.instructions}\n\nFix these in the work you just did, verify each fix the way the owner would use it, then return the result in the same format.`
            : s.kind === 'gate' ? gatePrompt(p, m, s) : workPrompt(p, m, s);
      const funnel = m.route?.funnel;
      const jobBudget = s.kind === 'part' ? PART_BUDGET * (s.model === 'opus' ? 2 : 1)
        : s.kind === 'integrate' ? INTEGRATE_BUDGET * (s.model === 'opus' ? 2 : 1)
          : s.kind === 'gate' ? (GATE_BUDGET[m.plan?.size] || GATE_BUDGET.medium)
        : funnel && JOB_BUDGET[funnel] ? JOB_BUDGET[funnel] * (s.model === 'opus' ? 2 : 1)
          : (BUDGET[m.plan?.size] || BUDGET.medium)[reader ? 'specialist' : 'engineer'];
      const promise = cj({
        cwd, prompt, schema: s.kind === 'gate' ? GATE_SCHEMA : WORK_SCHEMA, readOnly: reader, resume: resumeText ? s.sessionId : continuing ? s.resumeFrom : undefined, room: ROLES[s.assignee]?.room || 'engineering', person: s.assignee,
        model: s.model || (reader ? (cfg.auditModel || DEFAULT_MODEL) : (cfg.builderModel || DEFAULT_MODEL)), timeoutSec: reader ? 1200 : 3600,
        budget: (s.budgetBoost || 1) * jobBudget,
        effort: s.kind === 'gate' ? 'low' : undefined,
        extraFlags: builderFlags, runnable: reader ? runnable : undefined, role: reader ? 'auditor' : 'mission', full: hasFull(),
        officeEdit: Boolean(m.officeMission) && !reader,
        officeMission: Boolean(m.officeMission),
        pushEnv: pushEnvFor(m), // git push: only the selected folder's repo, plus repos the owner named in the request
        streamFile: path.join(dirOf(p), `${m.id}.${s.id}.stream.jsonl`),
        onAction: (text) => { s.lastAction = text; s.lastActionAt = now(); throttledPersist(); },
        onSession: (sid) => { s.liveSession = sid; },
      }).then((r) => {
        running.delete(s.id);
        if (s.lock) {
          s.lock = false;
          const stillWriting = m.subtasks.some((x) => x !== s && x.lock && (x.workdir || '.') === (s.workdir || '.'));
          if (!stillWriting) folderLock(ROOT, s.workdir ? path.join(workRoot(), s.workdir) : workRoot(), '').release();
        }
        s.cost += r.cost; m.cost += r.cost; s.sessionId = r.sessionId || s.sessionId;
        if (!r.ok && m.preempting) { // stopped by "Send now": not a failure — it continues its own session afterwards
          const sid = r.sessionId || s.liveSession;
          s.preempted = true;
          if (sid) { s.sessionId = sid; s.status = 'answered'; s.answer = PREEMPT_RESUME; } else s.status = 'queued';
          log('paused', s.id); persist(); return;
        }
        if (!r.ok) { s.status = 'failed'; s.error = r.error; syncBeads(p, s, 'failed', r.error); say(m, s.assignee, 'I got stuck…'); log('fail', s.id, r.error); }
        else if (s.kind === 'gate') {
          const g = r.data;
          const issues = (g.issues || []).slice(0, 12);
          s.gate = { pass: g.pass === true && !issues.length, issues, notes: (g.notes || []).slice(0, 3), checked: g.checked };
          s.status = 'done'; s.endedAt = now();
          s.result = { summary: g.summary, details: issues.map((i) => `- ${i.title} (${i.file}): ${i.detail}`).join('\n'), files_changed: [], verified_by: g.checked, applied: true, owner_action_needed: '' };
          syncBeads(p, s, 'done', g.summary);
          say(m, s.assignee, g.bubble || (s.gate.pass ? 'Passed!' : 'Sending it back.'), s.gate.pass ? 'done' : 'say');
          log('gate', s.id, s.gate.pass ? 'PASS' : `FAIL (${issues.length})`);
        } else if (r.data.status === 'needs_human' && r.data.question?.what && ownerAsks(s) >= MAX_OWNER_ASKS) {
          // asked the owner too often for this one job: stop and say so honestly instead of another "try once more"
          s.status = 'failed'; s.retries = MAX_RETRIES; s.result = r.data;
          s.error = `Stopped after asking you ${ownerAsks(s)} times. Still needed: ${r.data.question.what}`;
          syncBeads(p, s, 'failed', s.error); say(m, s.assignee, 'I need to stop and explain.'); log('owner-ask cap', s.id);
        } else if (r.data.status === 'needs_human' && r.data.question?.what && ownerAsks(s) >= DIAGNOSE_AFTER && !s.selfDiagnosed) {
          // the owner already answered twice: diagnose from our side before bothering them again (ARES's nudge, not the owner's)
          s.selfDiagnosed = true; s.status = 'answered';
          s.answer = 'Do not ask the owner again yet. They already answered twice. First find the real cause from YOUR side: reproduce it yourself, read the server/app logs, probe the service directly (e.g. curl the provider URL and read its error), take a screenshot with the browser tools. Fix what you can. Ask the owner again only with that evidence and one exact step that only they can do.';
          s.answers = [...(s.answers || []), { ts: now(), text: s.answer, by: 'orchestrator' }];
          say(m, 'orchestrator', `${roleOf(s.assignee).name}, dig into it yourself before asking again.`); log('self-diagnose nudge', s.id);
        } else if (r.data.status === 'needs_human' && r.data.question?.what) {
          s.question = { what: r.data.question.what, why: r.data.question.why, steps: r.data.question.steps || [], doneWhen: r.data.question.done_when, reply: r.data.question.reply };
          s.partial = r.data;
          if ((s.triaged || 0) < MAX_TRIAGE && !overBudget()) triage(s); // ARES answers it if anyone on the team can; the owner only hears owner-only questions
          else { s.status = 'waiting_human'; syncBeads(p, s, 'blocked', s.question.what); say(m, s.assignee, r.data.bubble || 'I need your help!', 'help'); log('needs human', s.id); }
        } else if (r.data.status === 'split' && canSplit(m, s)) { splitJob(s, r.data); }
        else if (r.data.status === 'failed') { s.status = 'failed'; s.result = r.data; s.error = r.data.summary; syncBeads(p, s, 'failed', r.data.summary); say(m, s.assignee, r.data.bubble || 'Could not do it.'); }
        else { s.status = 'done'; s.result = r.data; s.endedAt = now(); syncBeads(p, s, 'done', r.data.summary); say(m, s.assignee, r.data.bubble || 'Done!', 'done'); log('done', s.id); }
        persist();
      });
      running.set(s.id, promise);
    };

    /** The lead split her job: her own part + helper parts run side by side, then she integrates and checks the whole. */
    const splitJob = (s, out) => {
      const lead = s.assignee, free = helpersFor(ROLES, lead), d = out.delegate || {};
      const mine = { title: String(d.my_part?.title || 'My part').slice(0, 120), instructions: String(d.my_part?.instructions || ''), owns: cleanOwns(d.my_part?.owns_files), workdir: '' };
      const parts = (Array.isArray(d.helpers) ? d.helpers : []).slice(0, free.length).map((h, i) => ({
        title: String(h.title || `Part ${i + 1}`).slice(0, 120), instructions: String(h.instructions || ''), owns: cleanOwns(h.owns_files),
        model: h.model === 'haiku' ? 'haiku' : 'sonnet', assignee: free[i], workdir: '' }));
      const why = parts.length ? splitProblem([mine, ...parts]) : 'no helper parts were given';
      s.status = 'done'; s.endedAt = now();
      s.result = { ...out, applied: true, owner_action_needed: '', summary: why ? `Tried to split the job: ${why}.` : `Split the job: ${[mine, ...parts].map((x) => x.title).join(' · ')}` };
      syncBeads(p, s, 'done', s.result.summary);
      if (why) { // unusable split: she does the whole job herself, in the same session
        log('split rejected', s.id, why);
        addJob({ title: s.title, assignee: lead, kind: 'part', changesFiles: true, resumeFrom: s.sessionId, model: s.model,
          instructions: `Your split could not be used (${why}). Do the whole job yourself now, end to end, and return status "done".` });
        return;
      }
      m.lead = lead;
      m.split = { by: lead, contract: String(d.contract || '').slice(0, 6000), integrate: String(d.integrate || '').slice(0, 2000), parts: parts.length, at: now() };
      const others = (x) => [mine, ...parts].filter((y) => y !== x).map((y) => `${roleOf(y.assignee || lead).name}: ${y.owns.join(', ')}`).join('; ');
      const ids = [addJob({ title: mine.title, assignee: lead, kind: 'part', changesFiles: true, owns: mine.owns, resumeFrom: s.sessionId, model: s.model,
        instructions: `Your split is accepted. Build YOUR part now: ${mine.title}\n${mine.instructions}\nYou own ONLY: ${mine.owns.join(', ')}. Others are building in parallel — do not edit their files (${others(mine)}). Test your part, commit only your files, return status "done".` }).id];
      for (const x of parts) ids.push(addJob({ title: x.title, assignee: x.assignee, kind: 'part', changesFiles: true, owns: x.owns, model: x.model,
        instructions: `${x.instructions}\nOthers are building in parallel — never edit their files (${others(x)}).` }).id);
      addJob({ title: `Integrate and check: ${m.route?.title || s.title}`.slice(0, 120), assignee: lead, kind: 'integrate', changesFiles: true, dependsOn: ids, model: s.model, instructions: '' });
      say(m, lead, `Splitting it with ${parts.map((x) => roleOf(x.assignee).name).join(' & ')}!`, 'assign');
      log('split', s.id, `${parts.length} helper part(s)`);
    };
    /** Her integration session: resume her latest session with what every part reports. */
    const integrateBrief = (s) => {
      const latest = [...m.subtasks].reverse().find((x) => x.assignee === s.assignee && x.sessionId && x.status === 'done' && x.kind !== 'gate');
      s.resumeFrom = latest?.sessionId;
      const parts = m.subtasks.filter((x) => x.kind === 'part' && x.status === 'done');
      s.instructions = [
        `Every part is in. Your integration plan: ${m.split?.integrate || '(none given)'}`,
        'What each part reports:',
        ...parts.map((x) => `- ${roleOf(x.assignee).name}: ${x.title} (owns ${x.owns.join(', ') || 'everything'})\n  ${x.result?.summary || ''}\n  ${String(x.result?.details || '').slice(0, 2000)}`),
        'Now: read their commits (git log / git show), wire everything together, run ALL the tests, use the feature the way the owner will (live, for anything visible), and fix whatever is off in any file. Commit, then return the final result with status "done"; files_changed = every file the whole job changed.',
      ].join('\n');
    };

    /** A teammate asked a question: ARES answers it from the request, plan and code unless only the owner can. */
    const triage = (s) => {
      s.status = 'triaging'; s.triaged = (s.triaged || 0) + 1;
      say(m, 'orchestrator', `${roleOf(s.assignee).name} has a question — let me see if I can answer it.`);
      persist();
      const q = s.question;
      const prompt = [
        rosterNow(ROOT).managerPrompt,
        `Your teammate ${roleOf(s.assignee).name} (${roleOf(s.assignee).title}) is working on job #${s.n} "${s.title}" for the owner's request on "${p.name}":`,
        `Request: """${m.planner?.rewrittenPrompt || m.prompt}"""`, `Plan: ${m.plan?.summary || ''}`,
        `Their question: ${q.what}`, q.why ? `Why they ask: ${q.why}` : '',
        `What they have so far: ${String(s.partial?.summary || '').slice(0, 800)}`,
        '',
        'The owner wants to see only finished work, so answer it yourself whenever the team can decide: read the code/docs, follow existing conventions, pick the sensible default and say which.',
        'Set owner_only=true ONLY for things no teammate can provide: credentials/API keys/accounts/logins, spending money, a real physical device, legal sign-off, or a genuine product decision the request leaves open and that is costly to get wrong.',
      ].filter(Boolean).join('\n');
      const promise = cj({ cwd: workRoot(), prompt, schema: TRIAGE_SCHEMA, readOnly: true, full: hasFull(), runnable, model: cfg.managerModel, timeoutSec: 600, role: 'auditor', budget: TRIAGE_BUDGET, effort: 'low', room: 'control' })
        .then((r) => {
          running.delete(`${s.id}:triage`);
          m.cost += r.cost; s.cost += r.cost;
          if (!r.ok && m.preempting) { s.triaged--; persist(); return; } // still 'triaging': asked again after the pause
          if (r.ok && r.data.owner_only === false && r.data.answer?.trim()) {
            s.answer = r.data.answer; s.status = 'answered';
            s.answers = [...(s.answers || []), { ts: now(), text: r.data.answer, by: 'orchestrator' }];
            say(m, 'orchestrator', `Answered ${roleOf(s.assignee).name}'s question — no need to bother you.`);
            log('triage answered', s.id);
          } else {
            s.status = 'waiting_human'; syncBeads(p, s, 'blocked', q.what);
            say(m, s.assignee, 'I need your help!', 'help'); log('needs human (owner-only)', s.id, r.ok ? r.data.why : r.error);
          }
          persist();
        });
      running.set(`${s.id}:triage`, promise);
    };

    // ── the hand-off loop: decide what happens after every round of work ──
    const loop = (m.loop ||= { round: 0, stage: 'build', history: [] });
    const maxRounds = Number(cfg.maxFixRounds ?? MAX_FIX_ROUNDS);
    // a split mission gets room for each part (and her integration) on top of the solo cap
    const splitRoom = () => (m.split ? (m.split.parts + 1) * PART_BUDGET : 0);
    const budgetCap = () => Number(cfg.missionBudgetUsd) || (m.route && FUNNEL_BUDGET[m.route.funnel] ? FUNNEL_BUDGET[m.route.funnel] * (m.route.model === 'opus' ? 2 : 1) + splitRoom() : null) || MISSION_BUDGET[m.plan?.size] || MISSION_BUDGET.medium;
    const overBudget = () => (m.cost || 0) >= budgetCap();
    const fixers = () => Object.entries(ROLES).map(([id, r]) => ({ id, ...r }));
    const pickGate = (stage) => {
      const all = fixers();
      return stage === 'qa'
        ? all.find((r) => r.room === 'qa' && r.readOnly) || all.find((r) => /\bqa\b|quality/i.test(r.title))
        : all.find((r) => /security/i.test(r.title)) || all.find((r) => r.room === 'engineering' && r.readOnly);
    };
    const mainWriter = () => m.subtasks.find((x) => writes(x) && x.kind !== 'gate')?.assignee || fixers().find((r) => !r.readOnly)?.id;
    const addJob = (job) => {
      const n = m.subtasks.length + 1;
      const s = { id: `s${n}`, n, status: 'queued', cost: 0, dependsOn: [], owns: [], workdir: '', ...job };
      m.subtasks.push(s);
      say(m, s.assignee, `Assigned: ${s.title}`, 'assign');
      return s;
    };
    /** Send problems back: one rework job per teammate who can fix them. */
    const sendBack = (from, issues) => {
      loop.round++;
      const groups = new Map();
      for (const i of issues) {
        const who = ROLES[i.fix_by] ? i.fix_by : mainWriter();
        groups.set(who, [...(groups.get(who) || []), i]);
      }
      for (const [who, list] of groups) {
        const prior = [...m.subtasks].reverse().find((x) => x.assignee === who && x.kind !== 'gate' && x.sessionId && x.status === 'done');
        addJob({
          title: `Fix round ${loop.round}: ${list.length} problem(s) found by ${from}`.slice(0, 120), assignee: who, kind: 'rework', changesFiles: true,
          resumeFrom: prior?.sessionId, model: prior?.model,
          instructions: [`${from} checked the work and sent it back to you. Fix these, then verify each one yourself (run the tests / the app):`,
            ...list.map((i, k) => `${k + 1}. ${i.title}${i.file ? ` (${i.file})` : ''}\n   ${i.detail}`)].join('\n'),
        });
      }
      loop.history.push({ round: loop.round, stage: loop.stage, by: from, issues: issues.map((i) => i.title).slice(0, 12), at: now() });
      say(m, 'orchestrator', `${from} found ${issues.length} problem(s) — back to ${[...groups.keys()].map((k) => roleOf(k).name).join(' & ')}.`);
      loop.stage = 'build';
    };
    const gateJob = (stage) => {
      const g = pickGate(stage);
      if (!g) return null;
      return addJob({ title: `${stage === 'qa' ? 'QA check' : 'Security check'}${loop.round ? ` (after fix round ${loop.round})` : ''}`, assignee: g.id, kind: 'gate', stage, instructions: '' });
    };
    /** Returns true when there is more work queued, false when the result is ready for the owner's desk. */
    const nextStep = () => {
      if (overBudget()) { loop.stage = 'over-budget'; say(m, 'orchestrator', `We reached this mission's $${budgetCap()} spending cap — wrapping up with what we have.`); return false; }
      // 1) jobs that crashed or gave up: retry them (and the jobs that were waiting on them)
      const broken = m.subtasks.filter((x) => x.status === 'failed' && (x.retries || 0) < MAX_RETRIES);
      if (broken.length) {
        for (const x of broken) {
          x.retries = (x.retries || 0) + 1;
          if (/budget/i.test(String(x.error || ''))) x.budgetBoost = (x.budgetBoost || 1) * 2; // ran out of room, not out of ideas
          else if (x.model) x.model = nextModel(x.model); // got stuck: a stronger model gets the retry
          x.history = [...(x.history || []), { error: x.error, at: now() }];
          x.instructions = `${x.instructions}\n\nYOUR PREVIOUS ATTEMPT FAILED: ${String(x.error || '').slice(0, 600)}\nFind the cause and finish the job this time.`;
          Object.assign(x, { status: 'queued', error: undefined, sessionId: undefined, result: undefined });
          say(m, 'orchestrator', `${roleOf(x.assignee).name}, have another go at #${x.n}.`);
        }
        for (const x of m.subtasks) if (x.status === 'skipped') { x.status = 'queued'; x.error = undefined; }
        return true;
      }
      if (m.subtasks.some((x) => x.status === 'failed')) { loop.stage = 'stuck'; return false; } // retries used up — the report says so
      const writeJobs = m.subtasks.filter((x) => writes(x));
      if (!writeJobs.length) return false; // an analysis/report mission: nothing to hand off
      // 2) "the owner still has to …" — the team does it instead, unless it truly needs the owner
      // Only real actions (install, restart, migrate…), once per mission. "Open it and check" is QA's job, not a new job.
      const todo = m.subtasks.filter((x) => x.result?.owner_action_needed?.trim() && !x.todoRouted && !x.fromTodo);
      for (const x of todo) if (VERIFY_ONLY.test(x.result.owner_action_needed) || loop.todoJobs >= 1) x.todoRouted = 'skipped';
      const doable = todo.filter((x) => x.todoRouted !== 'skipped');
      if (doable.length) {
        loop.todoJobs = (loop.todoJobs || 0) + 1;
        for (const x of doable.slice(0, 1)) {
          x.todoRouted = true;
          addJob({ title: `Do it for the owner: ${x.result.owner_action_needed}`.slice(0, 120), assignee: x.assignee, kind: 'rework', changesFiles: true, fromTodo: true,
            instructions: `Your teammate's job left this for the owner: "${x.result.owner_action_needed}". Do it yourself now (install, build, restart, migrate, copy files…) and verify it worked. Only if it truly needs the owner (their credentials, payment, a physical device) return needs_human — and leave owner_action_needed empty unless that is the case.` });
        }
        return true;
      }
      if (loop.stage === 'build') {
        // 3) did anything actually land?
        const changed = m.baseSnap?.length ? diffSnapshots(m.baseSnap, snapshotAll(m.workDirs)).files : null;
        if (changed && !changed.length) {
          if ((loop.notApplied || 0) >= 1) return false;
          loop.notApplied = (loop.notApplied || 0) + 1;
          sendBack('the change check', [{ title: 'Nothing was saved to the files', detail: 'The job finished but no file changed. Apply the change for real (edit the files and commit), then check it.', file: '', fix_by: mainWriter() }]);
          return true;
        }
        // 4) the independent QA script first — no AI tokens spent on work that does not even pass the tests
        const qa = m.officeMission ? runQA({ name: 'office', config: { path: ROOT, qa: OFFICE_QA } }) : runQA(wp());
        loop.lastQa = qa.map((x) => ({ name: x.name, ok: x.ok }));
        loop.qaRun = { at: m.subtasks.length, results: qa.map((x) => ({ name: x.name, run: x.run, ok: x.ok, code: x.code, seconds: x.seconds, output: String(x.output || '').slice(-2000) })) };
        const failing = qa.filter((x) => !x.ok);
        if (failing.length) {
          if (loop.round >= maxRounds) { loop.stage = 'exhausted'; return false; }
          sendBack('the QA script', failing.map((x) => ({ title: `QA command "${x.name}" fails`, detail: `\`${x.run}\` exits ${x.code}. Last output:\n${String(x.output || '').slice(-1500)}\nFix the cause; never weaken or skip the test.`, file: '', fix_by: mainWriter() })));
          return true;
        }
        if (m.route?.funnel === 'quick') { loop.stage = 'passed'; return false; } // quick: the QA script is the check
        loop.stage = 'qa';
        if (gateJob('qa')) return true;
      }
      const lastGate = (stage) => [...m.subtasks].reverse().find((x) => x.kind === 'gate' && x.stage === stage);
      for (const stage of ['qa', 'security']) {
        if (loop.stage !== stage) continue;
        const g = lastGate(stage);
        if (g && g.status === 'done' && !g.gate.pass) {
          if (loop.round >= maxRounds) { loop.stage = 'exhausted'; return false; }
          sendBack(`${roleOf(g.assignee).name} (${stage === 'qa' ? 'QA' : 'security'})`, g.gate.issues.length ? g.gate.issues : [{ title: 'Check failed', detail: g.result?.summary || '', file: '', fix_by: mainWriter() }]);
          return true;
        }
        if (stage === 'qa' && m.route?.funnel === 'solo') break; // solo: one combined QA + security check
        if (stage === 'qa') { loop.stage = 'security'; if (gateJob('security')) return true; }
      }
      loop.stage = 'passed';
      return false;
    };

    // Ask the owner ONCE per project whether the team may work with full access (no permission prompts).
    if (loadProject(p.name).config.fullAccess === undefined && !m.access) {
      m.access = { status: 'asking', ask: {
        what: `Can your team use your computer with full access while working on "${p.name}"?`,
        why: 'To build, install packages and run any command without stopping to ask each time. Only you can allow that.',
        steps: ['Say "yes" if you trust the team to run any command in this project.', 'Say "no" and they will stick to a safe list of commands.', 'You can change it any time with the "Team access" button in the panel.'],
        doneWhen: 'You have answered yes or no — I only ask once per project.',
        reply: 'yes or no',
      } };
      m.status = 'waiting_human';
      say(m, 'orchestrator', 'Quick question before we start!', 'help');
      persist();
    }

    // 2) work loop → hand-off loop (QA, security, fixes) → final review → report (see "deliver" below)

    async function workLoop() {
    for (;;) {
      // inbox: answers + cancel
      const inbox = fs.existsSync(inboxOf(p, id)) ? fs.readFileSync(inboxOf(p, id), 'utf8').split('\n').filter(Boolean) : [];
      for (const line of inbox.slice(consumed)) {
        consumed++;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'cancel') m.cancelRequested = true;
        if (msg.type === 'preempt' && !m.cancelRequested) {
          const by = load(p, msg.by);
          if (by && by.status === 'queued' && alive(by.runnerPid)) { m.preempting = { id: by.id, prompt: by.prompt }; for (const k of kids) k.kill('SIGTERM'); }
        }
        if (msg.type === 'answer' && msg.subtask === '__access' && m.access?.status === 'asking') {
          const grant = /^\s*(y|yes|yeah|yep|sure|ok|okay|full|grant|allow)/i.test(msg.text);
          const fresh = loadProject(p.name);
          fresh.config.fullAccess = grant;
          fresh.config.fullAccessAnsweredAt = now();
          fs.writeFileSync(path.join(fresh.dir, 'config.json'), JSON.stringify(fresh.config, null, 2) + '\n');
          m.access.status = grant ? 'granted' : 'denied';
          say(m, 'orchestrator', grant ? 'Thanks! Full speed ahead.' : "OK — we'll stick to safe commands.");
          continue;
        }
        if (msg.type === 'answer') {
          const s = m.subtasks.find((x) => x.id === msg.subtask);
          if (s && s.status === 'waiting_human') { s.answer = msg.text; s.status = 'answered'; s.answers = [...(s.answers || []), { ts: msg.ts, text: msg.text }]; }
        }
      }
      if (m.inboxConsumed !== consumed) { m.inboxConsumed = consumed; persist(); } // the owner sees their answer land right away
      if (m.access?.status === 'asking' && loadProject(p.name).config.fullAccess !== undefined) {
        m.access.status = loadProject(p.name).config.fullAccess ? 'granted' : 'denied';
      }
      const asking = m.access?.status === 'asking';
      // "Send now" on another mission: stop our jobs (they keep their sessions), wait for it, then carry on
      if (m.preempting && !running.size) {
        const by = m.preempting, was = m.status;
        say(m, 'orchestrator', `Pausing so "${by.prompt.slice(0, 50)}" can go first — I'll pick this back up after.`);
        const ok = await waitTurn(true);
        m.preempting = null;
        if (!ok) { m.cancelRequested = true; continue; }
        m.status = was === 'queued' ? 'working' : was;
        say(m, 'orchestrator', 'Back to this one — carrying on where we stopped.');
        persist();
        continue;
      }
      if (m.cancelRequested) {
        for (const s of m.subtasks) if (['queued', 'answered', 'waiting_human'].includes(s.status)) { s.status = 'cancelled'; syncBeads(p, s, 'cancel', 'Mission cancelled by the owner'); }
        if (!running.size) { m.status = 'cancelled'; say(m, 'orchestrator', 'Mission cancelled.'); persist(); return false; }
      }
      // a question ARES was answering when the runner stopped (reboot / resume): pick it up again
      if (!m.preempting) for (const s of m.subtasks) if (s.status === 'triaging' && !running.has(`${s.id}:triage`)) { if ((s.triaged || 0) < MAX_TRIAGE) triage(s); else s.status = 'waiting_human'; }
      const byId = new Map(m.subtasks.map((s) => [s.id, s]));
      // Only one builder at a time (two Claudes editing one repo collide); read-only experts run in parallel.
      // Engineers take turns per folder (two Claudes editing one repo collide); different app folders run
      // in parallel. Read-only specialists run in parallel up to MAX_PARALLEL_READERS.
      const isEng = (x) => writes(x);
      const writers = m.subtasks.filter((x) => x.status === 'working' && isEng(x));
      let readers = m.subtasks.filter((x) => x.status === 'working' && !isEng(x)).length;
      if (!m.cancelRequested && !m.preempting && !asking && !overBudget()) {
        for (const s of m.subtasks) {
          const isBuilder = isEng(s);
          // Writers run side by side when their files don't overlap; otherwise they take turns.
          if (isBuilder ? writers.length >= MAX_PARALLEL_WRITERS || writers.some((w) => ownershipClash(w, s)) : readers >= MAX_PARALLEL_READERS) continue;
          if (s.status === 'answered' && s.sessionId) {
            if (isBuilder) {
              const lock = folderLock(ROOT, s.workdir ? path.join(workRoot(), s.workdir) : workRoot(), `${m.id}/${s.id}`);
              const busy = lock.acquire();
              if (busy) { // someone else is editing; try again next round
                if (s.waitingFor !== busy.holder) { s.waitingFor = busy.holder; say(m, s.assignee, 'Got your answer — waiting for another mission to finish editing this folder.'); persist(); }
                continue;
              }
              s.lock = true;
            }
            start(s, s.answer);
          } else if (s.status === 'queued') {
            const deps = s.dependsOn.map((d) => byId.get(d)).filter(Boolean);
            if (deps.some((d) => ['failed', 'cancelled', 'skipped'].includes(d.status))) { s.status = 'skipped'; s.error = 'A job it depended on did not finish.'; syncBeads(p, s, 'cancel', s.error); persist(); continue; }
            if (!deps.every((d) => d.status === 'done')) continue;
            if (isBuilder) {
              const lock = folderLock(ROOT, s.workdir ? path.join(workRoot(), s.workdir) : workRoot(), `${m.id}/${s.id}`);
              const busy = lock.acquire();
              if (busy) {
                if (s.waitingFor !== busy.holder) { s.waitingFor = busy.holder; say(m, s.assignee, 'Waiting — another mission is editing this folder.'); persist(); }
                continue;
              }
              s.lock = true;
            }
            start(s);
          } else continue;
          if (isBuilder) writers.push(s); else readers++;
        }
      }
      if (overBudget()) for (const s of m.subtasks) if (['queued', 'answered'].includes(s.status)) { s.status = 'skipped'; s.error = 'Not started: the mission reached its spending cap.'; }
      const open = m.subtasks.filter((s) => ['queued', 'working', 'answered', 'waiting_human', 'triaging'].includes(s.status));
      const waiting = open.filter((s) => s.status === 'waiting_human');
      const checking = open.length && open.every((s) => s.kind === 'gate');
      if (m.preempting) { await new Promise((r) => setTimeout(r, 300)); continue; } // waiting for our jobs to stop
      const newStatus = m.limitUntil ? 'paused' : asking ? 'waiting_human' : open.length === 0 ? 'reviewing' : waiting.length && waiting.length === open.length ? 'waiting_human' : checking ? 'checking' : 'working';
      if (m.status !== newStatus) { m.status = newStatus; persist(); }
      if (!open.length && !running.size) return true;
      await new Promise((r) => setTimeout(r, 1500)); // the runner is the only writer; in-memory state is authoritative
    }
    }

    let qa, git, snapDiff, diff, changedFiles, commits, qaOk, allDone, writeJobs, noChanges, ownerTodo, quick, r;
    // eslint-disable-next-line no-constant-condition
    deliver: for (;;) {
    for (;;) {
      if (!(await workLoop())) return; // cancelled
      persist();
      if (!nextStep()) break;
      m.status = 'working'; persist();
    }

    // 3) final review by ARES. Anything not done / not verified goes BACK to the team, not to the owner's desk.
    m.status = 'reviewing'; say(m, 'orchestrator', 'Checking everyone\'s work…'); persist();
    log('reviewing');
    // Office missions are checked by the office's own build checks; project missions by the project's QA.
    // reuse the QA run from the hand-off loop when nothing could have changed since (only read-only checks ran after it)
    const reusable = loop.qaRun && !m.subtasks.slice(loop.qaRun.at).some((x) => writes(x));
    qa = reusable ? loop.qaRun.results : m.officeMission ? runQA({ name: 'office', config: { path: ROOT, qa: OFFICE_QA } }) : runQA(wp());
    if (reusable) log('review: reusing the QA run from the hand-off loop');
    git = (args) => spawnSync('git', ['-C', workRoot(), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
    snapDiff = m.baseSnap?.length ? diffSnapshots(m.baseSnap, snapshotAll(m.workDirs)) : null;
    diff = snapDiff ? snapDiff.patch
      : m.baseCommit ? git(['diff', m.baseCommit, '--stat', '--patch', '--', '.', ...((cfg.protectedFiles || []).map((f) => `:(exclude)${f}`))]) : '';
    changedFiles = snapDiff ? snapDiff.files : [];
    fs.writeFileSync(path.join(dirOf(p), `${id}.diff`), diff.slice(0, 4 * 1024 * 1024));
    commits = m.baseCommit ? spawnSync('git', ['-C', workRoot(), 'log', '--oneline', `${m.baseCommit}..HEAD`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean) : [];
    qaOk = qa.every((x) => x.ok);
    allDone = m.subtasks.length > 0 && m.subtasks.every((x) => x.status === 'done');
    // Small + every job done + QA green → the report is built from the work itself (no extra AI call).
    writeJobs = m.subtasks.filter((x) => writes(x));
    noChanges = writeJobs.length > 0 && changedFiles.length === 0;
    ownerTodo = m.subtasks.filter((x) => !x.todoRouted).map((x) => x.result?.owner_action_needed).filter((t) => t && t.trim());
    // Quick report only when the work is provably finished: changes really landed and nothing is left for you.
    // quick / solo funnels never pay for a manager review: the report is built from the work, the QA script and the
    // check (honesty rules below still apply). Team missions keep the small-and-clean shortcut too.
    const lean = Boolean(m.route && m.route.funnel !== 'team');
    const clean = loop.stage !== 'exhausted' && loop.stage !== 'over-budget' && allDone && qaOk && !noChanges && !ownerTodo.length && writeJobs.every((x) => x.result?.applied !== false);
    quick = lean || (m.plan?.size === 'small' && clean);
    const work = m.subtasks.filter((x) => x.kind !== 'gate' && x.result);
    const gateIssues = m.subtasks.filter((x) => x.kind === 'gate' && x.gate && !x.gate.pass).flatMap((x) => x.gate.issues.map((i) => i.title));
    r = quick
      ? { ok: true, cost: 0, data: {
        headline: (m.route?.title || m.subtasks[0]?.title || 'Done').slice(0, 80), verdict: clean ? 'success' : 'partial',
        summary: work.map((x) => x.result.summary).join(' ') || 'No work was recorded.',
        completed: work.map((x) => ({ job: x.title, by: roleOf(x.assignee).name, result: x.result.summary })),
        changes: work.flatMap((x) => (x.result.files_changed || []).map((file) => ({ file, what: x.title }))),
        checks: { qa_passed: qaOk, notes: work.map((x) => x.result.verified_by).filter(Boolean).join(' ') || (qaOk ? 'QA script passed.' : 'QA script failed.') },
        concerns: clean ? [] : [...new Set(gateIssues)].slice(0, 6), next_steps: [],
        for_you: clean ? 'Nothing — it is done. Reply to this report if you want changes.' : 'Read the concerns; reply to this report to send it back.', send_back: [],
      } }
      : await cj({ cwd: workRoot(), prompt: reviewPrompt(p, m, diff.slice(0, 60000), qa), schema: REPORT_SCHEMA, readOnly: true, full: hasFull(), runnable, model: cfg.managerModel, timeoutSec: 1200, role: 'auditor', budget: BUDGET.review, effort: 'low' });
    m.cost += r.cost;
    // Final review: one send-back at most, only for real defects. Asking to "verify more" after the QA lead passed it live
    // is not a defect — that loop is what burned the budget before.
    const qaPassed = m.subtasks.some((x) => x.kind === 'gate' && x.stage === 'qa' && x.gate?.pass);
    const back = (r.ok ? (r.data.send_back || []).filter((i) => i && i.title) : []).filter((i) => !(qaPassed && VERIFY_ONLY.test(i.title))).slice(0, 6);
    if (back.length && loop.round < maxRounds && (loop.aresSendBacks || 0) < MAX_ARES_SENDBACKS && !overBudget() && !m.cancelRequested) {
      loop.aresSendBacks = (loop.aresSendBacks || 0) + 1;
      sendBack('ARES (final review)', back);
      m.status = 'working'; persist();
      continue deliver; // the owner's desk only gets work that survived the whole loop
    }
    if (back.length) { loop.stage = 'exhausted'; loop.unresolved = back.map((i) => i.title); }
    break;
    }
    m.report = r.ok ? { ...r.data } : {
      headline: 'Work finished — automatic review failed', verdict: 'partial', summary: `The review step errored (${r.error}). Teammate summaries are below.`,
      completed: m.subtasks.map((s) => ({ job: s.title, by: roleOf(s.assignee).name, result: s.result?.summary || s.error || s.status })),
      changes: [], checks: { qa_passed: qaOk, notes: '' }, concerns: ['The manager review did not run; check the diff yourself.'], next_steps: [], for_you: 'Read the teammate notes and check the changes.',
    };
    // The hand-off loop's outcome is part of the record.
    const gates = m.subtasks.filter((x) => x.kind === 'gate' && x.status === 'done');
    m.report.loop = { rounds: loop.round, outcome: loop.stage, history: loop.history,
      gates: gates.map((g) => ({ stage: g.stage, by: roleOf(g.assignee).name, pass: g.gate?.pass, checked: g.gate?.checked || '' })) };
    if (gates.length) m.report.checks = { ...(m.report.checks || {}), notes: [m.report.checks?.notes, `Hand-offs: ${gates.map((g) => `${g.stage === 'qa' ? 'QA' : 'security'} by ${roleOf(g.assignee).name} ${g.gate?.pass ? '✓' : '✗'}`).join(' → ')}${loop.round ? ` (${loop.round} fix round${loop.round > 1 ? 's' : ''})` : ''}.`].filter(Boolean).join(' ') };
    const gateNotes = gates.flatMap((g) => g.gate?.notes || []);
    if (gateNotes.length) m.report.next_steps = [...(m.report.next_steps || []), ...gateNotes.slice(0, 4)];
    if (loop.stage === 'over-budget') {
      if (m.report.verdict === 'success') m.report.verdict = 'partial';
      m.report.concerns = [...(m.report.concerns || []), `Stopped at this mission's $${budgetCap()} spending cap (spent $${(m.cost || 0).toFixed(2)}). Reply to continue, or raise it: sm set ${p.name} missionBudgetUsd <n>.`];
    }
    if (['exhausted', 'stuck'].includes(loop.stage)) {
      if (m.report.verdict === 'success') m.report.verdict = 'partial';
      const left = loop.stage === 'stuck' ? m.subtasks.filter((x) => x.status === 'failed').map((x) => `#${x.n} ${x.title}: ${x.error || ''}`) : (loop.unresolved || loop.history[loop.history.length - 1]?.issues || []);
      m.report.concerns = [...(m.report.concerns || []), `The team went ${loop.stage === 'stuck' ? `${MAX_RETRIES + 1} attempts` : `${loop.round} fix rounds`} and could not close these on its own: ${left.join('; ').slice(0, 600)}`];
    }
    // Honesty rules no report can override.
    if (noChanges && m.report.verdict === 'success') m.report.verdict = 'partial';
    if (noChanges) m.report.concerns = [...(m.report.concerns || []), 'Nothing was actually changed in the files — the work was not applied.'];
    if (ownerTodo.length) {
      if (m.report.verdict === 'success') m.report.verdict = 'partial';
      m.report.for_you = [m.report.for_you, ...ownerTodo].filter(Boolean).join(' · ');
    }
    m.report.qa = qa.map((x) => ({ name: x.name, ok: x.ok, seconds: x.seconds }));
    m.report.commits = commits;
    m.report.diffStat = snapDiff ? `${changedFiles.length} file(s) changed` : git(['diff', '--shortstat', m.baseCommit || 'HEAD']).trim();
    m.report.changedFiles = changedFiles;
    m.report.hasDiff = diff.trim().length > 0;
    m.report.office = Boolean(m.officeMission);
    m.report.cost = m.cost;
    if (m.route) m.report.route = m.route; // which funnel / model handled it, shown on the report
    m.report.at = now();
    m.status = 'done'; m.finishedAt = now();
    if (m.beadsEpic) beads(p, () => bd(p, ['close', m.beadsEpic, '--force', '--reason', `${m.report.verdict}: ${m.report.headline}`.slice(0, 400)]));
    // A finished video skips the desk: the conference room calls the owner into a meeting with it.
    const videos = m.report.verdict === 'failed' ? [] : videosFromSubtasks(m.subtasks, workRoot());
    const pdfs = m.report.verdict === 'failed' ? [] : pdfsFromSubtasks(m.subtasks, workRoot());
    if (videos.length || pdfs.length) {
      try {
        const mt = meetings.call(p.name, { title: m.report.headline, summary: m.report.summary, points: (m.report.completed || []).map((c) => `${c.by}: ${c.result}`),
          video: videos[0]?.path, pdf: pdfs[0]?.path, missionId: m.id, by: (videos[0] || pdfs[0]).by, host: 'orchestrator' });
        m.meetingId = mt.id;
        say(m, 'orchestrator', `The ${videos.length ? 'video' : 'PDF'} is ready — the conference room is calling you! 📞`, 'meeting');
      } catch (e) { log('meeting call failed', e.message); }
    }
    if (!m.meetingId) say(m, 'orchestrator', m.report.verdict === 'success' ? 'Report\'s on your desk! 🎉' : 'Report\'s on your desk — read the concerns.', 'report');
    if (m.report.verdict === 'success') say(m, 'all', 'Mission complete!', 'celebrate');
    persist();
    log('report filed', m.report.verdict);
    // ARES's watch after every mission: catches flow bugs this run left behind (stray processes, uncommitted work…)
    try { spawn(process.execPath, [SELF, 'ares', '--fix'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
    // The office's own code changed? Rebuild + restart it so the owner actually sees the change.
    const touched = [...changedFiles.map((l) => path.resolve(workRoot(), l.split('\t').pop())), ...m.subtasks.flatMap((x) => (x.result?.files_changed || []).map((f) => path.resolve(workRoot(), f)))];
    // A new office layout only shows once it's installed where Pixel Agents reads it.
    const layoutFile = path.join(ROOT, 'office-layout', 'layout.json');
    if (touched.includes(layoutFile) || touched.includes(path.join(ROOT, 'office-layout', 'generate.js'))) {
      try {
        if (touched.includes(path.join(ROOT, 'office-layout', 'generate.js'))) {
          const g = spawnSync(process.execPath, [path.join(ROOT, 'office-layout', 'generate.js')], { encoding: 'utf8' });
          if (g.status === 0) fs.writeFileSync(layoutFile, g.stdout);
        }
        JSON.parse(fs.readFileSync(layoutFile, 'utf8')); // valid before we touch the live one
        const live = path.join(require('os').homedir(), '.pixel-agents', 'layout.json');
        if (fs.existsSync(live)) {
          fs.copyFileSync(live, `${live}.backup-${Date.now()}`);
          // keep the owner's own edits (grown floor, moved furniture): only add what is new
          const merged = require('../office-layout/merge.js').mergeLayout(JSON.parse(fs.readFileSync(live, 'utf8')), JSON.parse(fs.readFileSync(layoutFile, 'utf8')));
          fs.writeFileSync(live, JSON.stringify(merged, null, 2) + '\n');
        } else fs.copyFileSync(layoutFile, live);
        m.report.concerns = [...(m.report.concerns || []), 'The new office layout was merged into yours (your own edits kept; the previous layout is backed up in ~/.pixel-agents).'];
        touched.push(path.join(ROOT, 'pixel-office', 'layout-changed'));
      } catch (e) {
        m.report.concerns = [...(m.report.concerns || []), `Installing the new layout failed: ${e.message}`];
        if (m.report.verdict === 'success') m.report.verdict = 'partial';
      }
    }
    const alreadyLive = (qa || []).some((x) => x.name === 'office-live' && x.ok); // the QA step already built + restarted the final version
    if (!alreadyLive && touched.some((f) => f.startsWith(path.join(ROOT, 'pixel-office') + path.sep) || f.startsWith(path.join(ROOT, 'bin') + path.sep))) {
      log('office code changed → rebuilding');
      const b = spawnSync(process.execPath, [SELF, 'office', '--build', '--restart', '--no-open'], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
      m.report.concerns = [...(m.report.concerns || []), b.status === 0 ? 'The office was rebuilt and restarted with these changes — your open office tab updates itself.' : `Rebuilding the office failed — run: sm office --build --restart (${(b.stderr || b.stdout || '').trim().slice(-200)})`];
      persist();
    }
    // keep the QA verdict visible to the rest of success-manager
    const fresh = loadProject(p.name); fresh.state.lastResults = qa; fresh.state.lastFingerprint = fingerprint(cfg.path); fresh.state.lastRun = now();
    sm.saveState(fresh);
  }

  /** Dollars spent by every mission created today (server-local day), not just the newest few. */
  function todayCost(project, at = new Date()) {
    const p = loadProject(project);
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
    return list(p, Infinity).reduce((sum, m) => (Date.parse(m.createdAt) >= start ? sum + (m.cost || 0) : sum), 0);
  }

  /** Summary for the UI: active + recent missions, live crew assignments, open questions. */
  function snapshot(project) {
    const p = loadProject(project);
    const ms = list(p, 15).map((m) => ({ ...m, runnerAlive: alive(m.runnerPid), replyPending: Boolean(replyPending(m)) }));
    // a runner that died mid-flight would leave a mission "working" forever — surface it
    for (const m of ms) if (['planning', 'working', 'checking', 'paused', 'waiting_human', 'reviewing'].includes(m.status) && m.runnerPid && !m.runnerAlive) m.status = 'stalled';
    const line = queued(p).map((x) => x.id); // waiting missions in the order they will run (1 = next)
    for (const m of ms) if (line.includes(m.id)) m.queuePos = line.indexOf(m.id) + 1;
    return ms;
  }

  /** Resume a stalled mission's runner (e.g. after a reboot). */
  function resume(project, id) {
    const p = loadProject(project);
    const m = load(p, id);
    if (!m) throw Object.assign(new Error('No such mission'), { status: 404 });
    if (alive(m.runnerPid)) return { ok: true, already: true };
    for (const s of m.subtasks || []) if (s.status === 'working') s.status = s.sessionId && s.answer ? 'answered' : 'queued';
    save(p, m);
    const fd = fs.openSync(path.join(dirOf(p), `${id}.log`), 'a');
    const child = spawn(process.execPath, [SELF, 'mission-run', p.name, id], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    m.runnerPid = child.pid; // claim it now: a second Resume click must see a live runner, not start another
    save(p, m);
    return { ok: true };
  }

  return { create, answer, cancel, reply, answerReply, run, snapshot, todayCost, resume, reorder, sendNow, list: (project) => list(loadProject(project)), roles: () => refreshRoster().roles };
}

/**
 * Snapshot a folder's current files as a git tree WITHOUT touching your index, branches or commits
 * (a throwaway index file). Two snapshots → an exact diff of what the mission changed, committed or not.
 */
function snapshotTree(dir) {
  const os = require('os');
  const idx = path.join(os.tmpdir(), `sm-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  // Not a git repo? Snapshot through a private "shadow" repo outside the project (never touches the folder).
  const gitArgs = spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0 ? ['-C', dir] : shadowArgs(dir);
  if (!gitArgs) return null;
  try {
    const add = spawnSync('git', [...gitArgs, 'add', '-A', '--', '.'], { cwd: dir, env, encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
    if (add.status !== 0) return null;
    const tree = spawnSync('git', [...gitArgs, 'write-tree'], { cwd: dir, env, encoding: 'utf8' });
    return tree.status === 0 ? tree.stdout.trim() : null;
  } catch { return null; } finally { try { fs.unlinkSync(idx); } catch { /* ignore */ } }
}

/** git args for a private snapshot repo of a non-git folder (~/.cache/success-manager/shadow/<hash>.git). */
function shadowArgs(dir) {
  const os = require('os');
  const crypto = require('crypto');
  const gitDir = path.join(os.homedir(), '.cache', 'success-manager', 'shadow', `${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16)}.git`);
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    if (spawnSync('git', ['init', '--bare', '-q', gitDir]).status !== 0) return null;
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), ['node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', '.next/', '.DS_Store', '*.log', '.beads/', 'DerivedData/'].join('\n') + '\n');
  }
  return [`--git-dir=${gitDir}`, `--work-tree=${path.resolve(dir)}`];
}

/**
 * Snapshot every git repo the mission can touch: each work folder plus any repo nested one level inside
 * it (e.g. success-manager/pixel-office has its own .git, so it must be snapshotted separately).
 */
function snapshotAll(dirs) {
  const seen = new Set();
  const out = [];
  const add = (dir, base) => {
    const real = path.resolve(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const tree = snapshotTree(real);
    // a folder inside a bigger repo (success-manager inside ~/Downloads/Projects) — strip that prefix later
    const prefix = spawnSync('git', ['-C', real, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).stdout?.trim() || '';
    if (tree) out.push({ dir: real, rel: path.relative(base, real) || '.', tree, prefix });
  };
  for (const d of dirs) {
    add(d, dirs[0]);
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && fs.existsSync(path.join(d, e.name, '.git'))) add(path.join(d, e.name), dirs[0]);
      }
    } catch { /* unreadable */ }
  }
  return out;
}

/** Diff two snapshotAll() results → { patch, files[] } with paths relative to the first work folder. */
function diffSnapshots(before, after) {
  let patch = '';
  const files = [];
  for (const b of before) {
    const a = after.find((x) => x.dir === b.dir);
    if (!a || a.tree === b.tree) continue;
    const pre = b.rel === '.' ? '' : `${b.rel}/`;
    const gitArgs = spawnSync('git', ['-C', b.dir, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0 ? ['-C', b.dir] : shadowArgs(b.dir);
    const run = (args) => spawnSync('git', [...gitArgs, ...args], { cwd: b.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
    const strip = (x) => (b.prefix && x.startsWith(b.prefix) ? x.slice(b.prefix.length) : x);
    // ignore the office's own bookkeeping (mission records, logs) — only real work counts
    const noise = (x) => /(^|\/)(projects\/[^/]+\/|\.pixel-office\.log$|[^/]+\.log$|\.beads\/|office\/ideas\/|standup\/|[^/]+\.status\.json$|\.office-build\.lock\/)/.test(strip(x));
    const keep = run(['diff', '--name-only', b.tree, a.tree]).trim().split('\n').filter((x) => x && !noise(x));
    if (!keep.length) continue;
    patch += run(['diff', '--stat', '--patch', `--src-prefix=a/${pre}`, `--dst-prefix=b/${pre}`, b.tree, a.tree, '--', ...keep.map((x) => `:(top)${x}`)])
      .replace(new RegExp(`([ab]/${pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})${b.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '$1');
    for (const l of run(['diff', '--name-status', b.tree, a.tree]).trim().split('\n').filter(Boolean)) {
      const [st, ...paths] = l.split('\t');
      if (paths.every(noise)) continue;
      files.push([st, ...paths.map((x) => pre + strip(x))].join('\t'));
    }
  }
  return { patch, files };
}

/**
 * One writer per folder across ALL missions (two runners editing the same repo collide). A lock is a file
 * holding the runner's pid; a lock whose pid is dead is stale and gets taken over.
 */
function folderLock(root, dir, holder) {
  const crypto = require('crypto');
  const locks = path.join(root, 'projects', '.locks');
  fs.mkdirSync(locks, { recursive: true });
  const file = path.join(locks, `${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16)}.json`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  return {
    acquire() {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur.pid !== process.pid && alive(cur.pid)) return cur; // someone else is working there
      } catch { /* free */ }
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, holder, dir: path.resolve(dir), at: new Date().toISOString() }));
      return null;
    },
    release() { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } },
  };
}

/** A job's sub-folder, only if it really is a folder inside the project. */
function safeWorkdir(root, wd) {
  if (!wd || typeof wd !== 'string') return null;
  const full = path.resolve(root, wd);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  try { return fs.statSync(full).isDirectory() ? path.relative(root, full) : null; } catch { return null; }
}

module.exports = { asksForAction, splitProblem, helpersFor, ownerRoute, nextModel, FUNNELS, usageLimitUntil, accountRescue, createMissions, snapshotAll, diffSnapshots, ownershipClash };

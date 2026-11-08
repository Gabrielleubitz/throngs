/**
 * node --test test/*.test.js — the hand-off loop, end to end with a fake `claude`:
 * build → teammate asks a question (ARES answers it, the owner is never asked) → QA script → QA lead rejects
 * → work goes back to the engineer → QA passes → security passes → only then a report lands on the desk.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMissions, usageLimitUntil } = require('../bin/missions.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-loop-'));
const ROOT = path.join(tmp, 'root');
const projDir = path.join(ROOT, 'projects', 'demo');
const repo = path.join(tmp, 'repo');
const bin = path.join(tmp, 'bin');
for (const d of [projDir, repo, bin]) fs.mkdirSync(d, { recursive: true });
const git = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
git('init', '-q'); fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('add', '-A'); git('commit', '-qm', 'init');

// Fake claude: answers by which JSON schema it was handed, and logs every call.
const calls = path.join(tmp, 'calls.log');
fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const prompt = a[a.indexOf('-p') + 1];
const props = JSON.parse(a[a.indexOf('--json-schema') + 1]).properties;
const app = path.join(process.cwd(), 'app.txt');
let out, who;
const resumed = a.includes('--resume');
const model = a[a.indexOf('--model') + 1];
if (props.funnel) { who = 'route'; out = { funnel: process.env.FAKE_FUNNEL || 'solo', model: process.env.FAKE_MODEL || 'sonnet', about_office: false, title: 'Say hello', reason: 'test' }; }
else if (props.answer && props.next_steps && !props.verdict) { who = 'answer:' + model; out = { headline: 'It says v0', answer: 'The app prints v0.', next_steps: [] }; }
else if (props.rewritten_prompt) { who = 'planner'; out = { bubble: 'ok', rewritten_prompt: 'team: Make the app say hello with sonnet', steps: ['edit app.txt'], risks: '' }; }
else if (props.subtasks) { who = 'plan'; out = { bubble: 'On it', summary: 'One change', size: process.env.FAKE_SIZE || 'small', about_office: false, approval: 'approved', approval_note: '',
  subtasks: [{ title: 'Make app say hello', assignee: 'builder', instructions: 'edit app.txt', depends_on: [], changes_files: true, owns_files: [], workdir: '' }] }; }
else if (props.owner_only) { who = 'triage'; out = { owner_only: false, answer: 'Use "hello" in lower case.', why: 'conventions' }; }
else if (props.pass) {
  const qa = /QA hand-off/.test(prompt); who = qa ? 'gate-qa' : 'gate-security';
  const fixed = fs.readFileSync(app, 'utf8').includes('hello fixed');
  out = qa && (!fixed || process.env.FAKE_QA_ALWAYS_FAIL) ? { pass: false, bubble: 'Back to FORGE', summary: 'Missing newline handling', checked: 'read app.txt', notes: [],
    issues: [{ title: 'Greeting not final', detail: 'It must say "hello fixed".', file: 'app.txt', fix_by: 'builder' }] }
    : { pass: true, bubble: 'Looks good', summary: 'Checked', checked: 'read app.txt', issues: [], notes: [] };
} else if (props.headline) {
  who = 'review';
  const first = process.env.FAKE_REVIEW_SENDBACK && !fs.existsSync(process.env.FAKE_REVIEW_SENDBACK);
  if (first) fs.writeFileSync(process.env.FAKE_REVIEW_SENDBACK, '1');
  out = { headline: 'Hello', verdict: first ? 'partial' : 'success', summary: 'Done', completed: [], changes: [], checks: { qa_passed: true, notes: '' }, concerns: [], next_steps: [], for_you: 'Nothing',
    send_back: first ? [{ title: process.env.FAKE_REVIEW_TITLE || 'Nobody clicked through it', detail: 'Open it in the browser and confirm it sticks.', file: 'app.txt', fix_by: 'builder' }] : [] };
}
else if (props.applied && /You were paused/.test(prompt)) { who = 'continued' + (resumed ? '(' + a[a.indexOf('--resume') + 1] + ')' : ''); fs.writeFileSync(app, 'hello fixed\\n');
  out = { status: 'done', bubble: 'Done', summary: 'Carried on', details: '', files_changed: ['app.txt'], verified_by: 'cat', applied: true, owner_action_needed: '' }; }
else if (props.applied && process.env.FAKE_SLOW) { console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-slow' })); fs.appendFileSync(${JSON.stringify(calls)}, 'slow\\n'); setInterval(() => {}, 1000); return; }
else if (props.applied && process.env.FAKE_LIMIT_ONCE && !fs.existsSync(process.env.FAKE_LIMIT_ONCE)) {
  fs.writeFileSync(process.env.FAKE_LIMIT_ONCE, '1');
  fs.appendFileSync(${JSON.stringify(calls)}, 'limit\\n');
  console.log(JSON.stringify({ type: 'result', is_error: true, session_id: 'sess-limit', total_cost_usd: 0, result: "You've hit your session limit · resets 11:10pm (Asia/Jerusalem)" }));
  process.exit(0);
}
else if (props.applied) {
  const write = (f, t) => fs.writeFileSync(path.join(process.cwd(), f), t);
  const ok = (summary, files) => ({ status: 'done', bubble: 'Done', summary, details: '', files_changed: files, verified_by: 'cat', applied: true, owner_action_needed: '' });
  if (process.env.FAKE_SPLIT && /YOU MAY DELEGATE/.test(prompt)) { who = 'split'; out = { status: 'split', bubble: 'Splitting', summary: 'Split', details: '', files_changed: [], verified_by: '', applied: false, owner_action_needed: '',
    delegate: { contract: 'app.txt says hello, ui.txt shows it', integrate: 'check both', my_part: { title: 'Engine', instructions: 'app.txt', owns_files: ['app.txt'] },
      helpers: [{ title: 'UI', instructions: 'ui.txt', owns_files: [process.env.FAKE_SPLIT === 'bad' ? 'app.txt' : 'ui.txt'], model: 'haiku' }] } }; }
  else if (/split could not be used/.test(prompt)) { who = 'whole' + (resumed ? '(resumed)' : ''); write('app.txt', 'hello fixed\\n'); out = ok('Did it all', ['app.txt']); }
  else if (/Build YOUR part now/.test(prompt)) { who = 'part-lead' + (resumed ? '(resumed)' : ''); write('app.txt', 'hello\\n'); out = ok('Engine', ['app.txt']); }
  else if (/building ONE PART/.test(prompt)) { who = 'part:' + model + (/own ONLY: ui\\.txt/.test(prompt) ? ':owns-ui' : ''); write('ui.txt', 'shows hello\\n'); out = ok('UI', ['ui.txt']); }
  else if (/Every part is in/.test(prompt)) { who = 'integrate' + (resumed ? '(resumed)' : '') + (/UI \\(owns ui\\.txt\\)/.test(prompt) ? ':saw-ui' : ''); write('app.txt', 'hello fixed\\n'); out = ok('All wired', ['app.txt', 'ui.txt']); }
  else if (/Fix round|Fix these in the work you just did/.test(prompt)) { who = resumed ? 'rework(resumed)' : 'rework'; fs.writeFileSync(app, 'hello fixed\\n'); out = { status: 'done', bubble: 'Fixed', summary: 'Fixed it', details: '', files_changed: ['app.txt'], verified_by: 'cat', applied: true, owner_action_needed: '' }; }
  else if (/answered your question/.test(prompt)) { who = 'build-resume'; fs.writeFileSync(app, 'hello\\n'); out = { status: 'done', bubble: 'Done', summary: 'Says hello', details: '', files_changed: ['app.txt'], verified_by: 'cat', applied: true, owner_action_needed: '' }; }
  else if (process.env.FAKE_NO_ASK) { who = 'build:' + model; fs.writeFileSync(app, process.env.FAKE_BUILD_TEXT || 'hello\\n'); out = { status: 'done', bubble: 'Done', summary: 'Says hello', details: '', files_changed: ['app.txt'], verified_by: 'cat', applied: true, owner_action_needed: '' }; }
  else { who = 'build-ask'; out = { status: 'needs_human', bubble: '?', summary: 'Which case?', details: '', files_changed: [], verified_by: '', applied: false, owner_action_needed: '',
    question: { what: 'Upper or lower case hello?', why: 'style', steps: [], done_when: '', reply: 'upper/lower' } }; }
}
fs.appendFileSync(${JSON.stringify(calls)}, who + '\\n');
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-' + who, total_cost_usd: 0.01, structured_output: out }));
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.SM_CSWAP_BIN = 'none'; // never touch the real accounts from tests

// Fake cswap: account 1 is out, account 2 has room; `switch` flips which one is active.
const swapState = path.join(tmp, 'cswap-active');
const fakeSwap = path.join(bin, 'fake-cswap');
fs.writeFileSync(fakeSwap, `#!/usr/bin/env node
const fs = require('fs'); const f = ${JSON.stringify(swapState)};
const active = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 1;
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'switch') { fs.writeFileSync(f, String(arg)); fs.appendFileSync(f + '.log', 'switch ' + arg + '\\n'); process.exit(0); }
if (cmd === 'list') console.log(JSON.stringify({ accounts: [
  { number: 1, active: active === 1, usageStatus: 'ok', usage: { fiveHour: { pct: 100, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, sevenDay: { pct: 40 } } },
  { number: 2, active: active === 2, usageStatus: 'ok', usage: { fiveHour: { pct: 3 }, sevenDay: { pct: 20 } } },
] }));
`, { mode: 0o755 });

let qaRuns = 0;
const config = { path: repo, qa: [{ name: 'test', run: 'true' }], fullAccess: false };
const sm = {
  ROOT, SELF: path.join(bin, 'noop.js'),
  loadProject: (name) => ({ name, dir: projDir, config, state: {} }),
  readJSON: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
  usesBeads: () => false,
  runQA: () => { qaRuns++; return [{ name: 'test', run: 'true', ok: true, code: 0, output: '' }]; },
  fingerprint: () => 'fp', saveState: () => {},
};

test('work goes build → QA (rejects) → fix → QA → security → desk; ARES answers the question, not the owner', async () => {
  const M = createMissions(sm);
  const id = 'm-loop1';
  const file = path.join(projDir, 'missions', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
  await M.run('demo', id);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const order = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.deepEqual(order, ['planner', 'plan', 'build-ask', 'triage', 'build-resume', 'gate-qa', 'rework(resumed)', 'gate-qa', 'gate-security']); // the fix continues FORGE's own session // small + passed every hand-off → quick report, no extra review call
  assert.equal(m.status, 'done');
  assert.equal(m.report.verdict, 'success');
  assert.equal(m.loop.stage, 'passed');
  assert.equal(m.loop.round, 1);
  assert.ok(!m.subtasks.some((s) => s.status === 'waiting_human'), 'the owner was never asked');
  assert.equal(m.subtasks[0].answers[0].by, 'orchestrator');
  assert.deepEqual(m.subtasks.map((s) => s.kind || 'job'), ['job', 'gate', 'rework', 'gate', 'gate']);
  assert.equal(m.subtasks[2].assignee, 'builder', 'QA sent the fix back to the engineer who can fix it');
  assert.ok(qaRuns >= 2, 'the QA script runs before every QA hand-off');
  assert.match(m.report.checks.notes, /QA by ATLAS ✗ → QA by ATLAS ✓ → security by VEGA ✓/);
  assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'hello fixed\n');
});

test('if QA keeps rejecting it, the loop stops after maxFixRounds and the report says what is left (no endless loop)', async () => {
  process.env.FAKE_QA_ALWAYS_FAIL = '1';
  config.maxFixRounds = 2;
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('commit', '-qam', 'reset'); // fresh start for this mission
  try {
    const M = createMissions(sm);
    const id = 'm-loop2';
    const file = path.join(projDir, 'missions', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
    await M.run('demo', id);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(m.loop.stage, 'exhausted');
    assert.equal(m.loop.round, 2);
    assert.equal(m.subtasks.filter((s) => s.kind === 'rework').length, 2);
    assert.ok(!m.subtasks.some((s) => s.stage === 'security'), 'security never sees work QA rejected');
    assert.notEqual(m.report.verdict, 'success');
    assert.ok(m.report.concerns.some((c) => /Greeting not final/.test(c)));
  } finally { delete process.env.FAKE_QA_ALWAYS_FAIL; delete config.maxFixRounds; }
});

test('ARES\'s final review sends unfinished work back to the team instead of filing it on the owner\'s desk', async () => {
  process.env.FAKE_SIZE = 'medium';
  process.env.FAKE_REVIEW_SENDBACK = path.join(tmp, 'review-once');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('commit', '-qam', 'reset2');
  try {
    const M = createMissions(sm);
    const id = 'm-loop3';
    const file = path.join(projDir, 'missions', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
    await M.run('demo', id);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const order = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(order.filter((x) => x === 'review').length, 2, 'reviewed, sent back, reviewed again');
    assert.ok(m.subtasks.some((x) => x.kind === 'rework' && /ARES/.test(x.title)), 'the fix job came from ARES');
    assert.equal(m.report.verdict, 'success');
    assert.equal(m.status, 'done');
    assert.deepEqual(m.report.send_back, []);
  } finally { delete process.env.FAKE_SIZE; delete process.env.FAKE_REVIEW_SENDBACK; }
});

test('usage limit: reset times are read correctly', () => {
  const at = (h, mi) => { const d = new Date(2026, 9, 27, h, mi); return d.getTime(); };
  const u = usageLimitUntil("You've hit your session limit · resets 11:10pm (Asia/Jerusalem)", at(19, 0));
  assert.equal(u.getHours(), 23); assert.equal(u.getMinutes(), 12);
  const next = usageLimitUntil('You\'ve hit your usage limit · resets 6pm', at(19, 0));
  assert.equal(next.getDate(), 28, 'a reset time already passed today means tomorrow');
  assert.equal(usageLimitUntil('claude exited 1'), null);
});

test('hitting the usage limit pauses the mission and it carries on afterwards — no wasted retries, no report', async () => {
  process.env.FAKE_LIMIT_ONCE = path.join(tmp, 'limit-once');
  process.env.SM_LIMIT_WAIT_MS = '300'; process.env.SM_LIMIT_POLL_MS = '50';
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('commit', '-qam', 'reset4');
  try {
    const M = createMissions(sm);
    const id = 'm-loop4';
    const file = path.join(projDir, 'missions', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
    await M.run('demo', id);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(fs.readFileSync(calls, 'utf8').split('\n').filter((x) => x === 'limit').length, 1);
    assert.equal(m.status, 'done');
    assert.equal(m.subtasks[0].retries || 0, 0, 'waiting out the limit is not a failed attempt');
    assert.ok(m.events.some((e) => /usage limit/.test(e.text)));
    assert.ok(!m.limitUntil);
  } finally { for (const k of ['FAKE_LIMIT_ONCE', 'SM_LIMIT_WAIT_MS', 'SM_LIMIT_POLL_MS']) delete process.env[k]; }
});

test('with cswap: a usage limit switches to the account that has room and carries straight on (no pause)', async () => {
  process.env.FAKE_LIMIT_ONCE = path.join(tmp, 'limit-once-2');
  process.env.SM_CSWAP_BIN = fakeSwap;
  process.env.SM_LIMIT_WAIT_MS = '60000'; // would be a long wait if it paused
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('commit', '-qam', 'reset5');
  const started = Date.now();
  try {
    const M = createMissions(sm);
    const id = 'm-loop5';
    const file = path.join(projDir, 'missions', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
    await M.run('demo', id);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(m.status, 'done');
    assert.ok(Date.now() - started < 50000, 'did not sit out the limit');
    assert.equal(fs.readFileSync(swapState + '.log', 'utf8').trim(), 'switch 2');
    assert.ok(m.events.some((e) => /switched to account 2/.test(e.text)));
    assert.ok(!m.events.some((e) => /pausing until/.test(e.text)));
  } finally { process.env.SM_CSWAP_BIN = 'none'; for (const k of ['FAKE_LIMIT_ONCE', 'SM_LIMIT_WAIT_MS']) delete process.env[k]; }
});

const runMission = async (id, extra = {}) => {
  const M = createMissions(sm);
  const file = path.join(projDir, 'missions', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, project: 'demo', prompt: 'team: Make the app say hello with sonnet', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0, ...extra }));
  await M.run('demo', id);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const fresh = (tag) => { fs.writeFileSync(calls, ''); fs.writeFileSync(path.join(repo, 'app.txt'), 'v0\n'); git('commit', '-qam', tag); };

test('spending cap: once a mission has spent its cap it starts no new jobs and reports, instead of looping on', async () => {
  fresh('reset6');
  config.missionBudgetUsd = 0.035; // ~4 fake calls at $0.01
  try {
    const m = await runMission('m-cap1');
    assert.equal(m.loop.stage, 'over-budget');
    assert.notEqual(m.report.verdict, 'success');
    assert.ok(m.report.concerns.some((c) => /spending cap/.test(c)));
    assert.ok(!m.subtasks.some((x) => x.stage === 'security'), 'no new hand-offs past the cap');
  } finally { delete config.missionBudgetUsd; }
});

test('ARES cannot bounce QA-passed work back just to "check it again" — that loop is what burned the budget', async () => {
  fresh('reset7');
  process.env.FAKE_SIZE = 'medium';
  process.env.FAKE_REVIEW_SENDBACK = path.join(tmp, 'review-once-verify');
  process.env.FAKE_REVIEW_TITLE = 'Browser-check every room against the 2D look';
  try {
    const m = await runMission('m-verify1');
    const reviews = fs.readFileSync(calls, 'utf8').split('\n').filter((x) => x === 'review').length;
    assert.equal(reviews, 1, 'no second round for a verification-only request');
    assert.ok(!m.subtasks.some((x) => /ARES/.test(x.title)));
  } finally { for (const k of ['FAKE_SIZE', 'FAKE_REVIEW_SENDBACK', 'FAKE_REVIEW_TITLE']) delete process.env[k]; }
});

test('one mission per project: a second request waits for the running one instead of colliding with it', async () => {
  fresh('reset8');
  process.env.SM_QUEUE_POLL_MS = '50';
  const earlier = path.join(projDir, 'missions', 'm-ahead.json');
  fs.writeFileSync(earlier, JSON.stringify({ id: 'm-ahead', project: 'demo', prompt: 'Earlier work', status: 'working', createdAt: new Date(Date.now() - 60000).toISOString(), runnerPid: process.pid, subtasks: [], events: [], cost: 0 }));
  setTimeout(() => fs.writeFileSync(earlier, JSON.stringify({ ...JSON.parse(fs.readFileSync(earlier, 'utf8')), status: 'done' })), 400);
  try {
    const m = await runMission('m-second');
    assert.equal(m.status, 'done');
    assert.ok(m.events.some((e) => /Queued — I'll start once "Earlier work"/.test(e.text)));
  } finally { delete process.env.SM_QUEUE_POLL_MS; }
});

test('queue: the owner reorders waiting missions, and the one moved up runs first', async () => {
  fresh('reset-order');
  process.env.SM_QUEUE_POLL_MS = '50';
  const M = createMissions(sm);
  const put = (id, extra) => fs.writeFileSync(path.join(projDir, 'missions', `${id}.json`), JSON.stringify({ id, project: 'demo', prompt: `Work ${id}`, subtasks: [], events: [], cost: 0, runnerPid: process.pid, ...extra }));
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  put('m-run', { status: 'working', createdAt: at(90000) });
  put('m-old', { status: 'queued', createdAt: at(60000), waitingFor: 'm-run' });
  put('m-new', { status: 'queued', createdAt: at(30000), waitingFor: 'm-run' });
  assert.deepEqual(M.snapshot('demo').filter((x) => x.queuePos).sort((a, b) => a.queuePos - b.queuePos).map((x) => x.id), ['m-old', 'm-new']);
  assert.deepEqual(M.reorder('demo', ['m-new', 'm-old']).order, ['m-new', 'm-old']);
  assert.equal(M.snapshot('demo').find((x) => x.id === 'm-new').queuePos, 1);
  const flip = (id) => { const f = path.join(projDir, 'missions', `${id}.json`); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), status: 'done' })); return Date.now(); };
  let newDoneAt = 0;
  setTimeout(() => flip('m-run'), 200);
  setTimeout(() => { newDoneAt = flip('m-new'); }, 700); // m-old must still be waiting until the one moved above it finishes
  try {
    process.env.FAKE_NO_ASK = '1';
    await M.run('demo', 'm-old');
    const m = JSON.parse(fs.readFileSync(path.join(projDir, 'missions', 'm-old.json'), 'utf8'));
    assert.ok(newDoneAt && Date.parse(m.dequeuedAt) >= newDoneAt - 5, 'm-old started only after m-new');
    assert.equal(m.status, 'done');
  } finally { delete process.env.SM_QUEUE_POLL_MS; delete process.env.FAKE_NO_ASK; fs.rmSync(path.join(projDir, 'missions', 'queue.json'), { force: true }); }
});

test('send now: the running mission pauses (its job keeps its session), the chosen one goes, then it carries on', async () => {
  fresh('reset-preempt');
  process.env.SM_QUEUE_POLL_MS = '50';
  process.env.FAKE_SLOW = '1';
  process.env.FAKE_FUNNEL = 'quick';
  const M = createMissions(sm);
  const dir = path.join(projDir, 'missions');
  const file = path.join(dir, 'm-busy.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'm-busy', project: 'demo', prompt: 'Make the app say hello', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
  const urgent = path.join(dir, 'm-urgent.json');
  try {
    const done = M.run('demo', 'm-busy');
    for (let i = 0; i < 100 && !fs.readFileSync(calls, 'utf8').includes('slow'); i++) await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(urgent, JSON.stringify({ id: 'm-urgent', project: 'demo', prompt: 'Urgent fix', status: 'queued', createdAt: new Date().toISOString(), runnerPid: process.pid, waitingFor: 'm-busy', subtasks: [], events: [], cost: 0 }));
    assert.throws(() => M.sendNow('demo', 'm-busy'), /waiting in the queue/);
    assert.deepEqual(M.sendNow('demo', 'm-urgent').paused, ['m-busy']);
    let paused = null;
    for (let i = 0; i < 100 && !paused; i++) { await new Promise((r) => setTimeout(r, 50)); const b = JSON.parse(fs.readFileSync(file, 'utf8')); if (b.status === 'queued' && b.waitingFor === 'm-urgent') paused = b; }
    assert.ok(paused, 'the running mission stepped aside for the urgent one');
    assert.equal(paused.subtasks[0].status, 'answered', 'its job is not failed — it will continue');
    assert.equal(M.snapshot('demo').find((x) => x.id === 'm-busy').queuePos, 2);
    fs.writeFileSync(urgent, JSON.stringify({ ...JSON.parse(fs.readFileSync(urgent, 'utf8')), status: 'done' })); // the urgent one finished
    await done;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(m.status, 'done');
    assert.ok(fs.readFileSync(calls, 'utf8').split('\n').includes('continued(sess-slow)'), 'the job carried on in its own session');
    assert.ok(m.events.some((e) => /Pausing so "Urgent fix" can go first/.test(e.text)));
    assert.ok(m.events.some((e) => /Back to this one/.test(e.text)));
    assert.ok(!m.subtasks.some((x) => x.status === 'failed'));
  } finally { for (const k of ['SM_QUEUE_POLL_MS', 'FAKE_SLOW', 'FAKE_FUNNEL']) delete process.env[k]; fs.rmSync(path.join(dir, 'queue.json'), { force: true }); }
});

test('funnels: a QUICK request is one agent + the QA script — no router call when the owner says so, no planner, no checker, no review', async () => {
  fresh('reset-q');
  process.env.FAKE_NO_ASK = '1';
  try {
    const m = await runMission('m-quick', { prompt: 'quick: make the app say hello with haiku' });
    const order = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual(order, ['build:haiku']);
    assert.equal(m.route.funnel, 'quick');
    assert.equal(m.route.model, 'haiku');
    assert.equal(m.report.verdict, 'success');
    assert.ok(!m.subtasks.some((x) => x.kind === 'gate'));
  } finally { delete process.env.FAKE_NO_ASK; }
});

test('funnels: SOLO = one lead end to end, one combined check, and a fix continues the SAME session', async () => {
  fresh('reset-s');
  process.env.FAKE_NO_ASK = '1';
  process.env.FAKE_FUNNEL = 'solo';
  try {
    const m = await runMission('m-solo', { prompt: 'Make the app say hello' });
    const order = fs.readFileSync(calls, 'utf8').trim().split('\n');
    // route → lead builds → combined check rejects → lead fixes IN ITS OWN SESSION → check passes; no planner, no security, no review
    assert.deepEqual(order, ['route', 'build:sonnet', 'gate-qa', 'rework(resumed)', 'gate-qa']);
    assert.equal(m.route.funnel, 'solo');
    assert.equal(m.loop.stage, 'passed');
    assert.equal(m.report.verdict, 'success');
    assert.equal(m.report.route.funnel, 'solo');
  } finally { delete process.env.FAKE_NO_ASK; delete process.env.FAKE_FUNNEL; }
});

test('delegation: FORGE splits a big job, she and a helper build side by side, then she integrates and one check runs', async () => {
  fresh('reset-split');
  process.env.FAKE_SPLIT = 'good'; process.env.FAKE_FUNNEL = 'solo';
  try {
    const m = await runMission('m-split', { prompt: 'Make the app say hello and show it in the UI' });
    const order = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.deepEqual([order[0], order[1]], ['route', 'split']);
    assert.deepEqual(order.slice(2, 4).sort(), ['part-lead(resumed)', 'part:haiku:owns-ui'], 'her part continues her session; the helper gets only its own files');
    assert.deepEqual(order.slice(4), ['integrate(resumed):saw-ui', 'gate-qa'], 'she integrates in her own session, knowing what the helper built');
    const helper = m.subtasks.find((x) => x.kind === 'part' && x.assignee !== 'builder');
    assert.ok(['bolt', 'flux'].includes(helper.assignee));
    assert.deepEqual(helper.owns, ['ui.txt']);
    assert.equal(m.split.parts, 1);
    assert.equal(m.loop.stage, 'passed');
    assert.equal(m.report.verdict, 'success');
    assert.equal(fs.readFileSync(path.join(repo, 'ui.txt'), 'utf8'), 'shows hello\n');
  } finally { delete process.env.FAKE_SPLIT; delete process.env.FAKE_FUNNEL; }
});

test('delegation: a split whose parts share files is refused — she does the whole job herself, in the same session', async () => {
  fresh('reset-split-bad');
  process.env.FAKE_SPLIT = 'bad'; process.env.FAKE_FUNNEL = 'solo';
  try {
    const m = await runMission('m-split-bad', { prompt: 'Make the app say hello' });
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['route', 'split', 'whole(resumed)', 'gate-qa']);
    assert.ok(!m.split, 'no split recorded');
    assert.ok(!m.subtasks.some((x) => x.assignee !== 'builder' && x.kind !== 'gate'), 'no helper started');
    assert.equal(m.report.verdict, 'success');
  } finally { delete process.env.FAKE_SPLIT; delete process.env.FAKE_FUNNEL; }
});

test('funnels: a question is answered by one read-only call — nothing built, no QA', async () => {
  fresh('reset-a');
  const m = await runMission('m-answer', { prompt: 'question: what does the app print? use haiku' });
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['answer:haiku']);
  assert.equal(m.status, 'done');
  assert.match(m.report.summary, /v0/);
  assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'v0\n', 'nothing was changed');
});

test('owner words pick the funnel and model; a stuck job retries on a stronger model', () => {
  const { ownerRoute, nextModel } = require('../bin/missions.js');
  assert.deepEqual(ownerRoute('quick: fix the typo'), { funnel: 'quick' });
  assert.deepEqual(ownerRoute('team: rebuild the dashboard using opus'), { funnel: 'team', model: 'opus' });
  assert.deepEqual(ownerRoute('add dark mode'), {});
  assert.equal(nextModel('haiku'), 'sonnet');
  assert.equal(nextModel('sonnet'), 'opus');
  assert.equal(nextModel('opus'), 'opus');
  const { asksForAction } = require('../bin/missions.js');
  assert.ok(asksForAction('start the firebase cli and ill log in'), 'a request to act is never just answered');
  assert.ok(asksForAction('why is it broken? fix it'));
  assert.ok(!asksForAction('how do I add a key?'));
  assert.ok(!asksForAction('where do i place the eleven labs key'));
});

test('home vs workplace: asked from the office about another project, the team works in THAT folder and nothing lands in the office', async () => {
  fresh('reset-home');
  const homeDir = path.join(ROOT, 'projects', 'home');
  fs.mkdirSync(path.join(homeDir, 'missions'), { recursive: true });
  const home = { name: 'home', dir: homeDir, config: { path: ROOT, qa: [{ name: 'test', run: 'true' }], fullAccess: false }, state: {} };
  const sm2 = { ...sm, listProjects: () => ['home', 'demo'], loadProject: (name) => (name === 'home' ? home : { name: 'demo', dir: projDir, config, state: {} }) };
  process.env.FAKE_NO_ASK = '1';
  try {
    const M = createMissions(sm2);
    const file = path.join(homeDir, 'missions', 'm-home.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'm-home', project: 'home', prompt: 'quick: make /demo say hello', status: 'queued', createdAt: new Date().toISOString(), subtasks: [], events: [], cost: 0 }));
    await M.run('home', 'm-home');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(m.workProject, 'demo');
    assert.ok(!m.officeMission, 'not office work');
    assert.equal(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'hello\n', 'the change landed in the project');
    assert.ok(!fs.existsSync(path.join(ROOT, 'app.txt')), 'nothing was written into the office');
    assert.equal(m.report.verdict, 'success');
  } finally { delete process.env.FAKE_NO_ASK; }
});

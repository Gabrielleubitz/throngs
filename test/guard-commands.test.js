/** The PreToolUse guard on office missions: the team can drive the live office in a browser, but can't leak the
 *  login token, hand-launch the server, publish, grant itself switches, or wipe the owner's uncommitted work. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SM = path.join(__dirname, '..', 'bin', 'sm.js');
const guard = (command) => {
  const r = spawnSync(process.execPath, [SM, 'hook', 'guard', 'success-manager'], {
    input: JSON.stringify({ tool_input: { command }, cwd: path.join(__dirname, '..') }), encoding: 'utf8',
    env: { ...process.env, SM_ROLE: 'mission', SM_OFFICE_MISSION: '1', SM_OFFICE_EDIT: '1' },
  });
  return r.stdout.includes('"deny"') ? 'deny' : 'allow';
};

test('the team can open and click through the live office', () => {
  assert.equal(guard('node bin/sm.js office --browse forge'), 'allow');
  assert.equal(guard('playwright-cli -s=forge click e12'), 'allow');
  assert.equal(guard('node bin/sm.js office --build --restart --no-open'), 'allow');
  assert.equal(guard('ls ~/.pixel-agents/'), 'allow', 'mentioning pixel-agents is not a crime any more');
});

const officeProject = fs.existsSync(path.join(__dirname, '..', 'projects', 'success-manager', 'config.json')) || 'needs the office registered as a project (sm add . --name success-manager)';
test('…but not the risky things', { skip: officeProject === true ? false : officeProject }, () => {
  assert.equal(guard('cat ~/.pixel-agents/standalone-token'), 'deny');
  assert.equal(guard('node pixel-office/dist/cli.js --port 4777'), 'deny');
  assert.equal(guard('git push origin main'), 'deny');
  assert.equal(guard('node bin/sm.js set success-manager allowPush true'), 'deny');
  assert.equal(guard('git stash'), 'deny');
  assert.equal(guard('git clean -fd'), 'deny');
});

test('a mission on the office project itself may edit office code even without the office-mission flags', { skip: officeProject === true ? false : officeProject }, () => {
  const root = path.join(__dirname, '..');
  const edit = (file) => {
    const r = spawnSync(process.execPath, [SM, 'hook', 'guard', 'success-manager'], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(root, file) }, cwd: root }), encoding: 'utf8',
      env: { ...process.env, SM_ROLE: 'mission', SM_OFFICE_MISSION: '', SM_OFFICE_EDIT: '' },
    });
    return r.stdout.includes('"deny"') ? 'deny' : 'allow';
  };
  assert.equal(edit('pixel-office/webview-ui/src/office3d/scene3d.ts'), 'allow');
  assert.equal(edit('lat.md/office-ui.md'), 'allow', 'the shared brain must stay editable');
  assert.equal(edit('projects/success-manager/config.json'), 'deny', 'its own QA settings stay off-limits');
});

test('token saving: with rtk installed, a full-access worker\'s commands go through rtk (and only after the safety checks)', { skip: (spawnSync('rtk', ['--version']).status !== 0 && 'rtk not installed') || (officeProject !== true && officeProject) }, () => {
  const run = (command, env) => spawnSync(process.execPath, [SM, 'hook', 'guard', 'success-manager'], {
    input: JSON.stringify({ tool_input: { command }, cwd: path.join(__dirname, '..') }), encoding: 'utf8', env: { ...process.env, ...env },
  }).stdout;
  const out = JSON.parse(run('git status', { SM_ROLE: 'mission', SM_OFFICE_MISSION: '1' }) || '{}').hookSpecificOutput;
  assert.equal(out?.updatedInput?.command, 'rtk git status');
  assert.match(run('git stash', { SM_ROLE: 'mission', SM_OFFICE_MISSION: '1' }), /"deny"/, 'denied before any rewrite');
  assert.equal(run('git status', { SM_ROLE: '' }), '', "the owner's own sessions are never touched");
  assert.equal(run('git status', { SM_ROLE: 'mission', SM_OFFICE_MISSION: '1', SM_NO_RTK: '1' }), '', 'SM_NO_RTK turns it off');
});

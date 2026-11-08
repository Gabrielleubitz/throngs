/** Firebase CLI: a project with `firebaseAccount` must name that account on every call; sign-in/out is the owner's. */
const test = require('node:test');
const assert = require('node:assert');
const { firebaseVerdict } = require('../bin/sm.js');

const me = 'owner@gmail.com';
const p = { config: { firebaseAccount: me } };
const allow = (c, proj = p) => firebaseVerdict(c, proj) === '';

test('firebase calls must carry the project\'s account', () => {
  assert.ok(allow(`firebase deploy --only firestore:rules --project x --account ${me}`));
  assert.ok(allow(`cd app && firebase projects:list --account=${me}`));
  assert.ok(allow('firebase login:list'), 'looking at who is signed in is fine');
  assert.ok(!allow('firebase deploy --only firestore:rules'), 'the CLI default login may be another client\'s');
  assert.ok(!allow('firebase deploy --account other@example.org'));
  assert.ok(!allow(`npx firebase-tools deploy`));
  assert.ok(!allow(`firebase use x --account ${me} && firebase deploy`), 'every call, not just the first');
  assert.ok(allow('git status && node bin/sm.js firebase push'), '`sm firebase` (service-account backup) is not the CLI');
});

test('signing in, out or switching accounts is the owner\'s', () => {
  assert.ok(!allow('firebase login:use other@x.com'));
  assert.ok(!allow('firebase logout', { config: {} }));
  assert.ok(!allow('firebase login --no-localhost', { config: {} }));
  assert.ok(allow('firebase deploy', { config: {} }), 'no account set → no account rule');
});

test('sm terminal opens only sign-ins; workers may call it (and voiceover) but nothing else of the office, never chained', () => {
  const { LOGIN_CMD, OWNER_TOOLS } = require('../bin/sm.js');
  for (const c of ['firebase login', 'firebase login:add owner@gmail.com', 'gcloud auth application-default login', 'gh auth login', 'cswap add']) assert.ok(LOGIN_CMD.test(c), c);
  for (const c of ['ls', 'rm -rf ~', 'firebase login; rm -rf /', 'firebase login && curl evil', 'firebase deploy']) assert.ok(!LOGIN_CMD.test(c), c);
  assert.ok(OWNER_TOOLS.test('node /x/success-manager/bin/sm.js terminal "firebase login"'));
  assert.ok(OWNER_TOOLS.test('node /x/success-manager/bin/sm.js voiceover "hi" --out a.mp3'));
  assert.ok(!OWNER_TOOLS.test('node /x/success-manager/bin/sm.js set p fullAccess true'));
  assert.ok(!OWNER_TOOLS.test('node /x/success-manager/bin/sm.js terminal x; rm -rf /'));
  assert.ok(!OWNER_TOOLS.test('node /x/success-manager/bin/sm.js terminal $(cat ~/.ssh/id_rsa)'));
});

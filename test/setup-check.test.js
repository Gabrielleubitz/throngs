'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSetupCheck } = require('../bin/setup-check.js');

const fresh = (o = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')); const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  fs.writeFileSync(path.join(root, '.env.example'), 'ELEVENLABS_API_KEY=\n');
  return { root, home, S: createSetupCheck(root, { home, env: {}, has: () => false, run: () => false, integrations: { list: () => [] }, nodeVersion: '22.1.0', ...o }) };
};

test('a brand-new machine: every missing piece is listed with its fix, and the office is not ready', () => {
  const { S } = fresh();
  const s = S.summary();
  assert.strictEqual(s.ready, false);
  const req = s.items.filter((i) => i.group === 'required');
  assert.deepStrictEqual(req.map((i) => [i.id, i.ok]), [['node', true], ['git', false], ['claude', false], ['claude-login', false], ['build', false], ['project', false]]);
  for (const i of s.items.filter((x) => !x.ok)) assert.ok(i.fix, `${i.id} says how to fix it`);
  assert.ok(s.items.filter((i) => i.group === 'optional').every((i) => i.unlocks), 'optional features say what they unlock');
});

test('everything in place: ready, and a key in .env counts without ever being read back', () => {
  const { root, home, S } = fresh({ has: () => true, run: () => true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x' } }));
  fs.mkdirSync(path.join(root, 'pixel-office', 'dist'), { recursive: true }); fs.writeFileSync(path.join(root, 'pixel-office', 'dist', 'cli.js'), '');
  fs.mkdirSync(path.join(root, 'projects', 'my-app'), { recursive: true }); fs.writeFileSync(path.join(root, 'projects', 'my-app', 'config.json'), '{}');
  assert.strictEqual(S.summary().ready, true);
  assert.strictEqual(S.summary().items.find((i) => i.id === 'env').ok, false);
  S.createEnv();
  fs.appendFileSync(path.join(root, '.env'), 'ELEVENLABS_API_KEY=sk_secret\n');
  const s = S.summary();
  assert.ok(s.items.find((i) => i.id === 'env').ok && s.items.find((i) => i.id === 'voice').ok);
  assert.ok(!JSON.stringify(s).includes('sk_secret'), 'secrets never leave the file');
  S.createEnv(); assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /sk_secret/, 'never overwrites an existing .env');
});

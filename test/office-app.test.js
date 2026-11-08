const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { install } = require('../bin/office-app.js');

test('install builds a launchable native app bundle with icon and lsof on PATH', { skip: process.platform !== 'darwin' }, () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'));
  const app = install(dest);
  const exe = path.join(app, 'Contents', 'MacOS', 'AI Office');
  assert.ok(fs.statSync(exe).mode & 0o100, 'executable is runnable');
  assert.match(fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleExecutable<\/key><string>AI Office<\/string>/);
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns')));
  const bin = fs.readFileSync(exe).toString('latin1');
  assert.match(bin, /\/usr\/sbin/, 'PATH baked into the app has lsof');
  assert.match(bin, new RegExp(path.join(__dirname, '..').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'knows the office folder');
  fs.rmSync(dest, { recursive: true, force: true });
});

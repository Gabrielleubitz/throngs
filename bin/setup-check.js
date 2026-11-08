'use strict';
/**
 * What a new machine needs for the office to run, as one checklist: the onboarding Setup step (/sm/setup) and
 * `sm doctor` both read it. Three groups: required (missions can't run without it), recommended, and optional
 * features (each says what it unlocks). Every item that isn't done carries the exact fix. Secrets are never read
 * back: only whether a value is set.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const defaultHas = (cmd) => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const defaultRun = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 8000 }); return r.status === 0; };

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
  return out;
}

function createSetupCheck(root, { has = defaultHas, run = defaultRun, home = os.homedir(), env = process.env, integrations, nodeVersion = process.versions.node } = {}) {
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  const envFile = path.join(root, '.env');
  const envVals = () => { try { return parseEnv(fs.readFileSync(envFile, 'utf8')); } catch { return {}; } };
  const linked = (id) => { try { return !!(integrations || require('./integrations.js').createIntegrations(root)).list().find((x) => x.id === id)?.linked; } catch { return false; } };
  /** Signed in to Claude Code: an API key, or the login record the CLI writes (only its presence is checked). */
  const claudeSignedIn = () => {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
    try { const j = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); if (j.oauthAccount || j.primaryApiKey) return true; } catch { /* not signed in */ }
    return exists(path.join(home, '.claude', '.credentials.json'));
  };
  const projects = () => { try { return fs.readdirSync(path.join(root, 'projects')).filter((n) => exists(path.join(root, 'projects', n, 'config.json')) && n !== 'success-manager').length; } catch { return 0; } };

  function list() {
    const v = envVals(); const claude = has('claude'); const n = projects();
    const item = (group, id, label, ok, fix, extra = {}) => ({ group, id, label, ok: !!ok, fix: ok ? '' : fix, ...extra });
    return [
      item('required', 'node', `Node.js ${nodeVersion} (20 or newer)`, Number(String(nodeVersion).split('.')[0]) >= 20, 'Install Node 20+ from https://nodejs.org', { link: 'https://nodejs.org' }),
      item('required', 'git', 'git', has('git'), 'On a Mac: xcode-select --install', { cmd: 'xcode-select --install' }),
      item('required', 'claude', 'Claude Code CLI installed', claude, 'npm i -g @anthropic-ai/claude-code', { cmd: 'npm i -g @anthropic-ai/claude-code', link: 'https://docs.anthropic.com/en/docs/claude-code' }),
      item('required', 'claude-login', 'Claude Code signed in', claude && claudeSignedIn(), 'Run claude in a terminal once and sign in (a Claude Pro/Max plan or an API key)', { cmd: 'claude' }),
      item('required', 'build', 'Office app built', exists(path.join(root, 'pixel-office', 'dist', 'cli.js')), 'Run ./install.sh in the office folder', { cmd: './install.sh' }),
      item('required', 'project', n ? `${n} project${n > 1 ? 's' : ''} added` : 'Add your first project', n > 0, 'Pick a folder in the bar at the bottom, or run: node bin/sm.js add ~/path/to/your-app', { cmd: 'node bin/sm.js add ~/path/to/your-app' }),

      item('recommended', 'env', '.env settings file', exists(envFile), 'Create it from the template: cp .env.example .env', { cmd: 'cp .env.example .env', action: 'create-env' }),
      item('recommended', 'gh', 'GitHub CLI signed in', has('gh') && run('gh', ['auth', 'status']), has('gh') ? 'gh auth login' : 'brew install gh, then gh auth login', { cmd: has('gh') ? 'gh auth login' : 'brew install gh && gh auth login', unlocks: 'CI status and PRs in your dev pulse and morning brief' }),

      item('optional', 'voice', 'Crew voices (ElevenLabs)', !!(v.ELEVENLABS_API_KEY || env.ELEVENLABS_API_KEY), 'Add ELEVENLABS_API_KEY=… to .env (key from elevenlabs.io → Profile → API keys)', { link: 'https://elevenlabs.io/app/settings/api-keys', unlocks: 'The crew talks, narration for videos, IVY\'s natural phone voice' }),
      item('optional', 'telegram', 'Telegram (IVY on your phone)', linked('telegram'), 'Create a bot with @BotFather, then link Telegram the Penguin in the Zoo', { link: 'https://t.me/BotFather', unlocks: 'Mission reports, questions with answer buttons, talk to IVY from anywhere' }),
      item('optional', 'google', 'Google (Calendar, Meet, Gmail)', linked('google'), 'Link Google the Zebra in the Zoo', { unlocks: 'Your calendar in the office, Meet invites and emails from IVY' }),
      item('optional', 'phone', 'Phone line (Twilio)', linked('sms') && has('cloudflared'), linked('sms') ? 'brew install cloudflared (gives the phone line a public address)' : 'Link SMS the Fox (Twilio) in the Zoo, and brew install cloudflared', { cmd: 'brew install cloudflared', unlocks: 'IVY answers your calls and calls people for you' }),
      item('optional', 'ffmpeg', 'ffmpeg', has('ffmpeg'), 'brew install ffmpeg', { cmd: 'brew install ffmpeg', unlocks: 'REEL makes videos' }),
      item('optional', 'cswap', 'Several Claude accounts (cswap)', has(env.SM_CSWAP_BIN || 'cswap'), 'Install cswap and add your accounts', { unlocks: 'METER switches to a fresh account when one hits its limit' }),
    ];
  }
  function summary() {
    const items = list(); const req = items.filter((i) => i.group === 'required');
    return { items, ready: req.every((i) => i.ok), required: { done: req.filter((i) => i.ok).length, total: req.length } };
  }
  /** Create .env from .env.example (never overwrites). */
  function createEnv() {
    if (!exists(envFile)) { const tpl = path.join(root, '.env.example'); fs.writeFileSync(envFile, exists(tpl) ? fs.readFileSync(tpl, 'utf8') : '# Throngs settings\n', { mode: 0o600 }); }
    return { file: envFile, ...summary() };
  }
  return { list, summary, createEnv };
}

module.exports = { createSetupCheck, parseEnv };

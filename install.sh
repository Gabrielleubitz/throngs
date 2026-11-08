#!/usr/bin/env bash
# Throngs / Success Manager installer. Safe to re-run. Usage: ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking your machine"
command -v node >/dev/null || die "Node.js is missing. Install Node 20+ from https://nodejs.org and run ./install.sh again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node $(node -v) is too old. Install Node 20+."
command -v npm >/dev/null || die "npm is missing (it ships with Node)."
command -v git >/dev/null || die "git is missing. On a Mac run: xcode-select --install"
command -v claude >/dev/null || printf '  ! Claude Code CLI not found. Install it: npm i -g @anthropic-ai/claude-code, then run `claude` once to sign in.\n'

say "Installing the app (first time takes a few minutes)"
[ -d pixel-office ] || die "pixel-office/ folder is missing. Re-download the app."
npm --prefix pixel-office ci --no-audit --no-fund
npm --prefix pixel-office/webview-ui install --no-audit --no-fund
npm --prefix pixel-office run build

say "Setting up your settings file"
[ -f .env ] || { cp .env.example .env && echo "  created .env (add ELEVENLABS_API_KEY there if you want the crew to talk)"; }
mkdir -p projects project_inbox standup office/uploads

say "Final check"
node bin/sm.js doctor || true

cat <<'DONE'

✔ Installed. Start it with:  ./start.sh
  It opens in your browser and walks you through a short welcome.
DONE

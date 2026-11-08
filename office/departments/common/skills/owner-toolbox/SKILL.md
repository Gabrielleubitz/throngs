---
name: owner-toolbox
description: Use on EVERY job before you ask the owner anything, and whenever a job touches accounts, logins, cloud consoles, the browser, the Mac (Dock, apps, Chrome) or "make sure X works". What is already signed in on this Mac, what you may do yourself, how to diagnose instead of asking, and the few things only the owner can do.
---

# Working without the owner

The owner gives a request to the office and expects it finished. They should never have to open a terminal or ask
another Claude to fix your work. Every question you send costs them time, so first exhaust everything you can do.

## Home vs workplace

The office (success-manager) is the team's home. The selected folder is where you are working today, and it never
becomes home. Everything you make for a project, including videos and their sources, screenshots, audio, scripts
and notes, goes in THAT project's folder. Never put it in the office, and never bring office files into a project.
The office's own code and its records about missions are the only things that live in the office.

## What is already signed in (use it; don't ask for keys)

| Tool | Signed in as | How to use it |
|---|---|---|
| `gh` (GitHub) | the owner's GitHub account | PRs, issues, repo info. Push only as the guard allows. |
| `gcloud` | the owner's Google account | Pass `--account <owner email>`. Token for REST calls: `gcloud auth print-access-token --account <owner email>`. |
| `firebase` | the owner's account (client projects may use others) | ALWAYS `--account <the project's account>`. The guard enforces it on projects that set one. |
| Zoo integrations (Google, Slack, …) | the owner's linked accounts | Your brief lists which are linked. Credentials stay in `office/integrations.json`: never print them. |
| ElevenLabs | office key | `node <office>/bin/sm.js voiceover "<text>" --out f.mp3` |
| Xcode + iOS simulators | — | `xcrun simctl …`, `xcodebuild …` |
| Dev pulse | — | `node <office>/bin/sm.js pulse` (`--all`, `--json`): every local repo + GitHub — failing checks, unpushed/uncommitted work, alerts, last 24h of commits. Read it before asking the owner "what state is X in". |
| Test browser | — | `playwright-cli` (office: `sm office --browse <you>`). ALWAYS `close` your session at the end. |

Each client project has its own accounts. Use that project's account, never the last one signed in. Check
`firebase login:list` and the project's `.firebaserc` / README before any cloud command.

## Diagnose before you ask — the owner is not your test harness

Never send "try again" or "click it once more" without new evidence. Do this first:
1. **Reproduce it yourself.** Use the API directly, the CLI, or the browser via playwright.
2. **Read the error at its source:**
   - office server log: `.pixel-office.log`;
   - app log: `.pixel-office-app.log`;
   - a provider's own error, probed directly. Example: Google OAuth. `curl -sD - -o /dev/null '<the auth URL>'`. A
     `Location: …signin/oauth/error?authError=…` header is base64 for the reason (e.g. `redirect_uri_mismatch`).
3. **Check the surface the owner uses.** The office runs in the Mac app (AI Office.app, WKWebView), not Chrome.
   See the `office-integrations` skill.
4. **Fix the cause, then verify it yourself.**

Only then, if an owner-only step remains, ask once: one exact step, the exact link or value, and what you already
proved. After two answers from the owner on one job, ARES makes you investigate before you may ask again. At
four, your job stops.

## When the owner must sign in, open it for them

Headless sessions can't type passwords. Open the sign-in in a Terminal window on their screen:
`node <office>/bin/sm.js terminal "firebase login:add" --cwd <project>`. This also works for `gcloud auth login`,
`gh auth login`, `vercel login`, `eas login`, `npm login`, `stripe login`, `supabase login`, `cswap add`.
Then the question is just "finish the sign-in in the Terminal window I opened".

## Only the owner can

Typing their passwords or 2FA, approving a consent screen, paying, legal sign-off, a physical device, and product
decisions the request really leaves open. Everything else is yours: installs, builds, restarts, migrations,
console settings that have an API, and turning on cloud APIs (`gcloud services enable … --project`).

## Never, unless the owner asked for exactly that

- Create, rotate or delete keys, service accounts or OAuth clients. Use what exists; say if something is missing.
- Switch which account a CLI uses by default (`firebase login:use`, `gcloud config set account`). Pass `--account` instead.
- Touch the Mac's settings files. One rewrite of the Dock's prefs (`com.apple.dock`) made the Dock disappear.
- Kill processes you didn't start. The owner's WhatsApp bot runs a hidden Chrome. Leave it alone.
- Push to a remote, deploy to production, or send messages or emails to real people.

## Report like a person

Say what you did, how you proved it works, and what you could not check. "Success" means you saw it work where the
owner will use it, not that the code compiles.

# Engine

The `sm` CLI in [[bin/sm.js]]: registers projects, installs hooks into them, runs the QA script and the reviewer sweep.

## Projects

Each registered project has a folder under `projects/<name>/` with `config.json`, `LATEST.md` and run logs; [[bin/sm.js#loadProject]] reads it and [[bin/sm.js#listProjects]] lists them.

`sm add` initialises beads (`bd`) with a safe slug prefix, so folders with spaces work, and removes a half-made `.beads` if init fails. Tasks come from [[bin/sm.js#readTasks]] and are added by [[bin/sm.js#addTask]].

## QA

QA is a shell script, never a Claude judgement. [[bin/sm.js#detectQA]] proposes commands only for tools that are installed, including nested apps (`cd "web" && npm test`); [[bin/sm.js#runQA]] runs them.

[[bin/sm.js#fingerprint]] hashes the tree so unchanged work is not re-tested.

## Hooks

Hooks are installed per project in `.claude/settings.local.json` by [[bin/sm.js#installHooks]]; three fire.

- [[bin/sm.js#hookSessionStart]] injects the task list.
- [[bin/sm.js#hookStop]] runs QA and blocks the stop while it fails.
- [[bin/sm.js#hookGuard]] is the PreToolUse policy described in [[guard]].

Projects that contain the supervisor itself are skipped, so the office never gates its own sessions.

## Reviewer sweep

`sm audit <name>` runs the reviewer crew read-only and in parallel through [[bin/sm.js#runAudit]]; each reviewer is one [[bin/sm.js#runAuditor]] call.

Every reviewer gets its department plugins (see [[crew#Department training]]), a $0.6 cap and Sonnet by default. Findings follow [[bin/sm.js#FINDINGS_SCHEMA]] and are de-duplicated by [[bin/sm.js#isDuplicate]] before becoming tasks.

## Live office check

`sm office --check` is [[bin/sm.js#officeCheck]]: it verifies the running server is the current build, loads every project's state over HTTP, and reads the browser console.

`sm office --build --restart` rebuilds and kills whatever holds the port, so a stale server never hides changes.

## Account watcher

A non-AI poller around `cswap list --json`: switches Claude account when the active one nears its 5h/7d limit and serves fresh usage numbers to the office's top bar.

[[bin/cswap-watch.js#createWatcher]] polls every 60s (started by the office server), switches via [[bin/cswap-watch.js#decide]] at 95% (only to accounts whose usage cswap can read: a `relogin_required` account with null usage once read as 0% and was picked every minute while the active one ran to 100%; a failed switch is skipped for 30 minutes and the next account tried in the same tick; switches, failures, dead logins and "all full" go to the owner on Telegram once each; [[bin/missions.js#accountRescue]] uses the same rule), and exposes `/sm/accounts` (+ `POST /sm/accounts/refresh`). The UI readout is `SmAccountBar.tsx`.

## Mac app

`sm app` ([[bin/office-app.js#install]]) installs `~/Applications/AI Office.app` and pins it to the Dock.

The app has no pop-up windows: web links go to the default browser, office links stay in the app, and anything else (`about:blank`) is dropped. Its user agent carries `AIOffice/`, so the page can skip the browser-only "blank pop-up first" trick (OAuth sign-in in `SmRoom.tsx`). The engineering skill `office-integrations` teaches this. Uninstalling never edits the Dock prefs; the owner removes the icon by hand.

The app is a signed bash launcher with the office icon. Tapping it starts the office server only if it is down, then opens the browser with the token; log in `.pixel-office-app.log`. `--no-dock` skips the pin, `--uninstall` removes both. The launcher PATH must include `/usr/sbin` (lsof).

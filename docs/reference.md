# Success Manager (Throngs)

## Install (new machine)
```
git clone <this repo> success-manager && cd success-manager
./install.sh      # checks Node 20+, installs, builds, creates .env, runs `sm doctor`
./start.sh        # opens the app; first launch plays the welcome tour (TOUR button replays it)
```
Needs the Claude Code CLI signed in once (`npm i -g @anthropic-ai/claude-code`, then `claude`). `node bin/sm.js doctor` lists anything missing with the exact fix.

## Firebase backup of your linked services (optional)
Create a Firebase project, enable Firestore, download a service-account key, then:
```
node bin/sm.js firebase link key.json
node bin/sm.js firebase push --passphrase "<8+ chars>"   # AES-256-GCM encrypted before it leaves this machine
node bin/sm.js firebase pull --passphrase "<same>"       # restore on another machine
```
`firebase.json` + `firestore.rules` (deny all browser access) deploy with `firebase deploy --only firestore:rules`.


Keeps a Claude Code session working on a project until it is **actually** done, judged by plain QA scripts, not by Claude.

```
 you / Claude in fuel-app ──works──▶ stops
                                          │  Stop hook
                                          ▼
                     success-manager runs QA commands (build/tests/lint)
                     + reads projects/<name>/TASKS.md
                                          │
              ┌───────── QA red or tasks open ─────────┐   QA green + all tasks ticked
              ▼                                        ▼
   report sent back into the SAME Claude session    session allowed to stop
   → it keeps working                                → macOS notification ✅
```

## Commands
```
sm add <path> [--name n] [--goal "..."] [--qa "cmd"]...   start managing a project (QA auto-detected)
sm status                                                 overview of all projects
sm qa <name>                                              run QA now, print report
sm set-qa <name> "<cmd>" ["<cmd>"...]                      replace QA commands
sm run <name> [--prompt "..."] [-- <claude flags>]         run Claude headless until done
sm pause <name> / sm resume <name>                        toggle supervision
sm remove <name>                                          uninstall hooks from the project
```
`sm` = `node ~/Downloads/Projects/success-manager/bin/sm.js` (add an alias, see below).

## Adding projects
`sm add <path> --beads`, or drop a symlink into `project_inbox/` (`ln -s ~/Downloads/Projects/foo project_inbox/`) —
picked up by `sm ingest`, `sm status` and `sm dispatch`. The full orchestrator spec lives in `SYSTEM_PROMPT.md`.

## Intake → route → dispatch
```
Slack / Calendar / you ──▶ sm task "…" [--project p] [--source slack] [--human]
                              │ auto-routes by project name + `sm keywords`; unclear → INBOX.md (sm triage)
                              ▼
                 project's task list (beads or TASKS.md)
                              ▼
            sm dispatch ──▶ headless Claude in each project with ready work (one run per project)
```
- `--human` tasks (real-device tests, API keys, design calls) are shown but never block "done" and the worker may not close them.
- Run Claude inside this folder to get the **manager agent** (see `CLAUDE.md`): it files tasks from your connectors and dispatches — it never edits project code.
- Worker shell guard also blocks: `bd delete`, `bd close --force`, changing `human`/`src:` labels, touching `sm`/success-manager.
- Per-project `claudeFlags` in config.json = what headless workers may run (e.g. `Bash(xcodebuild:*)`).

## Multi-agent audit (`sm audit`, and automatically inside `sm run`)
Five read-only reviewer Claudes run in parallel — briefs in `agents/*.md` (code, ui, ux, functionality, marketing; edit freely).
They can only Read/Grep/Glob, return structured JSON, and **file tasks** — they never decide pass/fail.
- P0–2 findings → required tasks · P3–4 → `suggestion` (optional, never block) · needs a person → `human`.
- Duplicates of existing tasks are dropped. Cost per audit is logged in `history.log`.
`sm run <name>` = baseline QA → audit → builder Claude (Stop hook keeps it going) → re-audit → … until
**PRODUCTION_READY** (QA green, no required tasks, last audit found nothing new) or **AWAITING_HUMAN_INPUT**.
Limits: `maxAuditRounds` 3, `maxBuilderRuns` 6, `maxFindingsPerAgent` 6, `auditModel` "sonnet" (config.json).

Each project root gets `task_status.json` + `tasks.md` (status, critical_errors, agent_feedback, next_actions) —
git-excluded, regenerated on every stop/audit; an existing hand-written `tasks.md` is never overwritten.

## lat.md (optional, github.com/vercel-labs/lat.md)
If a project has a `lat.md/` knowledge graph: `lat check` is added to QA on `sm add` (deterministic spec↔code check),
auditors treat its specs as the requirements, and the builder is told to keep it updated.
Installed (`lat` 0.13.3). Only active in projects that have a `lat.md/` folder; `lat init` sets one up (it also adds agent hooks/instructions to the repo — run it yourself when you want that).
The office has its own shared brain in `lat.md/` (start at `lat.md/lat.md`). Office missions run `lat check` as part of QA, and workers read the brain before grepping, which keeps their context small.

## Department training (skills)
Each crew member's session loads `office/departments/common` (the shared-brain skill) plus their own room's
skill pack, for example QA gets webapp-testing, property-based-testing and verification-before-completion, and Marketing
gets copywriting and seo-audit. The packs are vetted, licensed skills from obra/superpowers, anthropics/skills,
coreyhaines31/marketingskills and trailofbits/skills. Each folder's `SOURCES.md` records the repo and commit.
The mapping is in `office/departments/README.md`, and the wiring is `pluginDirsFor` in `bin/staff.js`. A hire gets their room's pack automatically.

## The Office — `sm office` (main UI)
A fork of Pixel Agents in `pixel-office/` (MIT, upstream github.com/pixel-agents-hq/pixel-agents), built on top — not replaced:
- **Its office, layout editor, characters and real Claude sessions are untouched.** Our 7 crew (ARES, FORGE, VEGA, LYRA,
  ORION, ATLAS, NOVA) are injected as extra characters through Pixel Agents' own messages: WORKING = sits and types/reads
  with the task in its bubble, BLOCKED = amber "needs you" bubble, IDLE = wanders. Click one (or its card) → inspector.
- **SUCCESS MANAGER dock** (right, collapsible, Pixel Agents style): NEEDS YOU first — every human task explained like
  you're 5 (what / why only you / steps / done when / what to reply) with an answer box (Send to builder · I did it ·
  Just a note) — then Fix first, Builder queue, Optional, Done; TERMINAL tab with level + crew filters.
- Our code: `pixel-office/server/src/sm/smRoutes.ts` (/sm/* behind Pixel Agents' Bearer token, only when SM_ROOT is set),
  `pixel-office/webview-ui/src/sm/*`, plus small hooks in `App.tsx`, `httpServer.ts`, `ToolOverlay.tsx`.
- Rebuild after edits: `sm office --build --restart`. Data comes from `bin/sm-api.js` (shared with `sm dashboard`).
- Human-task explanations live in `projects/<name>/asks.json`; reviewers must return one (`human_ask`), the builder writes an
  `ASK:` note when escalating, and you can set one with `sm ask`.

## Your developer day (dev pulse, morning brief, reminders)
- `sm pulse` — every repo in your projects folder plus GitHub: failing checks, security alerts, PRs that need you, unpushed or uncommitted work, what you committed in the last 24h. Old untouched repos stay quiet (`--all` shows them).
- `sm today` — IVY's morning brief (calendar, needs-you, code, overnight missions, what you shipped). She WhatsApps it every morning at 08:30 (change it on her TODAY tab); `--send` sends it now.
- `sm remind "Call Dana" --at 09:45 [--call]` — she texts (or calls) you on time. Or just say it on the phone: "remind me at 4 to call Dana".
- Missions plan from the repo's real state (branch, uncommitted work, recent commits, CI), and engineers follow the `github-ci-workflow` skill.

## IVY on Telegram (your line to the office)
Link Telegram in the Zoo (bot token + your chat id) and IVY uses it as her main line: she messages you when missions finish or fail and when an agent needs you. Reply to her message to answer that agent (or a report, to ask ARES a follow-up), or just talk to her. If an agent is blocked and you don't answer within 10 minutes, she calls you. `sm telegram --test`, `--escalate <min>`, `--quiet 23:00-07:00`, `--no-call`. The morning brief and reminders go to Telegram too.

## Phone and the secretary (IVY)
You call the office number and **IVY**, the office secretary (read-only crew member), answers. ARES no longer talks on the phone. She keeps it short (one-line greeting, 1-2 sentence answers), remembers the whole call, answers small talk and "what did I miss" instantly, and when you ask for work she files it for ARES herself; "remind me…" goes on her desk.
- **Voice stack** (`phone_stack` in the "sms" integration): `relay` (default) = Twilio ConversationRelay, Deepgram listens, ElevenLabs speaks, replies stream sentence by sentence and Twilio stops talking the moment you cut in. `gather` = fallback, no extra service: Polly Neural voice, one sentence per `<Say>` inside a `<Gather>` so you can still interrupt. It drops to `gather` by itself if `public_url` is not https or the `ws` module is missing.
- **Setup:** existing Twilio keys only; set `public_url` (https tunnel, must allow wss) and point the number's voice webhook to `<public_url>/ares/voice`. Optional fields: `relay_voice`, `relay_tts_provider`, `relay_stt_provider`, `gather_voice`, `secretary_name`. Outbound: `sm call "<text>"` (`--whatsapp` texts instead); `sm call --status` shows the active stack.
- **Call outcomes** (written to `office/calls.json`, newest first):

| Outcome | When |
|---|---|
| `owner-chat` | you only asked questions |
| `request-filed` | you asked for something to be done; IVY filed it for ARES herself |
| `message-taken` | a stranger left a message; they learn nothing about the office |
| `silent` | nobody spoke; asked "still there?" once, then hung up |
| `hung-up-early` | caller left before speaking |
| `error` | answer failed or hit the 25s cap; IVY apologises ("One sec." after 2.5s) |
| `blocked` | no caller id or bad Twilio signature |
| `calling` | an outbound call was dialled and is ringing or in progress (logged at dial time) |
| `delivered` | an outbound call was answered and nobody talked |
| `no-answer` | outbound call rang out or was cancelled (Twilio CallStatus `no-answer` / `canceled`) |
| `busy` | outbound line was busy |
| `failed` | Twilio could not place the call |
| `voicemail` | outbound call reached an answering machine (AnsweredBy `machine_*` / `fax`); IVY hangs up on it |

Each record also keeps `interrupts` (how many times you cut her off) and `lastInterrupted` (the words she had got to). Outbound outcomes come from the `/ares/status` callback, which `sm call` asks Twilio for on every call; they show in the IVY checklist as "You missed our call".

- **Her desk** = the **IVY** tab in the office (AWAY, TASKS, CALLS, KNOWS): a "missed while away" checklist (stranger calls, finished/failed missions, questions for you, due tasks; ticks persist), a callback queue, office tasks, your schedule/facts and contacts (she greets known numbers by name), a "welcome back" briefing and a WhatsApp digest. Data: `office/secretary.json`.
- **Give her a task:** IVY tab → TASKS → add title/detail/due, or POST `/sm/secretary/addTask` (`{title, detail, due}`). She tracks it in the checklist; tick it done there.
- **Not verified:** no real phone call has been placed; all of this is tested by unit tests and the live office API only. Cost is about $0.08/min on relay (Twilio quote; whether ElevenLabs/Deepgram are bundled in it is unconfirmed, check your Twilio bill). IVY greets known numbers by name and answers from her desk (schedule, facts, tasks, briefing); the owner is greeted with the briefing. The digest goes by WhatsApp only (no email/SMS sender).

## Dashboard — `sm dashboard` (older standalone version)
Pixel-art office (Pixel Agents' art, loaded from your `npm i -g pixel-agents` install) with six rooms —
Control Deck, Engineering & Security, UI/UX Design Lab, QA & Logic, Marketing & Copy, Break Lounge — and seven crew:
ARES (orchestrator), FORGE (builder), VEGA/LYRA/ORION/ATLAS/NOVA (code/ui/ux/functionality/marketing reviewers).
Crew walk to their desk when WORKING, wander the lounge when IDLE, stand up with a red "!" when BLOCKED (a human task
of theirs is open). Click a crew member → inspector (live stream, Force Task = real single-agent review, Send to Lounge,
Inspect Code = latest commit / their findings). Click a room to zoom. Right panel: task queue (critical / builder /
awaiting human with an input modal / optional / done) + filterable terminal. Header: project switcher, cost, build
timer, status, Trigger Reviewers (click twice to confirm). `sm watch` opens the stock Pixel Agents app separately.

## Live web apps (playwright-cli, github.com/microsoft/playwright-cli)
`sm preview <name> --url http://localhost:5173 --cmd "npm run dev -- --port 5173" --paths /,/login`
- Adds **web-smoke** to QA (`sm smoke <name>`): starts the dev server if needed, loads each path headless,
  **fails on any console error or 4xx/5xx request**, saves desktop + mobile screenshots to `projects/<name>/browser/`.
- UI / UX / functionality / marketing reviewers get a real browser (`playwright-cli` only, own session each) and
  report what they saw on the running app, not just what the code suggests.
- The playwright-cli skill is installed globally (`~/.claude/skills/playwright-cli`), so builders can use it too.

## Per-project folder: `projects/<name>/`
| File | Who writes it | What |
|---|---|---|
| `TASKS.md` | you + worker Claude | goal, `- [ ]` checklist, log. The only file Claude may edit here. |
| `config.json` | you | project path, QA commands, `maxIterations` (30), `maxSameResult` (3) |
| `LATEST.md`, `reports/` | supervisor | latest + last 50 QA reports |
| `history.log`, `state.json` | supervisor | one line per stop; loop counters |

## Task tracker: markdown or beads
- **markdown (default):** `projects/<name>/TASKS.md` checklist. Done = no `- [ ]` left.
- **beads (`sm add <path> --beads`):** uses [beads](https://beads.gascity.com/) (`bd`, `brew install beads`) inside the project —
  issues with priorities + dependencies that survive context loss. Done = every issue closed.
  Initialised with `--stealth --skip-agents --skip-hooks`, so it writes no CLAUDE.md/AGENTS.md and stays out of the repo's git.
  Add work with `cd <project> && bd create "title" -p 1`. Auto-selected if the project already has `.beads/`.

## Headless runs
`sm run <name>` defaults to `--permission-mode acceptEdits` (edits OK, shell commands denied — QA still runs via the hook).
To let the worker run its own commands too, pass flags after `--`, e.g.
`sm run fuel-app -- --permission-mode acceptEdits --allowedTools "Bash(xcodebuild:*)" "Bash(bd:*)" "Bash(git:*)"`.

## Safety rails
- **Not biased:** the verdict comes from exit codes of the QA commands; Claude is blocked (PreToolUse hook) from editing its own config/reports/hook settings.
- **No infinite loops:** gives up after 30 rounds, or after 3 identical results in a row (stuck) → notification "needs you".
- **Paused = normal Claude.** `sm pause <name>` when you just want to chat in that folder.
- Hooks live in the project's `.claude/settings.local.json` (git-ignored by Claude Code), merged with what's already there; `sm remove` takes them out cleanly.

## Alias
```
echo 'alias sm="node ~/Downloads/Projects/success-manager/bin/sm.js"' >> ~/.zshrc && source ~/.zshrc
```

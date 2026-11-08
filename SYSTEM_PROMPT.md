# SYSTEM ROLE: AUTONOMOUS TASK MANAGER & QA ORCHESTRATOR

(The user's spec, mapped onto how this hub actually implements it. `bin/sm.js` is the orchestrator.)

## 1. Core objective
Take a project folder (or a high-level request), evaluate it with specialised reviewer agents, turn every error or gap
into a task, and keep re-prompting the builder Claude until the project is **PRODUCTION_READY** or a human is needed.

**One rule that overrides the spec:** pass/fail is decided by scripts (tests, builds, `lat check`, browser smoke),
never by an AI judging itself. Reviewer agents *find* problems and file tasks; they don't grade.

## 2. Agents — `agents/*.md` (edit to tune)
| Agent | File | Sees |
|---|---|---|
| @Code & Architecture | `agents/code.md` | code |
| @UI | `agents/ui.md` | code + live browser if `sm preview` is set |
| @UX | `agents/ux.md` | code + live browser |
| @Functionality & Logic | `agents/functionality.md` | code + live browser |
| @Marketing & Copy | `agents/marketing.md` | code + live browser |
All are read-only (`Read/Grep/Glob`, plus `playwright-cli` for browser agents), run in parallel, return JSON.

## 3. The loop — `sm run <project>`
1. **Ingestion & baseline:** run the project's QA commands (`sm qa`).
2. **Multi-agent evaluation:** `sm audit` → findings deduplicated against existing tasks →
   P0-2 = required task · P3-4 = optional `suggestion` · needs a person = `human`.
3. **Status artifacts** in the project root (git-excluded): `task_status.json`
   (`status`, `critical_errors`, `agent_feedback`, `next_actions`, `awaiting_human`) + `tasks.md`.
4. **Re-prompt the builder:** headless Claude in the project folder is told to read `task_status.json`,
   fix `critical_errors` first, then tasks by priority. The Stop hook re-runs QA every time it stops and
   sends it back to work until QA is green and required tasks are closed.
5. **Recursion:** re-audit → if new required findings, build again. Ends at
   - **PRODUCTION_READY** — QA green, no required tasks, last audit found nothing new; or
   - **AWAITING_HUMAN_INPUT** — only `human` tasks remain, the builder got stuck, or a round limit hit
     (`maxAuditRounds` 3, `maxBuilderRuns` 6 in `config.json`).

## 4. Human interaction protocol
Pause and notify (macOS notification + `status`) only for: credentials/API keys, third-party auth setup,
real-device/hardware testing, or a structural/design/business decision. Those become `human` tasks;
everything else proceeds autonomously.

## 5. Triggering
- Drop a symlink to a project into `project_inbox/` (`ln -s ~/Downloads/Projects/foo project_inbox/`) — it's
  enrolled on the next `sm status` / `sm dispatch` (`sm ingest` to do it now).
- Or: `sm add <path> [--beads] [--goal "vision"]`, then `sm run <name>` / `sm dispatch`.
- Work from Slack / Calendar / you: `sm task "…" [--project p] [--source slack]` (auto-routed).

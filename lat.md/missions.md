# Missions

A mission is one owner request handled by the Floor Manager (ARES): plan, delegate, run the team, review against the real diff and QA, report. All of it lives in [[bin/missions.js#createMissions]].

## Funnels and models

Not every request needs a team. A router picks a funnel and a model per request ([[bin/missions.js#FUNNELS]]): the owner's own words first ([[bin/missions.js#ownerRoute]]: `quick:`, `question:`, `team:`, `use opus`), otherwise one cheap Haiku call.

- answer: one read-only call, and the answer is the report. A request that asks for any action is never routed here ([[bin/missions.js#asksForAction]] overrides the router to quick).
- quick: one agent, then the QA script only. No planner, no checker, no manager review.
- solo (the default): one lead agent owns the request end to end, like a person in the CLI. Then the QA script and one combined QA and security check. A fix continues the lead's own session (`resumeFrom`), so nothing is relearned and the cached context is cheap.
- team: the full pipeline described below.

Haiku handles trivial work, Sonnet normal work, and Opus hard work. A job that gets stuck retries on the next stronger model ([[bin/missions.js#nextModel]]). Spending caps follow the funnel ([[bin/missions.js#FUNNEL_BUDGET]]). Every agent also has the caveman skill for terse working output, and full-access projects route shell output through rtk when it is installed.

## Home and workplaces

The office (success-manager) is the team's home. The selected folder is only where the team works on a request; it never becomes the team's home.

Material a project needs (code, docs, videos and their sources, audio, screenshots, scripts, notes) is saved in that project's folder, never in the office. Asked from the office about one other registered project ("a video for /bloom-booking"), the mission works in that project's folder ([[bin/missions.js#createMissions]], `m.workProject`) with that project's QA, access and git history. Its record stays in the office's mission log. Every job's instructions state the rule, and ARES flags project material found in the office (`checkProjectLeaks` in [[bin/watchdog.js#createWatchdog]]). Ideas for a client project are kept with the office's records for it (`projects/<name>/ideas.json`), not in `office/ideas/`.

## Delegation

On a solo mission the lead engineer (FORGE) may split a big job instead of doing it alone. She returns status `split` with a contract, her own part, up to two helper parts and an integration plan ([[bin/missions.js#MAX_HELPERS]]).

Helpers are the general engineers in Engineering besides her: BOLT and FLUX ([[bin/missions.js#helpersFor]]). Every part must own files no other part touches ([[bin/missions.js#splitProblem]]). An unusable split is refused, and she does the whole job in her own session. Accepted parts run side by side: her part continues her session. Then an `integrate` job resumes her latest session with every part's report, and she wires it together, runs everything and uses it. The usual QA check follows. A split raises the solo cap by one `PART_BUDGET` per part. Her personal skill `leading-a-split` (`office/departments/crew-builder/`) says when to split and how to check helpers' work. Covered by the delegation tests in `test/mission-loop.test.js`.

## Planning

Team funnel only. ARES (or SAGE's draft, approved by ARES) returns a plan matching the plan schema: size, `about_office`, and subtasks with assignee, dependencies, `owns_files` and `workdir`.

Small requests get exactly one job. Bigger ones are split by area so several people work at once. Budgets per size are in [[bin/missions.js#BUDGET]]; the default model is [[bin/missions.js#DEFAULT_MODEL]].

## Running the team

Every job is a headless `claude -p` session started by `claudeJSON` inside [[bin/missions.js#createMissions]], with the assignee's department plugins (see [[crew#Department training]]).

Readers run in parallel up to [[bin/missions.js#MAX_PARALLEL_READERS]]. Writers run in parallel up to [[bin/missions.js#MAX_PARALLEL_WRITERS]] when their `owns_files` don't overlap ([[bin/missions.js#ownershipClash]]). [[bin/missions.js#folderLock]] stops two missions writing the same folder.

Each job's activity is streamed to `missions/<id>.<job>.stream.jsonl` for the live feed.

## Change detection

[[bin/missions.js#snapshotAll]] takes a git-tree snapshot before and after; [[bin/missions.js#diffSnapshots]] reports what really changed.

Nested repos are snapshotted on their own, and non-git folders use a shadow repo ([[bin/missions.js#shadowArgs]]). Logs, `.beads/`, `projects/` and other noise are filtered out.

## Hand-off loop

After the team builds, the work goes QA script → QA lead → security engineer; anything rejected becomes a fix job for whoever can fix it, then the loop repeats.

Hand-off checks are ordinary jobs (`kind: 'gate'`, schema [[bin/missions.js#GATE_SCHEMA]]), so they show live in the office. The QA script runs first, so no AI tokens are spent on work that fails its own tests. A failed or crashed job is retried up to [[bin/missions.js#MAX_RETRIES]] times; a job that changed nothing, or left "owner_action_needed", is sent back to do it properly.

ARES's final review is the last stage: anything not done or never tried for real goes in `send_back` (part of [[bin/missions.js#REPORT_SCHEMA]]) and re-enters the loop instead of reaching the owner. QA must use the feature live (office missions: `sm office --browse <name>`); a check it could not do counts as a fail.

The loop ends when security and the final review pass, or after [[bin/missions.js#MAX_FIX_ROUNDS]] fix rounds (`maxFixRounds` in the project config); only then does the report reach the owner's desk. Covered by `test/mission-loop.test.js`.

## Shipping to the screen

Office missions finish live: the last office QA step builds, restarts and live-checks the office, so the QA lead clicks through the new version. A broken build goes back to engineering.

Open office tabs poll `/sm/build` and reload themselves once no office mission is running ([[bin/sm-api.js#createApi]] `officeBusy`). Rebuilds and restarts take turns through a lock (`.office-build.lock`).

## Usage limits

When the owner's plan hits its usage or session limit, every Claude call waits for the reset ([[bin/missions.js#usageLimitUntil]]) and then resumes its session; the mission shows "paused".

With several accounts (claude-swap, `cswap`), [[bin/missions.js#accountRescue]] switches to one with room and the job resumes at once; it only waits when every account is out. METER, the no-AI account watcher crew member ([[bin/cswap-watch.js#createWatcher]]), is the only thing that switches accounts, before a limit is hit; `sm office` starts no other switcher.

Waiting does not count as a failed attempt, and a job that ran out of budget is retried with double the budget.

## Cost limits

Every mission has a hard spending cap ([[bin/missions.js#MISSION_BUDGET]], `missionBudgetUsd`). At the cap it starts no new jobs, skips queued ones and reports.

ARES may send work back once ([[bin/missions.js#MAX_ARES_SENDBACKS]]), never for "verify again" after QA passed it live. "Do it for the owner" jobs are created only for real actions, never for checking ([[bin/missions.js#VERIFY_ONLY]]), and at most once. Only one mission runs per project at a time; later ones queue, and Resume can't start a second runner.

## Queue and Send now

Waiting missions run in the owner's order: `missions/queue.json` (written by [[bin/missions.js#createMissions]] `reorder`), then oldest first. A mission counts as running once it has `dequeuedAt`; `aheadOf` decides who goes first and `waitTurn` waits.

"Send now" (`sendNow`) puts the chosen mission first and the running one second, and posts `preempt` to the running one. Its runner kills its live claude jobs (not failures: each goes back to `answered` with its session id from the stream's init event and continues that session later), waits its turn, then carries on. Planning and the final review are not interrupted; the pause lands at the next work round. The Missions tab shows waiting ones under UP NEXT with drag, ▲▼ and Send now (`MissionQueue` in `SmMissions.tsx`). Covered by the queue and send-now tests in `test/mission-loop.test.js`.

## Videos and meetings

A request to make a video goes to REEL, the video lead ([[bin/missions.js#VIDEO_LEAD]]): the router sets `route.video` (or the owner starts with `video:`), and the solo lead becomes REEL instead of the first engineer.

A job that rendered a video returns its path in the `video` field of [[bin/missions.js#WORK_SCHEMA]]. When the mission finishes (verdict not failed), [[bin/meetings.js#videosFromSubtasks]] picks the real files and the mission calls a conference-room meeting instead of filing the report: `m.meetingId` is set and the report is left off the desk (`state().reports` skips it). See [[office-ui#Conference Room]].

## Questions go to ARES first

A teammate's question is triaged by ARES ([[bin/missions.js#TRIAGE_SCHEMA]]), who answers it from the request and code unless only the owner can (keys, money, devices, open product calls).

ARES answers up to [[bin/missions.js#MAX_TRIAGE]] questions per job; after that, or for owner-only questions, the owner is asked as before.

The owner is not a test harness. After [[bin/missions.js#DIAGNOSE_AFTER]] owner answers on one job, the next question is held back: ARES tells the teammate to find the cause from its own side (logs, probing the provider, screenshots) and ask again only with evidence. At [[bin/missions.js#MAX_OWNER_ASKS]] the job stops and the report says what is still needed. This came from a mission that asked the owner to retry Google sign-in five times without reading Google's error.

## Review and honesty

The final review sees the real diff and the QA output and fills [[bin/missions.js#REPORT_SCHEMA]].

Missions about the office run [[bin/missions.js#OFFICE_QA]] instead of the project's QA. A mission cannot report success if write jobs changed nothing or the owner still has steps left. Office missions that touched `bin/` or `pixel-office/` trigger a rebuild and restart.

## Questions and access

A worker that needs the owner returns `needs_human` with a question explained like to a five-year-old ([[bin/missions.js#ASK_SCHEMA]]).

Full access (bypass permissions) is asked once per project and then remembered. Owner replies to a finished mission go to FORGE as a follow-up ([[bin/missions.js#REPLY_SCHEMA]]).

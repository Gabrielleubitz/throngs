# Crew

Who works in the office: rooms, people and their training. The roster lives in `office/staff.json`, created and migrated by [[bin/staff.js#createStaff]].

## Rooms and staff

Rooms are departments with a brief ([[bin/staff.js#DEFAULT_ROOMS]]); people have real job titles ([[bin/staff.js#DEFAULT_STAFF]]).

Management (ARES, SAGE, MUSE) plans and approves and is never assigned jobs; only management may sit in restricted rooms ([[bin/staff.js#isManagement]]). METER (kind `watcher`, Engineering desk) does no AI: his bubble shows the live cswap usage and account switches ([[bin/cswap-watch.js#describe]]), and missions never assign him jobs. REEL (`video`, Video Producer, Marketing room, kind `engineer`) is in charge of every video: video requests are routed to him and he renders them with Remotion (`remotion-video` skill). FOLIO (`pdf`, PDF Designer, Design Lab, kind `engineer`, locked so he cannot be let go) is in charge of every PDF: requests (or a `pdf:` prefix) are routed to him, he builds them with the `pdf-design` skill (HTML printed by headless Chrome; the GitHub anthropics/skills `pdf` skill sits beside it) and a finished PDF becomes a conference-room meeting. REEL also carries a personal pack (`office/departments/crew-video/`): a `video-types` index plus 14 one-per-type skills (promo, demo, explainer, social short, ad, launch, tutorial, testimonial, data story, logo intro, kinetic typography, slideshow, audiogram, event teaser); when the type is unclear he returns `needs_human` with a numbered list of likely types instead of guessing. GAUGE (`growth`, Growth & Analytics Lead, Marketing room) and DECK (`docs`, Documents & Slides Producer, Design Lab) are engineers with a personal skill pack on top of their room's (`office/departments/crew-<id>/`: GAUGE gets analytics, A/B testing, pricing, retention, outreach; DECK gets docx, pptx, xlsx). IVY (`secretary`, Office Secretary, Reception, read-only) answers the phone and keeps the call records and the office checklist; her personal pack is `crew-secretary` (`phone-desk`, `office-checklist`). Her contacts can be bulk-imported from the WhatsApp assistant project's `contacts.json` ([[bin/secretary.js#createSecretary]] `importContacts`, the Secretary tab's "Import WhatsApp contacts" button), and her phone prompt includes the next 14 days of the linked Google Calendar and recent Drive file names ([[bin/ivy-google.js#createIvyGoogle]], read-only, cached 5 min). Engineering also carries `github-ci-workflow` (in-house): read the repo's real git/GitHub state before changing anything, find and fix a red check at its cause (`gh run view --log-failed`, the commit `status` API for Vercel, reproduce with the local build), stage only your own files, never push unless `allowPush`. BOLT and FLUX (`bolt`, `flux`, Software Engineers, Engineering) are FORGE's helpers: they build the parts she delegates. FORGE carries a personal pack too (`crew-builder`: `leading-a-split`). Everyone carries `owner-toolbox` (common). It lists what is signed in on the Mac and which account each project uses, says to diagnose before asking the owner, says when to open a sign-in with `sm terminal`, and lists what agents must never do (keys, account switching, Mac settings, other people's processes). QA carries `owner-eye-check`: judge work in the owner's surface and accounts, with the misses that reached the owner before. New default crew (management, METER, REEL, FOLIO, GAUGE, DECK, BOLT, FLUX) are merged into older rosters on load.

## Department training

Each department is a Claude Code plugin folder under `office/departments/<room>/` holding vetted skills from GitHub, with sources and licenses recorded there.

[[bin/staff.js#pluginDirsFor]] turns a room into `--plugin-dir` flags: the `common` shared-brain skill for everyone plus the room's own skills. [[bin/staff.js#trainingFor]] adds one line to the person's prompt naming those skills.

| Room | Skills |
|---|---|
| control | writing-plans, dispatching-parallel-agents, executing-plans, subagent-driven-development, brainstorming, requesting-code-review, verification-before-completion, doc-coauthoring, internal-comms, office-supervisor |
| engineering | test-driven-development, systematic-debugging, verification-before-completion, receiving/requesting-code-review, differential-review, sharp-edges, variant-analysis, supply-chain-risk-auditor, audit-context-building, post-patch-validation, finishing-a-development-branch, using-git-worktrees, mcp-builder, claude-api |
| qa | verification-before-completion, systematic-debugging, test-driven-development, requesting-code-review, webapp-testing, property-based-testing, spec-to-code-compliance, mutation-testing, regression hunting (3), variant-analysis, post-patch-validation |
| design | frontend-design, onboarding, pdf, pdf-design, brand-guidelines, theme-factory, web-artifacts-builder, webapp-testing |
| marketing | copywriting, copy-editing, seo-audit, ai-seo, onboarding, remotion-video, cro, content-strategy, marketing-psychology, product-marketing, social, launch, emails, ad-creative, pricing, schema, competitors |

## ARES's watch

The floor manager supervises the office with plain-script checks ([[bin/watchdog.js#createWatchdog]]). They run after every mission, every 10 minutes from the office server, from `sm ares`, and from the Health tab's "Check now" button.

The checks cover duplicate or dead mission runners, stray office servers and stale builds, clone characters, uncommitted work (both repos), the office token written into files, and flow bugs: fix rounds that changed nothing (flaky checks), repeated guard blocks, UI changes nobody opened, and missions near their cap. Safe fixes are applied: stopping stray office servers and duplicate runners, and marking dead missions stalled. Everything else is reported in the Health tab and in ARES's status. His `office-supervisor` skill (Control department) describes how to supervise like the lead engineer.

## Error log and learning box

TRACE (`errorlog`, kind `watcher`, no AI) logs every office error ([[bin/errorlog.js#createErrorLog]]); the learning box keeps lessons for next time ([[bin/learning.js#createLearning]]).

TRACE records failed or stalled missions, ARES's critical watch findings, office-server crashes, 5xx request failures and UI-reported errors in `office/errors.json` (repeats merge, keys are scrubbed) and tells ARES in his status bubble. ARES starts no fix until the owner presses "Approve fix" in the HEALTH tab (or `sm errors --approve <id>`): that opens a mission for ARES with the error as the request; when it finishes the error becomes fixed and a lesson is saved. Lessons live in `office/learnings.json` (HEALTH tab, `sm learn`); the newest are written into every AI teammate's prompt by [[bin/staff.js#createStaff]], and engineers and ARES are told to save reusable lessons themselves. Automatic: a fixed error becomes a lesson, and rule-like sentences in the owner's mission prompts ("always…", "never…", "from now on…") are saved as `prompt` lessons ([[bin/learning.js#createLearning]]). Not automatic: other info the owner shares (use Teach or `sm learn`). UI errors reach TRACE through window error and unhandled-rejection handlers in `smClient.ts` (capped, de-duplicated).

## Ideas

MUSE keeps five ideas per project per department tab ([[bin/ideas.js#CATEGORIES]]) in `office/ideas/<project>.json` ([[bin/ideas.js#createIdeas]]) and never refills them on its own.

"Fresh ideas" starts one short, read-only background pass (`sm ideas-fresh`, Sonnet, low effort, [[bin/ideas.js#FRESH_BUDGET_USD]] cap). Each tab's pass borrows that department's skill pack (the Security tab uses engineering's security skills) and replaces only that tab. A pass that dies is reported as an error, never left on "thinking".

## Wellbeing (ported from jarvis-notch)

[[bin/wellbeing.js#createWellbeing]]: keep-awake and break nudges.

`sm awake on [--hours n]` runs a detached `caffeinate -d -i` so long missions survive the Mac idling (pid in `office/awake.json`); `sm breaks on` makes IVY send a 20-20-20 break nudge at most every N minutes inside work hours (default off, 60 min, 9-18; `office/wellbeing.json`). IVY toggles both from chat/phone (`action=wellbeing` in [[bin/ares-chat.js]]) and the office shows them in IVY's Today tab (`/sm/wellbeing*` routes); nothing is switched on unless the owner asks. The nudge is sent from the IVY tick in [[bin/sm-api.js]] through the same notify path as reminders.

## Toolbelt (ported from jarvis-notch)

[[bin/toolbelt.js#createToolbelt]] holds the everyday utilities ported from jarvis-notch.

Portable without Swift: `sm convert` (open.er-api.com), `sm weather` (open-meteo, same source as jarvis), `sm shelf` (files copied to `office/shelf`), `sm clip` (pbpaste history, `office/clipboard.json`), `sm cal` (Apple Calendar via osascript; slow, ~30s with many calendars) and `sm jarvis mail|tracking` (Gmail today and tracked packages from the whatsapp-mcp-ai daemon on :3847).

jarvis-notch has no `.env`. Its secret lives in `../whatsapp-mcp-ai/.env` as `WHATSAPP_SERVICE_SECRET`; `sm jarvis link` copies only that one value plus `PUBLIC_SERVICE_URL` into `office/jarvis.json` (mode 0600, gitignored). The daemon's other keys (OpenAI, Google, ElevenLabs) are never copied. All personal state files are gitignored.

IVY can run weather, convert, mail, tracking and calendar from chat or phone (`action=lookup` in [[bin/ares-chat.js]], answered from live data in [[bin/sm-api.js]]), and the Today tab's GLANCE block (`GET /sm/glance`) shows weather, mail and tracked packages.

Not ported: the Swift notch UI, Now Playing, window snapping, Bluetooth notices and the Accessibility controller (Mac-app only), and the daemon's WhatsApp auto-reply/AI features (the office has IVY).

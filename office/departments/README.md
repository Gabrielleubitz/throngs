# Department training (skills)

Each office department is a Claude Code plugin folder. Every crew member's headless session is started
with `--plugin-dir common` plus `--plugin-dir <their department>`, so they get the shared-brain skill
and their department's playbooks, and nothing else. Wiring: `bin/staff.js#pluginDirsFor`.

| Room (id) | Department plugin | Skills | Who uses it |
|---|---|---|---|
| all | `common/` | shared-brain (lat.md), caveman (terse working output) | everyone |
| control | `control/` | office-supervisor, writing-plans, dispatching-parallel-agents, verification-before-completion | ARES (plans + final review), SAGE, MUSE |
| engineering | `engineering/` | test-driven-development, systematic-debugging, verification-before-completion, receiving-code-review, differential-review, sharp-edges | FORGE, VEGA, hired engineers |
| qa | `qa/` | verification-before-completion, systematic-debugging, webapp-testing, property-based-testing, spec-to-code-compliance | ATLAS |
| design | `design/` | frontend-design, onboarding | LYRA, ORION |
| marketing | `marketing/` | copywriting, copy-editing, seo-audit, onboarding | NOVA |

Personal packs (`crew-<id>/`, wired by `pluginDirsFor`) sit on top of the room's: GAUGE (`crew-growth`), DECK (`crew-docs`) and REEL (`crew-video`: video-types index + one skill per video type, written in-house).

Skills were vendored unmodified from reviewed, licensed sources. See each folder's `SOURCES.md` (repo + commit)
and `LICENSES/`: obra/superpowers (MIT), anthropics/skills (Apache-2.0, `LICENSE.txt` inside each skill),
coreyhaines31/marketingskills (MIT), trailofbits/skills (CC-BY-SA-4.0).
Vercel's agent-skills repo was considered and left out because it has no license.

To update a skill, re-copy it from the same repo and bump the commit in `SOURCES.md`. Don't edit vendored skills in place.


> Not included in the open-source copy: Anthropic's proprietary document skills (`crew-docs/skills/{docx,pptx,xlsx}`, `design/skills/pdf`). Copy them from github.com/anthropics/skills if you want them.

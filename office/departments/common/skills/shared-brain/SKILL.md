---
name: shared-brain
description: Use at the START of every office job and before any Grep/Glob sweep. The project's shared brain (a lat.md knowledge graph) tells you where things live and why, so you read 2-3 files instead of 30. Also use at the END of a job that changed behaviour, to keep the brain true.
---

# Shared brain (lat.md)

The office crew shares one memory per project: the `lat.md/` folder. It is a small set of
markdown sections, cross-linked with `[[wiki-links]]` that point at other sections and at real
code symbols (`[[bin/missions.js#createMissions]]`). Using it first is the cheapest way to get
context — every token you don't spend re-discovering the codebase is budget left for the job.

## Before you touch code (always)

1. If there is no `lat.md/` folder in the project root, skip this skill — work normally.
2. `lat locate "<topic>"` — find the section for the area your job names (fuzzy match is fine).
3. `lat section "<id>"` — read it. It shows the section, what it links to, and what links to it.
   Follow at most 2 links. Those links name the exact files/functions to open.
4. Open only the files the brain pointed you to. Fall back to Grep/Glob only when the brain has
   no section for your topic (and then add one at the end — see below).

`lat search "<question>"` is semantic search; it needs an API key. If it errors, don't retry —
use `lat locate` instead.

Without Bash access (read-only reviewers): `Read lat.md/<file>.md` directly — start from
`lat.md/lat.md` (the index) and follow the links by hand.

## After a job that changed behaviour (writers only)

- Update the matching section in `lat.md/` in the SAME change: describe what the code does now
  (a snapshot, not a changelog). New module or concept → add a section with a leading paragraph
  of ≤250 characters and `[[file#symbol]]` links to the code that implements it.
- Run `lat check`. It must pass — it is part of the office QA script, so a broken link fails
  your job just like a failing test.
- Never write plans, TODOs, or "I changed X today" notes into `lat.md/`.

## Why this matters

- The QA gate runs `lat check`, so stale links are caught automatically.
- Teammates working in parallel read the same brain, so they agree on where things live.
- Missions are billed against the owner's usage limits; reading 3 targeted files instead of
  sweeping the repo is the single biggest saving available to you.

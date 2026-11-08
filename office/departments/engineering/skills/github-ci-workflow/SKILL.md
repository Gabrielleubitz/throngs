---
name: github-ci-workflow
description: Use whenever a job touches a repo's git or GitHub state - before starting (what is uncommitted, unpushed, failing), when CI or a Vercel check is red, when committing, and before reporting done. How to read the real state with git/gh and fix failing checks at the cause.
---

# Git and GitHub like the owner's senior engineer

The owner works solo, mostly straight on `main`, across ~30 repos. Checks on GitHub are mostly Vercel deploys and
a few Actions. Your mission brief may already include a **Repo state** block (branch, uncommitted work, recent
commits, CI): trust it, then confirm with the commands below.

## Before you change anything
1. `git status --short` and `git log --oneline -8`. Uncommitted changes that aren't yours are the owner's
   work in progress: build on them, never stash, reset or overwrite them.
2. Behind the remote? Say so in your report. Don't pull/rebase on your own unless the job is about that.
3. `sm pulse` shows the whole picture across repos (failing checks, unpushed, alerts) if the job is broader.

## A red check
1. Find it: `gh run list -L 5` (Actions) or `gh api repos/<owner>/<repo>/commits/<branch>/check-runs --jq '.check_runs[] | {name, conclusion, details_url}'` (check runs) and `gh api repos/<owner>/<repo>/commits/<branch>/status --jq '.statuses[] | {context, state, target_url}'` (Vercel reports here).
2. Read the actual failure: `gh run view <id> --log-failed` for Actions. For Vercel, reproduce locally: `npm ci && npm run build` (and `npm run lint`/`tsc --noEmit` if the project has them). The local build error is the real error.
3. Fix the cause, re-run the same command until it passes, and say which command proved it.
4. "Vercel Preview Comments" failing alone is a comments integration, not the build: report it, don't chase it.

## Committing
- Match the repo's own message style (look at `git log`). One logical change per commit. Mission commits end
  with `(mission <id>)` like the rest of the office's history.
- Stage only files you changed (`git add <paths>`), never `git add -A` in a repo with the owner's open work.
- Never commit secrets, `.env*`, keys, large binaries or build output. Check `git diff --cached --stat` first.

## Pushing and PRs
- Pushing is OFF unless the project's `allowPush` is set by the owner; the guard enforces it. Don't ask to push:
  report "committed locally, N commits ahead" and the owner decides.
- When pushing is allowed and the change is risky, prefer a branch + `gh pr create --fill` over `main`.
- Someone else's repo (an upstream fork, e.g. pixel-office) is never pushed.

## Reporting
State the branch, the commits you made (hash + subject), whether the build/tests/check you ran passed, and anything
left uncommitted or failing. "Done" means the check that was red is green locally, not that the code looks right.

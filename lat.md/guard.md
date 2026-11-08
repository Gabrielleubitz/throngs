# Guard

The PreToolUse policy in [[bin/sm.js#hookGuard]]. It only polices sessions the office started (`SM_ROLE` set); the owner's own interactive sessions are never policed.

## Roles

`SM_ROLE` tells the hooks who is running.

- `auditor`: reviewers, planners and MUSE. Hooks ignore it; it is read-only through tool flags.
- `mission`: a mission writer. The Stop hook runs QA only.
- `builder`: `sm run` builders.

## What is always blocked

Workers may never touch the owner's work in progress, QA config, mission records, or destructive git (push, stash, reset, clean, rebase).

## Office missions

`SM_OFFICE_MISSION` marks a job working on the office itself. It may run `sm` read commands, `sm office --check` and the sanctioned `--restart`, but not raw server launches or kills.

They open the live office in a browser with `sm office --browse <session>`, which keeps the login token out of logs. With full access a project also allows rebase, restore and force-closing issues. Pushes are checked by [[bin/sm.js#pushVerdict]]: only the selected folder's repo (or a repo inside it), only to that repo's own remote, never forced. Other repos need the owner to name them in the request, or to list them in `pushRepos`. `sm set <project> allowPush false` turns pushing off. Stash, clean and hard reset stay blocked, because they wipe the owner's uncommitted work. Covered by `test/guard-commands.test.js`. Firebase CLI calls are checked by [[bin/sm.js#firebaseVerdict]]: a project with `firebaseAccount` (`sm set <project> firebaseAccount <email>`) must pass `--account <it>` on every call, because the CLI's default login may belong to another client (missions once used the bloom-booking login for the office). Signing the CLI in or out stays the owner's. The office uses owner@example.com. Covered by `test/guard-firebase.test.js`.

Workers in any project may call two office tools, unchained: `sm voiceover` and `sm terminal` ([[bin/sm.js#OWNER_TOOLS]]). `sm terminal "<sign-in>"` opens Terminal.app with an interactive login for the owner, limited to sign-in commands ([[bin/sm.js#LOGIN_CMD]]), so it can't run anything past the guard.

When the selected project is the office itself, every mission there counts as an office mission, flags or not. Earlier, missions started from the success-manager project were refused every edit.

`SM_OFFICE_EDIT` is set only for office writers, and only they may edit `bin/`, `test/` and `pixel-office/`. Path rules are covered by `test/guard-paths.test.js`.

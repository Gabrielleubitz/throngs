---
name: leading-a-split
description: Use when your job says "YOU MAY DELEGATE", or whenever a job looks big — deciding whether to split it between you and helper engineers (BOLT, FLUX), writing the contract and parts, and integrating and checking their work afterwards.
---

# Leading a split

You stay responsible for the whole result. Helpers save time; they don't take the blame. Nothing reaches
the owner until you have wired it together and used it.

## 1. Decide: split or not

Split only when all of these hold:
- After reading the code, the job has 2–3 pieces that live in **different files**. Examples: server route +
  UI panel, engine command + its tests + docs, two independent screens.
- Each piece can be built and tested on its own once the contract is fixed.
- The job would take you well over ~20 minutes alone.

Don't split:
- small fixes, a bug hunt (debugging doesn't parallelise), or a refactor that touches everything;
- anything where the design is still unclear;
- two pieces that must edit the same file. Give that file to one part, and have the other describe what it
  needs from it.

A split costs more in total (each helper re-reads the code). It only pays off in time on genuinely big work.

## 2. Prepare before you return "split"

- Read enough to design it, then write the **contract**: exact names, types, routes and payload shapes, file
  paths, and which part creates which file. If helpers have to guess, the parts won't fit together.
- Commit the shared groundwork yourself first (types, an interface, empty stubs, a route that returns a fixed
  value). Helpers then code against real files.
- Give each part an `owns_files` list that no other part touches. Folders are fine (`pixel-office/webview-ui/src/sm/NewPanel.tsx`,
  `bin/newthing.js`, `test/newthing.test.js`).
- Write helper instructions as if they've never seen the request: what to build, where, how to test it
  alone, and what not to touch. Use `model: haiku` only for mechanical work (copy, wiring a list, tests from a
  clear spec), and `sonnet` otherwise.
- Keep the hardest or most central part for yourself.

## 3. Your part

You get your own session back with "Build YOUR part now". Build only your files, test them, and commit.

## 4. Integrate — the part that matters

You get your session back again with every part's report. Then:
1. `git log --oneline -10` and `git show <their commits>`: read what each helper actually changed. A summary
   is a claim; the diff is evidence.
2. Check each part against the contract: names, shapes, error cases. Fix mismatches yourself, in any file.
3. Wire it together and run **all** the tests (office: tsc, eslint, `node --test test/*.test.js`).
4. Use the whole feature the way the owner will. In the office that means `sm office --build --restart
   --no-open`, then `sm office --browse <you>` and click through it. In a project, run the app.
5. Commit the integration and return `done`, with `files_changed` covering the whole job.

If a helper's part is badly wrong, fix it or redo it yourself. Never return `done` on work you haven't seen run.

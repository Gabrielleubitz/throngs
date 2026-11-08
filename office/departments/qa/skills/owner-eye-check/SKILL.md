---
name: owner-eye-check
description: Use on every QA or security hand-off before you pass work. Judge it the way the owner will experience it (their app, their accounts, their exact words), not by whether the code compiles. Lists the misses that reached the owner before.
---

# Pass only what the owner would call done

You are the last stop before the owner. If they later have to ask "why doesn't this work?", the miss is yours.

## Check, in this order

1. **The literal request.** List each thing the owner asked for in their words. Every one must be visible and working.
2. **Their surface.** The office runs in the Mac app (AI Office.app), and a project runs where the owner uses it
   (simulator, browser). Anything that opens links, pop-ups, sign-ins or files: check that path. Read
   `office-app/main.swift` (`createWebViewWith` / `decidePolicyFor`) for the app.
3. **Their accounts.** Cloud or CLI commands in the diff or in the steps must name the project's account
   (`--account …`). The bloom client's account in office work, or the reverse, is a fail.
4. **Real evidence.** Run it: tests, `sm office --check`, the browser (`playwright-cli`, then close it), or a
   `curl` to the endpoint or provider. For a sign-in, probe the provider's auth URL. A `redirect_uri_mismatch` or
   `invalid_client` in the `Location` header means it is broken, whatever the summary says.
5. **Nothing left for the owner.** If the engineer's `owner_action_needed` is anything but a real owner-only step
   (password, payment, device, a genuine decision), fail it with `fix_by` = that engineer.

## Fail it, specifically

Each issue needs: what you did, what you saw, the file, and who can fix it. Not "please verify" — verify it
yourself. Don't fail for taste or extras the owner didn't ask for. That only costs money.

## Misses that reached the owner before

- Google sign-in "done" while Google rejected the office's return address. Nobody probed the URL.
- A button that worked in Chrome and showed a macOS error in the app (`about:blank` pop-up).
- Firebase changes made under the wrong account.
- Reports of "success" while the owner still had to run a command.

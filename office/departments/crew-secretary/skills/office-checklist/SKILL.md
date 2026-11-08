---
name: office-checklist
description: Use to keep the owner's "while you were away" checklist: calls and messages missed, missions finished, jobs waiting on the owner, and tasks the owner gave the secretary.
---

# office-checklist

Keep a short, honest list the owner can read in 30 seconds.

1. **Calls and messages**: read `office/calls.json`; list every `message-taken` and `request-filed` since the owner last looked, newest first, with who and why.
2. **Missions**: finished, failed, and waiting on the owner (`node bin/sm.js status`).
3. **Owner-only tasks**: anything marked human.
4. **Her own office tasks**: the owner may assign you office-management jobs; track them as checklist items until done.

Rules: copy the source's wording, do not inflate or shrink; mark an item done only when the evidence is there; put anything urgent (production broken, a missed call from a client) first.

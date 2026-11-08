---
name: product-demo
description: Use for a product demo or walkthrough: showing the real product doing the job.
---

# Product demo

Goal: the viewer understands what to click and why it is worth it. Structure: the problem in one line -> the product's one core flow in 3-5 steps -> result -> call to action.
- Use REAL screenshots or a screen recording (playwright-cli screenshots at 1920x1080, or ffmpeg-trimmed recording) placed in `public/`. Never fake UI.
- Zoom (scale + translate with spring) onto the part being discussed; add a cursor and click ripple; caption each step in 6 words or fewer.
- Narration optional (ElevenLabs voiceover) timed to the steps.
Build it with the remotion-video skill (setup, render, ffprobe check, hand back the .mp4 path in the "video" field).

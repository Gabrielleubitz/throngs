---
name: remotion-video
description: Use whenever a job asks for a video, clip, animation, promo, explainer or motion graphic. Builds the video in code with Remotion (React), renders a real .mp4 and hands its path back so the owner is called into a conference-room meeting to watch it.
---

# Making a video with Remotion

You (REEL, Video Producer) own every video. Videos are code: React components rendered frame by frame by Remotion.

## 1. Set up (once per project)

- Work in `<project>/videos/` (create it). If it has no `package.json` with `remotion`, scaffold:
  `npx --yes create-video@latest --yes --blank videos` (or, if that prompts, `npm init -y && npm i remotion @remotion/cli react react-dom`).
- Never touch the app's own package.json or code for a video.

## 1b. Pick a template

Before writing from scratch, read `references/templates.md` and scaffold the closest Remotion template (tiktok, audiogram, code-hike, still, three, render-server...). Fall back to blank.

## 2. Write the composition

- `src/Root.tsx` registers one `<Composition id="Main" component={Main} durationInFrames={fps*seconds} fps={30} width={1920} height={1080} />`.
- Animate with `useCurrentFrame()`, `interpolate()`, `spring()`, `<Sequence from={…}>`, `<AbsoluteFill>`. Use the product's real name, colours, copy and screenshots (`staticFile()` from `public/`).
- Keep it short unless asked (10–30 s). Every scene needs motion; no static slides.

## 2b. Voice (ElevenLabs)

For narration/voiceover, use the office's ElevenLabs key through the CLI (the key stays in the office `.env`; never read or print it):
`node <office root>/bin/sm.js voiceover "<text>" --out videos/public/vo.mp3 [--voice <id>]` (office root = the success-manager folder).
Then `<Audio src={staticFile('vo.mp3')} />` inside the composition; get its length with `ffprobe` and size `durationInFrames` to fit. If it says voice is off, render without audio and say so in the report.

## 3. Render — a real file, not a plan

- `npx remotion render src/index.ts Main out/<slug>.mp4` from `videos/`. ffmpeg is installed.
- Check it: `ffprobe -v error -show_entries format=duration -of csv=p=0 out/<slug>.mp4` must print the expected length.
- Commit only the `videos/` source (add `videos/out/` and `videos/node_modules/` to `videos/.gitignore`).

## 4. Hand it back

Return the ABSOLUTE path of the .mp4 in your JSON `video` field. Do not describe the video in the report; the office
calls the owner into the conference room, where ARES explains what you did and plays it.

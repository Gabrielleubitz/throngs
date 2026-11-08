# Remotion template catalogue (source: remotion.dev/templates, checked 2026-10-28)

Pick the closest template, scaffold it with `npx create-video@latest` (choose it in the prompt) instead of starting blank.
Each page: `https://www.remotion.dev/templates/<slug>`. Repo/command not verified per template: open the page first.

## Match the job to a template

| Job looks like | Slug | Notes |
|---|---|---|
| Generic promo, explainer, anything unclear | `blank` / `hello-world` | default; hello-world shows animation basics |
| Social clip with word-by-word captions | `tiktok` | vertical 1080x1920; feed it a transcript |
| Podcast / voice clip with waveform | `audiogram` | needs audio + captions |
| Music or sound-reactive visuals | `music-visualization` | audio-driven |
| Code walkthrough, dev tutorial | `code-hike` | animated code |
| "Thanks for N stars" repo celebration | `stargazer` | GitHub repo stats |
| 3D product or logo spin | `three` | React Three Fiber |
| Story from a text prompt (images + voiceover) | `prompt-to-video` | needs AI keys: ask owner |
| AI-generated motion graphics | `prompt-to-motion-graphics` | SaaS starter, needs AI keys |
| Thumbnails / OG images / posters | `still` | PNG/JPEG via `renderStill` |
| Overlays for an editor (lower thirds, titles) | `overlay` | for use in other editing software |
| Many videos from data (per-customer, per-booking) | `render-server` | Express render API |
| Video feature inside a web app | `next`, `react-router`, `vercel` | SaaS starters |
| Desktop render tool | `electron` | |
| Reusable component library | `element-library` | |
| Custom shaders / canvas drawing | `skia` | React Native Skia |
| Record and edit talking-head video | `recorder` | browser-based |

Paid (need owner approval, never buy): Editor Starter, Watercolor Map, Timeline (remotion.pro).

## Ideas for this team (bloom-booking and future projects)
- Booking promo, 15s vertical: `tiktok` layout + real app screenshots.
- Per-appointment confirmation clip: `render-server` with customer name as input props.
- Social proof / launch announcement: `blank` with spring-animated stat cards.
- Treatment explainer with voiceover: `prompt-to-video` (ask owner for keys first).
- Share cards for each service: `still`.

## Rules
- Real brand colours, name and copy only. No stock claims about health outcomes.
- Props-driven compositions (`defaultProps` + zod schema) so one template renders many variants.
- Render a real mp4 and verify with ffprobe before handing back.

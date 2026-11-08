---
name: audiogram
description: Use to turn a podcast or audio clip into a shareable video with waveform and captions.
---

# Audiogram

Input: an audio file (trim with `ffmpeg -ss <start> -t <len>`). Composition: cover art or host photo, animated waveform from @remotion/media-utils (visualizeAudio), captions word-synced, show name and episode title, call to action at the end. 1:1 or 9:16, 15-60 s.
- Transcribe for captions only if a transcript is supplied or a local tool exists; otherwise ask the owner for the text. Size durationInFrames from `ffprobe`.
Build it with the remotion-video skill (setup, render, ffprobe check, hand back the .mp4 path in the "video" field).

---
name: photo-slideshow
description: Use for slideshows, recaps, memories and image-led videos from supplied photos or screenshots.
---

# Photo slideshow

Use only the supplied images (copy to `public/`, check size with `sips -g pixelWidth`). 3-5 s per image, Ken Burns (slow scale + pan) on each, cross-fade or slide transitions via @remotion/transitions, caption per image, opening title and closing card.
- Keep order as given unless told. Match the length to the music or voiceover if there is one.
Build it with the remotion-video skill (setup, render, ffprobe check, hand back the .mp4 path in the "video" field).

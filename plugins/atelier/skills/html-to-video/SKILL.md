---
name: html-to-video
description: Record any HTML page or URL as MP4 (H.264) or WebM (VP9) at configurable resolution and frame rate via headless Playwright + ffmpeg, with optional first-frame JPG poster. Use for marketing trailers, tutorial screencasts (e.g. from a local dev server), video for docs/changelogs/social posts, archiving an animated page, or demo GIFs.
---

Requires Node >= 20, Playwright Chromium (via `npm install`), ffmpeg on PATH (`brew install ffmpeg`, `apt install ffmpeg`, or ffmpeg.org on Windows).

## Run

```js
import { recordHtml } from './plugins/atelier/skills/html-to-video/index.mjs';
await recordHtml({ url: 'http://localhost:5173/trailer.html', duration: 10, width: 1920, height: 1080, fps: 30, outPath: 'dist/trailer.mp4' });
await recordHtml({ url, outPath: 'dist/demo.webm', format: 'webm', poster: true }); // also writes dist/demo-poster.jpg
```

```bash
node plugins/atelier/skills/html-to-video/index.mjs <url> <out.mp4|out.webm> [durationSec=5]   # format from extension
```

Options:
- `url`: page URL or `file://` URL (local file: `pathToFileURL(path).href`)
- `outPath`: `.mp4` or `.webm`
- `duration` 5 (s), `width` 1280, `height` 720, `fps` 30
- `format`: `'mp4'|'webm'`, default from extension
- `poster`: default `false`; exports first frame as `<name>-poster.jpg`
- `audioSource`: see below

Codecs: MP4 H.264 libx264 `-preset medium -crf 20 -pix_fmt yuv420p`; WebM VP9 libvpx-vp9 `-b:v 2M -pix_fmt yuv420p`.

## Audio capture

Output is silent by default (identical to v0.1). Pass `audioSource: async (outWavPath) => {…}`; it receives an absolute path inside the skill's temp dir, must write a WAV there (48kHz 16-bit PCM mono/stereo recommended) and resolve. `recordHtml` muxes it before returning.
- Missing file or ≤ 44 bytes (WAV header only) throws `audioSource wrote an empty or missing file: <path>`.
- Video is stream-copied (`-c:v copy`), not re-encoded. Audio is re-encoded to `aac -b:a 192k` (MP4) or `libopus -b:a 160k` (WebM).

Never capture Web Audio in headless Chromium (`AudioContext → MediaStreamDestination → MediaRecorder`). The TideWane trailer pipeline prototyped and abandoned it:
- Audio drifts 10-50 ms/min against video even with frame-locked screenshot capture; cut-to-SFX timing is visibly wrong.
- Headless `MediaRecorder` silently emits zeros on some Chromium versions, with no failure signal.
- CI worker-thread jitter makes the drift non-deterministic; output can also glitch.

Synthesize in pure Node instead (OfflineAudioContext polyfill or hand-rolled synth); the browser pass produces video only. Atelier ships no synth library; the caller owns it. References: `tidewane-build/scripts/trailers/render-*-audio.mjs` (hand-written percussive sequencing, 48 kHz PCM WAV); rationale in `docs/superpowers/specs/2026-04-15-html-to-video-v0.2-audio.md`. Manual mux: `ffmpeg -i video.mp4 -i audio.wav -c:v copy -c:a aac -shortest out.mp4`.

## Production directives for marketing trailers

`recordHtml()` is a constant-fps capture: fine for screencasts and doc animations. For trailers published to a store page, Steam, or YouTube it loses fidelity that shows only after upload. Each rule below (from the goneIdle/TideWane pipeline) came from a specific regression.

- Capture 60fps via virtual clock, not wall-clock ticks. Playwright capture isn't frame-locked; under CPU load it drifts to 15-30 effective fps while still writing a 60fps MP4 of duplicated frames (reads as stutter). Drive animation from a virtual clock (`window.__vclock` or similar) advancing exactly `1 / fps` s per captured frame, ignoring wall time: each tick calls the page's exposed `tickFrame(t)`, Playwright screenshots once, then the clock advances. Verify by hash-diffing consecutive frames (every frame should differ).
- Synthesize audio offline (above).
- Validate with ffprobe before ship:
  ```bash
  ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames,duration -of json trailer.mp4
  ```
  Gate on: exact expected resolution, `r_frame_rate == fps/1`, `nb_frames == duration * fps ± 1`, audio track present (when expected), peak audio < -1 dBFS. `trailer-tripwire` (`github.com/EthanY33/trailer-tripwire`) also catches AI-default tells: >40% fades (reads as slideshow), audio RMS stdev <3dB (procedural drone), silent ratio, palette mono-mood.
- Content (from A/B tests):
  - Real UI mockups over bullet lists: a demo, not a spec sheet.
  - Concrete numbers ("60fps · 3 MB · zero deps") over vibes ("fast, light, simple" reads as AI slop). Pull numbers from your own telemetry.
  - No ambient pads, ever (strongest "AI-generated" tell). Use percussive/rhythmic elements, even sparse; RMS stdev > 3dB.
  - Cap outros at 0.8 s (>1.5 s of black/logo hold reads unfinished).

The full 60fps virtual-clock + offline-synth + ffprobe-gated pipeline lives in the goneIdle repo (`scripts/record-trailers.mjs`, `docs/trailer-production-directive.md`); `recordHtml()` stays minimal. The v0.2 spec (`docs/superpowers/specs/2026-04-15-html-to-video-v0.2-audio.md`) tracks absorbing its audio half here.

## GIF (two-pass palette)

```bash
ffmpeg -i output/video.mp4 -vf "fps=15,scale=640:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i output/video.mp4 -i palette.png -filter_complex "fps=15,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse" output/demo.gif
```

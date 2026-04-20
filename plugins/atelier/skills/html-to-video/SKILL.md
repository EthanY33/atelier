---
name: html-to-video
description: Record any HTML page or URL as MP4 (H.264) or WebM (VP9) at a configurable resolution and frame rate via Playwright headless + ffmpeg. Optionally exports a first-frame JPG poster. Use for marketing trailers, tutorial screencasts, animated docs, or demo GIFs.
---

## Requirements

- **Node.js** >= 20
- **Playwright** with Chromium (installed via `npm install`)
- **ffmpeg** in PATH — `brew install ffmpeg` (macOS), `apt install ffmpeg` (Linux), or [ffmpeg.org](https://ffmpeg.org/download.html) (Windows)

## When to use

- Rendering marketing trailers from animated HTML pages
- Capturing tutorial screencasts from a local dev server
- Generating video assets for docs, changelogs, or social posts
- Archiving an animated page as a portable video file
- Pre-rendering GIF-style demos (see GIF recipe below)

## How to run

### API (in code)

```js
import { recordHtml } from './plugins/atelier/skills/html-to-video/index.mjs';

// Record 10 seconds of an animated page as 1080p MP4
await recordHtml({
  url: 'http://localhost:5173/trailer.html',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  outPath: 'dist/trailer.mp4',
});

// WebM with poster image
await recordHtml({
  url: 'https://example.com/demo',
  duration: 5,
  outPath: 'dist/demo.webm',
  format: 'webm',
  poster: true,   // also writes dist/demo-poster.jpg
});
```

### Local HTML file

```js
import { pathToFileURL } from 'url';
import { recordHtml } from './plugins/atelier/skills/html-to-video/index.mjs';

const url = pathToFileURL('/path/to/page.html').href;
await recordHtml({ url, outPath: 'output/preview.mp4', duration: 3 });
```

### CLI

```bash
# Record 5 seconds (default) as MP4
node plugins/atelier/skills/html-to-video/index.mjs https://example.com output/video.mp4

# Record 10 seconds
node plugins/atelier/skills/html-to-video/index.mjs https://example.com output/video.mp4 10

# WebM (inferred from extension)
node plugins/atelier/skills/html-to-video/index.mjs https://example.com output/video.webm
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | — | Page URL or `file://` URL |
| `duration` | number | `5` | Recording length in seconds |
| `width` | number | `1280` | Viewport width in pixels |
| `height` | number | `720` | Viewport height in pixels |
| `fps` | number | `30` | Frames per second |
| `outPath` | string | — | Output file path (`.mp4` or `.webm`) |
| `format` | `'mp4'\|'webm'` | from ext | Override format detection |
| `poster` | boolean | `false` | Export first frame as `<name>-poster.jpg` |

## Codec details

| Format | Codec | Args |
|--------|-------|------|
| MP4 | H.264 (libx264) | `-preset medium -crf 20 -pix_fmt yuv420p` |
| WebM | VP9 (libvpx-vp9) | `-b:v 2M -pix_fmt yuv420p` |

## Audio capture

By default, `recordHtml()` produces silent video. To include audio, supply
an `audioSource` callback that writes a WAV file to the path you're handed;
`recordHtml` will mux it against the silent video via ffmpeg before
returning.

```js
await recordHtml({
  url:        'file:///trailer.html',
  duration:   10,
  outPath:    'dist/trailer.mp4',
  audioSource: async (outWavPath) => {
    // Synthesize or copy audio into outWavPath.
    // 48kHz 16-bit PCM mono/stereo is the recommended format.
    const { renderAudio } = await import('./my-trailer-audio.mjs');
    renderAudio(outWavPath);
  },
});
```

Contract:

- Omitting `audioSource` is a no-op — output is silent (identical to v0.1).
- The callback receives an absolute path inside the skill's temp dir; write
  the file and resolve.
- If the file is missing or ≤ 44 bytes (WAV header only), `recordHtml`
  throws `audioSource wrote an empty or missing file: <path>`.
- Video is stream-copied during mux (`-c:v copy`), so it isn't re-encoded.
  Audio is re-encoded to `aac -b:a 192k` (MP4) or `libopus -b:a 160k`
  (WebM).

### Why not MediaRecorder / Web Audio capture in headless Chromium

The obvious approach — inject `AudioContext → MediaStreamDestination →
MediaRecorder` into the page, capture the destination stream, mux the
result — was prototyped by the TideWane trailer pipeline and abandoned
before shipping. Concrete failure modes:

- Audio drifts 10–50 ms per minute against video even with frame-locked
  screenshot capture. Any cut-to-SFX timing is visibly wrong.
- `MediaRecorder` in headless silently emits zeros on some Chromium
  versions; the browser provides no failure signal.
- Worker-thread scheduling jitter under CI load makes the drift
  non-deterministic.

Pure-Node synthesis — which is what `audioSource` enables — is the
replacement. Atelier doesn't ship a synth library; the caller owns that.
Reference implementations live in `tidewane-build/scripts/trailers/render-*-audio.mjs`
(hand-written percussive sequencing, writes 48 kHz PCM WAV). Full design
rationale in `docs/superpowers/specs/2026-04-15-html-to-video-v0.2-audio.md`.

## Production directives for marketing trailers

The basic `recordHtml()` contract is a constant-fps Playwright capture. That's
fine for tutorial screencasts and doc animations. For **marketing trailers
published on a store page / Steam / YouTube**, the default loses fidelity in
ways that only show up after upload. These directives come from the goneIdle /
TideWane trailer pipeline — every rule here was learned from a specific
regression.

### Capture at 60fps via virtual clock, not wall-clock ticks

Playwright's screencast / screenshot cadence is not frame-locked; under CPU
load it will drift to 15-30 effective fps while still producing a 60fps MP4
with duplicated frames. Viewers read that as "stutter."

Fix: drive animation from a virtual clock (`window.__vclock` or similar)
that advances exactly `1 / fps` seconds per captured frame. Ignore wall
time entirely — each capture tick calls a `tickFrame(t)` function the HTML
exposes, then Playwright screenshots once, then the clock advances. The
result is genuinely 60 per-frame-different screenshots per second of output,
verified by hash-diffing consecutive frames.

### Synthesize audio offline, not in the browser

Headless Chromium's Web Audio is unreliable — output can glitch, desync from
video, or silently emit zeros. Pre-render the trailer audio track in pure
Node (OfflineAudioContext polyfill or a hand-rolled synth) to a `.wav`, then
`ffmpeg -i video.mp4 -i audio.wav -c:v copy -c:a aac -shortest out.mp4`.
The browser pass produces video only.

### Validate output with ffprobe before ship

Before publishing any trailer asset, probe it:

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames,duration \
  -of json trailer.mp4
```

Gate the pipeline on: exact expected resolution, `r_frame_rate == fps/1`,
`nb_frames == duration * fps ± 1`, audio track present (when expected),
peak audio < −1 dBFS. A separate `trailer-tripwire` audit tool (see
`github.com/EthanY33/trailer-tripwire`) also catches AI-default content
tells: fade-heavy edits (>40% fades reads as slideshow), flat audio RMS
(<3dB stdev reads as procedural drone), silent ratio, palette mono-mood.

### Content guidance

Pattern-level rules learned from A/B'ing trailers:

- **Real mockups over bullet lists.** Five seconds of an actual UI screenshot
  outperforms a 5-second bullet list every time. Treat the trailer as a
  demo, not a spec sheet.
- **Concrete numbers over vibes.** "60fps · 3 MB · zero deps" reads as real;
  "fast, light, simple" reads as AI slop. Pull the numbers from your own
  telemetry before writing copy.
- **No ambient pads, ever.** Flat synth drones are the single strongest
  "AI-generated" tell. Use percussive / rhythmic elements, even if
  sparse. The audio RMS curve should have visible stdev > 3dB.
- **Short outros.** >1.5 s of black-frame / logo-hold at the end reads as
  unfinished. Cap outros at 0.8 s.

### Where the production pipeline actually lives

The skill's `recordHtml()` is intentionally minimal — a general-purpose
HTML-to-video recorder. The full 60fps virtual-clock + offline-synth +
ffprobe-gated pipeline is a separate implementation in the goneIdle repo
(`scripts/record-trailers.mjs` + `docs/trailer-production-directive.md`).
Atelier's v0.2 spec (`docs/superpowers/specs/2026-04-15-html-to-video-v0.2-audio.md`)
tracks absorbing the audio-capture half of that pipeline into this skill.

## GIF conversion recipe

Convert the output MP4 to a high-quality GIF using ffmpeg's two-pass palette method:

```bash
# Generate palette
ffmpeg -i output/video.mp4 -vf "fps=15,scale=640:-1:flags=lanczos,palettegen" palette.png

# Render GIF using palette
ffmpeg -i output/video.mp4 -i palette.png \
  -filter_complex "fps=15,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse" \
  output/demo.gif
```

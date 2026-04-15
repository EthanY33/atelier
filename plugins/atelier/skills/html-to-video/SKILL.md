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

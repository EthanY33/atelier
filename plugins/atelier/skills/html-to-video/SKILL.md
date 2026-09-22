---
name: html-to-video
description: Record an HTML page, local .html file or URL as an MP4 (H.264) or WebM (VP9) video with frame-exact timing (virtual clock), optional muxed audio and a JPG poster. Use for product or game trailers, animated demo clips, screencasts of a local dev server, changelog or social videos, and turning CSS/JS animations into a video or GIF.
---

Needs ffmpeg on PATH and Playwright Chromium (`npx playwright install chromium`; installing the plugin does not download a browser). `node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" doctor` checks both and prints the install command for anything missing.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" video http://localhost:5173/trailer.html dist/trailer.mp4 10 --width 1920 --height 1080
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" video demo/page.html dist/demo.webm --fps 60 --poster
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" video demo/page.html dist/trailer.mp4 12 --audio score.wav
```

JS API, for a generated `audioSource` or to reuse one browser across many clips (`pathToFileURL` keeps the import working with Windows paths):

```bash
node --input-type=module -e '
import { pathToFileURL } from "node:url";
const { recordHtml } = await import(pathToFileURL(String.raw`${CLAUDE_SKILL_DIR}/index.mjs`).href);
await recordHtml({
  url: "demo/page.html", outPath: "dist/trailer.mp4", duration: 12, fps: 60, poster: true,
  audioSource: async (wavPath) => { /* write a 48 kHz 16-bit PCM WAV to wavPath */ },
});
'
```

## Options

API name first, then the CLI form.
- `url` (1st argument): http(s), `file://` or `data:` URL, or a path to a local HTML file (relative to the working directory). `localhost:5173/x` without a scheme is rejected; write `http://localhost:5173/x`.
- `outPath` (2nd argument): `.mp4` (libx264 `-preset medium -crf 20 -pix_fmt yuv420p`, `+faststart`) or `.webm` (libvpx-vp9 2 Mbit/s). Any other extension, or none, gets `format` (default MP4).
- `duration` (`[seconds]` or `-d, --duration`): seconds of page time, default 5. Frames = round(duration x fps), at least 1.
- `fps` (`--fps`): default 30, max 240.
- `width`, `height` (`--width`, `--height`): default 1280x720, integers 1 to 8192. MP4 needs even sizes, so an odd value is rounded up by 1 px and the page is laid out at that size (the CLI prints a note). WebM keeps odd sizes.
- `format` (`-f, --format`): `mp4` or `webm`. Must agree with a `.mp4`/`.webm` extension; a mismatch is an error.
- `poster` (`--poster`): also write `<name>-poster.jpg` (the first frame) next to the video.
- `audioSource(wavPath)` (`--audio <file>`): see Audio below.
- `browser` (API only): a launched Playwright Chromium to reuse. It is not closed; each call opens and closes its own context.
- `signal` (API only): an `AbortSignal`. Aborting stops the capture or ffmpeg step, removes the temp files and rejects with the abort reason. The CLI does this on the first Ctrl+C.

## Output

- The video at `outPath` (parent directories are created) and, with `poster`, `<name>-poster.jpg` beside it. `recordHtml` resolves with `outPath`; the CLI prints `Video written to: <path>` and `Poster written to: <path>`.
- Frames, the intermediate video and the WAV live in a temp directory that is removed on success and on every failure. The finished files are moved into place last, so a failed run never leaves a truncated video at `outPath` or overwrites an earlier one.

## Exit codes

- `0`: video written.
- `2`: usage error (message and usage on stderr) or runtime failure (one `atelier: ...` line, plus a `Fix:` line when ffmpeg or Chromium is missing).

## Notes

### Timing

Capture runs on a virtual clock: frame N shows the page exactly N / fps seconds after the first frame, however long each screenshot takes. The video is `duration` long and animations play at their authored speed.
- The first frame is taken after the `load` event and `document.fonts.ready`. Page timers are frozen during load, so page time 0 is the first frame.
- JS time (`Date`, `performance.now`, `setTimeout`, `setInterval`, `requestAnimationFrame`) runs on Playwright's fake clock, advanced 1000 / fps ms per frame.
- CSS animations, CSS transitions and Web Animations are frozen when created and stepped by the same amount each frame, honoring `playbackRate` and page seeks. An animation the page pauses stays paused at the previous frame's value. SVG SMIL is seeked with `setCurrentTime`.
- Not on the virtual clock: `<video>` and `<audio>` playback, Web Workers, scroll-driven animations, CSS animations inside cross-origin iframes, and `document.timeline.currentTime`. Content fetched after `load` appears at whichever frame is being captured when it arrives.
- ffmpeg is resolved on PATH (never through a shell) before Chromium launches, so a missing ffmpeg fails immediately.

### Audio

Output is silent unless `audioSource` or `--audio` is given. `audioSource` receives an absolute path in the temp directory and must write a WAV there (48 kHz 16-bit PCM recommended). A missing file, or one of 44 bytes or less (header only), throws `audioSource wrote an empty or missing file: <path>`. `--audio` copies an existing file (WAV recommended; any format ffmpeg reads). The video stream is copied; audio is encoded to AAC 192k (MP4) or Opus 160k (WebM) and the output ends with the shorter stream.

Do not record Web Audio in headless Chromium (`MediaRecorder`): it drifts 10 to 50 ms per minute against the video, and some Chromium versions silently record zeros. Synthesize the track in Node on the same timeline (frame N = N / fps seconds) and pass it in.

### Trailers and GIFs

- Record at the delivery frame rate (60 for store pages and YouTube), then check the file:
  ```bash
  ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=width,height,r_frame_rate,nb_read_frames -of json dist/trailer.mp4
  ```
  Expect the exact size, `r_frame_rate` = fps/1 and `nb_read_frames` = round(duration x fps).
- Show real UI rather than bullet lists, use concrete numbers, prefer percussive audio over ambient pads, and keep outros under about 0.8 s.
- GIF (two-pass palette):
  ```bash
  ffmpeg -i dist/demo.mp4 -vf "fps=15,scale=640:-1:flags=lanczos,palettegen" palette.png
  ffmpeg -i dist/demo.mp4 -i palette.png -filter_complex "fps=15,scale=640:-1:flags=lanczos[x];[x][1:v]paletteuse" dist/demo.gif
  ```

Also exported: `runCli(argv, { stdout, stderr })` (returns the exit code) and `findOnPath`, re-exported from the shared preflight helper for v0.2 callers.

# html-to-video v0.2 — Audio capture

**Status:** Spec only (filed 2026-04-15 from goneidle.com Phase 3 dogfood).

## Problem

`html-to-video@0.1.0` produces silent video. Pages with audio (Web Audio API, `<audio>`, `<video>` with sound) lose the audio track. Surfaced during goneidle.com trailer dogfood: `record-trailers.mjs` had to remain custom-built rather than calling `html-to-video` because trailers need procedural Web Audio output.

## Proposal

Add an opt-in `audioCapture: boolean` option to `recordHtml()`. When true:

1. Inject `AudioContext → MediaStreamDestination → MediaRecorder` setup via `page.evaluate()` BEFORE navigation.
2. Capture audio stream to a separate WebM file in the same temp dir.
3. After Playwright stops video recording, call `ffmpeg -i video.webm -i audio.webm -map 0:v:0 -map 1:a:0? -c copy out.webm` to mux the final output.

## API

```js
await recordHtml({
  url:          'file:///page.html',
  duration:     10,
  audioCapture: true,            // NEW (default false; backward compat)
  outPath:      'out.webm',
});
```

## Reference implementation

`tidewane-build/scripts/record-trailers.mjs` at SHA `9837bf1ddffcddf0e2a186fd46f474517c04de36` is the working pattern. Steps:
- Setup AudioContext + MediaStreamDestination injection in browser.
- Hook source nodes' `.connect()` to also connect to the destination.
- MediaRecorder records the destination stream's audio-only WebM.
- Page emits buffer to the harness via window message channel.
- ffmpeg muxes final.

## Acceptance criteria

1. New Vitest unit test verifies output has audio stream via `ffprobe -show_streams`.
2. Existing video-only tests (`audioCapture: false` or omitted) unchanged.
3. Default behavior is unchanged from v0.1 (silent).
4. `audioCapture: true` requires Playwright > 1.40 (verify in test).
5. README updated with audio-capture example.

## Out of scope

- System-audio capture (loopback). Only Web Audio API + media-element audio.
- Per-track volume / mix controls.
- Audio-only output (no video). Would be a separate skill.

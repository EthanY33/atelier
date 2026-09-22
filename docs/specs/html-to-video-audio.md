# html-to-video v0.2 — Audio muxing via caller-provided synth

**Status:** Spec revised 2026-04-19. Original filing 2026-04-15 proposed
browser-side MediaRecorder capture of `AudioContext` — that approach was
abandoned by the TideWane trailer pipeline before this spec was
implemented, and the revision reflects the working pattern.

## Problem

`html-to-video@0.1.0` produces silent video. Pages with audio (`<audio>`,
`<video>` with sound, Web Audio API output) lose the audio track. This
surfaced on the goneidle.com Phase 3 dogfood — `record-trailers.mjs` could
not call `recordHtml()` because trailers need audio.

## What didn't work: browser-side audio capture

The original v0.2 spec proposed injecting
`AudioContext → MediaStreamDestination → MediaRecorder` into the page,
capturing the destination stream to WebM, and muxing. TideWane prototyped
this (see `record-trailers.mjs` SHA `9837bf1`) and abandoned it before shipping.
The concrete failure modes:

- Headless Chromium's Web Audio output is not frame-locked to Playwright's
  screenshot capture. Even with virtual-clock video capture, audio drifts
  against video by 10–50 ms per minute — enough to make lip-sync-like
  timing (a cut to an SFX) visibly wrong.
- `MediaRecorder` in headless silently emits zeros on some Chromium versions.
  Detection requires inspecting the produced WebM with `ffprobe`; the
  browser itself does not signal failure.
- Worker-thread scheduling jitter under CI load makes the problem worse and
  non-deterministic.

The working pipeline (`scripts/record-trailers.mjs:9–15`) replaced browser
audio capture with **pure-Node audio synthesis**: a Node module reads the
same timeline data the HTML reads, renders a 48 kHz 16-bit PCM WAV directly
to disk, and ffmpeg muxes the WAV against the silent video.

Quoting the file: *"No recordVideo, no MediaRecorder, no wall-clock
capture. Sync is guaranteed because frames and samples share one virtual
clock."*

## Proposal

Add an opt-in `audioSource` option to `recordHtml()`. When present,
`recordHtml` runs the caller's audio generator, treats the result as a
WAV file, and muxes it with the silent video before returning.

The caller owns the synthesis — `recordHtml` stays framework-agnostic.
This works for Web Audio–style programmatic synth, library-driven synth
(Tone.js Node build, `node-web-audio-api`), reading an existing audio
file, or ffmpeg-produced audio from a different source.

## API

```js
await recordHtml({
  url:         'file:///trailer.html',
  duration:    10,
  outPath:     'out.mp4',

  // NEW: caller synthesizes audio into the supplied WAV path.
  // Called after video is captured, before final mux.
  // Must write a 48 kHz 16-bit PCM WAV (mono or stereo) to outWavPath.
  audioSource: async (outWavPath) => {
    const { renderAudio } = await import('./my-trailer-audio.mjs');
    renderAudio(outWavPath);         // writes 48kHz PCM WAV
  },
});
```

Contract:

- Omitting `audioSource` is a no-op: output is silent, identical to v0.1
  (strict backward compat).
- The callback receives an absolute path inside the same temp directory as
  the intermediate frames. `recordHtml` creates the directory; the callback
  only writes the file.
- The callback is awaited. Synchronous generators must return a fulfilled
  Promise.
- After the callback resolves, `recordHtml` verifies the file exists and is
  non-empty. Missing or zero-byte → throw with a clear message.
- If `ffprobe` is available, `recordHtml` also verifies the file has an
  audio stream. If not, mux is skipped and the silent video is returned
  with a warning on stderr (first-class failure would break portability on
  CI images that lack `ffprobe`).
- The mux step rewrites `outPath`: video is encoded once without audio,
  then re-muxed with `-c copy` to add the audio stream. No re-encode of
  video.

### Recommended WAV format

48 kHz, 16-bit PCM, mono or stereo. This is what ffmpeg-mux expects to
stream-copy cleanly. Callers are free to produce 44.1 kHz or 24-bit if
they accept a re-encode on mux — `recordHtml` falls back to
`-c:a aac` (MP4) or `-c:a libopus` (WebM) when the source doesn't match
the container's default.

### Pure-Node synth — reference snippet

For a trailer with hand-authored percussive sequencing (the TideWane
pattern), the caller's `audioSource` typically does:

```js
import { writeFileSync } from 'fs';

export function renderAudio(outWavPath) {
  const sampleRate = 48000;
  const seconds    = 10;
  const samples    = sampleRate * seconds;
  const buf        = Buffer.alloc(44 + samples * 2);
  // ... write WAV header at offset 0, 16-bit PCM samples after ...
  writeFileSync(outWavPath, buf);
}
```

Atelier does not ship a synth library — the TideWane scripts in
`tidewane-build/scripts/trailers/render-*-audio.mjs` are the reference.

## Implementation

### Changes to `plugins/atelier/skills/html-to-video/index.mjs`

1. Add `audioSource` to the `recordHtml` options shape (JSDoc + destructure).
2. After the existing frame-capture + ffmpeg-encode loop, if `audioSource`
   is present:
   a. Compute `audioWav = join(tempDir, 'audio.wav')`.
   b. `await audioSource(audioWav)`.
   c. Validate: `statSync(audioWav).size > 44` (minimum WAV header).
   d. Call `muxAudio(silentVideo, audioWav, outPath, format)` which runs:
      `ffmpeg -y -i <silentVideo> -i <audioWav> -map 0:v:0 -map 1:a:0 -c:v copy -c:a <containerDefault> -shortest <outPath>`.
      Container defaults: MP4 → `aac -b:a 192k`; WebM → `libopus -b:a 160k`.
   e. Clean up the intermediate silent video.
3. When `audioSource` is absent, behavior is unchanged (current code path).

### Changes to `tests/html-to-video.test.mjs`

Add a test:
```js
it.skipIf(!ffmpegAvailable)(
  'muxes audio when audioSource is provided',
  async () => {
    /* helper: write a 1-second 48kHz 16-bit PCM silence WAV inline (~100 lines) */
    const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'output.mp4');
    await recordHtml({
      url, outPath, duration: 1, fps: 10, width: 640, height: 360,
      audioSource: async (wav) => writeSilenceWav(wav, 1),
    });
    // Probe output — expect one video stream + one audio stream.
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0', outPath,
    ], { encoding: 'utf8' });
    const types = probe.stdout.trim().split('\n').sort();
    expect(types).toEqual(['audio', 'video']);
  },
  120_000,
);
```

Gate on `ffprobe` availability (matches the existing `ffmpegAvailable`
pattern). Skip when unavailable.

### SKILL.md update

Add a short "Audio capture" section with the `audioSource` example and a
pointer to the "Production directives" section already added in this repo
at `3fc16df`, which already warns against browser Web Audio.

## Acceptance criteria

1. `audioSource` option documented and typed in `recordHtml` JSDoc.
2. Omitting `audioSource` produces the same output bytes as v0.1 (binary
   equality not required; passes the v0.1 tests unmodified).
3. Supplying `audioSource` that writes a valid WAV produces an output
   whose `ffprobe` stream list contains exactly one `audio` stream and
   one `video` stream.
4. Supplying `audioSource` that writes zero bytes throws with the message
   "audioSource wrote an empty or missing file: <path>".
5. New vitest test in `tests/html-to-video.test.mjs` passes on Ubuntu +
   Windows. Skip on machines without `ffmpeg` (existing pattern).
6. `docs/skill-reference.md` unchanged — the skill's inputs/outputs row
   still reads the same (the caller provides the audio, not atelier).
7. `SKILL.md` updated with an `audioSource` example and link to the
   existing "Production directives" section.
8. CHANGELOG `[Unreleased]` entry added.
9. No new runtime dependencies. (`ffprobe` check is shelled out like
   `ffmpeg`.)

## Out of scope

- **Audio synthesis utilities.** Writing WAV headers, OfflineAudioContext
  polyfills, or oscillator helpers. Callers supply their own synth.
- **System audio capture** (loopback). Only caller-supplied WAV input.
- **Per-track mixing / volume controls.** The WAV that reaches mux is
  final; the caller mixes.
- **Audio-only output** (no video). Separate skill if ever needed.
- **`<audio>` / `<video>` element playback capture from the page.**
  Still requires browser audio capture, which is the pattern this spec
  explicitly rejects. The caller should render those elements' audio
  sources in Node instead (e.g., mux the underlying MP3 against the
  silent video directly).

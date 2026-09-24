#!/usr/bin/env node
/**
 * Render the atelier trailer soundtrack from the same timeline the scene
 * uses, so keystrokes, enter presses and success tones land on the frames
 * that show them. Samples are CC0 (demos/trailer/samples/manifest.json).
 *
 * There is no music or ambient bed: only keycaps, a soft click and a chime.
 * A cue's gain is the peak level it should hit, so the six keycap recordings,
 * which sit up to 19 dB apart as downloaded, play at one even level.
 *
 * Usage: node scripts/trailer/render-audio.mjs <out.wav>
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMain } from '../../plugins/atelier/lib/cli.mjs';
import { createSampleEngine, writeWav } from './sample-engine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES = join(REPO, 'demos', 'trailer', 'samples');
const SR = 44100;
// Master gain: about -27 LUFS integrated with keystroke peaks near -10 dBFS.
// That is well under the -16 LUFS web norm on purpose: with no music under
// them, keystrokes normalized to -16 sound harsh.
const MASTER = 10 ** (10.4 / 20);

/** Peak of a 16-bit PCM WAV, 0..1. */
function wavPeak(file) {
  const b = readFileSync(file);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'data') {
      let peak = 0;
      for (let i = at + 8; i + 1 < Math.min(b.length, at + 8 + size); i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
      return peak / 32768;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

/**
 * @param {string} outPath
 * @returns {Promise<{ duration: number, cues: number }>}
 */
export async function renderAudio(outPath) {
  const { buildTimeline } = await import(pathToFileURL(join(REPO, 'demos', 'trailer', 'timeline.mjs')).href);
  const tl = buildTimeline();
  const totalSamples = Math.ceil((tl.duration + 0.6) * SR);
  const buf = new Float32Array(totalSamples);
  const engine = createSampleEngine({ sr: SR, totalSamples, samplesRoot: SAMPLES });

  const peaks = new Map();
  for (const c of tl.cues) {
    if (!peaks.has(c.sample)) peaks.set(c.sample, wavPeak(join(SAMPLES, `${c.sample}.wav`)));
    engine.addSample(c.t, c.sample, { gain: (MASTER * c.gain) / peaks.get(c.sample), ...(c.opts ?? {}) });
  }

  engine.flushChannels(buf);
  writeWav(outPath, buf, SR);
  return { duration: tl.duration, cues: tl.cues.length };
}

if (isMain(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node scripts/trailer/render-audio.mjs <out.wav>');
    process.exit(2);
  }
  const r = await renderAudio(out);
  console.log(`wrote ${out} (${r.duration}s, ${r.cues} cues)`);
}

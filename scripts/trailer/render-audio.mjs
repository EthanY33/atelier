#!/usr/bin/env node
/**
 * Render the atelier 1.0 trailer soundtrack from the same timeline the scene
 * uses, so keystroke ticks, enter clicks and success tones land on the frames
 * that show them. Samples are CC0 (demos/trailer/samples/manifest.json).
 *
 * Usage: node scripts/trailer/render-audio.mjs <out.wav>
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMain } from '../../plugins/atelier/lib/cli.mjs';
import { createSampleEngine, writeWav } from './sample-engine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SR = 44100;

/**
 * @param {string} outPath
 * @returns {Promise<{ duration: number, cues: number }>}
 */
export async function renderAudio(outPath) {
  const { buildTimeline } = await import(pathToFileURL(join(REPO, 'demos', 'trailer', 'timeline.mjs')).href);
  const tl = buildTimeline();
  const totalSamples = Math.ceil((tl.duration + 0.6) * SR);
  const buf = new Float32Array(totalSamples);
  const engine = createSampleEngine({ sr: SR, totalSamples, samplesRoot: join(REPO, 'demos', 'trailer', 'samples') });

  // Sub-bass bed under the whole piece; the dual LFO keeps RMS expressive.
  engine.addAmbientBed('ambient-bed', { gain: 0.04, startSec: 0, endSec: tl.duration + 0.4, fadeIn: 1.2, fadeOut: 1.4 });
  for (const c of tl.cues) engine.addSample(c.t, c.sample, { gain: c.gain, ...(c.opts ?? {}) });

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

// Sample engine for trailer audio. Copied from the goneIdle trailer pipeline
// (goneidle/tidewane/prototype/scripts/trailers/sample-engine.mjs), unchanged
// below this header, so atelier can rebuild its trailer on its own.

// Sample-driven trailer audio engine.
//
// Architecture from jobcopilot-phase-1 v12 (user-approved 2026-05-06,
// captured in memory 30_reference_sample_trailer_pipeline.md).
//
// Provides:
//   - createSampleEngine({ sr, totalSamples, samplesRoot }) → factory
//     that returns addSample/addAmbientBed/flushChannels/resetChannels/
//     loadSample bound to that render's sample-rate, total-length, and
//     sample dir.
//   - writeWav(path, floatSamples, sampleRate) → write 16-bit PCM mono WAV.
//   - loadWav(path) → parse 16-bit PCM mono WAV → { samples, sampleRate }.
//
// Each per-trailer renderer (e.g. render-jobcopilot-phase-1-audio.mjs)
// instantiates one engine, then mixes its specific call-site choices.
//
// Engine features (all proven through 12 jobcopilot iterations):
//   - Per-sample voice-stealing on retrigger (10ms cosine fade-out of
//     prior tail before mixing new event). Cross-sample layering preserved.
//     Disable per-call with opts.poly = true.
//   - One-pole IIR lowpass via opts.lowpass (Hz). Used to warm bright
//     stock UI clicks (~5kHz cutoff) without losing transient bite.
//   - addAmbientBed crossfade-tiles a sample across a timeline window
//     with cosine equal-power crossfade at copy seams (sums to 1.0,
//     no amplitude dip), plus dual-LFO swing for RMS-stdev variance.
//
// Defaults match the jobcopilot-v12 mix; pass opts to override per call.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ─── WAV i/o ─────────────────────────────────────────────────────
export function loadWav(path) {
  const data = readFileSync(path);
  if (data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a WAV file: ${path}`);
  }
  let off = 12;
  let bitsPerSample = 16, numChannels = 1, sampleRate = 44100;
  let dataStart = -1, dataLen = 0;
  while (off + 8 <= data.length) {
    const id = data.toString('ascii', off, off + 4);
    const size = data.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      numChannels   = data.readUInt16LE(off + 10);
      sampleRate    = data.readUInt32LE(off + 12);
      bitsPerSample = data.readUInt16LE(off + 22);
    } else if (id === 'data') {
      dataStart = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size;
  }
  if (dataStart < 0) throw new Error(`No data chunk: ${path}`);
  if (bitsPerSample !== 16 || numChannels !== 1) {
    throw new Error(`Expected 16-bit mono, got ${bitsPerSample}-bit ${numChannels}ch: ${path}`);
  }
  const numSamples = dataLen / 2;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = data.readInt16LE(dataStart + i * 2) / 32768;
  }
  return { samples, sampleRate };
}

export function writeWav(path, floatSamples, sampleRate = 44100) {
  const dataLen = floatSamples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

// ─── engine factory ──────────────────────────────────────────────
export function createSampleEngine({ sr, totalSamples, samplesRoot }) {
  const sampleCache = new Map();
  let channels = new Map();

  function loadSample(name) {
    if (sampleCache.has(name)) return sampleCache.get(name);
    const entry = loadWav(join(samplesRoot, `${name}.wav`));
    sampleCache.set(name, entry);
    return entry;
  }

  function getChannel(name) {
    let chan = channels.get(name);
    if (!chan) {
      chan = { buf: new Float32Array(totalSamples), lastEnd: -1 };
      channels.set(name, chan);
    }
    return chan;
  }

  function voiceSteal(chan, dstStart) {
    const stealSamp = Math.max(1, Math.floor(0.010 * sr));
    const fadeStart = Math.max(0, dstStart - stealSamp);
    for (let k = 0; k < stealSamp; k++) {
      const idx = fadeStart + k;
      if (idx < 0 || idx >= totalSamples) continue;
      const env = 0.5 + 0.5 * Math.cos(Math.PI * k / stealSamp); // 1 → 0
      chan.buf[idx] *= env;
    }
    for (let i = Math.max(0, dstStart); i < chan.lastEnd && i < totalSamples; i++) {
      chan.buf[i] = 0;
    }
  }

  function resetChannels() {
    channels = new Map();
  }

  function flushChannels(masterBuf) {
    for (const chan of channels.values()) {
      for (let i = 0; i < totalSamples; i++) {
        masterBuf[i] += chan.buf[i];
      }
    }
  }

  // Mix a CC0 sample into its channel buffer at atSec.
  //   gain    — output multiplier (sample is unnormalized; calibrate per call).
  //   dur     — clip the sample to this many seconds (default = full sample).
  //   offset  — start atSec into the sample (default = 0).
  //   fadeOut — taper at clip end to prevent pops (default 5ms).
  //   channel — voice-stealing group (default: sample name).
  //   poly    — true to disable voice-stealing for this call (default false).
  //   lowpass — one-pole IIR cutoff in Hz (default: off). Warms bright/brittle
  //             samples without losing transient attack.
  function addSample(atSec, name, opts = {}) {
    const { samples, sampleRate } = loadSample(name);
    const gain = opts.gain ?? 0.5;
    const offsetSec = opts.offset ?? 0;
    const startSrc = Math.floor(offsetSec * sampleRate);
    let lenSrc = samples.length - startSrc;
    if (opts.dur != null) {
      lenSrc = Math.min(lenSrc, Math.floor(opts.dur * sampleRate));
    }
    if (lenSrc <= 0) return;

    const dstStart = Math.floor(atSec * sr);
    const fadeOutSec = opts.fadeOut ?? 0.005;
    const channelName = opts.channel ?? name;
    const chan = getChannel(channelName);

    const lpA = opts.lowpass ? 1 - Math.exp(-2 * Math.PI * opts.lowpass / sr) : 0;
    let lp = 0;

    if (sampleRate === sr) {
      const dstEnd = dstStart + lenSrc;
      if (!opts.poly && chan.lastEnd > dstStart) voiceSteal(chan, dstStart);
      const fadeOutSamp = Math.max(1, Math.floor(fadeOutSec * sr));
      for (let k = 0; k < lenSrc; k++) {
        const dstIdx = dstStart + k;
        if (dstIdx < 0 || dstIdx >= totalSamples) continue;
        let env = 1.0;
        if (k > lenSrc - fadeOutSamp) env = (lenSrc - k) / fadeOutSamp;
        let s = samples[startSrc + k];
        if (lpA > 0) { lp = lp + lpA * (s - lp); s = lp; }
        chan.buf[dstIdx] += s * gain * env;
      }
      chan.lastEnd = dstEnd;
      return;
    }

    // Resample path — defensive linear-interp for non-44.1kHz samples.
    const ratio = sampleRate / sr;
    const dstLen = Math.floor(lenSrc / ratio);
    const dstEnd = dstStart + dstLen;
    if (!opts.poly && chan.lastEnd > dstStart) voiceSteal(chan, dstStart);
    const fadeOutSamp = Math.max(1, Math.floor(fadeOutSec * sr));
    for (let k = 0; k < dstLen; k++) {
      const dstIdx = dstStart + k;
      if (dstIdx < 0 || dstIdx >= totalSamples) continue;
      const srcPos = startSrc + k * ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;
      const s0 = samples[srcIdx] || 0;
      const s1 = samples[srcIdx + 1] || 0;
      let env = 1.0;
      if (k > dstLen - fadeOutSamp) env = (dstLen - k) / fadeOutSamp;
      let s = s0 * (1 - frac) + s1 * frac;
      if (lpA > 0) { lp = lp + lpA * (s - lp); s = lp; }
      chan.buf[dstIdx] += s * gain * env;
    }
    chan.lastEnd = dstEnd;
  }

  // Tile a sample across [startSec..endSec] with cosine equal-power
  // crossfade at copy seams + dual-LFO swing. Defaults match the
  // skill's "ambient bed must have dynamic LFO" recipe (slow 0.04Hz
  // × 0.05-0.95 × fast 0.22Hz × 0.85-1.0).
  function addAmbientBed(name, opts = {}) {
    const { samples, sampleRate } = loadSample(name);
    const channel    = opts.channel   ?? `ambient-${name}`;
    const gain       = opts.gain      ?? 0.05;
    const startSec   = opts.startSec  ?? 0;
    const endSec     = opts.endSec    ?? (totalSamples / sr);
    const fadeIn     = opts.fadeIn    ?? 1.5;
    const fadeOut    = opts.fadeOut   ?? 2.5;
    const crossfade  = opts.crossfade ?? 2.0;
    const slowFreq   = opts.slowFreq  ?? 0.040;
    const slowMin    = opts.slowMin   ?? 0.05;
    const slowMax    = opts.slowMax   ?? 0.95;
    const fastFreq   = opts.fastFreq  ?? 0.220;
    const fastMin    = opts.fastMin   ?? 0.85;
    const fastMax    = opts.fastMax   ?? 1.00;

    const chan = getChannel(channel);
    const ratio = sampleRate / sr;
    const sampleLenSec = samples.length / sampleRate;
    const totalSec = endSec - startSec;
    const stride = Math.max(0.5, sampleLenSec - crossfade);
    const nCopies = Math.max(1, Math.ceil(totalSec / stride));

    for (let copy = 0; copy < nCopies; copy++) {
      const copyStart = startSec + copy * stride;
      if (copyStart >= endSec) break;
      const copyLenSec = Math.min(sampleLenSec, endSec - copyStart);
      const dstStart = Math.floor(copyStart * sr);
      const dstLen = Math.floor(copyLenSec * sr);

      for (let k = 0; k < dstLen; k++) {
        const dstIdx = dstStart + k;
        if (dstIdx < 0 || dstIdx >= totalSamples) continue;
        const srcPos = k * ratio;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;
        const s0 = samples[srcIdx] || 0;
        const s1 = samples[srcIdx + 1] || 0;
        let val = (s0 * (1 - frac) + s1 * frac) * gain;

        const localSec = k / sr;
        if (copy > 0 && localSec < crossfade) {
          val *= 0.5 - 0.5 * Math.cos(Math.PI * localSec / crossfade);
        }
        const remaining = copyLenSec - localSec;
        if (copy < nCopies - 1 && remaining < crossfade) {
          val *= 0.5 - 0.5 * Math.cos(Math.PI * remaining / crossfade);
        }

        const globalSec = copyStart + localSec - startSec;
        if (globalSec < fadeIn) val *= globalSec / fadeIn;
        const globalRem = totalSec - globalSec;
        if (globalRem < fadeOut) val *= Math.max(0, globalRem / fadeOut);

        const slowPhase = 0.5 + 0.5 * Math.sin(2 * Math.PI * slowFreq * globalSec - Math.PI / 2);
        const slowEnv = slowMin + (slowMax - slowMin) * slowPhase;
        const fastPhase = 0.5 + 0.5 * Math.sin(2 * Math.PI * fastFreq * globalSec);
        const fastEnv = fastMin + (fastMax - fastMin) * fastPhase;
        val *= slowEnv * fastEnv;

        chan.buf[dstIdx] += val;
      }
    }
  }

  return { addSample, addAmbientBed, flushChannels, resetChannels, loadSample };
}

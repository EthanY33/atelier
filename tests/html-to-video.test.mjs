import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { recordHtml } from '../plugins/atelier/skills/html-to-video/index.mjs';

// ---------------------------------------------------------------------------
// Feature detection — skip all tests if ffmpeg is not installed
// ---------------------------------------------------------------------------

const ffmpegCheck = spawnSync('ffmpeg', ['-version'], {
  shell: process.platform === 'win32',
});
const ffmpegAvailable = ffmpegCheck.status === 0;

const ffprobeCheck = spawnSync('ffprobe', ['-version'], {
  shell: process.platform === 'win32',
});
const ffprobeAvailable = ffprobeCheck.status === 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'h2v-test-'));
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function writeHtml(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return pathToFileURL(p).href;
}

/**
 * Writes a 48kHz 16-bit PCM mono silence WAV of the given duration to outPath.
 */
function writeSilenceWav(outPath, seconds) {
  const sampleRate = 48000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
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
  buf.writeUInt32LE(dataSize, 40);
  writeFileSync(outPath, buf);
}

const SIMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test Page</title>
  <style>
    body { background: #110f1b; color: #f2cc8f; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    h1 { font-size: 3rem; }
  </style>
</head>
<body>
  <h1>TideWane</h1>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('html-to-video', () => {
  it.skipIf(!ffmpegAvailable)(
    'produces an MP4 file from local HTML (2s at 640x360)',
    async () => {
      const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
      const outPath = join(tmp, 'output.mp4');

      await recordHtml({
        url,
        duration: 2,
        width: 640,
        height: 360,
        fps: 10,
        outPath,
      });

      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(1000);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable)(
    'produces a WebM file when format is webm',
    async () => {
      const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
      const outPath = join(tmp, 'output.webm');

      await recordHtml({
        url,
        duration: 1,
        width: 640,
        height: 360,
        fps: 10,
        outPath,
        format: 'webm',
      });

      expect(existsSync(outPath)).toBe(true);
      expect(statSync(outPath).size).toBeGreaterThan(1000);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)(
    'muxes audio when audioSource is provided',
    async () => {
      const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
      const outPath = join(tmp, 'output.mp4');

      await recordHtml({
        url,
        duration: 1,
        width: 640,
        height: 360,
        fps: 10,
        outPath,
        audioSource: (wavPath) => writeSilenceWav(wavPath, 1),
      });

      expect(existsSync(outPath)).toBe(true);

      const probe = spawnSync(
        'ffprobe',
        [
          '-v', 'error',
          '-show_entries', 'stream=codec_type',
          '-of', 'csv=p=0',
          outPath,
        ],
        { encoding: 'utf8', shell: process.platform === 'win32' },
      );
      expect(probe.status).toBe(0);
      const types = probe.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      expect(types).toEqual(['audio', 'video']);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable)(
    'throws when audioSource writes a missing or empty file',
    async () => {
      const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
      const outPath = join(tmp, 'output.mp4');

      await expect(
        recordHtml({
          url,
          duration: 1,
          width: 640,
          height: 360,
          fps: 10,
          outPath,
          audioSource: async () => {
            /* intentionally writes nothing */
          },
        }),
      ).rejects.toThrow(/audioSource wrote an empty or missing file/);
    },
    120_000,
  );

  it.skipIf(!ffmpegAvailable || !process.env.RUN_SLOW)(
    'poster flag exports first frame as JPG',
    async () => {
      const url = writeHtml(tmp, 'page.html', SIMPLE_HTML);
      const outPath = join(tmp, 'output.mp4');

      await recordHtml({
        url,
        duration: 1,
        width: 640,
        height: 360,
        fps: 10,
        outPath,
        poster: true,
      });

      const posterPath = join(tmp, 'output-poster.jpg');
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(posterPath)).toBe(true);
      expect(statSync(posterPath).size).toBeGreaterThan(1000);
    },
    120_000,
  );
});

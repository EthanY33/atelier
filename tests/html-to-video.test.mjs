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

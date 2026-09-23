#!/usr/bin/env node
/**
 * build.mjs: render the atelier 1.0 trailer.
 *
 *   1. serve demos/trailer over loopback HTTP (ES modules need an origin)
 *   2. drive the scene frame by frame on its virtual clock at 60 fps and
 *      1920x1080 (1280x720 authored, deviceScaleFactor 1.5), piping JPEG
 *      frames straight into ffmpeg
 *   3. render the soundtrack from the same timeline and mux it in as rendered
 *      (render-audio.mjs sets the level; no normalizer, so keystrokes stay soft)
 *   4. write demos/atelier-1.0-trailer.mp4 (with sound) plus the silent
 *      demos/overview.mp4 and animated demos/overview.webp the README embeds
 *
 * Usage: npm run demo:trailer
 */
import { spawn } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureFfmpeg, formatError, launchChromium } from '../../plugins/atelier/lib/preflight.mjs';
import { renderAudio } from './render-audio.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENE = join(REPO, 'demos', 'trailer');
const OUT = join(REPO, 'demos', 'atelier-1.0-trailer.mp4');
const OUT_README_MP4 = join(REPO, 'demos', 'overview.mp4');
const OUT_README_WEBP = join(REPO, 'demos', 'overview.webp');
const FPS = 60;

const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.png': 'image/png', '.ttf': 'font/ttf', '.wav': 'audio/wav', '.json': 'application/json' };

function serve(root) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function run(bin, args, { stdin } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { shell: false, windowsHide: true, stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}\n${err}`))));
    if (stdin) stdin(p.stdin);
  });
}

async function main() {
  const ffmpeg = ensureFfmpeg();
  const work = mkdtempSync(join(tmpdir(), 'atelier-trailer-'));
  const server = await serve(SCENE);
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
    await page.addInitScript(() => { window.__atelierDriven = true; });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__atelierReady !== undefined);
    await page.evaluate(() => window.__atelierReady);
    const duration = await page.evaluate(() => window.__atelierDuration);
    const frames = Math.round(duration * FPS);
    console.log(`capturing ${frames} frames (${duration}s at ${FPS} fps, 1920x1080)`);

    const silent = join(work, 'silent.mp4');
    await run(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], {
      stdin: async (w) => {
        for (let i = 0; i < frames; i++) {
          await page.evaluate((t) => window.__atelierAdvance(t), i / FPS);
          const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
          if (!w.write(jpg)) await new Promise((r) => w.once('drain', r));
          if (i % 300 === 0) console.log(`  frame ${i}/${frames}`);
        }
        w.end();
      },
    });

    const wav = join(work, 'audio.wav');
    const a = await renderAudio(wav);
    console.log(`audio: ${a.cues} cues`);
    await run(ffmpeg, ['-y', '-i', silent, '-i', wav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest',
      '-movflags', '+faststart', '-f', 'mp4', OUT]);

    copyFileSync(silent, OUT_README_MP4);
    await run(ffmpeg, ['-y', '-i', silent, '-vf', 'fps=24,scale=960:-1:flags=lanczos', '-c:v', 'libwebp_anim',
      '-pix_fmt', 'rgba', '-lossless', '0', '-compression_level', '6', '-q:v', '80', '-loop', '0', '-an', '-r', '24', OUT_README_WEBP]);

    for (const f of [OUT, OUT_README_MP4, OUT_README_WEBP]) console.log(`wrote ${f} (${(statSync(f).size / 1024).toFixed(0)} KB)`);
  } finally {
    await browser.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

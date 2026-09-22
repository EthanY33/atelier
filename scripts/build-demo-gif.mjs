#!/usr/bin/env node
/**
 * build-demo-gif.mjs: render the README overview clip with atelier itself.
 *
 *   1. `atelier demo` into a temp dir, for real skill output (OG card, icons)
 *   2. copy demos/storyboard/ plus those images into a temp stage
 *   3. record the stage with html-to-video (virtual clock, frame-exact)
 *   4. write demos/overview.mp4 and an animated demos/overview.webp
 *
 * Usage: npm run demo:gif
 */
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runDemo } from '../plugins/atelier/scripts/run-demo.mjs';
import { recordHtml } from '../plugins/atelier/skills/html-to-video/index.mjs';
import { ensureFfmpeg, formatError } from '../plugins/atelier/lib/preflight.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORYBOARD = join(REPO_ROOT, 'demos', 'storyboard');
const OUT_MP4 = join(REPO_ROOT, 'demos', 'overview.mp4');
const OUT_WEBP = join(REPO_ROOT, 'demos', 'overview.webp');

const PANELS = 10;
const SLOT_SECONDS = 2.4;
const DURATION = PANELS * SLOT_SECONDS;
const FPS = 30;
const WEBP_FPS = 20;
const WEBP_WIDTH = 960;

const IMAGES = [
  ['og/home.png', 'og-home.png'],
  ['brand/android-chrome-192.png', 'android-chrome-192.png'],
  ['brand/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['brand/favicon-64.png', 'favicon-64.png'],
  ['brand/favicon-32.png', 'favicon-32.png'],
  ['brand/favicon-16.png', 'favicon-16.png'],
  ['brand/twitter-cover.png', 'twitter-cover.png'],
];

function ffmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { shell: false, windowsHide: true });
    const err = [];
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${Buffer.concat(err).toString('utf8').slice(-2000)}`))));
  });
}

async function main() {
  const bin = ensureFfmpeg();
  const work = mkdtempSync(join(tmpdir(), 'atelier-overview-'));
  try {
    const demoOut = join(work, 'demo');
    await runDemo({ outDir: demoOut });

    const stage = join(work, 'stage');
    cpSync(STORYBOARD, stage, { recursive: true });
    mkdirSync(join(stage, 'assets'), { recursive: true });
    for (const [from, to] of IMAGES) copyFileSync(join(demoOut, from), join(stage, 'assets', to));

    const mp4 = join(work, 'overview.mp4');
    console.log(`\nRecording ${DURATION}s at ${FPS}fps, 1280x720...`);
    await recordHtml({ url: pathToFileURL(join(stage, 'index.html')).href, duration: DURATION, fps: FPS, width: 1280, height: 720, outPath: mp4 });
    copyFileSync(mp4, OUT_MP4);

    // Animated WebP needs libwebp_anim, rgba and an explicit output rate, or
    // ffmpeg writes a single frame.
    await ffmpeg(bin, [
      '-y', '-i', mp4,
      '-vf', `fps=${WEBP_FPS},scale=${WEBP_WIDTH}:-1:flags=lanczos`,
      '-c:v', 'libwebp_anim', '-pix_fmt', 'rgba', '-lossless', '0',
      '-compression_level', '6', '-q:v', '78', '-loop', '0', '-preset', 'picture',
      '-an', '-r', String(WEBP_FPS), OUT_WEBP,
    ]);

    for (const f of [OUT_MP4, OUT_WEBP]) console.log(`wrote ${f} (${(statSync(f).size / 1024).toFixed(0)} KB)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});

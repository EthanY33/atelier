#!/usr/bin/env node
// Build demos/overview.gif from demos/storyboard/index.html.
// Pipeline: ensure fixtures -> record MP4 -> ffmpeg palettegen -> ffmpeg paletteuse -> cleanup.

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { recordHtml } from '../plugins/atelier/skills/html-to-video/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const STORYBOARD_HTML = join(REPO_ROOT, 'demos', 'storyboard', 'index.html');
const FIXTURE_OG = join(REPO_ROOT, 'examples', 'fixtures', 'output', 'og', 'home.png');
const FIXTURE_COVER = join(REPO_ROOT, 'examples', 'fixtures', 'output', 'brand', 'og-cover.png');
const OUT_GIF = join(REPO_ROOT, 'demos', 'overview.gif');

const DURATION_SECONDS = 17.5;
const FPS = 15;
const WIDTH = 1280;
const HEIGHT = 720;
const GIF_WIDTH = 720; // scaled down for size

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { shell: process.platform === 'win32' });
    const err = [];
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${Buffer.concat(err).toString('utf8')}`));
    });
    proc.on('error', reject);
  });
}

function ffmpegAvailable() {
  const r = spawnSync('ffmpeg', ['-version'], { shell: process.platform === 'win32' });
  return r.status === 0;
}

async function main() {
  if (!ffmpegAvailable()) {
    console.error('ERROR: ffmpeg not found in PATH.');
    console.error('Install: choco install ffmpeg -y (Windows) | brew install ffmpeg (macOS) | apt install ffmpeg (Linux)');
    process.exit(1);
  }

  if (!existsSync(STORYBOARD_HTML)) {
    console.error(`ERROR: storyboard not found: ${STORYBOARD_HTML}`);
    process.exit(1);
  }

  if (!existsSync(FIXTURE_OG) || !existsSync(FIXTURE_COVER)) {
    console.log('Fixture outputs missing; running npm run demo to regenerate...');
    const r = spawnSync('npm', ['run', 'demo'], { stdio: 'inherit', cwd: REPO_ROOT, shell: true });
    if (r.status !== 0) {
      console.error('ERROR: npm run demo failed.');
      process.exit(1);
    }
  }

  mkdirSync(dirname(OUT_GIF), { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), 'atelier-gif-'));
  const mp4Path = join(workDir, 'storyboard.mp4');
  const palettePath = join(workDir, 'palette.png');

  try {
    console.log(`Recording MP4 (${DURATION_SECONDS}s @ ${FPS}fps, ${WIDTH}x${HEIGHT})...`);
    const storyboardUrl = pathToFileURL(STORYBOARD_HTML).href;
    await recordHtml({
      url: storyboardUrl,
      duration: DURATION_SECONDS,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      outPath: mp4Path,
    });
    console.log(`  wrote ${mp4Path}`);

    const scaleFilter = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;

    console.log('Generating palette (pass 1 of 2)...');
    await runFfmpeg([
      '-y',
      '-i', mp4Path,
      '-vf', `${scaleFilter},palettegen=stats_mode=diff`,
      palettePath,
    ]);

    console.log('Rendering GIF with palette (pass 2 of 2)...');
    await runFfmpeg([
      '-y',
      '-i', mp4Path,
      '-i', palettePath,
      '-lavfi', `${scaleFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      OUT_GIF,
    ]);

    console.log(`GIF written to: ${OUT_GIF}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

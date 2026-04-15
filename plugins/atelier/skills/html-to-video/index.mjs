import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, extname, basename } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determines the output format from explicit arg or outPath extension.
 * @param {string|undefined} format
 * @param {string} outPath
 * @returns {'mp4'|'webm'}
 */
function resolveFormat(format, outPath) {
  if (format === 'mp4' || format === 'webm') return format;
  const ext = extname(outPath).toLowerCase();
  if (ext === '.webm') return 'webm';
  return 'mp4';
}

/**
 * Builds the codec args for ffmpeg based on format.
 * @param {'mp4'|'webm'} format
 * @returns {string[]}
 */
function codecArgs(format) {
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-b:v', '2M', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
}

/**
 * Runs ffmpeg with the given args. Resolves on exit 0, rejects with stderr on failure.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const proc = spawn('ffmpeg', args, { shell: isWin });
    const stderrChunks = [];
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const msg = Buffer.concat(stderrChunks).toString('utf8');
        reject(new Error(`ffmpeg exited with code ${code}:\n${msg}`));
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Zero-pads a number to the given digit width.
 * @param {number} n
 * @param {number} width
 * @returns {string}
 */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * Sleep for ms milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records an HTML page as MP4 (H.264) or WebM (VP9) via Playwright + ffmpeg.
 *
 * @param {{
 *   url: string,
 *   duration?: number,
 *   width?: number,
 *   height?: number,
 *   fps?: number,
 *   outPath: string,
 *   format?: 'mp4'|'webm',
 *   poster?: boolean
 * }} opts
 * @param opts.duration - number of seconds at the requested fps (total frames = duration × fps).
 *   Actual wall-clock capture time may exceed duration depending on Playwright screenshot latency.
 * @returns {Promise<string>} resolves with outPath
 */
export async function recordHtml({
  url,
  duration = 5,
  width = 1280,
  height = 720,
  fps = 30,
  outPath,
  format,
  poster = false,
}) {
  const resolvedFormat = resolveFormat(format, outPath);
  mkdirSync(dirname(outPath), { recursive: true });

  const frameDir = mkdtempSync(join(tmpdir(), 'atelier-h2v-frames-'));
  const totalFrames = Math.round(duration * fps);
  const framePadWidth = String(totalFrames).length;
  const frameDelay = Math.round(1000 / fps);

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(100);

    for (let i = 0; i < totalFrames; i++) {
      const framePath = join(frameDir, `frame-${pad(i, framePadWidth)}.png`);
      await page.screenshot({ path: framePath });
      if (i < totalFrames - 1) {
        await sleep(frameDelay);
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  // Encode frames to video
  const inputPattern = join(frameDir, `frame-%0${framePadWidth}d.png`);
  const encodeArgs = [
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    ...codecArgs(resolvedFormat),
    '-movflags', '+faststart',
    outPath,
  ];
  await runFfmpeg(encodeArgs);

  // Optional: export poster (first frame as JPG)
  if (poster) {
    const ext = extname(outPath);
    const base = basename(outPath, ext);
    const posterPath = join(dirname(outPath), `${base}-poster.jpg`);
    await runFfmpeg(['-y', '-i', outPath, '-frames:v', '1', '-q:v', '3', posterPath]);
  }

  // Cleanup frames
  rmSync(frameDir, { recursive: true, force: true });

  return outPath;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const [, , url, outPathArg, durationArg] = process.argv;
  if (!url || !outPathArg) {
    console.error('Usage: node index.mjs <url> <outPath> [durationSeconds]');
    process.exit(1);
  }
  const duration = durationArg ? Number(durationArg) : 5;
  const result = await recordHtml({ url, outPath: outPathArg, duration });
  console.log(`Video written to: ${result}`);
}

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, extname, basename } from 'path';
import { pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';
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

/**
 * Returns container-appropriate ffmpeg audio codec args for mux.
 * @param {'mp4'|'webm'} format
 * @returns {string[]}
 */
function audioCodecArgs(format) {
  if (format === 'webm') {
    return ['-c:a', 'libopus', '-b:a', '160k'];
  }
  return ['-c:a', 'aac', '-b:a', '192k'];
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
 *   poster?: boolean,
 *   audioSource?: (outWavPath: string) => void | Promise<void>,
 * }} opts
 * @param opts.duration - number of seconds at the requested fps (total frames = duration × fps).
 *   Actual wall-clock capture time may exceed duration depending on Playwright screenshot latency.
 * @param opts.audioSource - optional caller-supplied audio generator. Receives an absolute
 *   path where the callback must write a WAV file (48kHz 16-bit PCM recommended). After the
 *   callback resolves, the file is muxed against the silent video with `ffmpeg -c:v copy`.
 *   When omitted, output is silent (v0.1 behavior). Design note: headless-Chromium MediaRecorder
 *   capture of Web Audio was considered and rejected — it drifts against video and silently
 *   emits zeros on some Chromium versions. See spec 2026-04-15-html-to-video-v0.2-audio.md.
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
  audioSource,
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

  // Encode frames to video. When audioSource is supplied, encode to an
  // intermediate silent file, run the caller's synth, then mux. Otherwise
  // encode straight to outPath.
  const inputPattern = join(frameDir, `frame-%0${framePadWidth}d.png`);
  const videoEncodeTarget = audioSource
    ? join(frameDir, `silent-video${extname(outPath)}`)
    : outPath;
  const encodeArgs = [
    '-y',
    '-framerate', String(fps),
    '-i', inputPattern,
    ...codecArgs(resolvedFormat),
    '-movflags', '+faststart',
    videoEncodeTarget,
  ];
  await runFfmpeg(encodeArgs);

  if (audioSource) {
    const audioWav = join(frameDir, 'audio.wav');
    await audioSource(audioWav);

    let audioStat;
    try {
      audioStat = statSync(audioWav);
    } catch {
      throw new Error(`audioSource wrote an empty or missing file: ${audioWav}`);
    }
    if (audioStat.size <= 44) {
      throw new Error(`audioSource wrote an empty or missing file: ${audioWav}`);
    }

    const muxArgs = [
      '-y',
      '-i', videoEncodeTarget,
      '-i', audioWav,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      ...audioCodecArgs(resolvedFormat),
      '-shortest',
      '-movflags', '+faststart',
      outPath,
    ];
    await runFfmpeg(muxArgs);
  }

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

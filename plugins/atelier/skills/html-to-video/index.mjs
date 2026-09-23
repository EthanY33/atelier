/**
 * html-to-video: record an HTML page as an MP4 (H.264) or WebM (VP9) video
 * with Playwright Chromium and ffmpeg.
 *
 * Capture runs on a virtual clock, so frame N always shows the page exactly
 * N / fps seconds after the first frame, however long each screenshot takes.
 * Between two screenshots the clock advances 1000 / fps ms in equal
 * sub-steps of at most one 60 Hz display frame (1000 / 60 ms); the last
 * sub-step lands on the frame time. At each sub-step:
 *   - JS time (Date, performance.now, setTimeout/setInterval) is driven by
 *     Playwright's clock API: paused before navigation, then run forward to
 *     the sub-step time.
 *   - requestAnimationFrame is a queue (Playwright's own fires on a 16 ms
 *     grid, off the frame times) that runs once per sub-step with the
 *     sub-step time as its timestamp: at least 60 times per page second, and
 *     exactly at the frame time just before each screenshot.
 *   - CSS animations, CSS transitions and Web Animations are frozen at
 *     creation (CDP Animation.setPlaybackRate(0)) and stepped by setting each
 *     animation's currentTime. One that starts between sub-steps (timer,
 *     event) begins at the next sub-step, at most 1/60 s late, as on a 60 Hz
 *     display.
 *   - SVG SMIL animations are paused and seeked with setCurrentTime().
 * <video>/<audio> playback, Web Workers, cross-origin iframes' CSS animations
 * and document.timeline.currentTime are not driven by this clock.
 */
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ensureFfmpeg, formatError, launchChromium } from '../../lib/preflight.mjs';
import { isMain } from '../../lib/cli.mjs';

// Kept for callers of the v0.2 API, which exported its own PATH walker.
export { findOnPath } from '../../lib/preflight.mjs';

const FORMAT_BY_EXT = { '.mp4': 'mp4', '.webm': 'webm' };
const MAX_DIMENSION = 8192;
const MAX_FPS = 240;
const FONT_WAIT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TEMP_PREFIX = 'atelier-h2v-frames-';
// Longest virtual-clock step between animation syncs and rAF runs: one 60 Hz
// display frame.
const DISPLAY_FRAME_MS = 1000 / 60;

// Playwright errors append a multi-line "Call log:" wrapped in ANSI dim codes.
const firstLine = (err) => String(err?.message ?? err).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)[0].trim();

// ---------------------------------------------------------------------------
// Option handling
// ---------------------------------------------------------------------------

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turn a URL or a local file path into something page.goto accepts.
 * Strings with a scheme of two or more letters (http:, https:, file:, data:,
 * about:) are URLs; a Windows drive letter is not a scheme. Anything else is a
 * file path, resolved against the working directory.
 * @param {string} input
 * @returns {string}
 */
function toPageUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('url is required: a page URL or a path to a local HTML file');
  }
  if (/^[^/\\:]+:\d+(\/|$)/.test(input)) {
    throw new TypeError(`"${input}" has no scheme; did you mean http://${input} ?`);
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(input)) {
    if (/^file:/i.test(input)) {
      let path;
      try {
        path = fileURLToPath(input);
      } catch (err) {
        throw new TypeError(`Invalid file URL "${input}": ${err.message}`);
      }
      if (!isFile(path)) throw new Error(`HTML file not found: ${path}`);
    }
    return input;
  }
  const abs = resolve(input);
  if (!isFile(abs)) throw new Error(`HTML file not found: ${abs}`);
  return pathToFileURL(abs).href;
}

/**
 * Pick the container from the output extension (.mp4 / .webm). An explicit
 * `format` must agree with that extension; for any other extension it
 * decides, and MP4 is the fallback.
 * @param {string|undefined|null} format
 * @param {string} outPath
 * @returns {'mp4'|'webm'}
 */
function resolveFormat(format, outPath) {
  if (format != null && format !== 'mp4' && format !== 'webm') {
    throw new TypeError(`format must be "mp4" or "webm", got ${JSON.stringify(format)}`);
  }
  const ext = extname(outPath);
  const fromExt = FORMAT_BY_EXT[ext.toLowerCase()];
  if (format && fromExt && format !== fromExt) {
    throw new TypeError(
      `format "${format}" does not match the output extension "${ext}": rename the output to .${format} or drop the format option`,
    );
  }
  return format || fromExt || 'mp4';
}

/** Render a bad option value for an error message (NaN stays NaN). */
function show(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function checkPositiveNumber(name, value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number, got ${show(value)}`);
  }
  if (max !== undefined && value > max) throw new TypeError(`${name} must be at most ${max}, got ${value}`);
}

function checkDimension(name, value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_DIMENSION}, got ${show(value)}`);
  }
}

/** Poster path for an output path: `<dir>/<name>-poster.jpg`. */
function posterPathFor(outPath) {
  return join(dirname(outPath), `${basename(outPath, extname(outPath))}-poster.jpg`);
}

/**
 * Validate and normalize recordHtml options. Throws TypeError for a bad
 * value and Error for a missing input file, before any work is done.
 */
function normalizeOptions({
  url,
  duration = 5,
  width = 1280,
  height = 720,
  fps = 30,
  outPath,
  format,
  poster = false,
  audioSource,
  browser,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowHttpError = false,
} = {}) {
  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new TypeError('outPath is required: the .mp4 or .webm file to write');
  }
  checkPositiveNumber('duration', duration);
  checkPositiveNumber('fps', fps, MAX_FPS);
  checkDimension('width', width);
  checkDimension('height', height);
  checkPositiveNumber('timeoutMs', timeoutMs);
  const totalFrames = Math.round(duration * fps);
  if (totalFrames < 1) {
    throw new TypeError(`duration x fps must give at least one frame (duration ${duration}, fps ${fps})`);
  }
  if (audioSource !== undefined && audioSource !== null && typeof audioSource !== 'function') {
    throw new TypeError('audioSource must be a function (outWavPath) => void | Promise<void>');
  }
  if (signal != null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  const resolvedFormat = resolveFormat(format, outPath);
  const absOut = resolve(outPath);
  if (/[\\/]$/.test(outPath) || isDirectory(absOut)) {
    throw new TypeError(`outPath must be a file path, not a directory: ${outPath}`);
  }
  const pageUrl = toPageUrl(url);
  // libx264 with yuv420p needs even dimensions, so MP4 rounds odd sizes up by
  // one pixel. The page is laid out at the rounded size (no padding bars).
  const even = (n) => (resolvedFormat === 'mp4' && n % 2 === 1 ? n + 1 : n);
  return {
    pageUrl,
    outPath,
    absOut,
    format: resolvedFormat,
    width: even(width),
    height: even(height),
    fps,
    totalFrames,
    poster: Boolean(poster),
    audioSource: audioSource || undefined,
    browser,
    signal: signal ?? undefined,
    timeoutMs,
    allowHttpError: Boolean(allowHttpError),
  };
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

/**
 * Run ffmpeg without a shell (argv goes straight to the process, so
 * metacharacters in paths are inert). Rejects with the tail of stderr.
 * @param {string} ffmpegPath
 * @param {string[]} args
 * @param {AbortSignal} [signal] - kills ffmpeg when aborted
 * @param {string} [cwd] - working directory (lets the frame pattern stay relative)
 * @returns {Promise<void>}
 */
function runFfmpeg(ffmpegPath, args, signal, cwd) {
  return new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(signal ? { signal } : {}),
      ...(cwd ? { cwd } : {}),
    });
    const chunks = [];
    proc.stderr.on('data', (chunk) => chunks.push(chunk));
    proc.on('error', (err) => {
      if (signal?.aborted) reject(signal.reason);
      else reject(new Error(`Could not run ffmpeg (${ffmpegPath}): ${err.message}`, { cause: err }));
    });
    proc.on('close', (code, signal) => {
      if (code === 0) return resolvePromise();
      const tail = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(-15).join('\n');
      reject(new Error(`ffmpeg failed (${signal ? `signal ${signal}` : `exit code ${code}`})${tail ? `:\n${tail}` : ''}`));
    });
  });
}

function videoCodecArgs(format) {
  if (format === 'webm') return ['-c:v', 'libvpx-vp9', '-b:v', '2M', '-pix_fmt', 'yuv420p'];
  return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];
}

function audioCodecArgs(format) {
  if (format === 'webm') return ['-c:a', 'libopus', '-b:a', '160k'];
  return ['-c:a', 'aac', '-b:a', '192k'];
}

function containerArgs(format) {
  return format === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'webm'];
}

/** Move a finished file into place; falls back to copy across devices. */
function moveInto(src, dest) {
  try {
    renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyFileSync(src, dest);
  }
}

// ---------------------------------------------------------------------------
// Virtual clock
// ---------------------------------------------------------------------------

/**
 * Init script, added after Playwright's clock so it replaces the clock's
 * requestAnimationFrame. Playwright fires rAF on its own 16 ms grid (with the
 * grid tick as the timestamp), which drifts up to 16 ms from the frame times.
 * Here callbacks wait in a queue that stepPageClock runs once per sub-step,
 * all with that sub-step's performance.now(), as a browser does once per
 * display frame. Must stay self-contained: it is serialized into the page.
 */
function installFrameQueue() {
  if (window.__atelierRaf) return;
  const queue = new Map();
  let nextId = 1;
  window.__atelierRaf = {
    /** Run the callbacks queued before this call; returns how many ran. */
    flush() {
      const ts = performance.now();
      let ran = 0;
      for (const id of [...queue.keys()]) {
        const callback = queue.get(id);
        if (!callback) continue; // cancelled by an earlier callback in this batch
        queue.delete(id);
        ran++;
        try {
          callback(ts);
        } catch (err) {
          if (typeof reportError === 'function') reportError(err);
          else console.error(err);
        }
      }
      return ran;
    },
  };
  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestAnimationFrame' on 'Window': parameter 1 is not of type 'Function'.");
    }
    const id = nextId++;
    queue.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    queue.delete(id);
  };
}

/**
 * Runs inside every frame of the page at each sub-step, after the JS clock
 * has run to it. `t` is the virtual time in ms since the first frame. Must
 * stay self-contained: it is serialized into the page.
 *
 * Order, as in a browser's rendering update: bring animations to `t`, run
 * the requestAnimationFrame queue, then sync again so an animation the
 * callbacks started begins at `t`.
 *
 * Web Animations (CSS animations and transitions included) are frozen by the
 * CDP playback rate, so each one is advanced by (t - last t) x playbackRate
 * from where it was. An animation first seen at this step keeps its current
 * time, which is where it was created (usually 0). Animations the page paused
 * are left alone, and a page seek (currentTime changed by the page) is
 * respected.
 */
async function stepPageClock(t) {
  const key = '__atelierHtmlToVideo';
  const state = window[key] || (window[key] = { anims: new WeakMap(), svgs: new WeakMap() });
  const sync = () => {
    for (const anim of document.getAnimations()) {
      try {
        if (anim.timeline !== document.timeline) continue;
        const current = anim.currentTime;
        if (typeof current !== 'number') continue;
        const rec = state.anims.get(anim);
        if (!rec) {
          state.anims.set(anim, { t, current });
          continue;
        }
        if (anim.playState === 'paused') {
          rec.t = t;
          rec.current = current;
          continue;
        }
        const base = Math.abs(current - rec.current) > 1 ? current : rec.current;
        const next = base + (t - rec.t) * anim.playbackRate;
        anim.currentTime = next;
        rec.t = t;
        rec.current = next;
      } catch {
        // A detached or exotic animation must not stop the capture.
      }
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.ownerSVGElement || typeof svg.setCurrentTime !== 'function') continue;
      let born = state.svgs.get(svg);
      if (born === undefined) {
        born = t;
        state.svgs.set(svg, born);
        svg.pauseAnimations();
      }
      svg.setCurrentTime((t - born) / 1000);
    }
  };
  sync();
  if (window.__atelierRaf && window.__atelierRaf.flush() > 0) {
    // Let promise callbacks the rAF callbacks queued run first.
    await Promise.resolve();
    sync();
  }
}

async function stepAllFrames(page, t) {
  await Promise.all(page.frames().map((frame) => frame.evaluate(stepPageClock, t).catch(() => {})));
}

/**
 * Open the page on a paused virtual clock and wait until it is ready for the
 * first frame (load event plus web fonts). A page that cannot be opened, that
 * misses its load event within timeoutMs, or that answers HTTP 4xx/5xx
 * (unless allowHttpError) is an error.
 */
async function openPage(browser, { pageUrl, width, height, timeoutMs, allowHttpError }) {
  const context = await browser.newContext({ viewport: { width, height } });
  try {
    const page = await context.newPage();
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
    } catch (err) {
      throw new Error('html-to-video needs a Chromium browser (CDP session unavailable)', { cause: err });
    }
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    // The installed clock ticks in real time until paused, and pauseAt cannot
    // go backwards, so install it a minute early and pause at "now". Nothing
    // is loaded yet, so the fast-forward fires no page timers.
    const start = Date.now();
    await page.clock.install({ time: start - 60_000 });
    await page.clock.pauseAt(start);
    // Added after the clock's init script so its rAF replaces the clock's.
    await context.addInitScript(installFrameQueue);
    let response;
    try {
      response = await page.goto(pageUrl, { waitUntil: 'load', timeout: timeoutMs });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new Error(`${pageUrl} did not fire its load event within ${timeoutMs} ms (raise --timeout or timeoutMs for slow pages)`, { cause: err });
      }
      throw new Error(`could not open ${pageUrl}: ${firstLine(err)}`, { cause: err });
    }
    // file:// answers 200 and data:/about: URLs have no response; only real HTTP errors stop here.
    const status = response ? response.status() : 0;
    if (status >= 400 && !allowHttpError) {
      const text = response.statusText();
      throw new Error(
        `${pageUrl} answered HTTP ${status}${text ? ` ${text}` : ''}; refusing to record an error page (use --allow-http-error to record it anyway)`,
      );
    }
    let timer;
    await Promise.race([
      page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => false),
      new Promise((r) => { timer = setTimeout(r, FONT_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    return { context, page };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

/**
 * Advance the virtual clock from frame to frame in equal sub-steps of at most
 * one 60 Hz display frame, stepping the page (animations and rAF) at each,
 * and screenshot at every frame time. `at(x)` maps a frame position, possibly
 * fractional, to whole ms since the first frame.
 */
async function captureFrames(page, { fps, totalFrames, signal }, frameDir, padWidth) {
  const steps = Math.max(1, Math.ceil(1000 / fps / DISPLAY_FRAME_MS - 1e-9));
  const at = (x) => Math.round((x * 1000) / fps);
  let now = 0;
  for (let i = 0; i < totalFrames; i++) {
    signal?.throwIfAborted();
    const t = at(i);
    for (let k = 1; i > 0 && k < steps; k++) {
      const next = at(i - 1 + k / steps);
      if (next <= now) continue;
      signal?.throwIfAborted();
      await page.clock.runFor(next - now);
      now = next;
      await stepAllFrames(page, now);
    }
    if (t > now) {
      await page.clock.runFor(t - now);
      now = t;
    }
    await stepAllFrames(page, t);
    await page.screenshot({ path: join(frameDir, `frame-${String(i).padStart(padWidth, '0')}.png`), type: 'png' });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records an HTML page as MP4 (H.264) or WebM (VP9) via Playwright + ffmpeg.
 *
 * Frame N shows the page N / fps seconds after the first frame (virtual
 * clock, see the module comment), so the video length equals `duration` and
 * animations play at their real speed regardless of screenshot latency. A
 * CSS or Web Animation that starts between frames begins within 1/60 s of
 * its start, as on a 60 Hz display.
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
 *   browser?: import('playwright').Browser,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   allowHttpError?: boolean,
 * }} opts
 * @param opts.url - http(s)/file/data URL, or a path to a local HTML file. A page that
 *   answers HTTP 4xx/5xx is an error unless `allowHttpError` is set.
 * @param opts.duration - seconds of page time to record (frames = round(duration x fps)).
 * @param opts.width - viewport width; MP4 rounds an odd value up to even.
 * @param opts.height - viewport height; MP4 rounds an odd value up to even.
 * @param opts.format - must match a .mp4/.webm extension; decides for any other extension (default mp4).
 * @param opts.poster - also write `<name>-poster.jpg` (the first frame) next to outPath.
 * @param opts.audioSource - optional caller-supplied audio generator. Receives an absolute
 *   path in the temp dir where it must write a WAV file (48 kHz 16-bit PCM recommended).
 *   The video stream is copied and the audio is encoded into the output (AAC for MP4,
 *   Opus for WebM), trimmed to the shorter of the two.
 * @param opts.browser - an already launched Playwright Chromium to reuse. It is not
 *   closed; each call opens and closes its own context.
 * @param opts.signal - aborting it stops the capture or ffmpeg step, removes the temp
 *   frames and rejects with the abort reason. outPath is left untouched.
 * @param opts.timeoutMs - how long to wait for navigation and the load event (default 30000).
 * @param opts.allowHttpError - record the page even when it answers HTTP 4xx/5xx.
 * @returns {Promise<string>} resolves with outPath
 */
export async function recordHtml(opts) {
  const o = normalizeOptions(opts);
  o.signal?.throwIfAborted();
  // Fail before launching a browser or capturing anything.
  const ffmpegPath = ensureFfmpeg();
  mkdirSync(dirname(o.absOut), { recursive: true });

  const frameDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    const padWidth = Math.max(4, String(o.totalFrames - 1).length);
    const ownBrowser = !o.browser;
    const browser = o.browser ?? (await launchChromium());
    try {
      const { context, page } = await openPage(browser, o);
      try {
        await captureFrames(page, o, frameDir, padWidth);
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      if (ownBrowser) await browser.close().catch(() => {});
    }

    // Everything is written inside frameDir first and moved into place at the
    // end, so a failure never leaves a truncated file at outPath. The frame
    // pattern is relative (cwd = frameDir) so a '%' in the temp path is inert.
    const video = join(frameDir, `video.${o.format}`);
    await runFfmpeg(ffmpegPath, [
      '-framerate', String(o.fps),
      '-start_number', '0',
      '-i', `frame-%0${padWidth}d.png`,
      ...videoCodecArgs(o.format),
      ...containerArgs(o.format),
      video,
    ], o.signal, frameDir);

    let finalVideo = video;
    if (o.audioSource) {
      const audioWav = join(frameDir, 'audio.wav');
      await o.audioSource(audioWav);
      o.signal?.throwIfAborted();
      let size = 0;
      try {
        size = statSync(audioWav).size;
      } catch {
        size = 0;
      }
      if (size <= 44) throw new Error(`audioSource wrote an empty or missing file: ${audioWav}`);
      finalVideo = join(frameDir, `muxed.${o.format}`);
      await runFfmpeg(ffmpegPath, [
        '-i', video,
        '-i', audioWav,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        ...audioCodecArgs(o.format),
        '-shortest',
        ...containerArgs(o.format),
        finalVideo,
      ], o.signal);
    }

    let posterTmp;
    if (o.poster) {
      posterTmp = join(frameDir, 'poster.jpg');
      await runFfmpeg(ffmpegPath, [
        '-i', join(frameDir, `frame-${'0'.repeat(padWidth)}.png`),
        '-frames:v', '1',
        '-q:v', '3',
        '-update', '1',
        posterTmp,
      ], o.signal);
    }

    moveInto(finalVideo, o.absOut);
    if (posterTmp) moveInto(posterTmp, posterPathFor(o.absOut));
  } finally {
    try {
      rmSync(frameDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A virus scanner can hold a frame open on Windows. Leave the directory
      // to the OS temp cleaner rather than fail or mask the real result.
    }
  }
  return o.outPath;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: atelier video <url|file.html> <out.mp4|out.webm> [seconds] [options]

Record an HTML page or URL as an MP4 (H.264) or WebM (VP9) video.
Frames are captured on a virtual clock: frame N shows the page N/fps
seconds after the first frame, so animations keep their real speed.

Options:
  -d, --duration <s>   seconds to record (default 5; same as [seconds])
      --fps <n>        frames per second (default 30, max ${MAX_FPS})
      --width <px>     viewport width (default 1280; MP4 rounds odd up)
      --height <px>    viewport height (default 720; MP4 rounds odd up)
  -f, --format <fmt>   mp4 or webm (default: from the output extension, else mp4)
      --poster         also write <name>-poster.jpg from the first frame
      --audio <file>   mux this audio file (WAV recommended) into the video
      --timeout <ms>   navigation and load event timeout (default ${DEFAULT_TIMEOUT_MS})
      --allow-http-error
                       record the page even when it answers HTTP 4xx or 5xx
  -h, --help           show this help

Requires ffmpeg on PATH and Playwright Chromium (atelier doctor checks both).
Exit codes: 0 video written, 2 usage or runtime error (a page that answers
HTTP 4xx or 5xx, cannot be opened or misses its load event is a runtime error).`;

class UsageError extends Error {}

function parseNumberArg(name, raw) {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) {
    throw new UsageError(`--${name} must be a number, got "${raw}"`);
  }
  return n;
}

/**
 * CLI entry point. Returns the exit code instead of exiting, so it can be
 * tested in-process.
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {{ stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {Promise<number>}
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  let audioPath;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        duration: { type: 'string', short: 'd' },
        fps: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        format: { type: 'string', short: 'f' },
        poster: { type: 'boolean' },
        audio: { type: 'string' },
        timeout: { type: 'string' },
        'allow-http-error': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (positionals.length < 2) throw new UsageError('expected a page URL or HTML file and an output path');
    if (positionals.length > 3) throw new UsageError(`unexpected argument "${positionals[3]}"`);
    if (positionals[2] !== undefined && values.duration !== undefined) {
      throw new UsageError('give the duration either as [seconds] or as --duration, not both');
    }
    const [url, outPath, secondsArg] = positionals;
    const durationRaw = values.duration ?? secondsArg;
    opts = { url, outPath };
    if (durationRaw !== undefined) opts.duration = parseNumberArg('duration', durationRaw);
    if (values.fps !== undefined) opts.fps = parseNumberArg('fps', values.fps);
    if (values.width !== undefined) opts.width = parseNumberArg('width', values.width);
    if (values.height !== undefined) opts.height = parseNumberArg('height', values.height);
    if (values.format !== undefined) opts.format = values.format;
    if (values.poster) opts.poster = true;
    if (values.timeout !== undefined) opts.timeoutMs = parseNumberArg('timeout', values.timeout);
    if (values['allow-http-error']) opts.allowHttpError = true;
    audioPath = values.audio;
  } catch (err) {
    stderr.write(`atelier: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }

  try {
    let normalized;
    try {
      normalized = normalizeOptions(opts);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      stderr.write(`atelier: ${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    if (audioPath !== undefined) {
      const absAudio = resolve(audioPath);
      if (!isFile(absAudio)) throw new Error(`Audio file not found: ${absAudio}`);
      opts.audioSource = (dest) => copyFileSync(absAudio, dest);
    }
    const requested = { width: opts.width ?? 1280, height: opts.height ?? 720 };
    if (normalized.width !== requested.width || normalized.height !== requested.height) {
      stderr.write(`atelier: MP4 needs even dimensions; recording at ${normalized.width}x${normalized.height}\n`);
    }
    // First Ctrl+C: stop, remove the temp frames and exit 2. A second one
    // falls through to Node's default handler.
    const controller = new AbortController();
    const onSigint = () => {
      stderr.write('atelier: stopping and removing temporary frames (Ctrl+C again to force)\n');
      controller.abort(new Error('Recording cancelled'));
    };
    process.once('SIGINT', onSigint);
    let written;
    try {
      written = await recordHtml({ ...opts, signal: controller.signal });
    } catch (err) {
      throw controller.signal.aborted ? controller.signal.reason : err;
    } finally {
      process.removeListener('SIGINT', onSigint);
    }
    stdout.write(`Video written to: ${written}\n`);
    if (normalized.poster) stdout.write(`Poster written to: ${posterPathFor(written)}\n`);
    return 0;
  } catch (err) {
    stderr.write(`${formatError(err)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await runCli();
}

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOnPath as legacyFindOnPath, recordHtml, runCli } from '../plugins/atelier/skills/html-to-video/index.mjs';
import { findOnPath, launchChromium, PreflightError } from '../plugins/atelier/lib/preflight.mjs';

// ---------------------------------------------------------------------------
// Feature detection: resolve ffmpeg the same way recordHtml does, so the skip
// decision matches what the skill will actually be able to spawn.
// ---------------------------------------------------------------------------

const FFMPEG = findOnPath('ffmpeg');
const FFPROBE = findOnPath('ffprobe');
const hasFfmpeg = FFMPEG !== null;
const hasProbe = hasFfmpeg && FFPROBE !== null;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = join(REPO, 'plugins', 'atelier', 'skills', 'html-to-video');
const BIN = join(REPO, 'plugins', 'atelier', 'bin', 'atelier');
const TEMP_PREFIX = 'atelier-h2v-frames-';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp;
let browser;

beforeAll(async () => {
  if (hasFfmpeg) browser = await launchChromium();
});

afterAll(async () => {
  if (browser) await browser.close();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'h2v-test-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  tmp = null;
});

function writeHtml(name, content) {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Point os.tmpdir() at a private dir for the duration of fn, then list what is left in it. */
async function withPrivateTemp(fn) {
  const dir = join(tmp, 'private-temp');
  mkdirSync(dir, { recursive: true });
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = dir;
  process.env.TMP = dir;
  process.env.TMPDIR = dir;
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return readdirSync(dir).filter((n) => n.startsWith(TEMP_PREFIX));
}

/** Writes a 48kHz 16-bit PCM mono silence WAV of the given duration. */
function writeSilenceWav(outPath, seconds) {
  const sampleRate = 48000;
  const dataSize = Math.round(sampleRate * seconds) * 2;
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

function probe(file) {
  const r = spawnSync(FFPROBE, [
    '-v', 'error',
    '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=format_name,duration',
    '-of', 'json',
    file,
  ], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const json = JSON.parse(r.stdout);
  const video = json.streams.find((s) => s.codec_type === 'video');
  const audio = json.streams.find((s) => s.codec_type === 'audio');
  return { format: json.format, video, audio };
}

/** Decode every frame of a video to raw RGB and return a pixel reader. */
function decodeFrames(file, width, height) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 * 1024 * 1024 });
  expect(r.status, String(r.stderr)).toBe(0);
  const frameSize = width * height * 3;
  return {
    count: r.stdout.length / frameSize,
    px(frame, x, y) {
      const o = frame * frameSize + (y * width + x) * 3;
      return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
    },
  };
}

const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;

const SIMPLE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Test Page</title>
<style>body { background: #110f1b; color: #f2cc8f; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; } h1 { font-size: 3rem; }</style>
</head><body><h1>TideWane</h1></body></html>`;

const RED_HTML = '<!DOCTYPE html><html><body style="margin:0;background:rgb(255,0,0)"></body></html>';

// Five 32px stripes that each switch from red to blue at t = 1s, driven by a
// different timing mechanism.
const TIMING_HTML = `<!DOCTYPE html><html><head><style>
html, body { margin: 0; height: 100%; }
.s { position: absolute; top: 0; width: 32px; height: 100%; background: rgb(255,0,0); }
#css { left: 0; animation: flip 1ms linear 1s forwards; }
#tmo { left: 32px; }
#raf { left: 64px; }
#trn { left: 96px; transition: background-color 500ms steps(1, end); }
#trn.on { background: rgb(0,0,255); }
#svg { left: 128px; }
@keyframes flip { from { background: rgb(255,0,0); } to { background: rgb(0,0,255); } }
</style></head><body>
<div class="s" id="css"></div><div class="s" id="tmo"></div><div class="s" id="raf"></div><div class="s" id="trn"></div>
<svg class="s" id="svg" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" fill="rgb(255,0,0)"><set attributeName="fill" to="rgb(0,0,255)" begin="1s" fill="freeze"/></rect></svg>
<script>
const start = performance.now();
setTimeout(() => { document.getElementById('tmo').style.background = 'rgb(0,0,255)'; }, 1000);
setTimeout(() => { document.getElementById('trn').classList.add('on'); }, 500);
(function loop() {
  document.getElementById('raf').style.background = performance.now() - start >= 1000 ? 'rgb(0,0,255)' : 'rgb(255,0,0)';
  requestAnimationFrame(loop);
})();
</script></body></html>`;

// ---------------------------------------------------------------------------
// Option validation: runs everywhere, needs neither ffmpeg nor a browser
// ---------------------------------------------------------------------------

describe('recordHtml option validation', () => {
  const bad = [
    [{ duration: 0 }, /duration must be a positive number/],
    [{ duration: -1 }, /duration must be a positive number/],
    [{ duration: Number.NaN }, /duration must be a positive number, got NaN/],
    [{ duration: '5' }, /duration must be a positive number/],
    [{ fps: 0 }, /fps must be a positive number/],
    [{ fps: Number.POSITIVE_INFINITY }, /fps must be a positive number/],
    [{ fps: 500 }, /fps must be at most 240/],
    [{ duration: 0.01, fps: 30 }, /at least one frame/],
    [{ width: 0 }, /width must be an integer/],
    [{ width: 1.5 }, /width must be an integer/],
    [{ height: -5 }, /height must be an integer/],
    [{ height: 100000 }, /height must be an integer/],
    [{ format: 'gif' }, /format must be "mp4" or "webm"/],
    [{ format: 'mp4', outPath: 'clip.webm' }, /does not match the output extension/],
    [{ format: 'webm', outPath: 'clip.MP4' }, /does not match the output extension/],
    [{ audioSource: 'track.wav' }, /audioSource must be a function/],
    [{ signal: 'stop' }, /signal must be an AbortSignal/],
    [{ outPath: '' }, /outPath is required/],
    [{ url: '' }, /url is required/],
    [{ url: 'localhost:5173/trailer.html' }, /has no scheme; did you mean http:\/\/localhost:5173/],
  ];

  it.each(bad)('rejects %o before doing any work', async (override, message) => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'out', override.outPath ?? 'clip.mp4');
    const opts = { url: page, outPath, ...override };
    if (override.outPath !== undefined) opts.outPath = override.outPath === '' ? '' : join(tmp, 'out', override.outPath);
    const err = await recordHtml(opts).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toMatch(message);
    expect(existsSync(join(tmp, 'out'))).toBe(false);
  });

  it('rejects an outPath that is a directory', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    await expect(recordHtml({ url: page, outPath: tmp })).rejects.toThrow(/outPath must be a file path, not a directory/);
    await expect(recordHtml({ url: page, outPath: 'dist/' })).rejects.toThrow(/not a directory/);
  });

  it('rejects a missing option object', async () => {
    await expect(recordHtml()).rejects.toThrow(/outPath is required/);
  });

  it('names a missing local HTML file (path or file:// URL)', async () => {
    const missing = join(tmp, 'nope.html');
    await expect(recordHtml({ url: missing, outPath: join(tmp, 'o.mp4') })).rejects.toThrow(`HTML file not found: ${missing}`);
    await expect(recordHtml({ url: pathToFileURL(missing).href, outPath: join(tmp, 'o.mp4') })).rejects.toThrow('HTML file not found');
  });

  it('checks for ffmpeg before launching a browser or creating anything', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'out', 'clip.mp4');
    let contexts = 0;
    const fakeBrowser = { newContext: async () => { contexts++; throw new Error('browser used'); } };
    const savedPath = process.env.PATH;
    let err;
    const leaked = await withPrivateTemp(async () => {
      process.env.PATH = '';
      try {
        err = await recordHtml({ url: page, outPath, browser: fakeBrowser }).catch((e) => e);
      } finally {
        process.env.PATH = savedPath;
      }
    });
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.code).toBe('FFMPEG_MISSING');
    expect(err.fix).toBeTruthy();
    expect(contexts).toBe(0);
    expect(leaked).toEqual([]);
    expect(existsSync(join(tmp, 'out'))).toBe(false);
  });

  it('an already aborted signal rejects before any work', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const reason = new Error('stop now');
    const err = await recordHtml({ url: page, outPath: join(tmp, 'out', 'clip.mp4'), signal: AbortSignal.abort(reason) }).catch((e) => e);
    expect(err).toBe(reason);
    expect(existsSync(join(tmp, 'out'))).toBe(false);
  });

  it('still exports findOnPath for older callers', () => {
    expect(legacyFindOnPath).toBe(findOnPath);
  });
});

// ---------------------------------------------------------------------------
// Recording (needs ffmpeg + Chromium)
// ---------------------------------------------------------------------------

describe.skipIf(!hasFfmpeg)('recordHtml', () => {
  it.skipIf(!hasProbe)('writes an H.264 MP4 with exactly duration x fps frames and leaves no temp files', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'output.mp4');
    let result;
    // No `browser` option: exercises the launch-and-close path.
    const leaked = await withPrivateTemp(async () => {
      result = await recordHtml({ url: pathToFileURL(page).href, duration: 1, width: 320, height: 180, fps: 10, outPath });
    });
    expect(result).toBe(outPath);
    expect(leaked).toEqual([]);
    const { format, video, audio } = probe(outPath);
    expect(format.format_name).toMatch(/mp4/);
    expect(video.codec_name).toBe('h264');
    expect([video.width, video.height]).toEqual([320, 180]);
    expect(video.r_frame_rate).toBe('10/1');
    expect(Number(video.nb_read_frames)).toBe(10);
    expect(Number(format.duration)).toBeCloseTo(1, 1);
    expect(audio).toBeUndefined();
  });

  it('frame N shows the page at N / fps seconds (CSS, timers, rAF, transitions, SMIL)', async () => {
    const page = writeHtml('timing.html', TIMING_HTML);
    const outPath = join(tmp, 'timing.mp4');
    await recordHtml({ url: page, duration: 2, width: 160, height: 90, fps: 10, outPath, browser });
    const frames = decodeFrames(outPath, 160, 90);
    expect(frames.count).toBe(20);
    const stripes = { css: 16, timeout: 48, raf: 80, transition: 112, smil: 144 };
    for (const [name, x] of Object.entries(stripes)) {
      for (const f of [0, 5, 9]) expect(isRed(frames.px(f, x, 45)), `${name} at ${f / 10}s should be red: ${frames.px(f, x, 45)}`).toBe(true);
      for (const f of [11, 15, 19]) expect(isBlue(frames.px(f, x, 45)), `${name} at ${f / 10}s should be blue: ${frames.px(f, x, 45)}`).toBe(true);
    }
  });

  it.skipIf(!hasProbe)('writes VP9 WebM for a .webm output and keeps odd sizes', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'output.webm');
    await recordHtml({ url: page, duration: 0.3, width: 321, height: 181, fps: 10, outPath, browser });
    const { format, video } = probe(outPath);
    expect(format.format_name).toMatch(/webm/);
    expect(video.codec_name).toBe('vp9');
    expect([video.width, video.height]).toEqual([321, 181]);
  });

  it.skipIf(!hasProbe)('rounds odd MP4 dimensions up to even instead of failing in libx264', async () => {
    const page = writeHtml('page.html', RED_HTML);
    const outPath = join(tmp, 'odd.mp4');
    await recordHtml({ url: page, duration: 0.1, width: 641, height: 361, fps: 10, outPath, browser });
    const { video } = probe(outPath);
    expect(video.codec_name).toBe('h264');
    expect([video.width, video.height]).toEqual([642, 362]);
    // The page is laid out at the rounded size: no padding bar on the edge.
    const frames = decodeFrames(outPath, 642, 362);
    expect(isRed(frames.px(0, 641, 361))).toBe(true);
  });

  it.skipIf(!hasProbe)('picks the container from format when the extension does not decide it', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const noExt = join(tmp, 'clip');
    await recordHtml({ url: page, duration: 0.2, width: 160, height: 90, fps: 10, outPath: noExt, browser });
    expect(probe(noExt).format.format_name).toMatch(/mp4/);

    const other = join(tmp, 'clip.video');
    await recordHtml({ url: page, duration: 0.2, width: 160, height: 90, fps: 10, outPath: other, format: 'webm', browser });
    expect(probe(other).format.format_name).toMatch(/webm/);

    const withAudio = join(tmp, 'clip-audio');
    await recordHtml({
      url: page, duration: 0.5, width: 160, height: 90, fps: 10, outPath: withAudio, browser,
      audioSource: (wav) => writeSilenceWav(wav, 0.5),
    });
    const probed = probe(withAudio);
    expect(probed.format.format_name).toMatch(/mp4/);
    expect(probed.audio.codec_name).toBe('aac');
  });

  it('accepts a relative or absolute local file path as url', async () => {
    const page = writeHtml('page.html', RED_HTML);
    const rel = relative(process.cwd(), page);
    const a = join(tmp, 'rel.mp4');
    const b = join(tmp, 'abs.mp4');
    await recordHtml({ url: rel, duration: 0.1, width: 64, height: 48, fps: 10, outPath: a, browser });
    await recordHtml({ url: page, duration: 0.1, width: 64, height: 48, fps: 10, outPath: b, browser });
    expect(isRed(decodeFrames(a, 64, 48).px(0, 32, 24))).toBe(true);
    expect(isRed(decodeFrames(b, 64, 48).px(0, 32, 24))).toBe(true);
  });

  it.skipIf(!hasProbe)('muxes audio from audioSource (AAC in MP4, Opus in WebM)', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    for (const [ext, codec] of [['mp4', 'aac'], ['webm', 'opus']]) {
      const outPath = join(tmp, `output.${ext}`);
      let received;
      await recordHtml({
        url: page, duration: 0.5, width: 160, height: 90, fps: 10, outPath, browser,
        audioSource: (wavPath) => { received = wavPath; writeSilenceWav(wavPath, 0.5); },
      });
      const { video, audio } = probe(outPath);
      expect(video).toBeDefined();
      expect(audio.codec_name).toBe(codec);
      expect(received.endsWith('.wav')).toBe(true);
      expect(existsSync(received)).toBe(false);
    }
  });

  it('rejects an empty audioSource without leaking frames or clobbering the output', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'output.mp4');
    writeFileSync(outPath, 'previous render');
    let err;
    const leaked = await withPrivateTemp(async () => {
      err = await recordHtml({
        url: page, duration: 1, width: 160, height: 90, fps: 10, outPath, browser,
        audioSource: async () => { /* intentionally writes nothing */ },
      }).catch((e) => e);
    });
    expect(err.message).toMatch(/audioSource wrote an empty or missing file/);
    expect(leaked).toEqual([]);
    expect(readFileSync(outPath, 'utf8')).toBe('previous render');
  });

  it('cleans up when audioSource throws or the page cannot load', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const outPath = join(tmp, 'output.mp4');
    const errors = [];
    const leaked = await withPrivateTemp(async () => {
      errors.push(await recordHtml({
        url: page, duration: 0.2, width: 160, height: 90, fps: 10, outPath, browser,
        audioSource: () => { throw new Error('synth exploded'); },
      }).catch((e) => e));
      errors.push(await recordHtml({
        url: 'http://127.0.0.1:9/', duration: 0.2, width: 160, height: 90, fps: 10, outPath, browser,
      }).catch((e) => e));
    });
    expect(errors[0].message).toBe('synth exploded');
    expect(errors[1]).toBeInstanceOf(Error);
    expect(leaked).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  });

  it('aborting mid-capture stops, removes the temp frames and writes nothing', async () => {
    const page = writeHtml('timing.html', TIMING_HTML);
    const outPath = join(tmp, 'aborted.mp4');
    const controller = new AbortController();
    const reason = new Error('Recording cancelled');
    let err;
    const started = Date.now();
    const leaked = await withPrivateTemp(async () => {
      const timer = setTimeout(() => controller.abort(reason), 400);
      err = await recordHtml({ url: page, duration: 60, width: 160, height: 90, fps: 30, outPath, browser, signal: controller.signal }).catch((e) => e);
      clearTimeout(timer);
    });
    expect(err).toBe(reason);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(leaked).toEqual([]);
    expect(existsSync(outPath)).toBe(false);
  });

  it('poster writes the first frame as a JPEG next to the video', async () => {
    const page = writeHtml('page.html', `<!DOCTYPE html><html><head><style>
      body { margin: 0; height: 100vh; background: rgb(255,0,0); animation: f 1ms linear 0.2s forwards; }
      @keyframes f { to { background: rgb(0,0,255); } }</style></head><body></body></html>`);
    const outPath = join(tmp, 'output.mp4');
    await recordHtml({ url: page, duration: 0.5, width: 160, height: 90, fps: 10, outPath, poster: true, browser });
    const posterPath = join(tmp, 'output-poster.jpg');
    expect(existsSync(outPath)).toBe(true);
    const jpg = readFileSync(posterPath);
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect(isRed(decodeFrames(posterPath, 160, 90).px(0, 80, 45))).toBe(true);
    expect(isBlue(decodeFrames(outPath, 160, 90).px(4, 80, 45))).toBe(true);
  });

  it('passes shell metacharacters in outPath through literally (PR #11 regression)', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const dir = join(tmp, 'a & b');
    // Characters cmd.exe would act on, all legal in Windows file names.
    const name = 'x & echo pwned ^ 50% (1)';
    const outPath = join(dir, `${name}.mp4`);
    await recordHtml({ url: page, duration: 0.1, width: 64, height: 48, fps: 10, outPath, poster: true, browser });
    expect(statSync(outPath).size).toBeGreaterThan(0);
    expect(readdirSync(dir).sort()).toEqual([`${name}-poster.jpg`, `${name}.mp4`]);
    expect(readdirSync(tmp).sort()).toEqual(['a & b', 'page.html']);
  });

  it('waits for the load event before the first frame', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
    const server = createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<html><body style="margin:0;background:#fff"><img src="/hero.png" style="display:block;width:100vw;height:100vh"></body></html>');
        return;
      }
      setTimeout(() => { res.setHeader('content-type', 'image/png'); res.end(png); }, 600);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const outPath = join(tmp, 'slow.mp4');
      await recordHtml({ url: `http://127.0.0.1:${server.address().port}/`, duration: 0.2, width: 64, height: 48, fps: 10, outPath, poster: true, browser });
      expect(isRed(decodeFrames(outPath, 64, 48).px(0, 32, 24))).toBe(true);
      expect(isRed(decodeFrames(join(tmp, 'slow-poster.jpg'), 64, 48).px(0, 32, 24))).toBe(true);
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write: (s) => { out.stdout += s; } },
      stderr: { write: (s) => { out.stderr += s; } },
    },
  };
}

describe('html-to-video CLI', () => {
  it('--help prints usage to stdout and exits 0', async () => {
    const { out, io } = capture();
    expect(await runCli(['--help'], io)).toBe(0);
    expect(out.stdout).toMatch(/^Usage: atelier video/);
    expect(out.stdout).toMatch(/--poster/);
    expect(out.stderr).toBe('');
  });

  it.each([
    [[], /expected a page URL or HTML file and an output path/],
    [['--bogus'], /Unknown option '--bogus'/],
    [['a.html', 'b.mp4', '1', 'extra'], /unexpected argument "extra"/],
    [['a.html', 'b.mp4', 'abc'], /--duration must be a number, got "abc"/],
    [['a.html', 'b.mp4', '--fps', ''], /--fps must be a number/],
    [['a.html', 'b.mp4', '1', '--duration', '2'], /either as \[seconds\] or as --duration/],
    [['a.html', 'b.webm', '--format', 'mp4'], /does not match the output extension/],
    [['a.html', 'b.mp4', '--width', '12.5'], /width must be an integer/],
  ])('usage error %j prints usage to stderr and exits 2', async (argv, message) => {
    const { out, io } = capture();
    expect(await runCli(argv, io)).toBe(2);
    expect(out.stderr).toMatch(message);
    expect(out.stderr).toMatch(/Usage: atelier video/);
    expect(out.stdout).toBe('');
  });

  it('runtime errors print one atelier: line and exit 2', async () => {
    const { out, io } = capture();
    const missing = join(tmp, 'missing.html');
    expect(await runCli([missing, join(tmp, 'o.mp4')], io)).toBe(2);
    expect(out.stderr).toBe(`atelier: HTML file not found: ${missing}\n`);

    const page = writeHtml('page.html', SIMPLE_HTML);
    const c2 = capture();
    expect(await runCli([page, join(tmp, 'o.mp4'), '--audio', join(tmp, 'none.wav')], c2.io)).toBe(2);
    expect(c2.out.stderr).toMatch(/^atelier: Audio file not found: /);
  });

  it.skipIf(!hasProbe)('records with --fps/--width/--height/--poster/--audio', async () => {
    const page = writeHtml('page.html', SIMPLE_HTML);
    const wav = join(tmp, 'track.wav');
    writeSilenceWav(wav, 0.5);
    const outPath = join(tmp, 'cli.mp4');
    const { out, io } = capture();
    const code = await runCli([page, outPath, '0.5', '--fps', '10', '--width', '161', '--height', '90', '--poster', '--audio', wav], io);
    expect(code, out.stderr).toBe(0);
    expect(out.stdout).toBe(`Video written to: ${outPath}\nPoster written to: ${join(tmp, 'cli-poster.jpg')}\n`);
    expect(out.stderr).toMatch(/recording at 162x90/);
    const { video, audio } = probe(outPath);
    expect([video.width, video.height]).toEqual([162, 90]);
    expect(Number(video.nb_read_frames)).toBe(5);
    expect(audio.codec_name).toBe('aac');
  });

  it('bin/atelier video --help exits 0', () => {
    const r = spawnSync(process.execPath, [BIN, 'video', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: atelier video/);
  });

  it('runs when reached through a symlink or junction', () => {
    const link = join(tmp, 'linked-skill');
    symlinkSync(SKILL_DIR, link, process.platform === 'win32' ? 'junction' : 'dir');
    const help = spawnSync(process.execPath, [join(link, 'index.mjs'), '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: atelier video/);
    const noArgs = spawnSync(process.execPath, [join(link, 'index.mjs')], { encoding: 'utf8' });
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toMatch(/Usage: atelier video/);
  });
});

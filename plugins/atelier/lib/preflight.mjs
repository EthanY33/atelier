/**
 * Preflight helpers shared by atelier skills.
 *
 * Find binaries on PATH without ever going through a shell, check that
 * Playwright's Chromium is installed, and turn a missing dependency into one
 * actionable message instead of a stack trace.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

/** Thrown when a prerequisite is missing. `fix` is the command that repairs it. */
export class PreflightError extends Error {
  constructor(message, { code, fix, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PreflightError';
    this.code = code;
    this.fix = fix;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// A plain env object (not process.env) is case sensitive, and Windows spells
// the variable `Path`. Prefer an exact `PATH`, as before, then any casing.
function pathFromEnv(env, win) {
  if (env.PATH != null) return String(env.PATH);
  if (win) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
    if (key && env[key] != null) return String(env[key]);
  }
  return env.Path != null ? String(env.Path) : '';
}

/**
 * Resolve an executable on PATH, the way a shell would, without a shell.
 * On Windows only .exe and .com are returned: .cmd/.bat shims cannot be
 * spawned without `shell: true`, which atelier never uses. On other
 * platforms a file must carry the execute bit. Directories never match.
 *
 * A name that contains a path separator (absolute, or relative such as
 * `./bin/ffmpeg`) is checked directly and never searched on PATH. The
 * current directory is never searched implicitly. `platform` selects the
 * lookup rules (extensions, execute bit, PATH separator); the filesystem
 * searched is always the host's.
 *
 * @param {string} name - Bare command name (e.g. 'ffmpeg') or a path.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {string|null} Absolute path, or null when not found.
 */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const win = platform === 'win32';
  const runnable = (file) => isFile(file) && (win || isExecutable(file));
  // On Windows a name counts as given only when it already ends in .exe/.com.
  const candidates = (base) => (!win || /\.(exe|com)$/i.test(base) ? [base] : [`${base}.exe`, `${base}.com`]);
  const first = (base) => candidates(base).find(runnable) ?? null;

  if (isAbsolute(name)) return first(name);
  if (win ? /[\\/]/.test(name) : name.includes('/')) return first(resolve(name));

  for (let dir of pathFromEnv(env, win).split(win ? ';' : delimiter)) {
    // Windows drops every double quote in a PATH entry ("C:\Program Files\x").
    dir = win ? dir.replaceAll('"', '').trim() : dir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const hit = first(join(dir, name));
    if (hit) return hit;
  }
  return null;
}

const firstLine = (s) => s.trim().split(/\r?\n/)[0]?.trim() ?? '';
const MAX_OUTPUT = 64 * 1024;

/**
 * Check whether a CLI binary is available and runs. Never uses a shell:
 * arguments reach the binary literally.
 * @param {string} cmd - Command name or absolute path (e.g. 'node', 'ffmpeg').
 * @param {string[]} [args=['--version']] - Arguments; ffmpeg wants ['-version'].
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 *   env: environment used to resolve `cmd` and passed to the child (default process.env).
 *   timeoutMs: kill the child and report failure after this long (default 15000).
 * @returns {Promise<{ ok: boolean, path?: string, version?: string, error?: string }>}
 */
export function checkBinary(cmd, args = ['--version'], { env = process.env, timeoutMs = 15_000 } = {}) {
  const path = findOnPath(cmd, { env });
  if (!path) return Promise.resolve({ ok: false, error: `${cmd} not found on PATH` });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(path, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      // spawn throws synchronously for some inputs (e.g. EINVAL on Windows).
      done({ ok: false, path, error: err.message });
      return;
    }
    // Settle on the timeout itself: a grandchild holding the pipes open would
    // otherwise delay 'close' indefinitely.
    timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      done({ ok: false, path, error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUTPUT) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUTPUT) stderr += c; });
    child.on('error', (err) => done({ ok: false, path, error: err.message }));
    child.on('close', (code, signal) => {
      if (code === 0) return done({ ok: true, path, version: firstLine(stdout) || firstLine(stderr) });
      const why = firstLine(stderr) || firstLine(stdout);
      done({ ok: false, path, error: why || (signal ? `killed by ${signal}` : `exited with code ${code}`) });
    });
  });
}

/**
 * Check whether a Node module resolves from the plugin's node_modules.
 * @param {string} name - Module name (e.g. 'sharp').
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function checkNodeModule(name) {
  try {
    require.resolve(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run a batch of preflight checks and throw one aggregated PreflightError.
 * @param {Array<{ kind: 'bin'|'module', cmd?: string, name?: string, args?: string[], install?: string }>} checks
 * @returns {Promise<Array<object>>} Per-check results on success.
 */
export async function runPreflight(checks) {
  const results = [];
  const failures = [];
  for (const check of checks) {
    let result;
    if (check.kind === 'bin') result = await checkBinary(check.cmd, check.args);
    else if (check.kind === 'module') result = await checkNodeModule(check.name);
    else {
      failures.push(`Unknown preflight check kind: ${check.kind}`);
      continue;
    }
    results.push({ ...check, ...result });
    if (!result.ok) {
      const what = check.kind === 'bin' ? `binary: ${check.cmd}` : `module: ${check.name}`;
      failures.push(`Missing ${what}${check.install ? `\n  Install: ${check.install}` : ''}`);
    }
  }
  if (failures.length > 0) {
    throw new PreflightError(`Preflight failed:\n${failures.join('\n')}`, { code: 'PREFLIGHT_FAILED' });
  }
  return results;
}

/** Installed Playwright version, or null when Playwright itself is missing. */
export function playwrightVersion() {
  try {
    return require('playwright/package.json').version;
  } catch {
    return null;
  }
}

const npxPlaywright = () => {
  const v = playwrightVersion();
  return `npx playwright${v ? `@${v}` : ''}`;
};

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (err) {
    throw new PreflightError(
      'Playwright is not installed next to the atelier plugin.',
      { code: 'PLAYWRIGHT_MISSING', fix: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.', cause: err },
    );
  }
}

// Playwright's "browser not downloaded" error, and its (Linux) "shared
// libraries missing" error. The second also mentions `playwright install`
// (as `install-deps`), so it is checked first.
const DEPS_MISSING = /Host system is missing dependencies|playwright install-deps/i;
const BROWSER_MISSING = /Executable doesn't exist|please run the following command to download new browsers|playwright install/i;

/**
 * Launch Playwright's Chromium, converting "browser not downloaded" into a
 * PreflightError (code CHROMIUM_MISSING) whose `fix` is the exact install
 * command for this version. Missing Linux system libraries become
 * CHROMIUM_DEPS_MISSING with the matching `install-deps` command.
 * @param {import('playwright').LaunchOptions} [launchOptions]
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromium(launchOptions = {}) {
  const chromium = await loadChromium();
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (DEPS_MISSING.test(message)) {
      throw new PreflightError('Chromium cannot start: system libraries it needs are missing.', {
        code: 'CHROMIUM_DEPS_MISSING',
        fix: `sudo ${npxPlaywright()} install-deps chromium`,
        cause: err,
      });
    }
    // A caller-supplied executablePath is not something `playwright install` fixes.
    if (BROWSER_MISSING.test(message) && !launchOptions?.executablePath) {
      const channel = launchOptions?.channel;
      const browser = channel && !/^chromium/.test(channel) ? channel : 'chromium';
      throw new PreflightError(`Playwright ${browser === 'chromium' ? 'Chromium' : `browser channel "${browser}"`} is not installed.`, {
        code: 'CHROMIUM_MISSING',
        fix: `${npxPlaywright()} install ${browser}`,
        cause: err,
      });
    }
    throw err;
  }
}

function ffmpegInstallHint(platform) {
  if (platform === 'win32') return 'winget install Gyan.FFmpeg  (or: choco install ffmpeg), then restart the terminal';
  if (platform === 'darwin') return 'brew install ffmpeg';
  return 'sudo apt install ffmpeg  (or your distro\'s package manager)';
}

/**
 * Resolve ffmpeg on PATH or throw a PreflightError with per-OS install hints.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts] - Same as findOnPath.
 * @returns {string} Absolute path to ffmpeg.
 */
export function ensureFfmpeg({ env = process.env, platform = process.platform } = {}) {
  const found = findOnPath('ffmpeg', { env, platform });
  if (found) return found;
  throw new PreflightError('ffmpeg was not found on PATH.', { code: 'FFMPEG_MISSING', fix: ffmpegInstallHint(platform) });
}

function messageOf(err) {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Human-readable rendering of any error for CLI output: `atelier: <message>`,
 * plus `\n  Fix: <fix>` when the error carries a fix (every PreflightError
 * does; any error with a string `fix` property is treated the same way).
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  const fix = err && typeof err === 'object' && typeof err.fix === 'string' && err.fix ? err.fix : null;
  return `atelier: ${messageOf(err)}${fix ? `\n  Fix: ${fix}` : ''}`;
}

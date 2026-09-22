/**
 * Preflight helpers shared by atelier skills.
 *
 * Find binaries on PATH without ever going through a shell, check that
 * Playwright's Chromium is installed, and turn a missing dependency into one
 * actionable message instead of a stack trace.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, isAbsolute, join } from 'node:path';

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

/**
 * Resolve an executable on PATH, the way a shell would, without a shell.
 * On Windows only .exe and .com are returned: .cmd/.bat shims cannot be
 * spawned without `shell: true`, which atelier never uses.
 *
 * @param {string} name - Bare command name (e.g. 'ffmpeg') or an absolute path.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {string|null} Absolute path, or null when not found.
 */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  if (isAbsolute(name)) return isFile(name) ? name : null;
  const exts = platform === 'win32' ? ['.exe', '.com', ''] : [''];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (let dir of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      // On Windows, a bare name only counts when it already carries .exe/.com.
      if (platform === 'win32' && ext === '' && !/\.(exe|com)$/i.test(name)) continue;
      const candidate = join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Check whether a CLI binary is available and runs.
 * @param {string} cmd - Command name or absolute path (e.g. 'node', 'ffmpeg').
 * @param {string[]} [args=['--version']] - Arguments; ffmpeg wants ['-version'].
 * @returns {Promise<{ ok: boolean, path?: string, version?: string, error?: string }>}
 */
export function checkBinary(cmd, args = ['--version']) {
  const path = findOnPath(cmd);
  if (!path) return Promise.resolve({ ok: false, error: `${cmd} not found on PATH` });
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(path, args, { shell: false, windowsHide: true, timeout: 15_000 });
    child.stdout?.on('data', (c) => { out += c; });
    child.stderr?.on('data', (c) => { out += c; });
    child.on('error', (err) => done({ ok: false, path, error: err.message }));
    child.on('close', (code) => {
      const first = out.trim().split(/\r?\n/)[0]?.trim() ?? '';
      done(code === 0 ? { ok: true, path, version: first } : { ok: false, path, error: first || `exited with code ${code}` });
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

const installChromiumFix = () => {
  const v = playwrightVersion();
  return `npx playwright${v ? `@${v}` : ''} install chromium`;
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

/**
 * Launch Playwright's Chromium, converting "browser not downloaded" into a
 * PreflightError whose `fix` is the exact install command for this version.
 * @param {import('playwright').LaunchOptions} [launchOptions]
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromium(launchOptions = {}) {
  const chromium = await loadChromium();
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    if (/Executable doesn't exist|please run the following command to download new browsers|playwright install/i.test(String(err?.message))) {
      throw new PreflightError('Playwright Chromium is not installed.', {
        code: 'CHROMIUM_MISSING',
        fix: installChromiumFix(),
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Resolve ffmpeg on PATH or throw a PreflightError with per-OS install hints.
 * @returns {string} Absolute path to ffmpeg.
 */
export function ensureFfmpeg() {
  const found = findOnPath('ffmpeg');
  if (found) return found;
  const fix = process.platform === 'win32'
    ? 'winget install Gyan.FFmpeg  (or: choco install ffmpeg), then restart the terminal'
    : process.platform === 'darwin'
      ? 'brew install ffmpeg'
      : 'sudo apt install ffmpeg  (or your distro\'s package manager)';
  throw new PreflightError('ffmpeg was not found on PATH.', { code: 'FFMPEG_MISSING', fix });
}

/**
 * One-line, human-readable rendering of any error for CLI output. Preflight
 * errors get their fix appended; other errors keep their message.
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  if (err instanceof PreflightError) return `atelier: ${err.message}${err.fix ? `\n  Fix: ${err.fix}` : ''}`;
  return `atelier: ${err instanceof Error ? err.message : String(err)}`;
}

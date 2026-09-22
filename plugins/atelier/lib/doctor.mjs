/**
 * `atelier doctor`: check everything the skills need, in one place, and say
 * exactly how to fix what is missing.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readJsonFile } from './io.mjs';
import { checkBinary, ensureFfmpeg, launchChromium, PreflightError } from './preflight.mjs';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MIN_NODE_MAJOR = 22;

/**
 * @typedef {{ name: string, status: 'ok'|'warn'|'fail', detail: string, fix?: string }} Check
 */

// A dependency counts as installed when either resolver finds it, so an
// ESM-only package (no "require" export) is not reported missing.
function resolves(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    try {
      import.meta.resolve(name);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Run every check.
 * @param {{ cwd?: string, launchBrowser?: boolean }} [opts]
 *   launchBrowser: actually start Chromium (slower, but proves it runs).
 * @returns {Promise<{ ok: boolean, version: string, pluginRoot: string, checks: Check[] }>}
 */
export async function runDoctor({ cwd = process.cwd(), launchBrowser = true } = {}) {
  const pkg = readJsonFile(join(pluginRoot, 'package.json'));
  const checks = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push(major >= MIN_NODE_MAJOR
    ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : { name: 'node', status: 'fail', detail: `v${process.versions.node}; atelier needs ${MIN_NODE_MAJOR}+`, fix: 'Install Node.js 22 LTS or newer from https://nodejs.org' });

  const deps = Object.keys(pkg.dependencies ?? {});
  const missing = deps.filter((d) => !resolves(d));
  checks.push(missing.length === 0
    ? { name: 'dependencies', status: 'ok', detail: `${deps.length} of ${deps.length} resolve` }
    : { name: 'dependencies', status: 'fail', detail: `missing: ${missing.join(', ')}`, fix: `Reinstall the plugin (/plugin install atelier@atelier), or run: npm ci --prefix "${pluginRoot}"` });

  try {
    const sharp = (await import('sharp')).default;
    checks.push({ name: 'sharp', status: 'ok', detail: `libvips ${sharp.versions.vips}` });
  } catch (err) {
    checks.push({ name: 'sharp', status: 'fail', detail: firstLine(err), fix: `npm ci --prefix "${pluginRoot}"` });
  }

  if (launchBrowser) {
    try {
      const browser = await launchChromium();
      const version = browser.version();
      await browser.close();
      checks.push({ name: 'chromium', status: 'ok', detail: `${version} (og-card, a11y, video, ux --dynamic)` });
    } catch (err) {
      checks.push({ name: 'chromium', status: 'warn', detail: err instanceof PreflightError ? err.message : firstLine(err), fix: err?.fix ?? 'npx playwright install chromium' });
    }
  }

  checks.push(await ffmpegCheck());

  const brandPath = join(cwd, '.atelier', 'brand.json');
  if (!existsSync(brandPath)) {
    checks.push({ name: 'brand.json', status: 'warn', detail: `none at ${brandPath}`, fix: 'Run /brand-init in Claude Code, or see: atelier brand --help' });
  } else {
    try {
      const { loadBrand } = await import(pathToFileURL(join(pluginRoot, 'skills', 'brand-memory', 'index.mjs')).href);
      const cfg = await loadBrand(cwd);
      checks.push({ name: 'brand.json', status: 'ok', detail: `${cfg.brand?.studio ?? 'unnamed'} (${Object.keys(cfg.palette ?? {}).length} colors)` });
    } catch (err) {
      checks.push({ name: 'brand.json', status: 'fail', detail: firstLine(err), fix: 'Fix the reported field, or run /brand-audit' });
    }
  }

  return { ok: checks.every((c) => c.status !== 'fail'), version: pkg.version, pluginRoot, checks };
}

// ffmpeg is optional (only html-to-video needs it), so problems are warnings.
async function ffmpegCheck() {
  let path;
  try {
    path = ensureFfmpeg();
  } catch (err) {
    return { name: 'ffmpeg', status: 'warn', detail: 'not on PATH (only html-to-video needs it)', fix: err.fix };
  }
  const run = await checkBinary(path, ['-version']);
  if (!run.ok) {
    return { name: 'ffmpeg', status: 'warn', detail: `${path} does not run: ${run.error}`, fix: 'Reinstall ffmpeg, or put a working ffmpeg first on PATH' };
  }
  const version = /ffmpeg version (\S+)/.exec(run.version)?.[1];
  return { name: 'ffmpeg', status: 'ok', detail: version ? `${version} (${path})` : path };
}

/**
 * Render doctor results as aligned plain text.
 * @param {Awaited<ReturnType<typeof runDoctor>>} result
 * @returns {string}
 */
export function formatDoctor(result) {
  const lines = [`atelier ${result.version} doctor  (${result.pluginRoot})`, ''];
  const w = Math.max(0, ...result.checks.map((c) => c.name.length));
  for (const c of result.checks) {
    lines.push(`  ${c.status.padEnd(4)}  ${c.name.padEnd(w)}  ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`  ${''.padEnd(4)}  ${''.padEnd(w)}  fix: ${c.fix}`);
  }
  lines.push('', result.ok ? 'Ready.' : 'Not ready: fix the failing checks above.');
  return lines.join('\n');
}

function firstLine(err) {
  return String(err?.message ?? err).split(/\r?\n/)[0];
}

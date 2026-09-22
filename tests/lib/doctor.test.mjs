import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDoctor, runDoctor } from '../../plugins/atelier/lib/doctor.mjs';
import { findOnPath } from '../../plugins/atelier/lib/preflight.mjs';
import { binPath, envWithPath, isWin, makeTmp, pluginRoot, runNode, touch } from './helpers.mjs';

const hasFfmpeg = findOnPath('ffmpeg') !== null;
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('doctor')); });
afterEach(() => cleanup());

const byName = (result) => Object.fromEntries(result.checks.map((c) => [c.name, c]));

function writeBrand(dir, content) {
  mkdirSync(join(dir, '.atelier'), { recursive: true });
  writeFileSync(join(dir, '.atelier', 'brand.json'), content);
}

/** Run with process.env.PATH replaced, restoring every casing afterwards. */
async function withPath(path, fn) {
  const saved = Object.entries(process.env).filter(([k]) => k.toUpperCase() === 'PATH');
  for (const [k] of saved) delete process.env[k];
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    delete process.env.PATH;
    for (const [k, v] of saved) process.env[k] = v;
  }
}

describe('runDoctor without launching a browser', () => {
  it('reports a missing brand.json as a warning, not a failure', async () => {
    const result = await runDoctor({ cwd: tmp, launchBrowser: false });
    const checks = byName(result);
    expect(result.version).toBe(pkg.version);
    expect(result.pluginRoot).toBe(pluginRoot);
    expect(result.checks.map((c) => c.name)).toEqual(['node', 'dependencies', 'sharp', 'ffmpeg', 'brand.json']);
    expect(checks.node).toMatchObject({ status: 'ok', detail: `v${process.versions.node}` });
    const deps = Object.keys(pkg.dependencies).length;
    expect(checks.dependencies).toMatchObject({ status: 'ok', detail: `${deps} of ${deps} resolve` });
    expect(checks.sharp.status).toBe('ok');
    expect(checks.sharp.detail).toMatch(/^libvips \d+\.\d+/);
    expect(checks['brand.json']).toMatchObject({ status: 'warn', detail: `none at ${join(tmp, '.atelier', 'brand.json')}` });
    expect(checks['brand.json'].fix).toMatch(/\/brand-init/);
    expect(result.ok).toBe(true);
  });

  it('accepts a valid brand.json', async () => {
    mkdirSync(join(tmp, '.atelier'));
    copyFileSync(join(pluginRoot, 'examples', 'brand.json'), join(tmp, '.atelier', 'brand.json'));
    const result = await runDoctor({ cwd: tmp, launchBrowser: false });
    expect(byName(result)['brand.json']).toEqual({ name: 'brand.json', status: 'ok', detail: 'goneIdle (4 colors)' });
    expect(result.ok).toBe(true);
  });

  it('fails on a brand.json that breaks the schema', async () => {
    writeBrand(tmp, JSON.stringify({ brand: {} }));
    const result = await runDoctor({ cwd: tmp, launchBrowser: false });
    const brand = byName(result)['brand.json'];
    expect(brand.status).toBe('fail');
    expect(brand.detail).toMatch(/brand\.json/);
    expect(brand.detail).not.toMatch(/\n/);
    expect(brand.fix).toMatch(/\/brand-audit/);
    expect(result.ok).toBe(false);
  });

  it('fails on a brand.json that is not JSON', async () => {
    writeBrand(tmp, '{ not json');
    const result = await runDoctor({ cwd: tmp, launchBrowser: false });
    expect(byName(result)['brand.json'].status).toBe('fail');
    expect(result.ok).toBe(false);
  });

  it.skipIf(!hasFfmpeg)('reports the ffmpeg version and path when ffmpeg runs', async () => {
    const result = await runDoctor({ cwd: tmp, launchBrowser: false });
    const ffmpeg = byName(result).ffmpeg;
    // Whole-object match so a failure shows the detail and fix.
    expect(ffmpeg).toMatchObject({ name: 'ffmpeg', status: 'ok' });
    expect(ffmpeg.detail).toContain(findOnPath('ffmpeg'));
    expect(ffmpeg.detail).toMatch(/^\S+ \(/);
  });

  it('warns, with an install hint, when ffmpeg is not on PATH', async () => {
    const result = await withPath('', () => runDoctor({ cwd: tmp, launchBrowser: false }));
    const ffmpeg = byName(result).ffmpeg;
    expect(ffmpeg).toMatchObject({ status: 'warn', detail: 'not on PATH (only html-to-video needs it)' });
    expect(ffmpeg.fix).toMatch(/winget|brew|apt/);
    expect(result.ok).toBe(true);
  });

  it('warns when the ffmpeg on PATH does not run', async () => {
    const bin = join(tmp, 'bin');
    if (isWin) touch(join(bin, 'ffmpeg.exe'), 'not a PE file');
    else touch(join(bin, 'ffmpeg'), '#!/bin/sh\necho "broken ffmpeg" >&2\nexit 1\n');
    const result = await withPath(bin, () => runDoctor({ cwd: tmp, launchBrowser: false }));
    const ffmpeg = byName(result).ffmpeg;
    expect(ffmpeg.status).toBe('warn');
    expect(ffmpeg.detail).toMatch(/does not run/);
    expect(ffmpeg.fix).toBeTruthy();
  });
});

describe('runDoctor with a browser', () => {
  it('adds a chromium check that is ok or an actionable warning', async () => {
    const result = await runDoctor({ cwd: tmp });
    const chromium = byName(result).chromium;
    expect(result.checks.map((c) => c.name)).toContain('chromium');
    expect(['ok', 'warn']).toContain(chromium.status);
    if (chromium.status === 'warn') expect(chromium.fix).toMatch(/playwright/);
  });

  it('warns with the exact install command when Chromium is missing', () => {
    const empty = join(tmp, 'browsers');
    mkdirSync(empty);
    const r = runNode([binPath, 'doctor', '--json'], { cwd: tmp, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } });
    expect(r.status).toBe(0);
    const chromium = byName(JSON.parse(r.stdout)).chromium;
    expect(chromium).toMatchObject({ status: 'warn', detail: 'Playwright Chromium is not installed.' });
    expect(chromium.fix).toBe(`npx playwright@${pkg.dependencies.playwright} install chromium`);
  });
});

describe('formatDoctor', () => {
  const result = {
    ok: false,
    version: '9.9.9',
    pluginRoot: '/plugin',
    checks: [
      { name: 'node', status: 'ok', detail: 'v22.0.0' },
      { name: 'dependencies', status: 'fail', detail: 'missing: sharp', fix: 'npm ci' },
      { name: 'ffmpeg', status: 'warn', detail: 'not on PATH', fix: 'brew install ffmpeg' },
      { name: 'x', status: 'ok', detail: 'fine', fix: 'never shown for ok checks' },
    ],
  };

  it('aligns names and puts each fix under its check', () => {
    expect(formatDoctor(result)).toBe([
      'atelier 9.9.9 doctor  (/plugin)',
      '',
      '  ok    node          v22.0.0',
      '  fail  dependencies  missing: sharp',
      '                      fix: npm ci',
      '  warn  ffmpeg        not on PATH',
      '                      fix: brew install ffmpeg',
      '  ok    x             fine',
      '',
      'Not ready: fix the failing checks above.',
    ].join('\n'));
  });

  it('ends with Ready. when nothing failed', () => {
    expect(formatDoctor({ ...result, ok: true }).endsWith('\nReady.')).toBe(true);
  });

  it('copes with an empty check list', () => {
    expect(formatDoctor({ ok: true, version: '1', pluginRoot: '/p', checks: [] })).toBe('atelier 1 doctor  (/p)\n\n\nReady.');
  });

  it('formats a real result', async () => {
    const text = formatDoctor(await runDoctor({ cwd: tmp, launchBrowser: false }));
    expect(text).toMatch(/^atelier \S+ doctor {2}\(/);
    expect(text).toMatch(/^ {2}ok {4}node {2}/m);
    expect(text).toMatch(/^ {2}warn {2}brand\.json/m);
    expect(text.endsWith('Ready.')).toBe(true);
  });
});

describe('atelier doctor from the command line', () => {
  it('exits 1 and says not ready when brand.json is invalid', () => {
    writeBrand(tmp, '{ not json');
    const r = runNode([binPath, 'doctor', '--no-browser'], { cwd: tmp });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^ {2}fail {2}brand\.json/m);
    expect(r.stdout).toMatch(/Not ready/);
  });

  it('prints parseable JSON with --json even when PATH is empty', () => {
    const r = runNode([binPath, 'doctor', '--no-browser', '--json'], { cwd: tmp, env: envWithPath('') });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(byName(parsed).ffmpeg.status).toBe('warn');
    expect(byName(parsed).chromium).toBeUndefined();
  });
});

/**
 * End-to-end tests for runtime-ux-audit: the full static pipeline on a
 * realistic site, the CLI exit codes through a real child process, schema
 * validation, determinism, the static performance budget, and one dynamic
 * run in Chromium (skipped when Playwright's Chromium is not installed).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020, addFormats } from '../helpers/plugin-deps.mjs';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { USAGE } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';
import {
  FIXED_TS, FIXTURES_DIR, REPO_ROOT, SKILL_DIR, chromiumAvailable, expectAsciiNoDash, expectGolden, rawJson, tempDir, writeFiles,
} from './helpers.mjs';

const SITE = join(FIXTURES_DIR, 'e2e', 'index.html');
const CLEAN = join(FIXTURES_DIR, 'e2e', 'clean', 'index.html');
const ENTRY = join(SKILL_DIR, 'index.mjs');
const BIN = join(REPO_ROOT, 'plugins', 'atelier', 'bin', 'atelier');
const PREFIX = 'atelier/runtime-ux/';

const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins', 'atelier', 'schemas', 'ux-audit.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function expectValidRaw(raw) {
  const ok = validate(raw);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

const short = (id) => id.slice(PREFIX.length);
const failedByArea = (raw) => {
  const out = {};
  for (const v of raw.violations) (out[v.area] ??= []).push(short(v.ruleId));
  for (const ids of Object.values(out)) ids.sort();
  return out;
};

/** Run a CLI in a fresh working directory (no ./.atelier/brand.json to pick up). */
function cli(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('static audit of a realistic site', () => {
  let res;
  beforeAll(async () => {
    res = await auditRuntimeUx({ url: SITE, timestamp: FIXED_TS, write: false });
  });

  it('finds problems in all four areas and fails the gate', () => {
    expect(failedByArea(res.raw)).toEqual({
      transitions: ['no-unload-handler', 'vta-no-feature-check'],
      inp: ['scroll-listener-animates-transform'],
      panels: ['div-role-dialog', 'z-index-literal-smell'],
      mobile: ['hover-only-affordance', 'uses-vh-without-dvh'],
    });
    expect(res.pass).toBe(false);
    expect(res.summary.rules).toEqual({ critical: 1, serious: 3, moderate: 3, minor: 0 });
    expect(res.incomplete).toEqual([]);
    expect(res.raw.errors).toEqual([]);
    // Every static rule ran; the dynamic-only rules are skipped, not dropped.
    const statuses = Object.groupBy(res.raw.rules, (r) => r.status);
    expect(statuses.error).toBeUndefined();
    expect(statuses.skipped.every((r) => r.reason === 'dynamic-only')).toBe(true);
    expect(res.raw.resources.map((r) => `${r.kind} ${r.url} ${r.status}`)).toEqual([
      'document index.html parsed',
      'stylesheet css/site.css parsed',
      'script js/analytics.js parsed',
      'script js/cart.js parsed',
      'script js/app.js parsed',
      'manifest manifest.webmanifest parsed',
    ]);
  });

  it('matches the golden report and raw JSON, which validates against the schema', () => {
    expectGolden('e2e.report.md', res.markdown);
    expectGolden('e2e.raw.json', rawJson(res.raw));
    expectValidRaw(res.raw);
    expectAsciiNoDash(res.markdown, 'e2e report');
  });

  it('is deterministic for the same inputs and timestamp, on disk and in memory', async () => {
    const { dir, cleanup } = tempDir('ux-e2e-');
    try {
      const a = await auditRuntimeUx({ url: SITE, timestamp: FIXED_TS, outDir: join(dir, 'a') });
      const b = await auditRuntimeUx({ url: SITE, timestamp: FIXED_TS, outDir: join(dir, 'b'), areas: ['mobile', 'panels', 'inp', 'transitions'] });
      for (const name of ['ux-report.md', 'ux-raw.json']) {
        expect(readFileSync(join(dir, 'b', name), 'utf8')).toBe(readFileSync(join(dir, 'a', name), 'utf8'));
      }
      expect(readFileSync(a.rawPath, 'utf8')).toBe(rawJson(res.raw));
      expect(readFileSync(a.reportPath, 'utf8')).toBe(res.markdown);
      expect(b.markdown).toBe(res.markdown);
    } finally {
      cleanup();
    }
  });

  it('passes a well-built page with no findings at all', async () => {
    const clean = await auditRuntimeUx({ url: CLEAN, timestamp: FIXED_TS, write: false });
    expect(clean.pass).toBe(true);
    expect(clean.violations.all).toEqual([]);
    expect(clean.incomplete).toEqual([]);
    expect(clean.markdown).toContain('Pass: yes');
    expectValidRaw(clean.raw);
  });

  it('finishes the static pass on a generated ~100 KB site in under 5 s', async () => {
    const n = 160;
    const css = Array.from({ length: n }, (_, i) => [
      `.card-${i} { position: relative; padding: 16px; transition: opacity .2s ease, transform .2s ease; }`,
      `.card-${i}:hover .actions-${i} { opacity: 1; }`,
      `.actions-${i} { opacity: 0; }`,
      `.panel-${i}[popover] { transition: opacity .2s, display .2s allow-discrete; z-index: ${i}; }`,
      `@media (prefers-reduced-motion: reduce) { .panel-${i}[popover] { transition: none; } }`,
      `.hero-${i} { min-height: 100vh; min-height: 100dvh; }`,
    ].join('\n')).join('\n');
    const js = Array.from({ length: n }, (_, i) => [
      `document.querySelector('.card-${i} button').addEventListener('click', function onClick${i}(event) {`,
      `  const box = event.currentTarget.getBoundingClientRect();`,
      `  if (box.width > 0) event.currentTarget.classList.toggle('open');`,
      `});`,
      `window.addEventListener('scroll', () => { if (window.scrollY > ${i}) document.body.dataset.s${i} = '1'; }, { passive: true });`,
    ].join('\n')).join('\n');
    const body = Array.from({ length: n }, (_, i) => `<section class="hero-${i}"><div class="card-${i}"><h2>Item ${i}</h2><p>Details for item ${i}.</p><div class="actions-${i}"><button type="button">Save ${i}</button></div></div><div class="panel-${i}" popover>Panel ${i}</div></section>`).join('\n');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Perf</title><link rel="stylesheet" href="site.css"></head><body>\n${body}\n<script src="app.js"></script></body></html>`;
    expect(html.length + css.length + js.length).toBeGreaterThan(100_000);
    const { dir, cleanup } = tempDir('ux-perf-');
    try {
      writeFiles(dir, { 'index.html': html, 'site.css': css, 'app.js': js });
      const t0 = performance.now();
      const perf = await auditRuntimeUx({ url: join(dir, 'index.html'), timestamp: FIXED_TS, write: false });
      const ms = performance.now() - t0;
      expect(perf.raw.errors).toEqual([]);
      expect(perf.raw.rules.filter((r) => r.status === 'failed').length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(5000);
    } finally {
      cleanup();
    }
  });
});

describe('CLI exit codes (child process)', () => {
  it('exits 0 on the clean page and writes both files', () => {
    const { dir, cleanup } = tempDir('ux-cli-');
    try {
      const r = cli([ENTRY, CLEAN, 'out', '--timestamp', FIXED_TS], dir);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Report written to: ${join(dir, 'out', 'ux-report.md')}`);
      expect(r.stdout).toContain('Violations: critical 0, serious 0, moderate 0, minor 0');
      expectValidRaw(JSON.parse(readFileSync(join(dir, 'out', 'ux-raw.json'), 'utf8')));
    } finally {
      cleanup();
    }
  });

  it('exits 1 on the realistic site, through bin/atelier ux, with the same bytes as the API', () => {
    const { dir, cleanup } = tempDir('ux-cli-');
    try {
      const r = cli([BIN, 'ux', SITE, '--out', 'report', '--timestamp', FIXED_TS], dir);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('Violations: critical 1, serious 3, moderate 3, minor 0');
      const raw = readFileSync(join(dir, 'report', 'ux-raw.json'), 'utf8');
      expect(raw).toBe(readFileSync(join(REPO_ROOT, 'tests', 'runtime-ux-audit', '__golden__', 'e2e.raw.json'), 'utf8').replace(/\r\n/g, '\n'));
      // A file:// URL is accepted as well as a path.
      const url = cli([ENTRY, pathToFileURL(SITE).href, 'r2', '--timestamp', FIXED_TS, '--area', 'transitions'], dir);
      expect(url.code).toBe(1);
      expect(JSON.parse(readFileSync(join(dir, 'r2', 'ux-raw.json'), 'utf8')).mode.areas).toEqual(['transitions']);
    } finally {
      cleanup();
    }
  });

  it('exits 0 when the only blocking rules are ignored', () => {
    const { dir, cleanup } = tempDir('ux-cli-');
    try {
      const ignore = ['no-unload-handler', 'vta-no-feature-check', 'hover-only-affordance', 'uses-vh-without-dvh'].flatMap((id) => ['--ignore', id]);
      const r = cli([ENTRY, SITE, 'out', ...ignore], dir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Violations: critical 0, serious 0, moderate 3, minor 0');
    } finally {
      cleanup();
    }
  });

  it('exits 2 on usage errors and on inputs it cannot read, without a stack trace', () => {
    const { dir, cleanup } = tempDir('ux-cli-');
    try {
      const missing = cli([ENTRY, join(dir, 'nope.html')], dir);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toMatch(/^atelier: /);
      expect(missing.stderr).toContain('Fix: ');
      expect(missing.stderr).not.toMatch(/\n\s+at /);
      const flag = cli([BIN, 'ux', SITE, '--nope'], dir);
      expect(flag.code).toBe(2);
      expect(flag.stderr).toContain(USAGE.split('\n')[0]);
      const noArgs = cli([ENTRY], dir);
      expect(noArgs.code).toBe(2);
      expect(noArgs.stderr).toContain('Missing <url|file>.');
      const badTs = cli([ENTRY, SITE, '--timestamp', 'yesterday'], dir);
      expect(badTs.code).toBe(2);
      expect(badTs.stderr).toContain('Invalid timestamp');
      const scheme = cli([ENTRY, 'ftp://example.com/index.html'], dir);
      expect(scheme.code).toBe(2);
      const help = cli([BIN, 'ux', '--help'], dir);
      expect(help.code).toBe(0);
      expect(help.stdout.trim()).toBe(USAGE);
    } finally {
      cleanup();
    }
  });
});

describe.skipIf(!chromiumAvailable)('dynamic audit of the realistic site (Chromium)', () => {
  let res;
  beforeAll(async () => {
    res = await auditRuntimeUx({ url: SITE, dynamic: true, timestamp: FIXED_TS, write: false });
  }, 180_000);

  it('adds runtime findings, still covering all four areas', () => {
    const ids = res.raw.violations.map((v) => short(v.ruleId));
    for (const id of ['tap-target-under-minimum', 'loaf-long-script', 'bfcache-not-restored', 'focus-lost-after-close']) expect(ids, id).toContain(id);
    // The static findings are still there.
    for (const id of ['no-unload-handler', 'vta-no-feature-check', 'scroll-listener-animates-transform', 'div-role-dialog', 'uses-vh-without-dvh']) expect(ids, id).toContain(id);
    expect(new Set(res.raw.violations.map((v) => v.area))).toEqual(new Set(['transitions', 'inp', 'panels', 'mobile']));
    const tap = res.raw.violations.find((v) => v.ruleId === `${PREFIX}tap-target-under-minimum`);
    expect(tap.nodes.map((n) => n.selector)).toEqual(['#menu-btn', '#search-btn']);
    const loaf = res.raw.violations.find((v) => v.ruleId === `${PREFIX}loaf-long-script`);
    expect(loaf.nodes[0]).toMatchObject({ selector: 'js/cart.js' });
    expect(loaf.nodes[0].location).toMatch(/^js\/cart\.js:\d+:\d+$/);
    const focus = res.raw.violations.find((v) => v.ruleId === `${PREFIX}focus-lost-after-close`);
    expect(focus.nodes[0]).toMatchObject({ selector: '#menu-btn', location: '(runtime)' });
    expect(res.raw.rules.filter((r) => r.reason === 'dynamic-only')).toEqual([]);
  });

  it('reports the INP estimate, the bfcache result and the engine', () => {
    expect(typeof res.metrics.inpP75Ms).toBe('number');
    expect(res.metrics.inpP75Ms).toBeGreaterThanOrEqual(100);
    expect(res.metrics.inp.count).toBeGreaterThan(0);
    expect(res.metrics.bfcache).toEqual({ restored: false, reasons: expect.any(Array) });
    expect(res.metrics.bfcache.reasons.length).toBeGreaterThan(0);
    expect(res.raw.mode).toMatchObject({ dynamic: true, engine: { name: 'chromium', device: 'Pixel 7', cpuThrottle: 4 } });
    expect(res.raw.errors).toEqual([]);
  });

  it('notes the Chromium-only scope in the report and validates against the schema', () => {
    expect(res.markdown).toMatch(/^Mode: static \+ dynamic \(Chromium \d+, Pixel 7, 4x CPU\)$/m);
    expect(res.markdown).toContain('Dynamic findings reflect Chromium-only APIs.');
    expect(res.markdown).toMatch(/INP est\. \d+ ms \(budget 200 ms\)/);
    expectValidRaw(res.raw);
    expectAsciiNoDash(res.markdown, 'dynamic e2e report');
  });
});

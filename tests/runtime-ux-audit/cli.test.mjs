import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { main } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { FIXTURES_DIR, REPO_ROOT, SKILL_DIR, chromiumAvailable, tempDir } from './helpers.mjs';
import { ensureChromium, launchUxChromium } from '../../plugins/atelier/skills/runtime-ux-audit/lib/browser.mjs';
import { UxAuditError, fromPreflight } from '../../plugins/atelier/skills/runtime-ux-audit/lib/errors.mjs';
import { parseCliArgs, USAGE } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';
import { PreflightError, formatError } from '../../plugins/atelier/lib/preflight.mjs';

const ENTRY = join(SKILL_DIR, 'index.mjs');
const BIN = join(REPO_ROOT, 'plugins', 'atelier', 'bin', 'atelier');
const CLEAN = join(FIXTURES_DIR, 'core', 'clean', 'index.html');

function run(args, { cwd = REPO_ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('CLI', () => {
  it('prints usage for --help and -h and exits 0', () => {
    for (const flag of ['--help', '-h']) {
      const r = run([ENTRY, flag]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(USAGE);
      expect(r.stderr).toBe('');
    }
  });

  it('audits a clean page, writes both files and exits 0', () => {
    const { dir, cleanup } = tempDir();
    try {
      const r = run([ENTRY, CLEAN, join(dir, 'out'), '--timestamp', '2026-01-01T00:00:00Z', '--no-brand']);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Report written to: ');
      expect(r.stdout).toContain('Violations: critical 0, serious 0, moderate 0, minor 0');
      const raw = JSON.parse(readFileSync(join(dir, 'out', 'ux-raw.json'), 'utf8'));
      expect(raw).toMatchObject({ tool: 'atelier/runtime-ux-audit', url: 'index.html', timestamp: '2026-01-01T00:00:00.000Z' });
      expect(existsSync(join(dir, 'out', 'ux-report.md'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('works through bin/atelier ux with --out, --area and a local brand.json', () => {
    const { dir, cleanup } = tempDir();
    try {
      mkdirSync(join(dir, '.atelier'));
      writeFileSync(join(dir, '.atelier', 'brand.json'), JSON.stringify({ targets: { minTapPx: 40 } }));
      const r = run([BIN, 'ux', CLEAN, '--out', 'report', '--area', 'mobile,panels', '--timestamp', '2026-01-01T00:00:00Z'], { cwd: dir });
      expect(r.code).toBe(0);
      const raw = JSON.parse(readFileSync(join(dir, 'report', 'ux-raw.json'), 'utf8'));
      expect(raw.mode.areas).toEqual(['panels', 'mobile']);
      expect(raw.budgets).toMatchObject({ minTapPx: 40, minTapPxSource: 'brand' });
      const noBrand = run([BIN, 'ux', CLEAN, 'r2', '--no-brand'], { cwd: dir });
      expect(noBrand.code).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'r2', 'ux-raw.json'), 'utf8')).budgets.minTapPx).toBe(24);
    } finally {
      cleanup();
    }
  });

  it('exits 2 with a message and no stack for a missing input', () => {
    const r = run([ENTRY, 'definitely-missing.html']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('atelier: Input not found: definitely-missing.html');
    expect(r.stderr).toContain('Fix:');
    expect(r.stderr).not.toMatch(/\bat .+:\d+:\d+\)?$/m);
    expect(r.stdout).toBe('');
  });

  it('exits 2 and prints usage to stderr for usage errors', () => {
    for (const args of [[], ['--bogus', 'x'], ['a.html', 'b', 'c'], ['a.html', '--brand', 'x', '--no-brand'], ['a.html', 'out', '--out', 'o'], ['a.html', '--area', 'nav'], ['a.html', '--timeout', 'soon'], ['a.html', '--timestamp', 'now']]) {
      const r = run([ENTRY, ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toContain('Usage: atelier ux');
      expect(r.stdout).toBe('');
    }
  });

  it('exits 2 for runtime failures: bad scheme and invalid brand', () => {
    const scheme = run([ENTRY, 'data:text/html,hi']);
    expect(scheme.code).toBe(2);
    expect(scheme.stderr).toContain('Unsupported scheme');
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(join(dir, 'brand.json'), JSON.stringify({ targets: { minTapPx: 'big' } }));
      const brand = run([ENTRY, CLEAN, join(dir, 'o'), '--brand', join(dir, 'brand.json')]);
      expect(brand.code).toBe(2);
      expect(brand.stderr).toContain('brand.json targets.minTapPx');
    } finally {
      cleanup();
    }
  });

  it('gives the friendly Chromium error when the browser is missing (--dynamic)', () => {
    const { dir, cleanup } = tempDir();
    try {
      const empty = join(dir, 'browsers');
      mkdirSync(empty);
      const r = run([ENTRY, CLEAN, join(dir, 'out'), '--dynamic'], { env: { PLAYWRIGHT_BROWSERS_PATH: empty } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("runtime-ux-audit --dynamic needs Playwright's Chromium.");
      expect(r.stderr).toMatch(/npx playwright(@[\d.]+)? install chromium/);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(existsSync(join(dir, 'out'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it.skipIf(!chromiumAvailable)('runs --dynamic when Chromium is installed and prints the INP line', () => {
    const { dir, cleanup } = tempDir();
    try {
      const r = run([ENTRY, CLEAN, join(dir, 'out'), '--dynamic', '--no-brand', '--timestamp', '2026-01-01T00:00:00Z']);
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/INP est\.: .+ \(budget 200 ms\)/);
      const md = readFileSync(join(dir, 'out', 'ux-report.md'), 'utf8');
      expect(md).toContain('Mode: static + dynamic');
      expect(md).toContain('Dynamic findings reflect Chromium-only APIs.');
    } finally {
      cleanup();
    }
  });

  it('does not run the CLI when imported (node -e)', () => {
    const r = run(['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(ENTRY).href)}).then((m) => console.log(typeof m.auditRuntimeUx))`]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('function');
  });
});

describe('main() in process', () => {
  async function capture(argv) {
    const out = [];
    const err = [];
    const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
    try {
      const code = await main(argv);
      return { code, stdout: out.join(''), stderr: err.join('') };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  }

  it('returns 0, 2 and prints the documented lines', async () => {
    expect((await capture(['--help'])).code).toBe(0);
    const usage = await capture(['--nope']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Usage: atelier ux');
    const missing = await capture(['missing-file.html']);
    expect(missing).toMatchObject({ code: 2, stdout: '' });
    expect(missing.stderr).toContain('Input not found');
    const badArea = await capture([CLEAN, '--area', 'nav']);
    expect(badArea.code).toBe(2);
    expect(badArea.stderr).toContain('Unknown area: nav');
    const { dir, cleanup } = tempDir();
    try {
      const ok = await capture([CLEAN, join(dir, 'o'), '--no-brand', '--timestamp', '2026-01-01T00:00:00Z']);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toBe(`Report written to: ${join(dir, 'o', 'ux-report.md')}\nViolations: critical 0, serious 0, moderate 0, minor 0\n`);
    } finally {
      cleanup();
    }
  });
});

describe('argument parsing', () => {
  it('maps flags to API options', () => {
    const { options } = parseCliArgs(['https://x.test', 'dir', '--dynamic', '--root', 'site', '--area', 'inp', '--area', 'panels,mobile', '--ignore', 'a', '--ignore', 'b', '--allow-origin', 'https://cdn.test', '--timeout', '500', '--max-bytes', '1000', '--timestamp', '2026-01-01T00:00:00Z', '--no-brand']);
    expect(options).toEqual({
      url: 'https://x.test', outDir: 'dir', dynamic: true, brand: null, root: 'site', areas: ['inp', 'panels', 'mobile'], ignore: ['a', 'b'],
      allowOrigins: ['https://cdn.test'], timestamp: '2026-01-01T00:00:00Z', limits: { timeoutMs: 500, maxBytes: 1000 },
    });
    expect(parseCliArgs(['x.html']).options).toMatchObject({ outDir: 'ux-report', dynamic: false, areas: undefined, limits: {} });
    expect(parseCliArgs(['x.html', '--brand', 'b.json']).options.brand).toBe('b.json');
    expect(parseCliArgs(['-h'])).toEqual({ help: true });
  });
});

describe('Chromium preflight', () => {
  it('ensureChromium rejects with CHROMIUM_MISSING when the executable is absent', async () => {
    await expect(ensureChromium({ chromium: { executablePath: () => '/nope/chrome' } })).rejects.toMatchObject({ code: 'CHROMIUM_MISSING', hint: expect.stringMatching(/install chromium/) });
    await expect(ensureChromium({ chromium: { executablePath: () => { throw new Error('x'); } } })).rejects.toMatchObject({ code: 'CHROMIUM_MISSING' });
    await expect(ensureChromium({ chromium: { executablePath: () => ENTRY } })).resolves.toBe(ENTRY);
  });

  it('maps shared PreflightErrors to UxAuditError and formats hints', async () => {
    const chromium = fromPreflight(new PreflightError('Playwright Chromium is not installed.', { code: 'CHROMIUM_MISSING', fix: 'npx playwright@1.63.0 install chromium' }));
    expect(chromium).toBeInstanceOf(UxAuditError);
    expect(chromium).toMatchObject({ code: 'CHROMIUM_MISSING', hint: expect.stringContaining('npx playwright@1.63.0 install chromium') });
    expect(formatError(chromium)).toMatch(/^atelier: runtime-ux-audit --dynamic needs Playwright's Chromium\.\n {2}Fix: npx playwright/);
    const pw = fromPreflight(new PreflightError('x', { code: 'PLAYWRIGHT_MISSING', fix: 'npm ci' }));
    expect(pw).toMatchObject({ code: 'PLAYWRIGHT_MISSING', hint: 'npm ci' });
    const other = new Error('other');
    expect(fromPreflight(other)).toBe(other);
    expect(fromPreflight(chromium)).toBe(chromium);
    const err = new UxAuditError('USAGE', 'bad', { path: 'a.b' });
    expect(err).toMatchObject({ name: 'UxAuditError', code: 'USAGE', path: 'a.b', hint: undefined });
    expect(typeof launchUxChromium).toBe('function');
  });
});

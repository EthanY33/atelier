import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditError,
  DEFAULT_TAGS,
  USAGE,
  auditPage,
  buildMarkdownReport,
  formatTarget,
  groupByImpact,
  mdCodeSpan,
  runCli,
} from '../plugins/atelier/skills/accessibility-design-audit/index.mjs';
import { launchChromium } from '../plugins/atelier/lib/preflight.mjs';
import {
  BAD_HTML,
  BUSY_HTML,
  CLEAN_HTML,
  HOSTILE_HTML,
  LATE_CONTENT_HTML,
  NESTED_HTML,
  startServer,
} from './accessibility-design-audit/fixtures.mjs';

let tmp;
let browser;
let server;
let seq = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'a11y-test-'));
  browser = await launchChromium();
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}, 60_000);

function writeHtml(name, content) {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

const fileUrl = (name, content) => pathToFileURL(writeHtml(name, content)).href;
const outDir = (label) => join(tmp, `out-${label}-${seq++}`);

/** Collects what a CLI run writes. */
function captureIo() {
  const io = { out: '', err: '' };
  io.stdout = { write: (s) => { io.out += s; } };
  io.stderr = { write: (s) => { io.err += s; } };
  return io;
}

/**
 * True when the text after "- " is exactly one CommonMark code span: an
 * opening run of N backticks, a body with no run of exactly N, and a closing
 * run of N, optionally followed by a plain-text label.
 */
function isSingleCodeSpan(item) {
  const open = item.match(/^`+/)?.[0];
  if (!open) return false;
  const n = open.length;
  const close = item.indexOf(open, n);
  if (close === -1) return false;
  const body = item.slice(n, close);
  if ((body.match(/`+/g) ?? []).some((run) => run.length === n)) return false;
  const rest = item.slice(close + n);
  return rest === '' || /^ \(in [a-zA-Z ,]+\)$/.test(rest);
}

const selectorLines = (report) => report.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));

// ---------------------------------------------------------------------------
// End to end on local files (shared browser)
// ---------------------------------------------------------------------------

describe('auditPage on local files', () => {
  it('clean page: no critical or serious violations; report and raw JSON written', async () => {
    const dir = outDir('clean');
    const res = await auditPage({ url: fileUrl('clean.html', CLEAN_HTML), outDir: dir, browser });

    expect(res.violations.critical).toHaveLength(0);
    expect(res.violations.serious).toHaveLength(0);
    expect(res.reportPath).toBe(join(dir, 'a11y-report.md'));
    expect(res.rawPath).toBe(join(dir, 'a11y-raw.json'));
    expect(existsSync(res.reportPath)).toBe(true);
    const raw = JSON.parse(readFileSync(res.rawPath, 'utf8'));
    expect(Array.isArray(raw.violations)).toBe(true);
    expect(res.tags).toEqual([...DEFAULT_TAGS]);
    expect(DEFAULT_TAGS).toContain('wcag21a');
    expect(readFileSync(res.reportPath, 'utf8')).toContain('No violations found.');
  });

  it('image missing alt and html missing lang are reported by rule id and selector', async () => {
    const { violations, reportPath } = await auditPage({ url: fileUrl('bad.html', BAD_HTML), outDir: outDir('bad'), browser });

    expect(violations.critical.map((v) => v.id)).toContain('image-alt');
    expect(violations.serious.map((v) => v.id)).toContain('html-has-lang');
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toMatch(/^# Accessibility audit/);
    expect(report).toContain('## Critical Violations (1)');
    expect(report).toContain('### image-alt');
    expect(report).toContain('### html-has-lang');
    expect(report).toContain('  - `html`');
    expect(report).toContain('  - `img`');
    expect(report).toContain('tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`');
    // axe's own text contains "<img>" and "<html>": escaped, never raw HTML.
    expect(report).not.toMatch(/(^|[^\\])<html>/m);
  });

  it('accepts a plain absolute path and a path relative to the working directory', async () => {
    const abs = writeHtml('by-path.html', BAD_HTML);
    const byAbs = await auditPage({ url: abs, outDir: outDir('abs'), browser });
    expect(byAbs.url).toBe(pathToFileURL(abs).href);
    expect(byAbs.violations.critical.length).toBeGreaterThan(0);

    const rel = relative(process.cwd(), abs);
    const byRel = await auditPage({ url: rel, outDir: outDir('rel'), browser });
    expect(byRel.url).toBe(pathToFileURL(abs).href);
  });

  it('page-controlled selectors cannot break out of their code span', async () => {
    const { reportPath } = await auditPage({ url: fileUrl('hostile.html', HOSTILE_HTML), outDir: outDir('hostile'), browser });
    const report = readFileSync(reportPath, 'utf8');
    const items = selectorLines(report);
    expect(items.some((i) => i.includes('**ALL_CLEAR**'))).toBe(true);
    expect(items.some((i) => i.includes('<b>'))).toBe(true);
    for (const item of items) expect(isSingleCodeSpan(item), item).toBe(true);
  });

  it('shadow DOM and iframe targets are joined readably and labeled', async () => {
    const { reportPath, violations } = await auditPage({ url: fileUrl('nested.html', NESTED_HTML), outDir: outDir('nested'), browser });
    expect(violations.all.map((v) => v.id)).toContain('image-alt');
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toMatch(/ {2}- `#host >>> img[^`]*` \(in shadow DOM\)/);
    expect(report).toContain('`#fr >>frame>> #x` (in iframe)');
    expect(report).toContain('Selector notation:');
    expect(report).not.toContain('#host,img');
    expect(report).not.toContain('`#fr #x`');
  });

  it('--tags override: cat.color skips image-alt; a tag set that runs no rule is an error', async () => {
    const url = fileUrl('tags.html', BAD_HTML);
    const res = await auditPage({ url, outDir: outDir('tags'), tags: ['cat.color'], browser });
    expect(res.tags).toEqual(['cat.color']);
    expect(res.violations.all.map((v) => v.id)).not.toContain('image-alt');
    expect(readFileSync(res.reportPath, 'utf8')).toContain('tags `cat.color`');

    // wcag21a only holds an experimental rule, which axe does not run.
    const dir = outDir('norules');
    await expect(auditPage({ url, outDir: dir, tags: 'wcag21a', browser })).rejects.toMatchObject({ code: 'NO_RULES' });
    expect(existsSync(dir)).toBe(false);
  });

  it('waitFor waits for late content, and fails clearly when the selector never appears', async () => {
    const url = fileUrl('late-content.html', LATE_CONTENT_HTML);
    const res = await auditPage({ url, outDir: outDir('waitfor'), waitFor: '#late', browser });
    expect(res.violations.critical.map((v) => v.id)).toContain('image-alt');

    await expect(auditPage({ url, outDir: outDir('waitfor-miss'), waitFor: '#never', timeoutMs: 3000, browser }))
      .rejects.toMatchObject({ code: 'WAIT_FOR_FAILED', message: expect.stringMatching(/did not appear within 3000 ms/) });
    await expect(auditPage({ url, outDir: outDir('waitfor-bad'), waitFor: 'main[[[', browser }))
      .rejects.toMatchObject({ code: 'WAIT_FOR_FAILED', message: expect.stringMatching(/"main\[\[\[" failed: /) });
  });
});

// ---------------------------------------------------------------------------
// Served pages: load timing and HTTP status
// ---------------------------------------------------------------------------

describe('auditPage over HTTP', () => {
  it('waits for a slow stylesheet before running axe (color-contrast is caught)', async () => {
    const { violations } = await auditPage({ url: server.url('/late'), outDir: outDir('late'), browser });
    expect(violations.serious.map((v) => v.id)).toContain('color-contrast');
  });

  it('a 404 response throws HTTP_ERROR and writes no report', async () => {
    const dir = outDir('404');
    const err = await auditPage({ url: server.url('/missing'), outDir: dir, browser }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.message).toMatch(/HTTP 404/);
    expect(existsSync(dir)).toBe(false);
  });

  it('a 502 response throws; allowHttpError audits the error page anyway', async () => {
    await expect(auditPage({ url: server.url('/boom'), outDir: outDir('502'), browser }))
      .rejects.toThrow(/HTTP 502/);
    const res = await auditPage({ url: server.url('/missing'), outDir: outDir('404-allowed'), allowHttpError: true, browser });
    expect(res.violations.critical).toHaveLength(0);
  });

  it('a page whose load event never fires throws LOAD_TIMEOUT', async () => {
    await expect(auditPage({ url: server.url('/hang'), outDir: outDir('hang'), timeoutMs: 3000, browser }))
      .rejects.toMatchObject({ code: 'LOAD_TIMEOUT' });
  });

  it('an unreachable server throws NAVIGATION_FAILED', async () => {
    await expect(auditPage({ url: 'http://127.0.0.1:9/', outDir: outDir('down'), timeoutMs: 5000, browser }))
      .rejects.toMatchObject({ code: 'NAVIGATION_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// Timeouts around axe
// ---------------------------------------------------------------------------

describe('auditPage analyze timeout', () => {
  it('a page that blocks its main thread fails with ANALYZE_TIMEOUT instead of hanging (own browser)', async () => {
    const started = Date.now();
    const err = await auditPage({
      url: fileUrl('busy.html', BUSY_HTML),
      outDir: outDir('busy'),
      settleTimeoutMs: 500,
      analyzeTimeoutMs: 1000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect(err.code).toBe('ANALYZE_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('with a shared browser the hung page is closed and the browser stays usable', async () => {
    await expect(auditPage({
      url: fileUrl('busy2.html', BUSY_HTML),
      outDir: outDir('busy2'),
      settleTimeoutMs: 500,
      analyzeTimeoutMs: 1000,
      browser,
    })).rejects.toMatchObject({ code: 'ANALYZE_TIMEOUT' });
    expect(browser.isConnected()).toBe(true);
    const res = await auditPage({ url: fileUrl('after-busy.html', CLEAN_HTML), outDir: outDir('after-busy'), browser });
    expect(res.violations.serious).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Input validation (fails before any browser starts)
// ---------------------------------------------------------------------------

describe('auditPage input validation', () => {
  it('rejects a missing file, a directory, and unsupported schemes', async () => {
    await expect(auditPage({ url: join(tmp, 'nope.html'), outDir: outDir('x') }))
      .rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
    await expect(auditPage({ url: 'example.com', outDir: outDir('x') }))
      .rejects.toThrow(/https:\/\/example\.com/);
    mkdirSync(join(tmp, 'site'), { recursive: true });
    await expect(auditPage({ url: join(tmp, 'site'), outDir: outDir('x') }))
      .rejects.toMatchObject({ code: 'INPUT_IS_DIRECTORY' });
    await expect(auditPage({ url: 'javascript:alert(1)', outDir: outDir('x') }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEME' });
    await expect(auditPage({ url: 'http://exa mple.com/', outDir: outDir('x') }))
      .rejects.toMatchObject({ code: 'INVALID_URL' });
  });

  it('rejects bad options', async () => {
    const url = fileUrl('opts.html', CLEAN_HTML);
    await expect(auditPage({ url })).rejects.toThrow(TypeError);
    await expect(auditPage({ outDir: outDir('x') })).rejects.toThrow(/url must be a non-empty string/);
    await expect(auditPage({ url, outDir: outDir('x'), timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    await expect(auditPage({ url, outDir: outDir('x'), waitFor: ' ' })).rejects.toThrow(/waitFor/);
    await expect(auditPage({ url, outDir: outDir('x'), tags: [] })).rejects.toMatchObject({ code: 'INVALID_TAGS' });
    await expect(auditPage({ url, outDir: outDir('x'), tags: ['wcag2a', 'wcag99zz'] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_TAG', message: expect.stringContaining('wcag99zz') });
  });
});

// ---------------------------------------------------------------------------
// Report helpers (no browser)
// ---------------------------------------------------------------------------

describe('report helpers', () => {
  it('mdCodeSpan uses a fence longer than any backtick run inside', () => {
    expect(mdCodeSpan('img')).toBe('`img`');
    expect(mdCodeSpan('a`b')).toBe('``a`b``');
    expect(mdCodeSpan('a``b```c')).toBe('````a``b```c````');
    expect(mdCodeSpan('`lead')).toBe('`` `lead ``');
    expect(mdCodeSpan('two\nlines')).toBe('`two lines`');
    for (const s of ['a`**X**`b', '`', 'x`<b>`y', '``']) expect(isSingleCodeSpan(mdCodeSpan(s))).toBe(true);
  });

  it('formatTarget handles plain, shadow, frame, shadow-in-frame and missing targets', () => {
    expect(formatTarget(['html'])).toEqual({ selector: 'html', where: [] });
    expect(formatTarget([['#host', 'img']])).toEqual({ selector: '#host >>> img', where: ['shadow DOM'] });
    expect(formatTarget(['#fr', '#x'])).toEqual({ selector: '#fr >>frame>> #x', where: ['iframe'] });
    expect(formatTarget(['#fr', ['#host', 'img']])).toEqual({ selector: '#fr >>frame>> #host >>> img', where: ['iframe', 'shadow DOM'] });
    expect(formatTarget(undefined)).toEqual({ selector: '(unknown)', where: [] });
    expect(formatTarget([])).toEqual({ selector: '(unknown)', where: [] });
  });

  it('buildMarkdownReport escapes text, caps selectors at 5, and lists unrated violations', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ target: [`li:nth-child(${i + 1})`] }));
    const violations = groupByImpact([
      { id: 'list', impact: 'minor', help: 'Lists *must* be <ul>', description: 'desc [x](y)', helpUrl: 'https://example.test/list', nodes },
      { id: 'odd', impact: null, description: 'no impact', helpUrl: 'javascript:alert(1)', nodes: [{}] },
    ]);
    const md = buildMarkdownReport({
      url: 'https://site.test/`x`',
      finalUrl: 'https://site.test/final',
      timestamp: '2026-01-01T00:00:00.000Z',
      violations,
      axeVersion: '4.13.0',
      incompleteCount: 2,
    });
    expect(md).toContain('- **URL:** `` https://site.test/`x` ``');
    expect(md).toContain('- **Final URL:** `https://site.test/final`');
    expect(md).toContain('- **Needs manual review:** 2 rules');
    expect(md).toContain('- **Rule:** Lists \\*must\\* be \\<ul\\>');
    expect(md).toContain('- **Description:** desc \\[x\\](y)');
    expect(md).toContain('- **Help URL:** <https://example.test/list>');
    expect(md).toContain('- **Help URL:** `javascript:alert(1)`');
    expect(md).toContain('- **Affected elements (7, first 5 shown):**');
    expect(md).toContain('`li:nth-child(5)`');
    expect(md).not.toContain('`li:nth-child(6)`');
    expect(md).toContain('## Unrated Violations (1)');
    expect(md).toContain('  - `(unknown)`');
    expect(md).toContain('**Total violations:** 2 (critical 0, serious 0, moderate 0, minor 1)');
  });
});

// ---------------------------------------------------------------------------
// CLI (in process; the spawned contract is in accessibility-design-audit-cli.test.mjs)
// ---------------------------------------------------------------------------

describe('runCli', () => {
  it('--help and -h print usage to stdout and return 0', async () => {
    for (const flag of ['--help', '-h']) {
      const io = captureIo();
      expect(await runCli([flag], io)).toBe(0);
      expect(io.out).toBe(`${USAGE}\n`);
      expect(io.err).toBe('');
    }
  });

  it('SKILL.md and --help document the same flags, and the parser accepts each one', async () => {
    const skillMd = readFileSync(new URL('../plugins/atelier/skills/accessibility-design-audit/SKILL.md', import.meta.url), 'utf8');
    const longFlags = (text) => new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z-]*[a-z])/g)].map((m) => `--${m[1]}`));
    const documented = longFlags(skillMd);
    documented.delete('--input-type'); // node's own flag in the JS API line
    const inHelp = longFlags(USAGE);
    expect([...documented].sort()).toEqual([...inHelp].sort());
    for (const short of ['-o', '-h']) {
      expect(skillMd).toContain(`\`${short}\``);
      expect(USAGE).toMatch(new RegExp(`^ {2}${short}, --`, 'm'));
    }
    for (const flag of inHelp) {
      if (flag === '--help') continue;
      const takesValue = new RegExp(`${flag} <`).test(USAGE);
      const io = captureIo();
      // No <url|file>: a known flag gets as far as the missing-argument check.
      expect(await runCli(takesValue ? [flag, '1'] : [flag], io), flag).toBe(2);
      expect(io.err, flag).toMatch(/^atelier: missing <url\|file>/);
    }
  });

  it('usage errors print usage to stderr and return 2', async () => {
    const cases = [
      [[], /missing <url\|file>/],
      [['--bogus', 'x'], /Unknown option '--bogus'/],
      [['a.html', 'out', 'extra'], /unexpected argument: extra/],
      [['a.html', 'out', '--out', 'other'], /output directory once/],
      [['a.html', '--timeout', 'soon'], /--timeout must be a positive whole number/],
      [['a.html', '--analyze-timeout', '0'], /--analyze-timeout must be/],
      [['a.html', '--settle-timeout', '1.5'], /--settle-timeout must be/],
      [['a.html', '--tags', ' , '], /--tags needs at least one tag/],
      [['a.html', '--wait-for', ' '], /--wait-for needs a CSS selector/],
    ];
    for (const [argv, re] of cases) {
      const io = captureIo();
      expect(await runCli(argv, io), argv.join(' ')).toBe(2);
      expect(io.err).toMatch(re);
      expect(io.err).toContain('Usage: atelier a11y');
      expect(io.out).toBe('');
    }
  });

  it('runtime failures print one "atelier:" line and return 2', async () => {
    const io = captureIo();
    expect(await runCli([join(tmp, 'missing.html')], io)).toBe(2);
    expect(io.err).toMatch(/^atelier: no such file: /);
    expect(io.err).not.toContain('Usage');

    const io2 = captureIo();
    expect(await runCli([writeHtml('cli-tags.html', CLEAN_HTML), outDir('cli'), '--tags', 'nope'], io2)).toBe(2);
    expect(io2.err).toMatch(/^atelier: unknown axe tag: nope/);
  });

  it('returns 1 for critical or serious violations and 0 for a clean page', async () => {
    const bad = captureIo();
    const badOut = outDir('cli-bad');
    expect(await runCli([writeHtml('cli-bad.html', BAD_HTML), '--out', badOut, '--timeout', '20000'], bad)).toBe(1);
    expect(bad.out).toContain(`Report written to: ${join(badOut, 'a11y-report.md')}`);
    expect(bad.out).toMatch(/Violations: critical 1, serious 1, moderate \d+, minor \d+/);

    const clean = captureIo();
    expect(await runCli([writeHtml('cli-clean.html', CLEAN_HTML), outDir('cli-clean'), '--tags', 'wcag2a,wcag2aa'], clean)).toBe(0);
    expect(clean.out).toContain('Violations: critical 0, serious 0');
  });
});

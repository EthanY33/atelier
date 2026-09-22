/**
 * accessibility-design-audit: WCAG 2.1 A and AA audit of a page with axe-core
 * in headless Chromium. Waits for the page to finish loading, runs axe, and
 * writes a markdown report grouped by impact plus the raw axe result.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isMain } from '../../lib/cli.mjs';
import { PreflightError, formatError, launchChromium } from '../../lib/preflight.mjs';

const require = createRequire(import.meta.url);

/** axe tags run by default: every WCAG 2.0 and 2.1 Level A and AA rule. */
export const DEFAULT_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);

const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
const MAX_TARGETS = 5;
const DEFAULTS = Object.freeze({ timeoutMs: 30_000, settleTimeoutMs: 10_000, analyzeTimeoutMs: 60_000 });
const URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'data:']);
const SHADOW_JOIN = ' >>> ';
const FRAME_JOIN = ' >>frame>> ';

/** An audit that could not run. `code` says why (HTTP_ERROR, LOAD_TIMEOUT, ...). */
export class AuditError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AuditError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/**
 * Turn a URL or a local file path into the URL Chromium should open.
 * Existing files win over URL parsing, because `C:\x\page.html` also parses
 * as a URL with scheme `c:`.
 * @param {string} input
 * @returns {string}
 */
function resolveTarget(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('auditPage: url must be a non-empty string (a URL or a path to an HTML file)');
  }
  const abs = resolve(input);
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) {
      throw new AuditError(`${abs} is a directory; pass the HTML file inside it (for example ${join(input, 'index.html')})`, { code: 'INPUT_IS_DIRECTORY' });
    }
    return pathToFileURL(abs).href;
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new AuditError(`not a valid URL: ${input}`, { code: 'INVALID_URL' });
    }
    if (!URL_SCHEMES.has(parsed.protocol)) {
      throw new AuditError(`unsupported URL scheme "${parsed.protocol}" in ${input}; use http, https, file or data`, { code: 'UNSUPPORTED_SCHEME' });
    }
    return input;
  }
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(input) && !/\.html?$/i.test(input);
  const hint = looksLikeHost ? `. For a website, pass a full URL such as https://${input}` : '';
  throw new AuditError(`no such file: ${abs}${hint}`, { code: 'INPUT_NOT_FOUND' });
}

let knownTags;
/** Every tag used by an axe rule, or null when axe-core cannot be loaded here. */
function knownAxeTags() {
  if (knownTags !== undefined) return knownTags;
  try {
    const axe = createRequire(require.resolve('@axe-core/playwright'))('axe-core');
    knownTags = new Set(axe.getRules().flatMap((r) => r.tags));
  } catch {
    knownTags = null;
  }
  return knownTags;
}

function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [...DEFAULT_TAGS];
  const list = (Array.isArray(tags) ? tags : String(tags).split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (list.length === 0) throw new AuditError('tags must name at least one axe tag', { code: 'INVALID_TAGS' });
  const known = knownAxeTags();
  const unknown = known ? list.filter((t) => !known.has(t)) : [];
  if (unknown.length > 0) {
    throw new AuditError(
      `unknown axe tag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (common tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice)`,
      { code: 'UNKNOWN_TAG' },
    );
  }
  return [...new Set(list)];
}

function positiveMs(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`auditPage: ${name} must be a positive number of milliseconds`);
  }
  return value;
}

async function loadAxeBuilder() {
  try {
    const { AxeBuilder } = await import('@axe-core/playwright');
    return AxeBuilder;
  } catch (err) {
    throw new PreflightError('@axe-core/playwright is not installed next to the atelier plugin.', {
      code: 'AXE_MISSING',
      fix: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.',
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Page loading
// ---------------------------------------------------------------------------

const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0].trim();

/**
 * Race `promise` against a timer. The loser is still observed so a late
 * rejection (for example when the browser closes) is never unhandled.
 */
function withTimeout(promise, ms, makeError) {
  let timer;
  promise.catch(() => {});
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function openPage(page, target, { timeoutMs, settleTimeoutMs, waitFor, allowHttpError }) {
  let response;
  try {
    response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    throw new AuditError(`could not open ${target}: ${firstLine(err)}`, { code: 'NAVIGATION_FAILED', cause: err });
  }
  // file:// answers 200 and data: URLs have no response; only real HTTP errors stop here.
  const status = response ? response.status() : 0;
  if (status >= 400 && !allowHttpError) {
    const text = response.statusText();
    throw new AuditError(
      `${target} answered HTTP ${status}${text ? ` ${text}` : ''}; refusing to audit an error page (use --allow-http-error to audit it anyway)`,
      { code: 'HTTP_ERROR' },
    );
  }
  try {
    await page.waitForLoadState('load', { timeout: timeoutMs });
  } catch (err) {
    throw new AuditError(`${target} did not fire its load event within ${timeoutMs} ms (raise the timeout for slow pages)`, { code: 'LOAD_TIMEOUT', cause: err });
  }
  // Best effort: pages with analytics beacons or websockets never go idle.
  await page.waitForLoadState('networkidle', { timeout: settleTimeoutMs }).catch(() => {});
  await withTimeout(
    page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true)),
    settleTimeoutMs,
    () => new Error('fonts not ready'),
  ).catch(() => {});
  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { state: 'attached', timeout: timeoutMs });
    } catch (err) {
      const why = err?.name === 'TimeoutError' ? `did not appear within ${timeoutMs} ms` : `failed: ${firstLine(err)}`;
      throw new AuditError(`wait-for selector ${JSON.stringify(waitFor)} ${why}`, { code: 'WAIT_FOR_FAILED', cause: err });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Groups axe violations by impact level. Violations with no known impact
 * appear only in `all`.
 * @param {Array} violations
 * @returns {{ critical: Array, serious: Array, moderate: Array, minor: Array, all: Array }}
 */
export function groupByImpact(violations) {
  const grouped = { critical: [], serious: [], moderate: [], minor: [], all: violations };
  for (const v of violations) {
    if (IMPACTS.includes(v.impact)) grouped[v.impact].push(v);
  }
  return grouped;
}

/**
 * A markdown code span that page-controlled text cannot break out of: the
 * fence is one backtick longer than the longest backtick run inside.
 * @param {unknown} text
 * @returns {string}
 */
export function mdCodeSpan(text) {
  const s = String(text).replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') || s === '' ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** Plain markdown text on one line, with markup characters escaped. */
function mdText(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_[\]<>|~&#!]/g, '\\$&');
}

/**
 * Render an axe node target as one readable selector. axe nests arrays for
 * shadow DOM and lists one entry per frame for iframes.
 * @param {Array<string|string[]>} target
 * @returns {{ selector: string, where: string[] }} `where` names the boundaries crossed.
 */
export function formatTarget(target) {
  if (!Array.isArray(target) || target.length === 0) return { selector: '(unknown)', where: [] };
  let shadow = false;
  const parts = target.map((part) => {
    if (Array.isArray(part)) {
      if (part.length > 1) shadow = true;
      return part.map(String).join(SHADOW_JOIN);
    }
    return String(part);
  });
  const where = [];
  if (parts.length > 1) where.push('iframe');
  if (shadow) where.push('shadow DOM');
  return { selector: parts.join(FRAME_JOIN), where };
}

function helpLink(url) {
  return typeof url === 'string' && /^https:\/\/[^\s<>]+$/.test(url) ? `<${url}>` : mdCodeSpan(url ?? '');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render the markdown report.
 * @param {{ url: string, finalUrl?: string, timestamp: string, violations: ReturnType<typeof groupByImpact>,
 *   tags?: string[], axeVersion?: string, incompleteCount?: number }} info
 * @returns {string}
 */
export function buildMarkdownReport({ url, finalUrl, timestamp, violations, tags = DEFAULT_TAGS, axeVersion, incompleteCount = 0 }) {
  const counts = IMPACTS.map((i) => `${i} ${violations[i].length}`).join(', ');
  const lines = ['# Accessibility audit', '', `- **URL:** ${mdCodeSpan(url)}`];
  if (finalUrl && finalUrl !== url) lines.push(`- **Final URL:** ${mdCodeSpan(finalUrl)}`);
  lines.push(
    `- **Timestamp:** ${mdText(timestamp)}`,
    `- **Rules:** axe-core ${mdText(axeVersion ?? 'unknown')}, tags ${tags.map(mdCodeSpan).join(', ')}`,
    `- **Total violations:** ${violations.all.length} (${counts})`,
  );
  if (incompleteCount > 0) {
    lines.push(`- **Needs manual review:** ${incompleteCount} rule${incompleteCount === 1 ? '' : 's'} axe could not decide (see "incomplete" in a11y-raw.json)`);
  }
  lines.push('');

  if (violations.all.length === 0) {
    lines.push('No violations found.', '');
    return lines.join('\n');
  }

  const nested = violations.all.some((v) => (v.nodes ?? []).some((n) => formatTarget(n.target).where.length > 0));
  if (nested) {
    lines.push(`Selector notation: \`${SHADOW_JOIN.trim()}\` enters a shadow root, \`${FRAME_JOIN.trim()}\` enters an iframe.`, '');
  }

  const unrated = violations.all.filter((v) => !IMPACTS.includes(v.impact));
  const sections = [...IMPACTS.map((i) => [capitalize(i), violations[i]]), ['Unrated', unrated]];
  for (const [label, items] of sections) {
    if (items.length === 0) continue;
    lines.push(`## ${label} Violations (${items.length})`, '');
    for (const v of items) {
      const nodes = v.nodes ?? [];
      lines.push(`### ${mdText(v.id)}`, '');
      lines.push(`- **Impact:** ${mdText(v.impact ?? 'unknown')}`);
      if (v.help) lines.push(`- **Rule:** ${mdText(v.help)}`);
      lines.push(`- **Description:** ${mdText(v.description)}`);
      lines.push(`- **Help URL:** ${helpLink(v.helpUrl)}`);
      if (nodes.length > 0) {
        const shown = nodes.length > MAX_TARGETS ? `, first ${MAX_TARGETS} shown` : '';
        lines.push(`- **Affected elements (${nodes.length}${shown}):**`);
        for (const n of nodes.slice(0, MAX_TARGETS)) {
          const { selector, where } = formatTarget(n.target);
          lines.push(`  - ${mdCodeSpan(selector)}${where.length ? ` (in ${where.join(', in ')})` : ''}`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs a WCAG 2.1 A and AA audit on a page using axe-core via Playwright.
 *
 * The page is audited after its load event, then up to `settleTimeoutMs` for
 * network idle and web fonts, then `waitFor` when given.
 *
 * @param {object} opts
 * @param {string} opts.url - http(s), file or data URL, or a path to a local HTML file.
 * @param {string} opts.outDir - Directory for a11y-report.md and a11y-raw.json.
 * @param {string[]|string} [opts.tags] - axe tags (default DEFAULT_TAGS). Unknown tags throw.
 * @param {string} [opts.waitFor] - CSS selector that must be in the DOM before the audit.
 * @param {number} [opts.timeoutMs=30000] - Navigation, load event and waitFor timeout.
 * @param {number} [opts.settleTimeoutMs=10000] - Max wait for network idle and fonts (best effort).
 * @param {number} [opts.analyzeTimeoutMs=60000] - Max time for the axe run.
 * @param {boolean} [opts.allowHttpError=false] - Audit 4xx/5xx responses instead of throwing.
 * @param {import('playwright').Browser} [opts.browser] - Browser to reuse; left open.
 * @returns {Promise<{ violations: { critical: Array, serious: Array, moderate: Array, minor: Array, all: Array },
 *   reportPath: string, rawPath: string, url: string, tags: string[] }>}
 */
export async function auditPage(opts = {}) {
  const { url, outDir, waitFor, allowHttpError = false, browser: sharedBrowser } = opts;
  if (typeof outDir !== 'string' || outDir === '') throw new TypeError('auditPage: outDir must be a non-empty string');
  if (waitFor !== undefined && (typeof waitFor !== 'string' || waitFor.trim() === '')) {
    throw new TypeError('auditPage: waitFor must be a non-empty CSS selector');
  }
  const timeoutMs = positiveMs(opts.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
  const settleTimeoutMs = positiveMs(opts.settleTimeoutMs, DEFAULTS.settleTimeoutMs, 'settleTimeoutMs');
  const analyzeTimeoutMs = positiveMs(opts.analyzeTimeoutMs, DEFAULTS.analyzeTimeoutMs, 'analyzeTimeoutMs');
  const target = resolveTarget(url);
  const tags = normalizeTags(opts.tags);
  const AxeBuilder = await loadAxeBuilder();

  const browser = sharedBrowser ?? (await launchChromium());
  let context;
  let result;
  let finalUrl;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await openPage(page, target, { timeoutMs, settleTimeoutMs, waitFor, allowHttpError: Boolean(allowHttpError) });
    finalUrl = page.url();
    result = await withTimeout(
      new AxeBuilder({ page }).withTags(tags).analyze(),
      analyzeTimeoutMs,
      () => new AuditError(
        `axe did not finish within ${analyzeTimeoutMs} ms on ${target} (the page may be blocking its main thread)`,
        { code: 'ANALYZE_TIMEOUT' },
      ),
    );
  } finally {
    // Closing also aborts an axe run that timed out.
    if (sharedBrowser) await context?.close().catch(() => {});
    else await browser.close().catch(() => {});
  }

  const ran = result.passes.length + result.violations.length + result.incomplete.length + result.inapplicable.length;
  if (ran === 0) {
    throw new AuditError(`axe ran no rules for tags ${tags.join(', ')}; nothing was checked`, { code: 'NO_RULES' });
  }

  const violations = groupByImpact(result.violations);
  const markdown = buildMarkdownReport({
    url: target,
    finalUrl,
    timestamp: new Date().toISOString(),
    violations,
    tags,
    axeVersion: result.testEngine?.version,
    incompleteCount: result.incomplete.length,
  });

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, 'a11y-report.md');
  const rawPath = join(outDir, 'a11y-raw.json');
  writeFileSync(reportPath, markdown, 'utf8');
  writeFileSync(rawPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { violations, reportPath, rawPath, url: target, tags };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `Usage: atelier a11y <url|file> [outDir] [options]

Audit a web page or local HTML file for WCAG 2.1 A and AA issues with axe-core
in headless Chromium. Writes <outDir>/a11y-report.md and <outDir>/a11y-raw.json.

Arguments:
  <url|file>                http(s), file or data URL, or a path to an HTML file
  [outDir]                  output directory (default: a11y-report)

Options:
  -o, --out <dir>           output directory (same as [outDir])
  --tags <list>             comma-separated axe tags
                            (default: ${DEFAULT_TAGS.join(',')})
  --wait-for <selector>     wait until this CSS selector is in the DOM
  --timeout <ms>            navigation and load event timeout (default: ${DEFAULTS.timeoutMs})
  --settle-timeout <ms>     max wait for network idle and fonts (default: ${DEFAULTS.settleTimeoutMs})
  --analyze-timeout <ms>    max time for the axe run (default: ${DEFAULTS.analyzeTimeoutMs})
  --allow-http-error        audit the page even when it answers HTTP 4xx or 5xx
  -h, --help                show this help

Exit codes:
  0  no critical or serious violations
  1  critical or serious violations found
  2  usage error, or the audit could not run`;

const CLI_OPTIONS = {
  out: { type: 'string', short: 'o' },
  tags: { type: 'string' },
  'wait-for': { type: 'string' },
  timeout: { type: 'string' },
  'settle-timeout': { type: 'string' },
  'analyze-timeout': { type: 'string' },
  'allow-http-error': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const MS_FLAGS = [
  ['timeout', 'timeoutMs'],
  ['settle-timeout', 'settleTimeoutMs'],
  ['analyze-timeout', 'analyzeTimeoutMs'],
];

/**
 * Run the CLI with `argv` (arguments after the script name).
 * @param {string[]} [argv]
 * @param {{ stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {Promise<number>} Exit code: 0 clean, 1 critical or serious found, 2 error.
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const usageError = (msg) => {
    stderr.write(`atelier: ${msg}\n\n${USAGE}\n`);
    return 2;
  };
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true }));
  } catch (err) {
    return usageError(err.message);
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length === 0) return usageError('missing <url|file>');
  if (positionals.length > 2) return usageError(`unexpected argument: ${positionals[2]}`);
  if (positionals[1] !== undefined && values.out !== undefined) {
    return usageError('give the output directory once, as [outDir] or --out');
  }

  const opts = {
    url: positionals[0],
    outDir: values.out ?? positionals[1] ?? 'a11y-report',
    waitFor: values['wait-for'],
    allowHttpError: Boolean(values['allow-http-error']),
  };
  for (const [flag, key] of MS_FLAGS) {
    if (values[flag] === undefined) continue;
    const n = Number(values[flag]);
    if (!/^\d+$/.test(values[flag].trim()) || n <= 0) {
      return usageError(`--${flag} must be a positive whole number of milliseconds, got "${values[flag]}"`);
    }
    opts[key] = n;
  }
  if (values.tags !== undefined) {
    opts.tags = values.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (opts.tags.length === 0) return usageError('--tags needs at least one tag');
  }
  if (opts.waitFor !== undefined && opts.waitFor.trim() === '') return usageError('--wait-for needs a CSS selector');

  try {
    const { violations, reportPath } = await auditPage(opts);
    stdout.write(`Report written to: ${reportPath}\n`);
    stdout.write(`Violations: ${IMPACTS.map((i) => `${i} ${violations[i].length}`).join(', ')}\n`);
    return violations.critical.length + violations.serious.length > 0 ? 1 : 0;
  } catch (err) {
    stderr.write(`${formatError(err)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}

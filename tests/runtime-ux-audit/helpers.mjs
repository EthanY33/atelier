/**
 * Shared helpers for the runtime-ux-audit tests (core, area and dynamic).
 *
 *   contextFor(files, opts)  -> ctx built exactly as in production
 *   runRule(rule, ctx)       -> the runner's view of one rule
 *   runFixture(area, opts)   -> auditRuntimeUx() on tests/fixtures/runtime-ux/<area>/index.html
 *   expectGolden(name, text) -> compare with tests/runtime-ux-audit/__golden__/<name>
 *   chromiumAvailable        -> true when Playwright's Chromium is installed
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { pluginRequire } from '../helpers/plugin-deps.mjs';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { collect, normalizeText } from '../../plugins/atelier/skills/runtime-ux-audit/lib/collect.mjs';
import { buildContext } from '../../plugins/atelier/skills/runtime-ux-audit/lib/context.mjs';
import { buildHtmlModel } from '../../plugins/atelier/skills/runtime-ux-audit/lib/html-model.mjs';
import { loadBrand, resolveBudgets } from '../../plugins/atelier/skills/runtime-ux-audit/lib/budgets.mjs';
import { AREAS, toFullRuleId } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';
import { runRules } from '../../plugins/atelier/skills/runtime-ux-audit/lib/runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXED_TS = '2026-01-01T00:00:00.000Z';
export const REPO_ROOT = resolve(here, '..', '..');
export const SKILL_DIR = join(REPO_ROOT, 'plugins', 'atelier', 'skills', 'runtime-ux-audit');
export const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'runtime-ux');
export const GOLDEN_DIR = join(here, '__golden__');

/** Write a { relPath: content } map under dir. */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A fresh temp directory; call cleanup() when done. */
export function tempDir(prefix = 'ux-test-') {
  // Real path: on macOS tmpdir() is under /var, a symlink to /private/var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a ctx from an in-memory site, through the real collector and context.
 * @param {Record<string, string|Buffer>} files - must include the entry (default index.html)
 * @param {{
 *   dynamic?: object|null,       // DynamicFacts; facts.rendered.html becomes ctx.rendered
 *   brand?: object|string|null,  // brand object, or a path relative to the temp site
 *   entry?: string, areas?: string[], allowOrigins?: string[], limits?: object
 * }} [opts]
 */
export async function contextFor(files, { dynamic = null, brand = null, entry = 'index.html', areas = AREAS, allowOrigins = [], limits = {} } = {}) {
  const { dir, cleanup } = tempDir('ux-ctx-');
  try {
    writeFiles(dir, files);
    const collected = await collect(join(dir, entry), { root: dir, allowOrigins, limits });
    const brandObj = loadBrand(brand, { cwd: dir });
    const budgets = resolveBudgets(brandObj);
    const rendered = typeof dynamic?.rendered?.html === 'string'
      ? buildHtmlModel(normalizeText(dynamic.rendered.html), { source: 'rendered', displayPath: '(rendered DOM)', resolve: (h) => collected.urls.resolve(h) })
      : null;
    return buildContext(collected, { options: { dynamic: dynamic !== null, areas }, budgets, brand: brandObj, dynamic, rendered });
  } finally {
    cleanup();
  }
}

/**
 * Run one rule through the production runner (suppression, dedupe, caps).
 * @returns {{ status: string|null, reason: string|null, suppressed: number, nodes: object[], incomplete: object[], nodesTruncated: number, violation: object|null, errors: object[] }}
 */
export function runRule(rule, ctx, { ignore = [] } = {}) {
  const run = runRules(ctx, [rule], { ignore: ignore.map(toFullRuleId) });
  const status = run.rules.find((r) => r.id === rule.id) ?? null;
  const violation = run.violations[0] ?? null;
  const inc = run.incomplete[0] ?? null;
  return {
    status: status?.status ?? null,
    reason: status?.reason ?? null,
    suppressed: status?.suppressed ?? 0,
    nodes: violation ? violation.nodes : [],
    incomplete: inc ? inc.nodes : [],
    nodesTruncated: violation?.nodesTruncated ?? 0,
    violation,
    errors: run.errors,
  };
}

/**
 * auditRuntimeUx() on tests/fixtures/runtime-ux/<area>/index.html, static,
 * areas [area], FIXED_TS, write false. A brand.json next to the fixture is
 * used automatically unless opts.brand is given.
 */
export async function runFixture(area, opts = {}) {
  const dir = join(FIXTURES_DIR, area);
  const brandPath = join(dir, 'brand.json');
  const areas = AREAS.includes(area) ? [area] : undefined;
  return auditRuntimeUx({
    url: join(dir, 'index.html'),
    areas,
    timestamp: FIXED_TS,
    write: false,
    brand: existsSync(brandPath) ? brandPath : null,
    ...opts,
  });
}

/** Read a JSON fixture, e.g. readFixtureJson('inp/facts/slow.json'). */
export function readFixtureJson(rel) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, rel), 'utf8'));
}

/**
 * Compare text with a golden file (CRLF normalized). UPDATE_GOLDEN=1 rewrites it.
 * @param {string} name - e.g. 'core.report.md'
 * @param {string} text
 */
export function expectGolden(name, text) {
  const file = join(GOLDEN_DIR, name);
  const actual = String(text).replace(/\r\n/g, '\n');
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file)) throw new Error(`Golden ${name} is missing; run the test with UPDATE_GOLDEN=1 to create it.`);
  expect(actual).toBe(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

/** Serialize a raw report the way the skill writes ux-raw.json. */
export const rawJson = (raw) => `${JSON.stringify(raw, null, 2)}\n`;

/** Tool-authored text must be ASCII with no em or en dash. */
export function expectAsciiNoDash(text, label = 'text') {
  const bad = [...String(text)].filter((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && ch !== '\n' && ch !== '\t'));
  expect(bad, `${label} has non-ASCII characters`).toEqual([]);
}

/**
 * Start an HTTP server on 127.0.0.1:0 for the duration of fn(baseUrl, server).
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 */
export async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  }
}

function detectChromium() {
  try {
    const { chromium } = pluginRequire('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** Playwright's Chromium is installed (use with it.skipIf(!chromiumAvailable)). */
export const chromiumAvailable = detectChromium();

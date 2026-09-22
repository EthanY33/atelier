/**
 * Option normalization for the API and CLI argument parsing.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { UxAuditError } from './errors.mjs';
import { normalizeOrigin } from './url.mjs';
import { DEFAULT_LIMITS } from './collect.mjs';

export const AREAS = Object.freeze(['transitions', 'inp', 'panels', 'mobile']);
export const RULE_PREFIX = 'atelier/runtime-ux/';

export const DYNAMIC_LIMITS = Object.freeze({
  navigationTimeoutMs: 30_000,
  dynamicTimeoutMs: 90_000,
  settleMs: 1000,
  maxTabs: 12,
  maxTaps: 12,
  maxDialogTriggers: 5,
  maxInteractive: 500,
});

/** 'no-unload-handler' or the full id -> 'atelier/runtime-ux/no-unload-handler'. */
export function toFullRuleId(id) {
  const s = String(id ?? '').trim();
  return s.startsWith(RULE_PREFIX) ? s : `${RULE_PREFIX}${s}`;
}

/** Full id -> short id. */
export function toShortRuleId(id) {
  const s = String(id ?? '');
  return s.startsWith(RULE_PREFIX) ? s.slice(RULE_PREFIX.length) : s;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Validate an ISO 8601 date-time and return its canonical toISOString(). */
export function normalizeTimestamp(ts) {
  if (typeof ts !== 'string' || !ISO_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    throw new UxAuditError('USAGE', `Invalid timestamp: ${JSON.stringify(ts)}. Use ISO 8601, e.g. 2026-01-01T00:00:00.000Z.`);
  }
  return new Date(ts).toISOString();
}

function usage(message) {
  return new UxAuditError('USAGE', message, { hint: 'Run with --help for usage.' });
}

function positiveInt(v, name) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n <= 0) throw usage(`${name} must be a positive integer (got ${JSON.stringify(v)})`);
  return n;
}

/**
 * Validate and fill defaults for auditRuntimeUx options.
 * @param {object} opts
 */
export function normalizeOptions(opts) {
  if (!opts || typeof opts !== 'object') throw usage('auditRuntimeUx expects an options object.');
  const url = opts.url instanceof URL ? opts.url.href : opts.url;
  if (typeof url !== 'string' || !url.trim()) throw usage('A url (file path, file:// URL or http(s) URL) is required.');

  let areas = [...AREAS];
  if (opts.areas !== undefined) {
    const list = Array.isArray(opts.areas) ? opts.areas : [opts.areas];
    const bad = list.filter((a) => !AREAS.includes(a));
    if (bad.length || list.length === 0) throw usage(`Unknown area: ${bad.join(', ') || '(empty)'}. Use ${AREAS.join(', ')}.`);
    areas = AREAS.filter((a) => list.includes(a));
  }

  const ignore = [...new Set((Array.isArray(opts.ignore) ? opts.ignore : opts.ignore ? [opts.ignore] : [])
    .map((id) => String(id).trim()).filter(Boolean).map(toFullRuleId))].sort();

  const allowOrigins = [...new Set((Array.isArray(opts.allowOrigins) ? opts.allowOrigins : opts.allowOrigins ? [opts.allowOrigins] : [])
    .map(normalizeOrigin))].sort();

  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(opts.limits ?? {})) {
    if (!(k in DEFAULT_LIMITS)) throw usage(`Unknown limit: ${k}`);
    limits[k] = positiveInt(v, `limits.${k}`);
  }
  const dynamicLimits = { ...DYNAMIC_LIMITS };
  for (const [k, v] of Object.entries(opts.dynamicLimits ?? {})) {
    if (!(k in DYNAMIC_LIMITS)) throw usage(`Unknown dynamic limit: ${k}`);
    dynamicLimits[k] = positiveInt(v, `dynamicLimits.${k}`);
  }

  if (opts.rules !== undefined && !Array.isArray(opts.rules)) throw usage('rules must be an array of rule objects.');
  if (opts.fetchImpl !== undefined && typeof opts.fetchImpl !== 'function') throw usage('fetchImpl must be a function.');
  if (opts.dynamicImpl !== undefined && typeof opts.dynamicImpl !== 'function') throw usage('dynamicImpl must be a function.');
  if (opts.outDir !== undefined && (typeof opts.outDir !== 'string' || !opts.outDir.trim())) throw usage('outDir must be a non-empty string.');
  if (opts.root !== undefined && opts.root !== null && typeof opts.root !== 'string') throw usage('root must be a string.');

  return {
    url: url.trim(),
    outDir: opts.outDir ?? 'ux-report',
    dynamic: opts.dynamic === true,
    brand: opts.brand ?? null,
    root: opts.root ?? undefined,
    areas,
    ignore,
    allowOrigins,
    timestamp: opts.timestamp === undefined || opts.timestamp === null ? null : normalizeTimestamp(opts.timestamp),
    write: opts.write !== false,
    limits: Object.freeze(limits),
    dynamicLimits: Object.freeze(dynamicLimits),
    rules: opts.rules,
    fetchImpl: opts.fetchImpl,
    dynamicImpl: opts.dynamicImpl,
    cwd: typeof opts.cwd === 'string' ? opts.cwd : process.cwd(),
  };
}

export const USAGE = `Usage: atelier ux <url|file> [outDir] [options]
       node index.mjs <url|file> [outDir] [options]

Audit a page for runtime UX problems in four areas: page transitions,
input latency (INP), panels and dialogs, and mobile viewport behavior.
Writes ux-report.md and ux-raw.json to outDir (default ./ux-report).
The static pass parses HTML, CSS and JS and never runs page code.

Options:
  --dynamic                 also load the page in Chromium (Pixel 7, 4x CPU) to
                            estimate INP, probe bfcache, dialogs and tap targets
  --brand <path>            brand.json with motion, surfaces and targets budgets
                            (default: ./.atelier/brand.json when it exists)
  --no-brand                do not load ./.atelier/brand.json
  --root <dir>              local site root; "/x" hrefs map to <dir>/x
                            (default: the HTML file's folder)
  --area <name>             transitions, inp, panels or mobile; repeatable or
                            comma separated (default: all four)
  --ignore <rule-id>        skip a rule, short or full id; repeatable
  --allow-origin <origin>   also fetch subresources from this origin; repeatable
  --timeout <ms>            per-request timeout (default 10000)
  --max-bytes <n>           per-resource size cap in bytes (default 2097152)
  --timestamp <iso>         fixed report timestamp, for reproducible output
  --out <dir>               same as the outDir argument
  -h, --help                show this help

Exit codes: 0 no critical or serious findings, 1 critical or serious
findings, 2 usage error or the audit could not run.`;

/**
 * Parse CLI arguments.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{ cwd?: string }} [env]
 * @returns {{ help: true } | { help: false, options: object }}
 */
export function parseCliArgs(argv, { cwd = process.cwd() } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        dynamic: { type: 'boolean' },
        brand: { type: 'string' },
        'no-brand': { type: 'boolean' },
        root: { type: 'string' },
        area: { type: 'string', multiple: true },
        ignore: { type: 'string', multiple: true },
        'allow-origin': { type: 'string', multiple: true },
        timeout: { type: 'string' },
        'max-bytes': { type: 'string' },
        timestamp: { type: 'string' },
        out: { type: 'string' },
      },
    });
  } catch (err) {
    throw usage(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (positionals.length === 0) throw usage('Missing <url|file>.');
  if (positionals.length > 2) throw usage(`Too many arguments: ${positionals.slice(2).join(' ')}`);
  if (values.out && positionals[1]) throw usage('Give the output directory either as an argument or with --out, not both.');
  if (values.brand && values['no-brand']) throw usage('--brand and --no-brand cannot be combined.');

  let brand = null;
  if (values.brand) brand = values.brand;
  else if (!values['no-brand']) {
    const auto = resolve(cwd, '.atelier', 'brand.json');
    if (existsSync(auto)) brand = auto;
  }

  const limits = {};
  if (values.timeout !== undefined) limits.timeoutMs = positiveInt(values.timeout, '--timeout');
  if (values['max-bytes'] !== undefined) limits.maxBytes = positiveInt(values['max-bytes'], '--max-bytes');

  const areas = values.area ? values.area.flatMap((a) => a.split(',')).map((a) => a.trim().toLowerCase()).filter(Boolean) : undefined;

  return {
    help: false,
    options: {
      url: positionals[0],
      outDir: values.out ?? positionals[1] ?? 'ux-report',
      dynamic: values.dynamic === true,
      brand,
      root: values.root,
      areas,
      ignore: values.ignore ?? [],
      allowOrigins: values['allow-origin'] ?? [],
      timestamp: values.timestamp,
      limits,
    },
  };
}

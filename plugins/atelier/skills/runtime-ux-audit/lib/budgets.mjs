/**
 * Budgets: defaults plus the brand.json motion / surfaces / targets sections.
 *
 * The skill never reads schemas/ at runtime. It validates only the fields it
 * uses, with the same ranges as brand.schema.json, and throws BRAND_INVALID
 * naming the JSON path.
 */
import { resolve } from 'node:path';
import { readJsonFile } from '../../../lib/io.mjs';
import { UxAuditError } from './errors.mjs';

export const DEFAULT_BUDGETS = Object.freeze({
  minTapPx: 24,
  minTapPxSource: 'default',
  inpBudgetMs: 200,
  inpBudgetMsSource: 'default',
  lcpBudgetMs: 2500,
  clsBudget: 0.1,
  zIndexMax: 100,
  longScriptMs: 100,
  motionDurationsMs: null,
});

const TOKEN_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s)$/;
const HINT = 'Fix the value in brand.json (see schemas/brand.schema.json), or pass --no-brand.';

function invalid(path, problem) {
  return new UxAuditError('BRAND_INVALID', `brand.json ${path}: ${problem}`, { hint: HINT, path });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Load a brand: a path (read and JSON-parsed, BOM tolerant), an object already
 * loaded (e.g. by brand-memory's loadBrand), or null/undefined for none.
 * @param {string|object|null|undefined} brand
 * @param {{ cwd?: string }} [opts]
 * @returns {object|null}
 */
export function loadBrand(brand, { cwd = process.cwd() } = {}) {
  if (brand === null || brand === undefined || brand === false) return null;
  if (typeof brand === 'string') {
    let data;
    try {
      data = readJsonFile(resolve(cwd, brand));
    } catch (err) {
      throw new UxAuditError('BRAND_INVALID', `Cannot load brand file: ${err.message}`, { hint: 'Pass a valid --brand path, or --no-brand.', cause: err });
    }
    if (!isObject(data)) throw invalid('(root)', 'must be a JSON object');
    return data;
  }
  if (isObject(brand)) return brand;
  throw invalid('(root)', 'must be an object or a path to a JSON file');
}

function checkNumber(obj, key, path, { integer = false, min, max, exclusiveMin = false }) {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  const ok = typeof v === 'number' && Number.isFinite(v) && (!integer || Number.isInteger(v))
    && (exclusiveMin ? v > min : v >= min) && v <= max;
  if (!ok) {
    const kind = integer ? 'an integer' : 'a number';
    const range = exclusiveMin ? `greater than ${min} and at most ${max}` : `from ${min} to ${max}`;
    throw invalid(`${path}.${key}`, `must be ${kind} ${range} (got ${JSON.stringify(v)})`);
  }
  return v;
}

/**
 * Resolve budgets from a brand object (or null).
 * @param {object|null} brand
 * @returns {Readonly<{ minTapPx: number, minTapPxSource: 'default'|'brand', inpBudgetMs: number, inpBudgetMsSource: 'default'|'brand', lcpBudgetMs: number, clsBudget: number, zIndexMax: number, longScriptMs: number, motionDurationsMs: Record<string, number>|null }>}
 */
export function resolveBudgets(brand) {
  if (brand === null || brand === undefined) return DEFAULT_BUDGETS;
  if (!isObject(brand)) throw invalid('(root)', 'must be a JSON object');
  const out = { ...DEFAULT_BUDGETS };

  if ('targets' in brand) {
    const t = brand.targets;
    if (!isObject(t)) throw invalid('targets', 'must be an object');
    const minTap = checkNumber(t, 'minTapPx', 'targets', { integer: true, min: 1, max: 200 });
    if (minTap !== undefined) { out.minTapPx = minTap; out.minTapPxSource = 'brand'; }
    const inp = checkNumber(t, 'inpBudgetMs', 'targets', { min: 0, max: 10000, exclusiveMin: true });
    if (inp !== undefined) { out.inpBudgetMs = inp; out.inpBudgetMsSource = 'brand'; }
    const lcp = checkNumber(t, 'lcpBudgetMs', 'targets', { min: 0, max: 60000, exclusiveMin: true });
    if (lcp !== undefined) out.lcpBudgetMs = lcp;
    const cls = checkNumber(t, 'clsBudget', 'targets', { min: 0, max: 10 });
    if (cls !== undefined) out.clsBudget = cls;
  }

  if ('surfaces' in brand) {
    const s = brand.surfaces;
    if (!isObject(s)) throw invalid('surfaces', 'must be an object');
    const z = checkNumber(s, 'zIndexMax', 'surfaces', { integer: true, min: 0, max: 2147483647 });
    if (z !== undefined) out.zIndexMax = z;
  }

  if ('motion' in brand) {
    const m = brand.motion;
    if (!isObject(m)) throw invalid('motion', 'must be an object');
    if ('duration' in m) {
      const d = m.duration;
      if (!isObject(d)) throw invalid('motion.duration', 'must be an object of named durations');
      const durations = {};
      for (const name of Object.keys(d).sort()) {
        if (!TOKEN_NAME_RE.test(name)) throw invalid(`motion.duration.${name}`, 'token names must match ^[a-zA-Z][a-zA-Z0-9_-]*$');
        const v = d[name];
        const match = typeof v === 'string' ? DURATION_RE.exec(v) : null;
        if (!match) throw invalid(`motion.duration.${name}`, `must be a duration like "180ms" or "0.2s" (got ${JSON.stringify(v)})`);
        const n = Number(match[1]);
        durations[name] = Math.round((match[2] === 's' ? n * 1000 : n) * 1000) / 1000;
      }
      if (Object.keys(durations).length) out.motionDurationsMs = Object.freeze(durations);
    }
  }
  return Object.freeze(out);
}

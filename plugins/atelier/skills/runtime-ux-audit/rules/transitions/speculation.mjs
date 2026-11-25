/**
 * Speculation Rules: immediate rules over Chromium's caps, and inline rules
 * that the page's Content-Security-Policy blocks.
 */
import { createHash } from 'node:crypto';
import { HELP, MATCH_BUDGET, compileHrefPattern, hrefMatchBudget, spendMatchBudget, stripQueryHash } from './shared.mjs';

// Chromium keeps at most this many immediate (and eager) speculations per action.
const LIMITS = Object.freeze({ prerender: 10, prefetch: 50 });
const LINK_SCHEME_RE = /^(https?|file):/i;
const MAX_PREDICATE_DEPTH = 32;
// A longer selector_matches selector makes the rule incomplete: parsing and
// matching cost grows with its length and nesting.
const MAX_SELECTOR_LENGTH = 1024;

// ctx.page.resolve parses the <base href> again on every call, relative results
// carry the whole base, and V8 stops hashing strings past 16383 characters, so
// a Set of long URLs costs its size squared. Bases up to FREE_BASE_LENGTH add
// no per-resolution cost of their own (see FREE_RESOLVES below). A longer one
// costs length / 8 steps per resolution, and one over MAX_BASE_LENGTH makes
// every resolution throw MATCH_BUDGET (rule incomplete).
const FREE_BASE_LENGTH = 1024;
const MAX_BASE_LENGTH = 8192;
// Resolving is not free on a short base either: a relative URL on a file: page
// is parsed twice (about 14 microseconds), and one that does not parse costs an
// exception (about 40). The first FREE_RESOLVES of a run cost nothing, so an
// ordinary page and its list rules are counted even after other rules spend the
// budget. After that each resolution costs RESOLVE_STEPS, and
// FAILED_RESOLVE_STEPS more when the URL does not parse.
const FREE_RESOLVES = 20_000;
const RESOLVE_STEPS = 256;
const FAILED_RESOLVE_STEPS = 1024;

// One match set per selector text and run, so a selector repeated across rules
// is charged once. Keyed by the run's budget object.
const selectorSets = new WeakMap();
// Total length of every attribute value of a page, summed once per HtmlModel.
const attrCharsOf = new WeakMap();

function attrChars(html) {
  let n = attrCharsOf.get(html);
  if (n === undefined) {
    n = 0;
    for (const el of html.elements) for (const a of el.attrs ?? []) n += a.value.length;
    attrCharsOf.set(html, n);
  }
  return n;
}

/** Steps one querySelectorAll pass over the page is charged: per element by combinators, simple selectors and lists, plus attribute value text once per attribute selector. */
function selectorPassCost(html, selector) {
  const combinators = selector.match(/[\s>+~]+/g)?.length ?? 0;
  const simple = selector.match(/[.#[:]/g)?.length ?? 0;
  const lists = selector.match(/[,(]/g)?.length ?? 0;
  const attrs = selector.match(/\[/g)?.length ?? 0;
  return html.elements.length * (16 + 24 * combinators + 2 * simple + 16 * lists) + attrs * attrChars(html);
}

/** Absolute URL of the audited document (no hash), comparable with ctx.page.resolve() output. */
function documentUrl(ctx) {
  if (ctx.page.kind === 'http') {
    const u = String(ctx.page.displayUrl);
    const h = u.indexOf('#');
    return h >= 0 ? u.slice(0, h) : u;
  }
  return ctx.page.resolve(`/${ctx.page.displayUrl}`);
}

/**
 * <a href> and <area href> links a document rule can match: { el, url, bare, id }.
 * id is a small integer, equal for equal URLs. Rules count unique ids, not URL
 * strings: V8 does not hash strings past 16383 characters, so a Set of long
 * URLs built once per rule costs the number of links squared every time.
 */
function documentLinks(ctx, docUrl, resolve) {
  const { html } = ctx;
  const out = [];
  const ids = new Map();
  for (const el of [...html.byTag('a'), ...html.byTag('area')]) {
    const href = html.attr(el, 'href');
    if (href === null) continue;
    const url = resolve(href);
    if (!url || !LINK_SCHEME_RE.test(url) || url === docUrl) continue;
    let id = ids.get(url);
    if (id === undefined) ids.set(url, (id = ids.size));
    out.push({ el, url, bare: stripQueryHash(url), id });
  }
  return out;
}

/**
 * Compile a document-rule predicate into a link filter. Supported:
 * href_matches (string or array, with optional relative_to),
 * selector_matches, and, or, not. Anything else: null (the rule is skipped).
 * Every href_matches pattern, every selector_matches parse and pass and every
 * predicate node evaluated draws on the one budget (see hrefMatchBudget), and
 * the filter throws MATCH_BUDGET once it is spent. Compiling throws it too, for
 * a selector over MAX_SELECTOR_LENGTH or a parse that exceeds the budget, so
 * callers compile inside the same try as the matching. Relative patterns resolve
 * through resolve, which the caller charges to the budget. A selector's match set
 * is built once per run, on first use, and shared by every rule that repeats it.
 */
function compilePredicate(pred, ctx, budget, resolve, depth = 0) {
  if (depth > MAX_PREDICATE_DEPTH || !pred || typeof pred !== 'object' || Array.isArray(pred)) return null;
  const keys = Object.keys(pred);
  const main = keys.filter((k) => k !== 'relative_to');
  if (main.length !== 1) return null;
  const [key] = main;
  if (keys.includes('relative_to') && (key !== 'href_matches' || !['document', 'ruleset'].includes(pred.relative_to))) return null;
  const value = pred[key];
  const list = Array.isArray(value) ? value : [value];
  switch (key) {
    case 'href_matches': {
      if (!list.length) return null;
      const res = list.map((p) => compileHrefPattern(p, resolve, budget));
      if (res.some((re) => re === null)) return null;
      return (link) => res.some((re) => re.test(link.bare));
    }
    case 'selector_matches': {
      if (!list.length || list.some((s) => typeof s !== 'string')) return null;
      if (list.some((s) => s.length > MAX_SELECTOR_LENGTH)) throw MATCH_BUDGET;
      // Parsing happens in the probe check below and in every pass.
      for (const s of list) spendMatchBudget(budget, 1024 + s.length * (16 + (s.match(/\(/g)?.length ?? 0)));
      const probe = ctx.html.elements[0];
      if (probe && list.some((s) => ctx.html.matches(probe, s) === null)) return null;
      let sets = selectorSets.get(budget);
      if (!sets) selectorSets.set(budget, (sets = new Map()));
      const setOf = (i) => {
        const selector = list[i];
        let set = sets.get(selector);
        if (!set) {
          spendMatchBudget(budget, selectorPassCost(ctx.html, selector));
          set = new Set(ctx.html.querySelectorAll(selector));
          sets.set(selector, set);
        }
        return set;
      };
      return (link) => list.some((_, i) => { spendMatchBudget(budget, 1); return setOf(i).has(link.el); });
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(value)) return null;
      const parts = value.map((p) => compilePredicate(p, ctx, budget, resolve, depth + 1));
      if (parts.some((p) => p === null)) return null;
      // One step per node evaluated, so a predicate of many empty nodes costs too.
      const part = (p, link) => { spendMatchBudget(budget, 1); return p(link); };
      return key === 'and' ? (link) => parts.every((p) => part(p, link)) : (link) => parts.some((p) => part(p, link));
    }
    case 'not': {
      const inner = compilePredicate(value, ctx, budget, resolve, depth + 1);
      return inner ? (link) => { spendMatchBudget(budget, 1); return !inner(link); } : null;
    }
    default:
      return null;
  }
}

/**
 * Unique candidate URLs of one immediate speculation rule, or null when the
 * rule is malformed, uses unsupported predicates or is not immediate. Only
 * immediate rules are reported, so the others are not matched and spend none
 * of the budget. The document branch also takes a fixed number of steps from
 * the budget per link visited. count is null when the budget ran out before
 * every link was matched, including while compiling the predicate or
 * resolving URLs (resolve, see check(): the first FREE_RESOLVES of a run are
 * free, each later one costs steps), in either branch.
 * @returns {{ count: number|null, source: 'list'|'document' }|null}
 */
function candidatesOf(r, ctx, docUrl, links, budget, resolve) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const hasUrls = r.urls !== undefined;
  const hasWhere = r.where !== undefined;
  if (hasUrls && hasWhere) return null;
  const source = r.source ?? (hasUrls ? 'list' : hasWhere ? 'document' : null);
  const eagerness = typeof r.eagerness === 'string' ? r.eagerness : source === 'list' ? 'immediate' : 'conservative';
  if (eagerness !== 'immediate') return null;
  if (source !== 'list' && source !== 'document') return null;
  if (source === 'list' && !Array.isArray(r.urls)) return null;
  if (source === 'document' && hasUrls) return null;
  try {
    if (source === 'list') {
      const set = new Set();
      for (const u of r.urls) {
        if (typeof u !== 'string') continue;
        const abs = resolve(u);
        if (abs && abs !== docUrl) set.add(abs);
      }
      return { count: set.size, source };
    }
    const pred = hasWhere ? compilePredicate(r.where, ctx, budget, resolve) : () => true;
    if (!pred) return null;
    const set = new Set(links().filter((l) => { spendMatchBudget(budget, 8); return pred(l); }).map((l) => l.id));
    return { count: set.size, source };
  } catch (e) {
    if (e === MATCH_BUDGET) return { count: null, source };
    throw e;
  }
}

export const speculationRulesImmediateAbuse = {
  id: 'atelier/runtime-ux/speculation-rules-immediate-abuse',
  area: 'transitions',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['html'],
  phase: 'static',
  description: 'An immediate speculation rule matches more URLs than Chromium will prerender or prefetch at once.',
  helpUrl: HELP.speculationImprovements,
  check(ctx) {
    const entries = ctx.html.speculationRules.filter((e) => e.json && typeof e.json === 'object' && !Array.isArray(e.json));
    if (!entries.length) return { notApplicable: 'no speculation rules' };
    const docUrl = documentUrl(ctx);
    let cachedLinks = null;
    // One budget for the whole run: many rules, patterns, selectors or links
    // cannot multiply it.
    const budget = hrefMatchBudget();
    const baseLength = (ctx.page.resolve('#') ?? '').length;
    const resolveSteps = baseLength > FREE_BASE_LENGTH ? baseLength >> 3 : 0;
    let freeResolves = FREE_RESOLVES;
    const resolve = (href) => {
      if (baseLength > MAX_BASE_LENGTH) throw MATCH_BUDGET;
      const free = freeResolves > 0;
      if (free) freeResolves--;
      else spendMatchBudget(budget, RESOLVE_STEPS);
      if (resolveSteps) spendMatchBudget(budget, resolveSteps);
      const abs = ctx.page.resolve(href);
      if (abs === null && !free) spendMatchBudget(budget, FAILED_RESOLVE_STEPS);
      return abs;
    };
    const links = () => (cachedLinks ??= documentLinks(ctx, docUrl, resolve));
    const out = [];
    for (const entry of entries) {
      // One NodeRef per script element and one finding per message. The runner
      // keeps one node per selector, location and message anyway, and building
      // a NodeRef reads the whole start tag and the path of the element.
      let node = null;
      const seen = new Set();
      const report = (finding) => {
        if (seen.has(finding.message)) return;
        seen.add(finding.message);
        out.push({ node: (node ??= ctx.ref.html(entry.el)), ...finding });
      };
      for (const action of Object.keys(LIMITS)) {
        const list = entry.json[action];
        if (!Array.isArray(list)) continue;
        for (const r of list) {
          const c = candidatesOf(r, ctx, docUrl, links, budget, resolve);
          if (!c) continue;
          if (c.count === null) {
            report({
              message: `Too many links, selectors and patterns to count the URLs this immediate ${action} rule matches statically.`,
              incomplete: true,
            });
            continue;
          }
          if (c.count <= LIMITS[action]) continue;
          report({
            message: `This immediate ${action} rule matches ${c.count} URLs, above Chromium's limit of ${LIMITS[action]}; the extra requests waste bandwidth and memory. Use eagerness moderate or conservative.`,
            data: { action, candidates: c.count, limit: LIMITS[action], source: c.source },
          });
        }
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// CSP
// ---------------------------------------------------------------------------

const EFFECTIVE_DIRECTIVES = ['script-src-elem', 'script-src', 'default-src'];
const NONCE_OR_HASH_RE = /^'(nonce-|sha(256|384|512)-)/i;

// A SHA-512 digest is 88 base64 characters with padding; longer hash sources
// cannot match and are not normalized.
const MAX_HASH_SOURCE = 128;

/** base64url to base64, trailing '=' padding removed. The trim is a linear scan: /=+$/ is quadratic on a long '=' run that is not at the end. */
function normB64(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  let end = t.length;
  while (end > 0 && t.charCodeAt(end - 1) === 61) end--; // '='
  return t.slice(0, end);
}

function digest(alg, text) {
  return createHash(alg).update(String(text), 'utf8').digest('base64');
}

/** True when a source list lets this inline speculation rules script run. */
function allowsInline(tokens, nonce, text) {
  const lowered = tokens.map((t) => t.toLowerCase());
  if (lowered.includes("'inline-speculation-rules'")) return true;
  const hasNonceOrHash = tokens.some((t) => NONCE_OR_HASH_RE.test(t));
  if (lowered.includes("'unsafe-inline'") && !hasNonceOrHash && !lowered.includes("'strict-dynamic'")) return true;
  // One digest per algorithm, however many hash sources the policy lists.
  const digests = new Map();
  const digestOf = (alg) => {
    if (!digests.has(alg)) digests.set(alg, normB64(digest(alg, text)));
    return digests.get(alg);
  };
  for (const t of tokens) {
    const n = /^'nonce-(.+)'$/i.exec(t);
    if (n && nonce && n[1] === nonce) return true;
    const h = /^'(sha256|sha384|sha512)-(.+)'$/i.exec(t);
    if (h && h[2].length <= MAX_HASH_SOURCE && normB64(h[2]) === digestOf(h[1].toLowerCase())) return true;
  }
  return false;
}

export const speculationRulesCspGap = {
  id: 'atelier/runtime-ux/speculation-rules-csp-gap',
  area: 'transitions',
  severity: 'serious',
  confidence: 'high',
  methods: ['html', 'headers'],
  phase: 'static',
  description: "The page's Content-Security-Policy blocks its inline speculation rules.",
  helpUrl: HELP.speculationApi,
  check(ctx) {
    const { html } = ctx;
    const inline = html.speculationRules.filter((e) => !html.hasAttr(e.el, 'src'));
    if (!inline.length) return { notApplicable: 'no inline speculation rules' };
    if (!ctx.page.csp.length) return { notApplicable: 'no Content-Security-Policy' };
    const out = [];
    for (const entry of inline) {
      const nonce = html.attr(entry.el, 'nonce');
      for (const policy of ctx.page.csp) {
        const directive = EFFECTIVE_DIRECTIVES.find((d) => Object.hasOwn(policy.directives, d));
        if (!directive || allowsInline(policy.directives[directive], nonce, entry.rawText)) continue;
        out.push({
          node: ctx.ref.html(entry.el),
          message: `Blocked by the ${policy.source} CSP ${directive}: add 'inline-speculation-rules', a matching nonce or the sha256 hash to ${directive}.`,
          data: { directive, policy: policy.source, sha256: `'sha256-${digest('sha256', entry.rawText)}'` },
        });
        break;
      }
    }
    return out;
  },
};

export const rules = [speculationRulesImmediateAbuse, speculationRulesCspGap];

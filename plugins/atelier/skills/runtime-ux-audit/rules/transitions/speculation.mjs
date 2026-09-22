/**
 * Speculation Rules: immediate rules over Chromium's caps, and inline rules
 * that the page's Content-Security-Policy blocks.
 */
import { createHash } from 'node:crypto';
import { HELP, compileHrefPattern, stripQueryHash } from './shared.mjs';

// Chromium keeps at most this many immediate (and eager) speculations per action.
const LIMITS = Object.freeze({ prerender: 10, prefetch: 50 });
const LINK_SCHEME_RE = /^(https?|file):/i;
const MAX_PREDICATE_DEPTH = 32;

/** Absolute URL of the audited document (no hash), comparable with ctx.page.resolve() output. */
function documentUrl(ctx) {
  if (ctx.page.kind === 'http') {
    const u = String(ctx.page.displayUrl);
    const h = u.indexOf('#');
    return h >= 0 ? u.slice(0, h) : u;
  }
  return ctx.page.resolve(`/${ctx.page.displayUrl}`);
}

/** <a href> and <area href> links a document rule can match: { el, url, bare }. */
function documentLinks(ctx, docUrl) {
  const { html } = ctx;
  const out = [];
  for (const el of [...html.byTag('a'), ...html.byTag('area')]) {
    const href = html.attr(el, 'href');
    if (href === null) continue;
    const url = ctx.page.resolve(href);
    if (!url || !LINK_SCHEME_RE.test(url) || url === docUrl) continue;
    out.push({ el, url, bare: stripQueryHash(url) });
  }
  return out;
}

/**
 * Compile a document-rule predicate into a link filter. Supported:
 * href_matches (string or array, with optional relative_to),
 * selector_matches, and, or, not. Anything else: null (the rule is skipped).
 */
function compilePredicate(pred, ctx, depth = 0) {
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
      const res = list.map((p) => compileHrefPattern(p, ctx.page.resolve));
      if (res.some((re) => re === null)) return null;
      return (link) => res.some((re) => re.test(link.bare));
    }
    case 'selector_matches': {
      if (!list.length || list.some((s) => typeof s !== 'string')) return null;
      const probe = ctx.html.elements[0];
      if (probe && list.some((s) => ctx.html.matches(probe, s) === null)) return null;
      return (link) => list.some((s) => ctx.html.matches(link.el, s) === true);
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(value)) return null;
      const parts = value.map((p) => compilePredicate(p, ctx, depth + 1));
      if (parts.some((p) => p === null)) return null;
      return key === 'and' ? (link) => parts.every((p) => p(link)) : (link) => parts.some((p) => p(link));
    }
    case 'not': {
      const inner = compilePredicate(value, ctx, depth + 1);
      return inner ? (link) => !inner(link) : null;
    }
    default:
      return null;
  }
}

/**
 * Unique candidate URLs of one speculation rule, or null when the rule is
 * malformed or uses unsupported predicates.
 * @returns {{ count: number, source: 'list'|'document', eagerness: string }|null}
 */
function candidatesOf(r, ctx, docUrl, links) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const hasUrls = r.urls !== undefined;
  const hasWhere = r.where !== undefined;
  if (hasUrls && hasWhere) return null;
  const source = r.source ?? (hasUrls ? 'list' : hasWhere ? 'document' : null);
  const eagerness = typeof r.eagerness === 'string' ? r.eagerness : source === 'list' ? 'immediate' : 'conservative';
  if (source === 'list') {
    if (!Array.isArray(r.urls)) return null;
    const set = new Set();
    for (const u of r.urls) {
      if (typeof u !== 'string') continue;
      const abs = ctx.page.resolve(u);
      if (abs && abs !== docUrl) set.add(abs);
    }
    return { count: set.size, source, eagerness };
  }
  if (source === 'document') {
    if (hasUrls) return null;
    const pred = hasWhere ? compilePredicate(r.where, ctx) : () => true;
    if (!pred) return null;
    const set = new Set(links().filter(pred).map((l) => l.url));
    return { count: set.size, source, eagerness };
  }
  return null;
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
    const links = () => (cachedLinks ??= documentLinks(ctx, docUrl));
    const out = [];
    for (const entry of entries) {
      for (const action of Object.keys(LIMITS)) {
        const list = entry.json[action];
        if (!Array.isArray(list)) continue;
        for (const r of list) {
          const c = candidatesOf(r, ctx, docUrl, links);
          if (!c || c.eagerness !== 'immediate' || c.count <= LIMITS[action]) continue;
          out.push({
            node: ctx.ref.html(entry.el),
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

const normB64 = (s) => String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');

function digest(alg, text) {
  return createHash(alg).update(String(text), 'utf8').digest('base64');
}

/** True when a source list lets this inline speculation rules script run. */
function allowsInline(tokens, nonce, text) {
  const lowered = tokens.map((t) => t.toLowerCase());
  if (lowered.includes("'inline-speculation-rules'")) return true;
  const hasNonceOrHash = tokens.some((t) => NONCE_OR_HASH_RE.test(t));
  if (lowered.includes("'unsafe-inline'") && !hasNonceOrHash && !lowered.includes("'strict-dynamic'")) return true;
  for (const t of tokens) {
    const n = /^'nonce-(.+)'$/i.exec(t);
    if (n && nonce && n[1] === nonce) return true;
    const h = /^'(sha256|sha384|sha512)-(.+)'$/i.exec(t);
    if (h && normB64(h[2]) === normB64(digest(h[1].toLowerCase(), text))) return true;
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

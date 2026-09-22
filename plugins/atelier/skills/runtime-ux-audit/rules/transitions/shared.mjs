/**
 * Helpers shared by the transitions rules. Pure: no I/O, no ctx mutation.
 */
import { isReducedMotionNoPreference, isReducedMotionReduce, splitTopLevel } from '../../lib/css-values.mjs';

export const HELP = Object.freeze({
  bfcache: 'https://web.dev/articles/bfcache',
  bfcacheReasons: 'https://developer.chrome.com/docs/web-platform/bfcache-notrestoredreasons',
  bfcacheCcns: 'https://developer.chrome.com/docs/web-platform/bfcache-ccns',
  vtUsing: 'https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using',
  reducedMotion: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion',
  vtName: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name',
  speculationImprovements: 'https://developer.chrome.com/blog/speculation-rules-improvements',
  speculationApi: 'https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API',
  prerendering: 'https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering',
});

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

// document.body.onX = f sets the window handler for window-reflecting events.
const BODY_RE = /^(?:(?:window|self|globalThis)\.)*document\.body$/;

/**
 * True when a ListenerInfo registers on the window: target 'window', or a
 * property handler assigned on document.body (window-reflecting).
 */
export function isWindowListener(l) {
  if (l.target === 'window') return true;
  return l.via === 'property' && BODY_RE.test(String(l.targetText ?? ''));
}

/** NodeRef for a listener: the attribute on the element, or the JS node. */
export function listenerRef(ctx, l) {
  if (l.via === 'attribute' && l.script?.el) return ctx.ref.html(l.script.el, l.script.eventName ?? `on${l.event}`);
  return ctx.ref.js(l);
}

/** String value of a string Literal or an expression-free template literal. */
export { stringValue } from '../../lib/js-model.mjs';

// ---------------------------------------------------------------------------
// prefers-reduced-motion contexts
// ---------------------------------------------------------------------------

// The media-query logic lives in lib/css-values.mjs (boolean form, 'not'
// on a feature or a whole query); these names are kept for the rules.
export { motionPreferenceOf } from '../../lib/css-values.mjs';

/**
 * Inside a media query that only matches when reduced motion is requested.
 * @param {object} c - a CssContext, or anything with .context
 */
export function inReduceMotion(c) {
  return isReducedMotionReduce(c);
}

/**
 * Inside a media query that only matches when no motion preference is set.
 * @param {object} c - a CssContext, or anything with .context
 */
export function inNoPreference(c) {
  return isReducedMotionNoPreference(c);
}

// ---------------------------------------------------------------------------
// Specificity
// ---------------------------------------------------------------------------

const MAX_ARG_FNS = new Set(['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any']);
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

const isIdentChar = (ch) => /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;

function skipIdent(s, i) {
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (!isIdentChar(s[i])) break;
    i++;
  }
  return i;
}

function readParens(s, i) {
  // s[i] === '(' -> [inner, index after the closing paren]
  let depth = 0;
  let quote = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

function skipBracket(s, i) {
  let quote = null;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ']') return j + 1;
  }
  return s.length;
}

/** Component-wise [a, b, c] comparison. */
export function compareSpecificity(x, y) {
  return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);
}

function maxOf(list) {
  let best = [0, 0, 0];
  for (const sel of list) {
    const sp = specificity(sel);
    if (compareSpecificity(sp, best) > 0) best = sp;
  }
  return best;
}

/**
 * Specificity [ids, classes, types] of one complex selector (Selectors 4):
 * :is/:not/:has take their most specific argument, :where counts zero,
 * :nth-child(An+B of S) adds S, pseudo-elements count as types.
 * @param {string} sel
 * @returns {[number, number, number]}
 */
export function specificity(sel) {
  const s = String(sel ?? '');
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { a++; i = skipIdent(s, i + 1); continue; }
    if (ch === '.') { b++; i = skipIdent(s, i + 1); continue; }
    if (ch === '[') { b++; i = skipBracket(s, i); continue; }
    if (ch === ':') {
      if (s[i + 1] === ':') {
        c++;
        i = skipIdent(s, i + 2);
        if (s[i] === '(') i = readParens(s, i)[1];
        continue;
      }
      const end = skipIdent(s, i + 1);
      const name = s.slice(i + 1, end).toLowerCase();
      i = end;
      let inner = null;
      if (s[i] === '(') [inner, i] = readParens(s, i);
      if (inner === null) {
        if (LEGACY_PSEUDO_ELEMENTS.has(name)) c++;
        else b++;
        continue;
      }
      if (name === 'where') continue;
      let add = [0, 0, 0];
      if (MAX_ARG_FNS.has(name)) add = maxOf(splitTopLevel(inner, ','));
      else {
        b++;
        const of = /\sof\s/i.exec(inner);
        if (of && /^nth-(last-)?child$/.test(name)) add = maxOf(splitTopLevel(inner.slice(of.index + of[0].length), ','));
      }
      a += add[0];
      b += add[1];
      c += add[2];
      continue;
    }
    if (ch === '\\' || isIdentChar(ch)) {
      const end = skipIdent(s, i);
      // A namespace prefix (ns|type) is not a type selector of its own.
      if (s[end] !== '|') c++;
      i = end;
      continue;
    }
    i++;
  }
  return [a, b, c];
}

// ---------------------------------------------------------------------------
// URL patterns (speculation rules href_matches)
// ---------------------------------------------------------------------------

const TOKEN = 'zzatelier';

/**
 * Compile the supported subset of a URL pattern string into a RegExp over
 * absolute URLs without query or hash. '*' matches anything and ':name' one
 * path segment. Relative patterns resolve like links (resolveHref, which
 * honors <base href> and the local root). Regex groups, braces, modifiers,
 * escapes and search or hash parts are unsupported: null.
 * @param {unknown} pattern
 * @param {(href: string) => string|null} resolveHref
 * @returns {RegExp|null}
 */
export function compileHrefPattern(pattern, resolveHref) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  const p = pattern.trim();
  if (/[(){}\\?#+]/.test(p)) return null;
  const kinds = [];
  const withTokens = p.replace(/\*|:([A-Za-z_$][\w$]*)/g, (m) => {
    kinds.push(m === '*' ? '.*' : '[^/]+');
    return `${TOKEN}${kinds.length - 1}x`;
  });
  const abs = resolveHref(withTokens);
  if (!abs) return null;
  const bare = stripQueryHash(abs);
  let src = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  src = src.replace(new RegExp(`${TOKEN}(\\d+)x`, 'g'), (m, n) => kinds[Number(n)] ?? m);
  return new RegExp(`^${src}$`);
}

/** Drop the query and fragment of a URL string. */
export function stripQueryHash(u) {
  const s = String(u);
  const h = s.indexOf('#');
  const noHash = h >= 0 ? s.slice(0, h) : s;
  const q = noHash.indexOf('?');
  return q >= 0 ? noHash.slice(0, q) : noHash;
}

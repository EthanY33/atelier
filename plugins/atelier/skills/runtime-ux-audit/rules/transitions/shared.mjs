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
// A longer pattern or link makes the rule incomplete (MATCH_BUDGET): matching costs pattern length times URL length per link.
const MAX_PATTERN_LENGTH = 1024;
const MAX_URL_LENGTH = 8192;
// The two bounds above cap one test() call. This one caps the steps of every
// call that draws on the same budget, about a second of matching.
const MAX_MATCH_STEPS = 20_000_000;

/** Thrown by test() once the step budget of its matcher is spent. */
export const MATCH_BUDGET = Symbol('href-match-budget');

/**
 * A step budget for compileHrefPattern, with the state arrays its matchers
 * work in. Matchers that share one stop together, so many links times many
 * patterns cannot multiply the bound. The same budget also pays for link
 * visits and selector passes (spendMatchBudget).
 */
export function hrefMatchBudget() {
  return { left: MAX_MATCH_STEPS, cur: [], next: [], stamp: [], step: 0 };
}

/**
 * Take steps from a budget made by hrefMatchBudget, for work done outside
 * test() (link visits, selector passes). Throws MATCH_BUDGET once it is spent.
 * @param {ReturnType<typeof hrefMatchBudget>} budget
 * @param {number} steps
 */
export function spendMatchBudget(budget, steps) {
  if ((budget.left -= steps) < 0) throw MATCH_BUDGET;
}

/**
 * Compile the supported subset of a URL pattern string into a matcher over
 * absolute URLs without query or hash. '*' matches anything and ':name' one
 * path segment. Relative patterns resolve like links (resolveHref, which
 * honors <base href> and the local root). Regex groups, braces, modifiers,
 * escapes and search or hash parts are unsupported: null. A pattern over 1024
 * characters throws MATCH_BUDGET, so the rule is reported incomplete rather
 * than skipped as unsupported. The matcher runs
 * in time linear in pattern length times URL length (no regex backtracking),
 * and every test() draws on a step budget, so hostile patterns and links
 * cannot stall the audit: once the budget is spent, test() throws
 * MATCH_BUDGET instead of answering. Compiling takes 512 steps plus the length
 * of the resolved pattern from the budget, so it can throw MATCH_BUDGET too:
 * call it where that is caught.
 * @param {unknown} pattern
 * @param {(href: string) => string|null} resolveHref
 * @param {ReturnType<typeof hrefMatchBudget>} [budget] - pass the same one
 *   for every pattern of a run. Default: one per pattern.
 * @returns {{ test: (url: string) => boolean }|null}
 */
export function compileHrefPattern(pattern, resolveHref, budget = hrefMatchBudget()) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  const p = pattern.trim();
  if (p.length > MAX_PATTERN_LENGTH) throw MATCH_BUDGET;
  if (/[(){}\\?#+]/.test(p)) return null;
  const kinds = [];
  const withTokens = p.replace(/\*|:([A-Za-z_$][\w$]*)/g, (m) => {
    kinds.push(m === '*' ? 'any' : 'seg');
    return `${TOKEN}${kinds.length - 1}x`;
  });
  const abs = resolveHref(withTokens);
  if (!abs) return null;
  const bare = stripQueryHash(abs);
  spendMatchBudget(budget, 512 + bare.length);
  // Items: a literal char, 'any' (zero or more of anything) or 'ns' / 'nsstar'
  // (one, then zero or more, non-slash chars: a ':name' segment).
  const items = [];
  const tokenRe = new RegExp(`${TOKEN}(\\d+)x`, 'g');
  const pushLiteral = (text) => { for (const ch of text) items.push(ch); };
  let last = 0;
  for (const m of bare.matchAll(tokenRe)) {
    pushLiteral(bare.slice(last, m.index));
    last = m.index + m[0].length;
    const kind = kinds[Number(m[1])];
    if (kind === 'seg') items.push('ns', 'nsstar');
    else if (kind === 'any') { if (items[items.length - 1] !== 'any') items.push('any'); }
    else pushLiteral(m[0]);
  }
  pushLiteral(bare.slice(last));
  return { test: (url) => matchItems(items, String(url), budget) };
}

/**
 * Simulate the pattern as an NFA over the input, one state set per character.
 * A call costs one step plus the number of active states per character, not
 * the pattern length, and an input longer than MAX_URL_LENGTH throws
 * MATCH_BUDGET: the link cannot be matched, and a clean answer would hide it.
 * The steps come out of the budget (MATCH_BUDGET once it is spent), and the
 * state arrays are the budget's too: allocating them per call cost more than
 * matching an ordinary link.
 */
function matchItems(items, input, budget) {
  if (--budget.left < 0) throw MATCH_BUDGET;
  if (input.length > MAX_URL_LENGTH) throw MATCH_BUDGET;
  const m = items.length;
  const loops = (i) => items[i] === 'any' || items[i] === 'nsstar';
  let { cur, next } = budget;
  let curN = 0;
  let nextN = 0;
  // stamp[i] === step marks state i as already in the set being built. Each
  // call takes its own run of step values, so stamps of earlier calls never match.
  const { stamp } = budget;
  while (stamp.length < m + 2) stamp.push(-1);
  let step = budget.step;
  budget.step += input.length + 1;
  const add = (i) => { if (stamp[i] !== step) { stamp[i] = step; next[nextN++] = i; } };
  // Add the states and follow epsilon moves out of loop states.
  const addClosed = (i) => { for (let j = i; ; j++) { add(j); if (j >= m || !loops(j)) break; } };
  addClosed(0);
  [cur, next] = [next, cur];
  curN = nextN;
  for (const ch of input) {
    if ((budget.left -= curN) < 0) throw MATCH_BUDGET;
    step++;
    nextN = 0;
    for (let k = 0; k < curN; k++) {
      const i = cur[k];
      if (i >= m) continue;
      const it = items[i];
      if (it === 'any') addClosed(i);
      else if (it === 'nsstar') { if (ch !== '/') addClosed(i); }
      else if (it === 'ns') { if (ch !== '/') addClosed(i + 1); }
      else if (it === ch) addClosed(i + 1);
    }
    if (nextN === 0) return false;
    [cur, next] = [next, cur];
    curN = nextN;
  }
  for (let k = 0; k < curN; k++) if (cur[k] === m) return true;
  return false;
}

/** Drop the query and fragment of a URL string. */
export function stripQueryHash(u) {
  const s = String(u);
  const h = s.indexOf('#');
  const noHash = h >= 0 ? s.slice(0, h) : s;
  const q = noHash.indexOf('?');
  return q >= 0 ? noHash.slice(0, q) : noHash;
}

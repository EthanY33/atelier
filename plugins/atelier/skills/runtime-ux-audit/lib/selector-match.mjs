/**
 * Subset CSS selector matcher over parse5 trees.
 *
 * Supported: type, *, #id, .class, [a] [a=v] [a~=v] [a|=v] [a^=v] [a$=v]
 * [a*=v] (i/s flags), :not/:is/:where/:matches (selector lists), :root,
 * :first-child, :last-child, :only-child, :first-of-type, :last-of-type,
 * :only-of-type, :nth-child(An+B), :nth-last-child, :nth-of-type,
 * :nth-last-of-type (without "of S"), :empty, :disabled, :enabled, :defined,
 * the ' ' '>' '+' '~' combinators and selector lists.
 * State pseudo-classes (STATE_PSEUDOS) are treated as matching (inside :not
 * they are treated as not matching, so :not(:hover) matches).
 * Pseudo-elements match their originating element.
 * Anything else (:has, :nth-*(of S), namespaces, '&', ...) is unsupported:
 * compileSelector returns null, matches() returns null and
 * querySelectorAll() returns [].
 */
import { STATE_PSEUDOS, stripCssComments } from './css-values.mjs';

const STATE = new Set(STATE_PSEUDOS);
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const STRUCTURAL = new Set(['root', 'first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'disabled', 'enabled', 'defined', 'scope']);
const NTH = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type']);
const LIST_FNS = new Set(['not', 'is', 'where', 'matches', '-webkit-any', '-moz-any']);
const DISABLEABLE = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);

class Unsupported extends Error {}

function isIdentChar(ch) {
  return /[\w-]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function readIdent(s, i) {
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(s.slice(i + 1));
      if (hex) {
        out += String.fromCodePoint(Number.parseInt(hex[0].trim(), 16));
        i += 1 + hex[0].length;
      } else {
        out += s[i + 1] ?? '';
        i += 2;
      }
      continue;
    }
    if (!isIdentChar(ch)) break;
    out += ch;
    i++;
  }
  return [out, i];
}

function readBalanced(s, i) {
  // s[i] === '('; returns [inner, indexAfterClose]
  let depth = 0;
  let quote = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  throw new Unsupported('unbalanced');
}

function splitList(s) {
  const parts = [];
  let depth = 0;
  let bracket = 0;
  let quote = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0 && bracket === 0) { parts.push(s.slice(last, i)); last = i + 1; }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim());
}

function parseNth(arg) {
  const a = arg.trim().toLowerCase().replace(/\s+/g, '');
  if (/\bof\b/.test(arg)) throw new Unsupported('nth of');
  if (a === 'odd') return [2, 1];
  if (a === 'even') return [2, 0];
  let m = /^([+-]?\d+)$/.exec(a);
  if (m) return [0, Number(m[1])];
  m = /^([+-]?\d*)n([+-]\d+)?$/.exec(a);
  if (m) {
    const A = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return [A, m[2] ? Number(m[2]) : 0];
  }
  throw new Unsupported('nth');
}

function nthMatches([A, B], pos) {
  if (A === 0) return pos === B;
  const n = (pos - B) / A;
  return Number.isInteger(n) && n >= 0;
}

function parseCompound(s) {
  const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
  let i = 0;
  if (s[i] === '*') i++;
  else if (isIdentChar(s[i] ?? '') || s[i] === '\\') {
    const [name, j] = readIdent(s, i);
    c.tag = name.toLowerCase();
    i = j;
  }
  if (s[i] === '|') throw new Unsupported('namespace');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') {
      const [name, j] = readIdent(s, i + 1);
      if (!name) throw new Unsupported('id');
      c.ids.push(name);
      i = j;
    } else if (ch === '.') {
      const [name, j] = readIdent(s, i + 1);
      if (!name) throw new Unsupported('class');
      c.classes.push(name);
      i = j;
    } else if (ch === '[') {
      const end = findBracketEnd(s, i);
      c.attrs.push(parseAttr(s.slice(i + 1, end)));
      i = end + 1;
    } else if (ch === ':') {
      const isElement = s[i + 1] === ':';
      const [name, j] = readIdent(s, i + (isElement ? 2 : 1));
      if (!name) throw new Unsupported('pseudo');
      i = j;
      let arg = null;
      if (s[i] === '(') {
        const [inner, after] = readBalanced(s, i);
        arg = inner;
        i = after;
      }
      const lower = name.toLowerCase();
      if (isElement || LEGACY_PSEUDO_ELEMENTS.has(lower)) {
        if (lower === 'slotted' || lower === 'part') throw new Unsupported('shadow');
        continue; // pseudo-elements match the originating element
      }
      if (STATE.has(lower) && arg === null) c.pseudos.push({ kind: 'state' });
      else if (LIST_FNS.has(lower) && arg !== null) {
        const list = parseList(arg);
        c.pseudos.push({ kind: lower === 'not' ? 'not' : 'is', list });
      } else if (STRUCTURAL.has(lower) && arg === null) c.pseudos.push({ kind: lower });
      else if (NTH.has(lower) && arg !== null) c.pseudos.push({ kind: lower, nth: parseNth(arg) });
      else throw new Unsupported(`:${lower}`);
    } else if (ch === '&') {
      throw new Unsupported('nesting');
    } else {
      throw new Unsupported(`char ${ch}`);
    }
  }
  return c;
}

function findBracketEnd(s, i) {
  let quote = null;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\') { j++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ']') return j;
  }
  throw new Unsupported('bracket');
}

function parseAttr(body) {
  const m = /^\s*((?:[\w-]|\\.)+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|(?:[^\s"'\]\\]|\\.)+)\s*([iIsS])?)?\s*$/.exec(body);
  if (!m) throw new Unsupported('attr');
  let value = m[3] ?? null;
  if (value !== null && /^["']/.test(value)) value = value.slice(1, -1);
  if (value !== null) value = value.replace(/\\(.)/g, '$1');
  return { name: m[1].replace(/\\(.)/g, '$1').toLowerCase(), op: m[2] ?? null, value, flag: m[4] ? m[4].toLowerCase() : null };
}

function tokenizeComplex(s) {
  // Split at top-level whitespace and > + ~ combinators.
  const parts = [];
  let buf = '';
  let pending = null;
  let depth = 0;
  let bracket = 0;
  let quote = null;
  const flush = () => {
    if (!buf) return;
    parts.push({ text: buf, combinator: parts.length ? (pending ?? ' ') : pending });
    buf = '';
    pending = null;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { buf += s.slice(i, i + 2); i++; continue; }
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[') bracket++;
    if (ch === ']') bracket--;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && bracket === 0) {
      if (/\s/.test(ch)) { flush(); continue; }
      if (ch === '>' || ch === '+' || ch === '~') {
        flush();
        if (pending) throw new Unsupported('double combinator');
        pending = ch;
        continue;
      }
    }
    buf += ch;
  }
  flush();
  if (pending) throw new Unsupported('trailing combinator');
  if (!parts.length) throw new Unsupported('empty');
  if (parts[0].combinator) throw new Unsupported('relative selector');
  return parts.map((p) => ({ combinator: p.combinator, compound: parseCompound(p.text) }));
}

function parseList(s) {
  const items = splitList(s);
  if (items.some((x) => !x)) throw new Unsupported('empty item');
  return items.map(tokenizeComplex);
}

const cache = new Map();

/**
 * Compile a selector list. Returns null for unsupported or invalid syntax.
 * @param {string} text
 * @returns {Array|null}
 */
export function compileSelector(text) {
  const key = String(text ?? '');
  if (cache.has(key)) return cache.get(key);
  let compiled;
  try {
    compiled = parseList(stripCssComments(key).trim());
  } catch (err) {
    if (!(err instanceof Unsupported)) throw err;
    compiled = null;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

function attrMatches(meta, a) {
  if (!meta.attrs.has(a.name)) return false;
  if (a.op === null) return true;
  let actual = meta.attrs.get(a.name);
  let want = a.value;
  if (a.flag === 'i') { actual = actual.toLowerCase(); want = want.toLowerCase(); }
  switch (a.op) {
    case '=': return actual === want;
    case '~=': return want !== '' && !/\s/.test(want) && actual.split(/\s+/).includes(want);
    case '|=': return actual === want || actual.startsWith(`${want}-`);
    case '^=': return want !== '' && actual.startsWith(want);
    case '$=': return want !== '' && actual.endsWith(want);
    case '*=': return want !== '' && actual.includes(want);
    default: return false;
  }
}

function matchCompound(adapter, el, c, negated, memo) {
  const meta = adapter(el);
  if (c.tag && c.tag !== meta.tag) return false;
  for (const id of c.ids) if (meta.id !== id) return false;
  for (const cls of c.classes) if (!meta.classes.has(cls)) return false;
  for (const a of c.attrs) if (!attrMatches(meta, a)) return false;
  for (const p of c.pseudos) {
    switch (p.kind) {
      case 'state': if (negated) return false; break;
      case 'not': if (p.list.some((cx) => matchComplex(adapter, el, cx, cx.length - 1, true, memo))) return false; break;
      case 'is': if (!p.list.some((cx) => matchComplex(adapter, el, cx, cx.length - 1, negated, memo))) return false; break;
      case 'root': case 'scope': if (meta.parent !== null) return false; break;
      case 'first-child': if (meta.childIndex !== 1) return false; break;
      case 'last-child': if (meta.childIndex !== meta.siblingCount) return false; break;
      case 'only-child': if (meta.siblingCount !== 1) return false; break;
      case 'first-of-type': if (meta.typeIndex !== 1) return false; break;
      case 'last-of-type': if (meta.typeIndex !== meta.typeCount) return false; break;
      case 'only-of-type': if (meta.typeCount !== 1) return false; break;
      case 'empty': if (!meta.empty) return false; break;
      case 'disabled': if (!(DISABLEABLE.has(meta.tag) && meta.attrs.has('disabled'))) return false; break;
      case 'enabled': if (!(DISABLEABLE.has(meta.tag) && !meta.attrs.has('disabled'))) return false; break;
      case 'defined': break;
      case 'nth-child': if (!nthMatches(p.nth, meta.childIndex)) return false; break;
      case 'nth-last-child': if (!nthMatches(p.nth, meta.siblingCount - meta.childIndex + 1)) return false; break;
      case 'nth-of-type': if (!nthMatches(p.nth, meta.typeIndex)) return false; break;
      case 'nth-last-of-type': if (!nthMatches(p.nth, meta.typeCount - meta.typeIndex + 1)) return false; break;
      default: return false;
    }
  }
  return true;
}

// Memo for one top-level match: (parts, negated) -> el -> idx -> boolean.
// Without it the ' ' and '~' combinators retry every ancestor/sibling for
// every partial match, which is exponential in the number of compounds.
function memoSlot(memo, parts, negated, el) {
  let byParts = memo.get(parts);
  if (!byParts) { byParts = [new Map(), new Map()]; memo.set(parts, byParts); }
  const byEl = byParts[negated ? 1 : 0];
  let slot = byEl.get(el);
  if (!slot) { slot = new Map(); byEl.set(el, slot); }
  return slot;
}

function matchComplex(adapter, el, parts, idx, negated, memo) {
  const slot = memoSlot(memo, parts, negated, el);
  const hit = slot.get(idx);
  if (hit !== undefined) return hit;
  const result = matchComplexUncached(adapter, el, parts, idx, negated, memo);
  slot.set(idx, result);
  return result;
}

// True when el, or any element reached from it by following `link` (parent
// for ' ', prev for '~'), matches parts[0..idx]. Iterative and memoized, so
// each (el, idx, link) is decided once and deep trees cannot overflow the stack.
function matchChain(adapter, el, parts, idx, negated, memo, link) {
  const key = `${link}:${idx}`;
  const pending = [];
  let result = false;
  for (let cur = el; cur !== null; cur = adapter(cur)[link]) {
    const slot = memoSlot(memo, parts, negated, cur);
    const hit = slot.get(key);
    if (hit !== undefined) { result = hit; break; }
    pending.push(slot);
    if (matchComplex(adapter, cur, parts, idx, negated, memo)) { result = true; break; }
  }
  for (const slot of pending) slot.set(key, result);
  return result;
}

function matchComplexUncached(adapter, el, parts, idx, negated, memo) {
  if (!matchCompound(adapter, el, parts[idx].compound, negated, memo)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].combinator;
  if (comb === '>') {
    const p = adapter(el).parent;
    return p !== null && matchComplex(adapter, p, parts, idx - 1, negated, memo);
  }
  if (comb === ' ') {
    const p = adapter(el).parent;
    return p !== null && matchChain(adapter, p, parts, idx - 1, negated, memo, 'parent');
  }
  if (comb === '+') {
    const s = adapter(el).prev;
    return s !== null && matchComplex(adapter, s, parts, idx - 1, negated, memo);
  }
  if (comb === '~') {
    const s = adapter(el).prev;
    return s !== null && matchChain(adapter, s, parts, idx - 1, negated, memo, 'prev');
  }
  return false;
}

/**
 * @param {Function} adapter - el -> meta { tag, id, classes:Set, attrs:Map, parent, prev, childIndex, siblingCount, typeIndex, typeCount, empty }
 * @param {object} el
 * @param {string} selector
 * @returns {boolean|null} null when the selector is unsupported
 */
export function matchesSelector(adapter, el, selector) {
  const compiled = compileSelector(selector);
  if (compiled === null) return null;
  const memo = new Map();
  return compiled.some((cx) => matchComplex(adapter, el, cx, cx.length - 1, false, memo));
}

/**
 * @param {Function} adapter
 * @param {object[]} elements - candidates in document order
 * @param {string} selector
 * @returns {object[]} matches in document order; [] when unsupported
 */
export function selectAll(adapter, elements, selector) {
  const compiled = compileSelector(selector);
  if (compiled === null) return [];
  const memo = new Map();
  return elements.filter((el) => compiled.some((cx) => matchComplex(adapter, el, cx, cx.length - 1, false, memo)));
}

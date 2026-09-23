/**
 * Pure CSS value parsers and selector predicates.
 *
 * Rule files import these directly ('../../lib/css-values.mjs'). Nothing here
 * touches the audit context, the file system or the network.
 */

// ---------------------------------------------------------------------------
// Low-level scanning
// ---------------------------------------------------------------------------

/** Functional pseudo-classes whose argument is itself a selector list. */
const SELECTOR_FNS = new Set([':is', ':where', ':not', ':has', ':matches', ':-webkit-any', ':-moz-any', ':host', ':host-context', '::slotted', '::part']);

/**
 * Walk `str`, calling visit(ch, index, depth) for characters that sit outside
 * quotes and outside [...] (depth counts open parentheses). Returns nothing.
 */
function scan(str, visit) {
  let depth = 0;
  let bracket = 0;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (bracket) { if (ch === ']') bracket--; else if (ch === '[') bracket++; continue; }
    if (ch === '[') { bracket++; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    visit(ch, i, depth);
  }
}

/**
 * Split a CSS value on a separator that sits at parenthesis depth 0 and
 * outside quotes. sep ' ' splits on any whitespace run.
 * @param {string} value
 * @param {','|'/'|' '} sep
 * @returns {string[]} trimmed, non-empty parts
 */
export function splitTopLevel(value, sep = ',') {
  const str = String(value ?? '');
  const parts = [];
  let last = 0;
  const isSep = sep === ' ' ? (ch) => /\s/.test(ch) : (ch) => ch === sep;
  scan(str, (ch, i, depth) => {
    if (depth === 0 && isSep(ch)) {
      parts.push(str.slice(last, i));
      last = i + 1;
    }
  });
  parts.push(str.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Remove CSS comments. Same result as str.replace(/\/\*[\s\S]*?\*\//g, ' ')
 * in linear time: the lazy regex rescans to the end of the input for every
 * unterminated '/*', which is quadratic on page-controlled text.
 * @param {string} input
 * @returns {string}
 */
export function stripCssComments(input) {
  const str = String(input ?? '');
  let out = '';
  let i = 0;
  for (;;) {
    const open = str.indexOf('/*', i);
    if (open === -1) break;
    const close = str.indexOf('*/', open + 2);
    if (close === -1) break; // no later '/*' can close either
    out += `${str.slice(i, open)} `;
    i = close + 2;
  }
  return i === 0 ? str : out + str.slice(i);
}

const isNameChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-';
const isSpace = (c) => c !== undefined && /\s/.test(c);

/**
 * Canonical selector text: comments removed, whitespace collapsed, one space
 * around the > + ~ combinators, ', ' between list items, no padding inside
 * (...) or [...]. Case is preserved.
 *
 * The output is built as a list of chunks, so trimming and last-character
 * checks never copy or rescan the whole output. The function is linear in the
 * input length, even for page-controlled selectors with thousands of '(' or ','.
 * @param {string} input
 * @returns {string}
 */
export function normalizeSelector(input) {
  const s = stripCssComments(input);
  const parts = [];
  const push = (t) => { if (t) parts.push(t); };
  const lastCh = () => {
    const p = parts[parts.length - 1];
    return p === undefined ? undefined : p[p.length - 1];
  };
  const trimOut = () => {
    while (parts.length) {
      const t = parts[parts.length - 1].trimEnd();
      if (t) { parts[parts.length - 1] = t; return; }
      parts.pop();
    }
  };
  // The ':name' or '::name' right before a '(' (what /(::?[\w-]+)$/ finds on
  // the output so far), scanning back over the trailing name only.
  const trailingPseudo = () => {
    let pi = parts.length - 1;
    let ci = pi >= 0 ? parts[pi].length - 1 : -1;
    const prev = () => {
      while (pi >= 0 && ci < 0) { pi--; ci = pi >= 0 ? parts[pi].length - 1 : -1; }
      return pi >= 0 ? parts[pi][ci--] : undefined;
    };
    let name = '';
    let c = prev();
    while (c !== undefined && isNameChar(c)) { name = c + name; c = prev(); }
    if (!name || c !== ':') return null;
    return (prev() === ':' ? '::' : ':') + name;
  };
  const stack = [];
  let pendingSpace = false;
  const top = () => stack[stack.length - 1];
  const inSelectorContext = () => stack.length === 0 || SELECTOR_FNS.has(top());
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const l = lastCh();
      if (pendingSpace && l !== undefined && !(isSpace(l) || l === '(' || l === '[')) push(' ');
      pendingSpace = false;
      push(s.slice(i, i + 2));
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const l = lastCh();
      if (pendingSpace && l !== undefined && !(isSpace(l) || l === '(' || l === '[' || l === '=')) push(' ');
      pendingSpace = false;
      let j = i + 1;
      while (j < s.length && s[j] !== ch) { if (s[j] === '\\') j++; j++; }
      push(s.slice(i, j + 1));
      i = j;
      continue;
    }
    if (/\s/.test(ch)) { pendingSpace = true; continue; }
    if (top() === '[') {
      if (ch === ']') { stack.pop(); push(']'); }
      else if ('=~|^$*'.includes(ch)) push(ch);
      else {
        const l = lastCh();
        if (pendingSpace && !(l === '[' || l === '=')) push(' ');
        push(ch);
      }
      pendingSpace = false;
      continue;
    }
    if (ch === '[') {
      const l = lastCh();
      if (pendingSpace && l !== undefined && !(isSpace(l) || l === '(')) push(' ');
      pendingSpace = false;
      stack.push('[');
      push('[');
      continue;
    }
    if (ch === '(') {
      const m = trailingPseudo();
      stack.push(m ? m.toLowerCase() : '(');
      push('(');
      pendingSpace = false;
      continue;
    }
    if (ch === ')') {
      stack.pop();
      trimOut();
      push(')');
      pendingSpace = false;
      continue;
    }
    if (inSelectorContext() && (ch === '>' || ch === '+' || ch === '~' || ch === ',')) {
      trimOut();
      push(ch === ',' ? ', ' : (parts.length === 0 || lastCh() === '(' ? `${ch} ` : ` ${ch} `));
      pendingSpace = false;
      continue;
    }
    const l = lastCh();
    if (pendingSpace && l !== undefined && !(isSpace(l) || l === '(')) push(' ');
    pendingSpace = false;
    push(ch);
  }
  return parts.join('').trim();
}

/**
 * Split a selector list at top-level commas; each item is normalized.
 * @param {string} sel
 * @returns {string[]}
 */
export function splitSelectorList(sel) {
  return splitTopLevel(normalizeSelector(sel), ',');
}

/**
 * Split one complex selector into compounds.
 * `combinator` is the combinator BEFORE the compound: null for the first,
 * then ' ' (descendant), '>', '+' or '~'.
 * @param {string} sel - a single selector (not a list)
 * @returns {Array<{ text: string, combinator: null|' '|'>'|'+'|'~' }>}
 */
export function compounds(sel) {
  const s = normalizeSelector(sel);
  const tokens = [];
  let last = 0;
  scan(s, (ch, i, depth) => {
    if (depth === 0 && ch === ' ') {
      tokens.push(s.slice(last, i));
      last = i + 1;
    }
  });
  tokens.push(s.slice(last));
  const out = [];
  let pending = null;
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok === '>' || tok === '+' || tok === '~') { pending = tok; continue; }
    // A leading combinator (relative nested selector) stays on the first compound.
    out.push({ text: tok, combinator: pending ?? (out.length ? ' ' : null) });
    pending = null;
  }
  return out;
}

function joinCompounds(parts) {
  return parts.map((p, i) => {
    if (i === 0) return p.combinator && p.combinator !== ' ' ? `${p.combinator} ${p.text}` : p.text;
    return p.combinator === ' ' ? ` ${p.text}` : ` ${p.combinator} ${p.text}`;
  }).join('');
}

/** State pseudo-classes that the static matcher treats as always matching. */
export const STATE_PSEUDOS = Object.freeze(['hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'link', 'checked', 'open', 'popover-open', 'modal', 'target']);

function removeTopLevelTokens(compound, re) {
  // Remove matches of `re` that sit at paren depth 0, outside brackets/quotes.
  let out = '';
  let last = 0;
  const hits = [];
  scan(compound, (ch, i, depth) => {
    if (depth === 0 && ch === ':' && compound[i - 1] !== ':' && compound[i + 1] !== ':') hits.push(i);
  });
  for (const at of hits) {
    re.lastIndex = 0;
    const m = re.exec(compound.slice(at));
    if (m && m.index === 0) {
      out += compound.slice(last, at);
      last = at + m[0].length;
    }
  }
  out += compound.slice(last);
  return out;
}

const STATE_RE = new RegExp(`^:(${[...STATE_PSEUDOS].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`, 'i');

/**
 * Remove state pseudo-classes (STATE_PSEUDOS) from every compound, at the top
 * level only. A compound left empty becomes '*'. Works on selector lists.
 * '.card:hover .tip' -> '.card .tip'.
 * @param {string} sel
 * @returns {string}
 */
export function stripStatePseudos(sel) {
  return splitSelectorList(sel).map((one) => joinCompounds(compounds(one).map((c) => {
    const text = removeTopLevelTokens(c.text, STATE_RE);
    return { ...c, text: text === '' || /^::/.test(text) ? `*${text}` : text };
  }))).join(', ');
}

const BASE_KEY_PSEUDO_RE = /^:(popover-open|open|modal|hover|focus-visible|focus-within|focus|active|checked)(?![\w-])/i;

/**
 * Key used to pair a panel's base rule with its open-state or
 * @starting-style rule: strips :popover-open, [open], :open, :modal, :hover,
 * :focus*, :active and :checked; keeps pseudo-elements such as ::backdrop.
 * 'dialog[open]::backdrop' -> 'dialog::backdrop'.
 * @param {string} sel - a single selector
 * @returns {string}
 */
export function selectorBaseKey(sel) {
  return joinCompounds(compounds(sel).map((c) => {
    let text = removeTopLevelTokens(c.text, BASE_KEY_PSEUDO_RE);
    text = text.replace(/\[open\]/gi, '');
    return { ...c, text: text === '' || /^::/.test(text) ? `*${text}` : text };
  }));
}

/**
 * True for a single root compound with no combinator: html, :root, html.x,
 * :root[data-x]. Pseudo-elements (html::before) do not count.
 * @param {string} sel
 * @returns {boolean}
 */
export function isRootSelector(sel) {
  const parts = compounds(sel);
  if (parts.length !== 1 || parts[0].combinator) return false;
  const t = parts[0].text;
  if (/::|:(before|after|first-line|first-letter)(?![\w-])/i.test(t)) return false;
  return /^html(?![\w-])/i.test(t) || /:root(?![\w-])/i.test(t);
}

// '[popover' must not continue as popovertarget or popovertargetaction: those
// attributes mark the invoker button, not the popover.
const POPOVER_OR_DIALOG_RE = /\[\s*popover(?![\w-])|:popover-open|(^|[\s>+~(,])dialog(?![\w-])/i;
const MODAL_EXTRA_RE = /\[role=["']?(alert)?dialog|\[aria-modal|\.(modal|lightbox)(?![\w-])/i;
const PANEL_EXTRA_RE = /\.(dialog|drawer|sheet|popover|dropdown|flyout|offcanvas|menu|tooltip)(?![\w-])/i;

/** [popover], :popover-open or a dialog type selector. [popovertarget] invokers do not count. */
export function isPopoverOrDialogSelector(sel) {
  return POPOVER_OR_DIALOG_RE.test(String(sel));
}

/** Popover/dialog, or [role=dialog|alertdialog], [aria-modal], .modal, .lightbox. */
export function isModalSelector(sel) {
  return isPopoverOrDialogSelector(sel) || MODAL_EXTRA_RE.test(String(sel));
}

/** Modal, or .dialog .drawer .sheet .popover .dropdown .flyout .offcanvas .menu .tooltip. */
export function isPanelSelector(sel) {
  return isModalSelector(sel) || PANEL_EXTRA_RE.test(String(sel));
}

// ---------------------------------------------------------------------------
// Context predicates. Each accepts a CssContext or anything with .context
// (RuleInfo, DeclInfo, AtRuleInfo).
// ---------------------------------------------------------------------------

function contextOf(c) {
  if (!c) return { media: [], supports: [], layer: [], container: [], startingStyle: false, keyframes: null };
  return c.context && Array.isArray(c.context.media) ? c.context : c;
}

/** Some enclosing @media prelude matches re. */
export function inMedia(context, re) {
  return contextOf(context).media.some((m) => { re.lastIndex = 0; return re.test(m); });
}

const MOTION_FEATURE_RE = /(not\s*)?\(\s*prefers-reduced-motion\s*(?::\s*([a-z-]+)\s*)?\)/gi;

/**
 * The motion preference a media query list is restricted to: 'reduce' when
 * every query only matches with reduced motion, 'no-preference' when every
 * query only matches without it, else null. The boolean form
 * (prefers-reduced-motion) means reduce. 'not' flips a feature ('not (f)')
 * or a whole query ('not all and (f)').
 * @param {string} prelude - a media prelude, e.g. '(prefers-reduced-motion: reduce)'
 * @returns {'reduce'|'no-preference'|null}
 */
export function motionPreferenceOf(prelude) {
  let result = null;
  for (const q of splitTopLevel(String(prelude ?? '').trim().toLowerCase(), ',')) {
    const wholeNot = /^not\s/.test(q);
    let pref = null;
    for (const m of q.matchAll(MOTION_FEATURE_RE)) {
      let v = m[2] ?? 'reduce';
      if (v !== 'reduce' && v !== 'no-preference') continue;
      if (Boolean(m[1]) !== (wholeNot && m.index !== 0)) v = v === 'reduce' ? 'no-preference' : 'reduce';
      pref = v;
      break;
    }
    if (pref === null) return null;
    if (result !== null && result !== pref) return null;
    result = pref;
  }
  return result;
}

/**
 * Inside a media query that only matches with reduced motion:
 * (prefers-reduced-motion: reduce), the boolean (prefers-reduced-motion), or
 * a negated no-preference query.
 */
export function isReducedMotionReduce(context) {
  return contextOf(context).media.some((m) => motionPreferenceOf(m) === 'reduce');
}

/** Inside a media query that only matches without a motion preference: (prefers-reduced-motion: no-preference) or a negated reduce query. */
export function isReducedMotionNoPreference(context) {
  return contextOf(context).media.some((m) => motionPreferenceOf(m) === 'no-preference');
}

/** Some enclosing @supports prelude matches re. */
export function inSupports(context, re) {
  return contextOf(context).supports.some((m) => { re.lastIndex = 0; return re.test(m); });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

// Unambiguous number grammar: \d+ and \d* never split the same digit run, so a
// long run of digits followed by a bad suffix fails in linear time.
const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
const TIME_RE = new RegExp(`^(${NUM})(ms|s)$`, 'i');
const LENGTH_RE = new RegExp(`^(${NUM})([a-z%]*)$`, 'i');

/**
 * '200ms' -> 200, '.2s' -> 200, '0' -> 0. Anything else -> null.
 * @param {string} token
 * @returns {number|null}
 */
export function parseTimeMs(token) {
  const t = String(token ?? '').trim();
  if (/^[+-]?(?:0*\.)?0+$/.test(t)) return 0;
  const m = TIME_RE.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 's' ? n * 1000 : n;
}

/**
 * A comma-separated time list (transition-duration, animation-duration).
 * @param {string} value
 * @returns {Array<number|null>} null for a var() or unparseable entry
 */
export function parseTimeList(value) {
  return splitTopLevel(value, ',').map(parseTimeMs);
}

const TIMING_KEYWORDS = new Set(['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const TIMING_FN_RE = /^(cubic-bezier|steps|linear)\(/i;
const GLOBAL_KEYWORDS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);

/**
 * Parse the transition shorthand.
 * property is 'all' when omitted, and null when it is omitted but a var() in
 * the item may hold it ('transition: var(--t)'). durationMs is 0 when no time is given and
 * null when the duration is a var() or other unresolved function; the raw
 * token is kept in durationToken.
 * @param {string} value
 * @returns {Array<{ property: string|null, durationMs: number|null, delayMs: number|null, timing: string|null, behavior: string|null, durationToken: string|null }>}
 */
export function parseTransitionList(value) {
  const v = String(value ?? '').trim();
  if (GLOBAL_KEYWORDS.has(v.toLowerCase())) return [];
  return splitTopLevel(v, ',').map((item) => {
    let property = null;
    let duration = null;
    let durationToken = null;
    let delay = null;
    let timing = null;
    let behavior = null;
    const unknown = [];
    for (const tok of splitTopLevel(item, ' ')) {
      const lower = tok.toLowerCase();
      const t = parseTimeMs(tok);
      if (t !== null && /[a-z]$/i.test(tok)) {
        if (duration === null) { duration = t; durationToken = tok; } else if (delay === null) delay = t;
      } else if (TIMING_KEYWORDS.has(lower) || TIMING_FN_RE.test(tok)) timing = tok;
      else if (lower === 'normal' || lower === 'allow-discrete') behavior = lower;
      else if (/^[a-z_-][\w-]*$/i.test(tok) && property === null) property = tok.startsWith('--') ? tok : lower;
      else unknown.push(tok);
    }
    let durationMs = duration;
    if (durationMs === null) durationMs = unknown.length ? null : 0;
    if (durationToken === null && unknown.length) durationToken = unknown[0];
    const hidden = property === null && unknown.some((tok) => /var\(/i.test(tok));
    return { property: hidden ? null : property ?? 'all', durationMs, delayMs: delay ?? (unknown.length > 1 ? null : 0), timing, behavior, durationToken };
  });
}

const ANIM_KEYWORDS = new Set(['infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'running', 'paused']);

/**
 * Parse the animation shorthand.
 * @param {string} value
 * @returns {Array<{ name: string, durationMs: number|null, delayMs: number|null, durationToken: string|null }>}
 */
export function parseAnimationList(value) {
  const v = String(value ?? '').trim();
  if (GLOBAL_KEYWORDS.has(v.toLowerCase())) return [];
  return splitTopLevel(v, ',').map((item) => {
    let name = null;
    let sawNone = false;
    let duration = null;
    let durationToken = null;
    let delay = null;
    const unknown = [];
    for (const tok of splitTopLevel(item, ' ')) {
      const lower = tok.toLowerCase();
      const t = parseTimeMs(tok);
      if (t !== null && /[a-z]$/i.test(tok)) {
        if (duration === null) { duration = t; durationToken = tok; } else if (delay === null) delay = t;
      } else if (TIMING_KEYWORDS.has(lower) || TIMING_FN_RE.test(tok)) continue;
      else if (ANIM_KEYWORDS.has(lower) || /^[+-]?(\d+(?:\.\d*)?|\.\d+)$/.test(tok)) continue;
      else if (lower === 'none') sawNone = true;
      else if (/^[a-z_-][\w-]*$/i.test(tok) || /^["']/.test(tok)) { if (name === null) name = tok.replace(/^["']|["']$/g, ''); }
      else unknown.push(tok);
    }
    let durationMs = duration;
    if (durationMs === null) durationMs = unknown.length ? null : 0;
    if (durationToken === null && unknown.length) durationToken = unknown[0];
    return { name: name ?? (sawNone ? 'none' : 'none'), durationMs, delayMs: delay ?? 0, durationToken };
  });
}

/**
 * '12px' -> { value: 12, unit: 'px' }, '0' -> { value: 0, unit: '' }.
 * @param {string} token
 * @returns {{ value: number, unit: string }|null}
 */
export function parseLength(token) {
  const m = LENGTH_RE.exec(String(token ?? '').trim());
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].toLowerCase() };
}

/**
 * Every number used with exactly `unit` anywhere in the value (calc()
 * included). 'vh' never matches dvh, svh or lvh.
 * @param {string} value
 * @param {string} unit
 * @returns {number[]}
 */
export function findUnitValues(value, unit) {
  const esc = String(unit).replace(/[.*+?^${}()|[\]\\%]/g, (c) => (c === '%' ? '%' : `\\${c}`));
  const re = new RegExp(`(?<![\\w.])(${NUM})${esc}(?![\\w-])`, 'gi');
  const out = [];
  for (const m of String(value ?? '').matchAll(re)) out.push(Number(m[1]));
  return out;
}

/** '0', '0px', '-0', '0.0rem', '0%' -> true. */
export function isZeroLength(value) {
  const l = parseLength(value);
  return l !== null && l.value === 0;
}

function insetComponent(prop, value, side) {
  const p = String(prop ?? '').toLowerCase();
  const parts = splitTopLevel(value, ' ');
  if (!parts.length) return null;
  if (p === side) return parts.join(' ');
  if (p === 'inset') {
    // top right bottom left
    const [a, b = a, c = a] = parts;
    return side === 'bottom' ? c : a;
  }
  if (p === `inset-block-${side === 'bottom' ? 'end' : 'start'}`) return parts.join(' ');
  if (p === 'inset-block') return side === 'bottom' ? (parts[1] ?? parts[0]) : parts[0];
  return null;
}

/**
 * The bottom component of bottom, inset, inset-block or inset-block-end.
 * Other properties -> null.
 * @param {string} prop
 * @param {string} value
 * @returns {string|null}
 */
export function parseInsetBottom(prop, value) {
  return insetComponent(prop, value, 'bottom');
}

/**
 * The top component of top, inset, inset-block or inset-block-start.
 * @param {string} prop
 * @param {string} value
 * @returns {string|null}
 */
export function parseInsetTop(prop, value) {
  return insetComponent(prop, value, 'top');
}

/** Integer literal z-index -> number; 'auto', var() and the rest -> null. */
export function parseZIndex(value) {
  const v = String(value ?? '').trim();
  return /^[+-]?\d+$/.test(v) ? Number.parseInt(v, 10) : null;
}

const NAMED_COLORS = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

function parseAlpha(tok) {
  const t = String(tok).trim().toLowerCase();
  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Alpha of a color value, 0..1.
 * hex3/hex6 and named colors -> 1; hex4/hex8 and rgb()/hsl()/hwb()/lab()/
 * lch()/oklab()/oklch()/color() alpha (comma or slash syntax, number or %)
 * are read. transparent, currentcolor, var() and color-mix() -> null.
 * @param {string} value
 * @returns {number|null}
 */
export function colorAlpha(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v.includes('var(') || v.startsWith('color-mix(')) return null;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (m) return 1;
  m = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    const hex = m[1];
    const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) : Number.parseInt(hex.slice(6), 16);
    return round3(a / 255);
  }
  if (NAMED_COLORS.has(v)) return 1;
  m = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((.*)\)$/.exec(v);
  if (!m) return null;
  const inner = m[2];
  let alphaTok = null;
  const slash = splitTopLevel(inner, '/');
  if (slash.length === 2) alphaTok = slash[1];
  else {
    const commas = splitTopLevel(inner, ',');
    if (commas.length === 4) alphaTok = commas[3];
  }
  if (alphaTok === null) return 1;
  if (alphaTok === 'none') return 0;
  const a = parseAlpha(alphaTok);
  if (a === null) return null;
  return round3(Math.min(1, Math.max(0, a)));
}

/**
 * Boolean value of an acorn literal, including minified !0 and !1.
 * @param {object|null|undefined} node
 * @returns {boolean|null}
 */
export function boolLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'boolean') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const arg = node.argument;
    if (arg?.type === 'Literal' && (typeof arg.value === 'number' || typeof arg.value === 'boolean')) return !arg.value;
    const inner = boolLiteral(arg);
    return inner === null ? null : !inner;
  }
  return null;
}

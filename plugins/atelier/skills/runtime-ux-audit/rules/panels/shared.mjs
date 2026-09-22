/**
 * Shared helpers for the panels rules. Pure: no I/O, no ctx mutation.
 */
import {
  compounds, inMedia, isModalSelector, isPanelSelector, isPopoverOrDialogSelector, isReducedMotionReduce,
  normalizeSelector, parseAnimationList, parseTimeMs, parseTransitionList, splitTopLevel,
} from '../../lib/css-values.mjs';
import { RULE_PREFIX } from '../../lib/options.mjs';

/** Rule factory: fills id, area and the default phase. */
export function panelsRule(shortId, def) {
  return Object.freeze({ id: `${RULE_PREFIX}${shortId}`, area: 'panels', phase: 'static', ...def });
}

/** id or class token that names a backdrop: backdrop, modal-overlay, page_scrim. */
export const BACKDROP_NAME_RE = /^(backdrop|overlay|scrim)$|[-_](backdrop|overlay|scrim)$/i;

/** Values that switch a property off (or leave it at its initial none). */
const OFF_VALUES = new Set(['none', 'initial', 'unset', 'revert', 'revert-layer']);

export const isOff = (value) => OFF_VALUES.has(String(value ?? '').trim().toLowerCase());

/** ms as a short string: 200, 0.5, 1234.568. */
export const fmtMs = (n) => String(Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

const ANY_REDUCED_MOTION_RE = /prefers-reduced-motion/i;

/** Inside @media (prefers-reduced-motion: reduce) or the boolean form (prefers-reduced-motion). */
export function inReduce(info) {
  return isReducedMotionReduce(info);
}

/** Inside any prefers-reduced-motion media query (reduce or no-preference). */
export function inAnyReducedMotion(info) {
  return inMedia(info, ANY_REDUCED_MOTION_RE);
}

/** Keyframe blocks never describe a panel's own box. */
export const isKeyframes = (info) => info.context.keyframes !== null;

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function attrMap(el) {
  const m = new Map();
  for (const a of el?.attrs ?? []) {
    const n = String(a.name).toLowerCase();
    if (!m.has(n)) m.set(n, a.value);
  }
  return m;
}

/**
 * A selector the css-values predicates understand, built from a style
 * attribute's element (its cssPath may be '#id', which hides the element's
 * nature): tag, [popover], [role=x], [aria-modal], then every class.
 */
export function styleAttrSelector(el) {
  const a = attrMap(el);
  let s = String(el?.tagName ?? '*').toLowerCase();
  if (a.has('popover')) s += '[popover]';
  const role = (a.get('role') ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (/^[a-z]+$/.test(role)) s += `[role=${role}]`;
  if ((a.get('aria-modal') ?? '').trim().toLowerCase() === 'true') s += '[aria-modal]';
  for (const c of (a.get('class') ?? '').split(/\s+/)) if (/^[\w-]+$/.test(c)) s += `.${c}`;
  return s;
}

/** Selectors to test with the panel predicates (a synthetic one for style attributes). */
export function predicateSelectors(rule) {
  return rule.fromStyleAttr ? [styleAttrSelector(rule.fromStyleAttr)] : rule.selectors;
}

/** The last compound of a selector: the element the rule styles. */
export function subjectOf(sel) {
  const parts = compounds(sel);
  return parts.length ? parts[parts.length - 1].text : String(sel ?? '');
}

/** Subjects of predicateSelectors(rule): 'dialog .btn' -> '.btn'. */
export function predicateSubjects(rule) {
  return predicateSelectors(rule).map(subjectOf);
}

// The css-values predicates ignore '[popovertarget]' (an invoker button).
export const isPopoverOrDialog = (sel) => isPopoverOrDialogSelector(sel);
export const isModal = (sel) => isModalSelector(sel);
export const isPanel = (sel) => isPanelSelector(sel);

/**
 * Split a compound into simple selectors at the top level:
 * 'dialog.a[open]:hover::backdrop' -> ['dialog', '.a', '[open]', ':hover', '::backdrop'].
 */
export function simpleParts(compound) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let bracket = 0;
  let quote = null;
  const s = String(compound ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { cur += s.slice(i, i + 2); i++; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (bracket) { cur += ch; if (ch === ']') bracket--; continue; }
    if (depth) { cur += ch; if (ch === '(') depth++; else if (ch === ')') depth--; continue; }
    const starts = ch === '.' || ch === '#' || ch === '[' || (ch === ':' && s[i - 1] !== ':');
    if (starts && cur) { parts.push(cur); cur = ''; }
    if (ch === '[') bracket++;
    if (ch === '(') depth++;
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Does the rule with base key `key` style every element that `target`
 * (also a base key) selects? True for an exact match, and for a single
 * compound key whose simple selectors are a subset of target's last
 * compound with the same pseudo-element: '[popover]' covers '.menu[popover]',
 * '*' covers 'dialog', but 'dialog' never covers 'dialog::backdrop'.
 */
export function keyCovers(key, target) {
  if (key === target) return true;
  const kc = compounds(key);
  const tc = compounds(target);
  if (kc.length !== 1 || tc.length === 0) return false;
  const kp = simpleParts(kc[0].text).filter((p) => p !== '*');
  const tp = simpleParts(tc[tc.length - 1].text).filter((p) => p !== '*');
  const pseudoEl = (list) => list.filter((p) => p.startsWith('::')).join('');
  if (pseudoEl(kp) !== pseudoEl(tp)) return false;
  return kp.every((p) => tp.includes(p));
}

/** Rebuild a selector from compounds() parts. */
export function joinCompounds(parts) {
  return normalizeSelector(parts.map((p, i) => {
    if (i === 0) return p.combinator && p.combinator !== ' ' ? `${p.combinator} ${p.text}` : p.text;
    return p.combinator === ' ' ? ` ${p.text}` : ` ${p.combinator} ${p.text}`;
  }).join(''));
}

/** Parenthesis depth at index i (quotes and brackets skipped). */
export function parenDepthAt(str, index) {
  let depth = 0;
  let quote = null;
  let bracket = 0;
  for (let i = 0; i < index && i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (bracket) { if (ch === ']') bracket--; continue; }
    if (ch === '[') bracket++;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/i;

/**
 * A duration token in ms: a literal, or a var() resolved one hop to the last
 * definition of the custom property outside keyframes and reduced-motion
 * blocks, then to the var() fallback. null when neither is a literal time.
 */
export function resolveTimeToken(ctx, token) {
  const t = String(token ?? '').trim();
  const direct = parseTimeMs(t);
  if (direct !== null) return direct;
  const m = VAR_RE.exec(t);
  if (!m) return null;
  const defs = ctx.css.customProps(m[1]).filter((d) => !isKeyframes(d) && !inReduce(d));
  if (defs.length) return parseTimeMs(defs[defs.length - 1].value);
  return m[2] === undefined ? null : parseTimeMs(m[2].trim());
}

/** Custom property names referenced by var() in a value. */
export function varNames(value) {
  return [...String(value ?? '').matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
}

export const TRANSITION_PROPS = Object.freeze(['transition', 'transition-duration']);
export const DURATION_PROPS = Object.freeze(['transition', 'transition-duration', 'animation', 'animation-duration']);

/**
 * Durations declared by one transition / animation decl.
 * @returns {Array<{ ms: number|null, raw: string, property: string|null, name: string|null }>}
 *   property: the transitioned property ('all' when omitted), name: the animation name.
 */
export function declDurations(ctx, decl) {
  const items = splitTopLevel(decl.value, ',');
  switch (decl.prop) {
    case 'transition':
      return parseTransitionList(decl.value).map((t, i) => {
        const raw = items[i] ?? '';
        const ms = t.durationMs !== null ? t.durationMs : resolveTimeToken(ctx, t.durationToken);
        let property = t.property;
        // parseTransitionList gives null when the property is omitted and a
        // var() may hold it. When the only var() is the duration and it
        // resolves to a time, the property is the implicit 'all'.
        if (property === null) {
          const rest = t.durationToken ? raw.replace(t.durationToken, '') : raw;
          if (!/var\(/i.test(rest) && ms !== null) property = 'all';
        }
        return { ms, raw, property, name: null };
      });
    case 'animation':
      return parseAnimationList(decl.value).map((a, i) => ({
        ms: a.durationMs !== null ? a.durationMs : resolveTimeToken(ctx, a.durationToken),
        raw: items[i] ?? '', property: null, name: a.name,
      }));
    case 'transition-duration':
    case 'animation-duration':
      return items.map((tok) => ({ ms: resolveTimeToken(ctx, tok), raw: tok, property: null, name: null }));
    default:
      return [];
  }
}

/** Largest known duration of a decl, or null when none is known. */
export function maxDeclMs(ctx, decl) {
  const known = declDurations(ctx, decl).map((d) => d.ms).filter((n) => n !== null);
  return known.length ? Math.max(...known) : null;
}

/**
 * The transition duration a rule declares: the last transition or
 * transition-duration decl wins. { ms: max known duration, decl } or null.
 */
export function declaredTransition(ctx, rule) {
  let decl = null;
  for (const d of rule.decls) if (TRANSITION_PROPS.includes(d.prop)) decl = d;
  if (!decl) return null;
  const ms = maxDeclMs(ctx, decl);
  return ms === null ? null : { ms, decl };
}

// ---------------------------------------------------------------------------
// Backdrop filter and fills
// ---------------------------------------------------------------------------

/** The rule's active backdrop-filter decl (unprefixed first), or null. */
export function backdropFilterDecl(rule) {
  for (const p of ['backdrop-filter', '-webkit-backdrop-filter']) {
    const d = rule.get(p);
    if (d && !isOff(d.value)) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JS helpers
// ---------------------------------------------------------------------------

/** String literal or expression-free template value, else null. */
export { stringValue } from '../../lib/js-model.mjs';

export const unwrapChain = (n) => (n?.type === 'ChainExpression' ? n.expression : n);

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** First role token, lowercased ('' when none). */
export function roleOf(html, el) {
  return (html.attr(el, 'role') ?? '').trim().split(/\s+/)[0].toLowerCase();
}

export const isAriaModal = (html, el) => (html.attr(el, 'aria-modal') ?? '').trim().toLowerCase() === 'true';

/** The id or class token that names a backdrop, or null. */
export function backdropName(html, el) {
  const id = html.attr(el, 'id');
  if (id && BACKDROP_NAME_RE.test(id)) return `#${id}`;
  const cls = html.classes(el).find((c) => BACKDROP_NAME_RE.test(c));
  return cls ? `.${cls}` : null;
}

/** Text of the elements named by aria-labelledby (their aria-label when they have no text). */
export function labelledByText(html, el) {
  const ids = (html.attr(el, 'aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean);
  return ids.map((id) => html.byId(id)).filter(Boolean)
    .map((t) => html.text(t) || (html.attr(t, 'aria-label') ?? '').trim())
    .join(' ').trim();
}

/** Elements in document order. */
export function inDocumentOrder(html, list) {
  return [...new Set(list)].sort((a, b) => html.indexOf(a) - html.indexOf(b));
}

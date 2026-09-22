/**
 * Helpers shared by the mobile rules. Pure: they only read ctx, and the
 * WeakMap caches below are keyed by the frozen models, never written into them.
 */
import { compounds, isZeroLength, parseInsetBottom, parseInsetTop, splitTopLevel } from '../../lib/css-values.mjs';

export const ROOT_TARGETS = new Set(['window', 'document', 'root-element']);

const lower = (v) => String(v ?? '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Viewport meta
// ---------------------------------------------------------------------------

/**
 * The viewport meta to judge: the static one, else the one in the rendered
 * DOM (a framework may inject it), else the static (empty) record.
 * @returns {{ el: object|null, content: string|null, props: Record<string, string> }}
 */
export function viewportOf(ctx) {
  if (ctx.html.viewport.el) return ctx.html.viewport;
  if (ctx.rendered && ctx.rendered !== ctx.html && ctx.rendered.viewport.el) return ctx.rendered.viewport;
  return ctx.html.viewport;
}

/** NodeRef for the viewport meta (its content attribute when present), or a page ref when it is missing. */
export function viewportRef(ctx, vp) {
  if (!vp.el) return ctx.ref.page('head', 'no viewport meta');
  const model = ctx.html.owns(vp.el) ? ctx.html : ctx.rendered;
  return ctx.ref.html(vp.el, model.hasAttr(vp.el, 'content') ? 'content' : undefined);
}

// ---------------------------------------------------------------------------
// CSS lookups
// ---------------------------------------------------------------------------

const declsByRuleCache = new WeakMap();

/** Every decl whose nearest style rule is `rule`, including decls nested in at-rules inside it. */
export function allDeclsOf(ctx, rule) {
  let map = declsByRuleCache.get(ctx.css);
  if (!map) {
    map = new Map();
    for (const d of ctx.css.decls) {
      if (!d.rule) continue;
      const list = map.get(d.rule);
      if (list) list.push(d);
      else map.set(d.rule, [d]);
    }
    declsByRuleCache.set(ctx.css, map);
  }
  return map.get(rule) ?? [];
}

const declIndexCache = new WeakMap();

/** Position of a decl in cascade order (ctx.css.decls). */
export function declIndex(ctx, decl) {
  let map = declIndexCache.get(ctx.css);
  if (!map) {
    map = new Map(ctx.css.decls.map((d, i) => [d, i]));
    declIndexCache.set(ctx.css, map);
  }
  return map.get(decl) ?? -1;
}

/** `later` wins over `earlier` for the same selector: later in the cascade, or !important over normal. */
export function overrides(ctx, later, earlier) {
  if (later.important !== earlier.important) return later.important;
  return declIndex(ctx, later) > declIndex(ctx, earlier);
}

/** The rule plus every rule that shares one of its selectors (keyframes excluded), in cascade order. */
export function sameSelectorRules(ctx, rule) {
  const out = new Set([rule]);
  for (const key of [rule.selectorText, ...rule.selectors]) {
    for (const r of ctx.css.rulesBySelector(key)) out.add(r);
  }
  return [...out];
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** `other` applies whenever `rule` applies: its media, supports and container conditions are a subset of rule's. */
export function appliesWith(other, rule) {
  const sub = (a, b) => a.every((x) => b.includes(x));
  return sub(other.context.media, rule.context.media)
    && sub(other.context.supports, rule.context.supports)
    && sub(other.context.container, rule.context.container)
    && !other.context.startingStyle;
}

/** Same media, supports, container and layer context. */
export function sameContext(a, b) {
  return sameList(a.context.media, b.context.media) && sameList(a.context.supports, b.context.supports)
    && sameList(a.context.container, b.context.container) && sameList(a.context.layer, b.context.layer);
}

/**
 * The position decl that applies to `rule` when it is one of `values`: the
 * rule's own winner when it declares position, else the last winner among
 * same-selector rules that apply whenever this one does.
 * @returns {object|null} DeclInfo
 */
export function positionDecl(ctx, rule, values) {
  const own = rule.get('position');
  if (own) return values.includes(lower(own.value)) ? own : null;
  let found = null;
  for (const r of sameSelectorRules(ctx, rule)) {
    if (r === rule || !appliesWith(r, rule)) continue;
    const d = r.get('position');
    if (d && (!found || overrides(ctx, d, found))) found = d;
  }
  return found && values.includes(lower(found.value)) ? found : null;
}

/** The winning top or bottom component across top/bottom, inset, inset-block and inset-block-start/end. */
export function insetSide(rule, side) {
  const parse = side === 'bottom' ? parseInsetBottom : parseInsetTop;
  let cur = null;
  for (const d of rule.decls) {
    const v = parse(d.prop, d.value);
    if (v === null) continue;
    if (cur && cur.decl.important && !d.important) continue;
    cur = { value: v, decl: d };
  }
  return cur;
}

/** Vertical overflow component of overflow, overflow-y or overflow-block decls in the rule (last wins). */
export function verticalOverflow(rule) {
  let cur = null;
  for (const d of rule.decls) {
    let v = null;
    if (d.prop === 'overflow-y' || d.prop === 'overflow-block') v = lower(d.value);
    else if (d.prop === 'overflow') {
      const parts = splitTopLevel(d.value, ' ');
      v = lower(parts[1] ?? parts[0]);
    }
    if (v === null) continue;
    if (cur && cur.decl.important && !d.important) continue;
    cur = { value: v, decl: d };
  }
  return cur;
}

/** Horizontal overflow component of overflow-x, overflow-inline or the overflow shorthand (last wins). */
export function horizontalOverflow(rule) {
  let cur = null;
  for (const d of rule.decls) {
    let v = null;
    if (d.prop === 'overflow-x' || d.prop === 'overflow-inline') v = lower(d.value);
    else if (d.prop === 'overflow') v = lower(splitTopLevel(d.value, ' ')[0]);
    if (v === null) continue;
    if (cur && cur.decl.important && !d.important) continue;
    cur = { value: v, decl: d };
  }
  return cur;
}

export const isScrollValue = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';

/**
 * Rules that pin an element to the bottom edge: position fixed (own or from a
 * same-selector rule), a zero bottom anchor, no zero top anchor (full-screen
 * overlays are skipped) and not display: none.
 * @returns {Array<{ rule: object, positionDecl: object, bottomDecl: object }>}
 */
export function fixedBottomCandidates(ctx) {
  const out = [];
  for (const rule of ctx.css.rules) {
    if (rule.context.keyframes !== null || rule.context.startingStyle) continue;
    const bottom = insetSide(rule, 'bottom');
    if (!bottom || !isZeroLength(bottom.value)) continue;
    const pos = positionDecl(ctx, rule, ['fixed']);
    if (!pos) continue;
    let top = insetSide(rule, 'top');
    if (!top) {
      for (const r of sameSelectorRules(ctx, rule)) {
        if (r === rule || !sameContext(r, rule)) continue;
        const t = insetSide(r, 'top');
        if (t) top = t;
      }
    }
    if (top && isZeroLength(top.value)) continue;
    const display = rule.get('display');
    if (display && lower(display.value) === 'none') {
      const shownElsewhere = sameSelectorRules(ctx, rule).some((r) => r !== rule && r.get('display') && lower(r.get('display').value) !== 'none');
      if (!shownElsewhere) continue;
    }
    out.push({ rule, positionDecl: pos, bottomDecl: bottom.decl });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM evidence
// ---------------------------------------------------------------------------

/** Elements of ctx.html that a rule applies to ([] when its selectors are unsupported). */
export function elementsFor(ctx, rule) {
  if (rule.fromStyleAttr) {
    if (ctx.html.owns(rule.fromStyleAttr)) return [rule.fromStyleAttr];
    return ctx.html.querySelectorAll(rule.selectorText);
  }
  const out = new Set();
  for (const s of rule.selectors) for (const el of ctx.html.querySelectorAll(s)) out.add(el);
  return [...out];
}

/** True when `evidence` (a RuleInfo) applies to one of `els`, or with descendants: true, to something inside them. */
export function ruleTouches(ctx, evidence, els, { descendants = false } = {}) {
  if (!els.length) return false;
  const pool = descendants ? [...new Set(els.flatMap((el) => [el, ...ctx.html.descendants(el)]))] : els;
  if (evidence.fromStyleAttr) return pool.includes(evidence.fromStyleAttr);
  return evidence.selectors.some((s) => pool.some((el) => ctx.html.matches(el, s) === true));
}

/**
 * Evidence for `rule` from any rule in `evidenceRules`: the rule itself, a
 * same-selector rule, a rule whose selector starts with one of its selectors
 * plus a combinator (child styling), or, through the DOM, a rule that matches
 * the same elements (or, with descendants, elements inside them).
 */
export function hasRuleEvidence(ctx, rule, evidenceRules, { children = false, descendants = false } = {}) {
  if (!evidenceRules.size) return false;
  if (evidenceRules.has(rule)) return true;
  if (sameSelectorRules(ctx, rule).some((r) => evidenceRules.has(r))) return true;
  if (children) {
    for (const e of evidenceRules) {
      if (e.selectors.some((s2) => rule.selectors.some((s) => s2.startsWith(`${s} `)))) return true;
    }
  }
  const els = elementsFor(ctx, rule);
  for (const e of evidenceRules) if (ruleTouches(ctx, e, els, { descendants })) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Class and id names used anywhere in a selector, split into lowercase words (kebab, snake, BEM and camelCase). */
export function selectorWords(sel) {
  const words = new Set();
  for (const m of String(sel).matchAll(/[.#]((?:[\w-]|\\.)+)/g)) {
    const name = m[1].replace(/\\/g, '');
    for (const part of name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/)) {
      if (part) words.add(part.toLowerCase());
    }
  }
  return words;
}

/** The last compound of a selector: its subject. */
export function subjectCompound(sel) {
  const parts = compounds(sel);
  return parts.length ? parts[parts.length - 1].text : '';
}

// ---------------------------------------------------------------------------
// Page usage (calibration: framework and plugin CSS often styles markup the
// audited page does not have)
// ---------------------------------------------------------------------------

const PSEUDO_ELEMENTS_RE = /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/gi;
const CONTENT_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label', 'img', 'svg', 'video', 'canvas', 'iframe', 'picture', 'object', 'embed']);
const CONTROL_ATTRS = ['tabindex', 'role', 'aria-label', 'aria-labelledby', 'onclick', 'contenteditable'];
const CONTROL_NAME_RE = /icon|btn|button|close|delete|remove|edit|action|menu|link/i;

/**
 * The element shows nothing a user could need: no text, no control or media
 * in its subtree, no ARIA name or click handler, and no class or id that
 * hints at an icon or a button. A gradient shade or a backdrop is decoration.
 */
export function looksDecorative(dom, el) {
  if (dom.text(el) !== '') return false;
  return ![el, ...dom.descendants(el)].some((n) => CONTENT_TAGS.has(dom.tag(n))
    || CONTROL_ATTRS.some((a) => dom.hasAttr(n, a))
    || CONTROL_NAME_RE.test(dom.attr(n, 'class') ?? '') || CONTROL_NAME_RE.test(dom.attr(n, 'id') ?? ''));
}

/** A link, button or other control that a tap activates. */
export function isControl(dom, el) {
  const tag = dom.tag(el);
  if ((tag === 'a' || tag === 'area') && dom.hasAttr(el, 'href')) return true;
  if (tag === 'button' || tag === 'summary' || tag === 'label') return true;
  return /^(button|link|menuitem|tab|option)$/.test((dom.attr(el, 'role') ?? '').trim().split(/\s+/)[0].toLowerCase());
}

/**
 * Elements that selectors match in the page HTML and, under --dynamic, in the
 * rendered DOM. State pseudo-classes and pseudo-elements are dropped first.
 * null when the matcher does not support a selector (no evidence either way).
 * @param {object} ctx
 * @param {string[]} selectors
 * @param {(sel: string) => string} strip - removes state pseudo-classes
 * @returns {Array<{ dom: object, els: object[] }>|null} only models with matches
 */
export function pageMatches(ctx, selectors, strip) {
  const targets = selectors.map((s) => strip(s).replace(PSEUDO_ELEMENTS_RE, '').trim() || '*');
  const probe = ctx.html.elements[0];
  if (probe && targets.some((t) => ctx.html.matches(probe, t) === null)) return null;
  const models = ctx.rendered && ctx.rendered !== ctx.html ? [ctx.html, ctx.rendered] : [ctx.html];
  return models.map((dom) => {
    const set = new Set();
    for (const t of targets) for (const el of dom.querySelectorAll(t)) set.add(el);
    return { dom, els: [...set] };
  }).filter((m) => m.els.length);
}

// ---------------------------------------------------------------------------
// JS
// ---------------------------------------------------------------------------

const unwrap = (n) => (n?.type === 'ChainExpression' ? n.expression : n);

/** True for an expression `x.preventDefault(...)` (optional chains included). */
export function isPreventDefaultCall(node) {
  if (node?.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  return callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'preventDefault';
}

/** preventDefault() calls made synchronously by a handler (nested functions are not entered). */
export function preventDefaultCalls(ctx, fn) {
  const out = [];
  ctx.js.walkFunction(fn, (node, ancestors) => {
    if (isPreventDefaultCall(node)) out.push({ node, ancestors });
  });
  return out;
}

const exits = (stmt) => {
  if (!stmt) return false;
  if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement') return true;
  return stmt.type === 'BlockStatement' && stmt.body.some((s) => s.type === 'ReturnStatement' || s.type === 'ThrowStatement');
};

/**
 * An earlier `if (...) return;` in an enclosing block of the handler, so the
 * node only runs when that guard lets it through.
 */
export function hasEarlyExit(ancestors, node) {
  for (let i = 0; i < ancestors.length; i++) {
    const a = ancestors[i];
    if (a.type !== 'BlockStatement' && a.type !== 'Program') continue;
    const child = ancestors[i + 1] ?? node;
    const idx = a.body.indexOf(child);
    for (let j = 0; j < idx; j++) {
      const s = a.body[j];
      if (s.type === 'IfStatement' && (exits(s.consequent) || exits(s.alternate))) return true;
    }
  }
  return false;
}

/** The call runs on every invocation of fn: not inside if/?:/&&/switch/catch and not after an early-return guard. */
export function isUnconditional(ctx, fn, call) {
  return !ctx.js.isConditional(call.ancestors, fn, call.node) && !hasEarlyExit(call.ancestors, call.node);
}

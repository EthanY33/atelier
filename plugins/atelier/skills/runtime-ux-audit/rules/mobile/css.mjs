/**
 * Mobile rules read from CSS: viewport units, scroll containers, hover reveals
 * and dead WebKit properties.
 */
import {
  compounds, findUnitValues, inMedia, inSupports, isModalSelector, splitTopLevel, stripStatePseudos,
} from '../../lib/css-values.mjs';
import {
  allDeclsOf, elementsFor, hasRuleEvidence, horizontalOverflow, isControl, isScrollValue, looksDecorative, overrides,
  pageMatches, positionDecl, ruleTouches, sameSelectorRules, selectorWords, subjectCompound, verticalOverflow,
} from './shared.mjs';

const lower = (v) => String(v ?? '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// vh units
// ---------------------------------------------------------------------------

const NUM = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const DYNAMIC_UNIT_RE = new RegExp(`(?<![\\w.])${NUM}(?:dvh|svh|lvh|dvb|svb|lvb)(?![\\w-])|-webkit-fill-available|(?<![\\w-])stretch(?![\\w-])`, 'i');
const LEGACY_SUPPORTS_RE = /not\s*\([^)]*(?:dvh|svh|lvh)/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The value reads a custom property that page scripts set (the classic --vh fix). */
function usesScriptedCustomProp(ctx, value) {
  for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (ctx.js.mentions(new RegExp(`${escapeRe(m[1])}(?![\\w-])`))) return true;
  }
  return false;
}

/**
 * A dvh/svh/lvh (or -webkit-fill-available, stretch, or a scripted custom
 * property) declaration of the same property that wins over `d` for the same
 * selector: later in the cascade or !important.
 */
function hasDynamicFallback(ctx, d) {
  for (const r of sameSelectorRules(ctx, d.rule)) {
    for (const f of allDeclsOf(ctx, r)) {
      if (f === d || f.prop !== d.prop || !overrides(ctx, f, d)) continue;
      if (ctx.css.valueMentions(f.value, DYNAMIC_UNIT_RE)) return true;
      if (r === d.rule && usesScriptedCustomProp(ctx, f.value)) return true;
    }
  }
  // Another selector gives the same element a dynamic height (utility classes: min-h-screen min-h-dvh).
  // It must win the cascade: later, or !important over normal (specificity is not compared).
  const others = dynamicDeclsOf(ctx, d.prop).filter((f) => f.rule !== d.rule && overrides(ctx, f, d));
  if (!others.length) return false;
  const els = elementsFor(ctx, d.rule);
  return others.some((f) => ruleTouches(ctx, f.rule, els));
}

const dynamicDeclCache = new WeakMap();

/** Decls of `prop` whose value uses a dynamic viewport unit (var() chains followed), cached per stylesheet model. */
function dynamicDeclsOf(ctx, prop) {
  let byProp = dynamicDeclCache.get(ctx.css);
  if (!byProp) {
    byProp = new Map();
    dynamicDeclCache.set(ctx.css, byProp);
  }
  if (!byProp.has(prop)) byProp.set(prop, ctx.css.declsByProp(prop).filter((f) => f.rule && ctx.css.valueMentions(f.value, DYNAMIC_UNIT_RE)));
  return byProp.get(prop);
}

/** vh declarations of `props` that no dynamic-unit fallback overrides. */
function unguardedVhDecls(ctx, props) {
  const out = [];
  for (const prop of props) {
    for (const d of ctx.css.declsByProp(prop)) {
      if (!d.rule || d.context.keyframes !== null) continue;
      const vh = findUnitValues(d.value, 'vh');
      if (!vh.length) continue;
      if (ctx.css.valueMentions(d.value, DYNAMIC_UNIT_RE) || usesScriptedCustomProp(ctx, d.value)) continue;
      if (inSupports(d, LEGACY_SUPPORTS_RE)) continue;
      if (hasDynamicFallback(ctx, d)) continue;
      out.push({ decl: d, vh });
    }
  }
  return out;
}

export const usesVhWithoutDvh = {
  id: 'atelier/runtime-ux/uses-vh-without-dvh',
  area: 'mobile',
  severity: 'serious',
  confidence: 'high',
  methods: ['css'],
  phase: 'static',
  description: 'A full-height box is sized with 100vh and no dvh or svh fallback, so on phones it is taller than the visible viewport while the URL bar shows.',
  helpUrl: 'https://web.dev/blog/viewport-units',
  check(ctx) {
    return unguardedVhDecls(ctx, ['height', 'min-height', 'max-height', 'block-size', 'min-block-size', 'max-block-size'])
      .filter(({ vh }) => vh.some((n) => n >= 90))
      .map(({ decl, vh }) => {
        const max = Math.max(...vh);
        const review = vhReviewReason(ctx, decl.rule);
        return {
          node: ctx.ref.css(decl),
          message: review
            ? `${decl.prop} uses ${max}vh with no dvh or svh fallback; check it: ${review}.`
            : `${decl.prop} uses ${max}vh with no later dvh or svh declaration; add ${decl.prop}: ${max}dvh (or svh) after it.`,
          data: { prop: decl.prop, vh: max },
          incomplete: review !== null,
        };
      });
  },
};

export const fixedHeaderVhSized = {
  id: 'atelier/runtime-ux/fixed-header-vh-sized',
  area: 'mobile',
  severity: 'minor',
  confidence: 'medium',
  methods: ['css'],
  phase: 'static',
  description: 'A position: fixed or sticky element is sized in vh, which follows the large viewport on phones and overstates the visible area while browser toolbars show.',
  helpUrl: 'https://web.dev/blog/viewport-units',
  check(ctx) {
    const out = [];
    for (const { decl, vh } of unguardedVhDecls(ctx, ['height', 'min-height', 'max-height', 'block-size'])) {
      if (!vh.every((n) => n < 90) || !vh.some((n) => n > 0)) continue;
      const pos = positionDecl(ctx, decl.rule, ['fixed', 'sticky', '-webkit-sticky']);
      if (!pos) continue;
      const max = Math.max(...vh);
      out.push({
        node: ctx.ref.css(decl),
        message: `position: ${lower(pos.value)} element sized with ${decl.prop}: ${max}vh; use svh or dvh.`,
        data: { position: lower(pos.value), prop: decl.prop, vh: max },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Scroll containers
// ---------------------------------------------------------------------------

const CAROUSEL_WORDS = new Set([
  'carousel', 'carousels', 'slider', 'sliders', 'slides', 'swiper', 'gallery', 'galleries',
  'scroller', 'scrollers', 'reel', 'reels', 'rail', 'rails', 'strip', 'strips', 'track', 'tracks',
]);
const SNAP_IN_JS_RE = /scrollSnapType|scroll-snap-type/;

function isHorizontalLayout(rule) {
  const display = lower(rule.get('display')?.value);
  if (display === 'flex' || display === 'inline-flex') {
    const dir = lower(rule.get('flex-direction')?.value);
    const wrap = lower(rule.get('flex-wrap')?.value);
    const flow = splitTopLevel(lower(rule.get('flex-flow')?.value), ' ');
    if (dir && dir !== 'row' && dir !== 'row-reverse') return false;
    if (wrap && wrap !== 'nowrap') return false;
    if (flow.some((t) => t.startsWith('column') || t.startsWith('wrap'))) return false;
    return true;
  }
  if (display === 'grid' || display === 'inline-grid') {
    return /(^|\s)column(\s|$)/.test(lower(rule.get('grid-auto-flow')?.value));
  }
  return false;
}

export const carouselNoScrollSnap = {
  id: 'atelier/runtime-ux/carousel-no-scroll-snap',
  area: 'mobile',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['css'],
  phase: 'static',
  description: 'A horizontal carousel scrolls freely without scroll-snap-type, or scroll-snap-align is set with no snap container, so swipes stop between slides.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_snap',
  check(ctx) {
    const out = [];
    const snapInJs = ctx.js.mentions(SNAP_IN_JS_RE);
    const typeDecls = ctx.css.declsByProp('scroll-snap-type').filter((d) => lower(d.value) !== 'none');
    // (a) scroll-snap-align does nothing without a snap container.
    const aligns = ctx.css.declsByProp('scroll-snap-align').filter((d) => lower(d.value) !== 'none');
    if (aligns.length && !typeDecls.length && !snapInJs) {
      out.push({
        node: ctx.ref.css(aligns[0]),
        message: 'scroll-snap-align is set but no rule sets scroll-snap-type, so nothing snaps.',
        confidence: 'high',
        incomplete: !ctx.css.complete,
      });
    }
    // (b) carousel-named horizontal scrollers without snapping.
    if (snapInJs) return out;
    const snapRules = new Set(typeDecls.filter((d) => d.rule).map((d) => d.rule));
    for (const rule of ctx.css.rules) {
      if (rule.context.keyframes !== null) continue;
      if (!rule.selectors.some((s) => [...selectorWords(s)].some((w) => CAROUSEL_WORDS.has(w)))) continue;
      const ox = horizontalOverflow(rule);
      if (!ox || !isScrollValue(ox.value) || !isHorizontalLayout(rule)) continue;
      if (hasRuleEvidence(ctx, rule, snapRules)) continue;
      out.push({
        node: ctx.ref.css(ox.decl),
        message: `${rule.selectorText} scrolls horizontally without scroll-snap-type; add scroll-snap-type: x mandatory and scroll-snap-align on the slides.`,
        incomplete: !ctx.css.complete,
      });
    }
    return out;
  },
};

const LOCK_CLASS_RE = /(?:no|lock|locked|disable|disabled|prevent|stop)[-_]?scroll|scroll[-_]?(?:lock|locked|disabled|off)|modal[-_]?open|overflow[-_]?hidden/i;
const LOCK_LIB_RE = /\b(?:disableBodyScroll|lockBodyScroll|clearAllBodyScrollLocks|scrollLock|ScrollLock)\b/;
// Modal libraries that lock body scrolling themselves (matched on script src, CDN copies included).
const LOCK_SCRIPT_RE = /bootstrap(?:\.bundle)?(?:\.min)?\.js|body-scroll-lock|scroll-lock|micromodal|a11y-dialog/i;
const BODY_STYLE_RE = /(?:^|\.)(?:body|documentElement|scrollingElement)\.style\.overflow(?:Y)?$/;
const ANY_STYLE_OVERFLOW_RE = /\.style\.overflow(?:Y)?$/;

function stringArg(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** A body scroll lock: a stateful html/body/:root rule or a lock class with overflow hidden, or script that sets it. */
function hasScrollLock(ctx) {
  for (const rule of ctx.css.rules) {
    const ov = verticalOverflow(rule);
    if (!ov || (ov.value !== 'hidden' && ov.value !== 'clip')) continue;
    for (const s of rule.selectors) {
      const parts = compounds(s);
      const first = parts[0]?.text ?? '';
      if (/^(?:html|body|:root)(?![\w-])/i.test(first) && /[.[]|:has\(/i.test(s)) return true;
      const cls = parts.length === 1 ? /^\.((?:[\w-]|\\.)+)$/.exec(first) : null;
      if (cls && (LOCK_CLASS_RE.test(cls[1]) || ctx.js.stringLiterals(cls[1]).length > 0)) return true;
    }
  }
  if (ctx.js.assignments.some((a) => BODY_STYLE_RE.test(a.normalizedTarget)
    || (ANY_STYLE_OVERFLOW_RE.test(a.normalizedTarget) && lower(stringArg(a.valueNode)) === 'hidden'))) return true;
  if (ctx.html.byTag('script').some((el) => LOCK_SCRIPT_RE.test(ctx.html.attr(el, 'src') ?? ''))) return true;
  for (const c of ctx.js.callsByMethod('setProperty')) {
    if (/(?:body|documentElement)\.style\.setProperty$/.test(c.callee) && /^overflow(?:-y)?$/.test(stringArg(c.args[0]) ?? '')) return true;
  }
  for (const c of ctx.js.callsByMethod('css')) {
    if (/^overflow(?:-y)?$/.test(stringArg(c.args[0]) ?? '') && lower(stringArg(c.args[1])) === 'hidden') return true;
  }
  if (ctx.js.mentions(LOCK_LIB_RE)) return true;
  return ctx.js.imports.some((i) => /scroll-lock/i.test(i.source));
}

const OVERSCROLL_PROPS = new Set(['overscroll-behavior', 'overscroll-behavior-y', 'overscroll-behavior-block']);

function containsOverscroll(d) {
  if (d.prop !== 'overscroll-behavior') return lower(d.value) !== 'auto';
  const parts = splitTopLevel(lower(d.value), ' ');
  return (parts[1] ?? parts[0]) !== 'auto';
}

export const modalNoOverscrollBehavior = {
  id: 'atelier/runtime-ux/modal-no-overscroll-behavior',
  area: 'mobile',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['css', 'js'],
  phase: 'static',
  description: 'A scrollable modal has no overscroll-behavior and the page has no body scroll lock, so scrolling past its end scrolls the page behind it.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior',
  check(ctx) {
    const candidates = [];
    for (const rule of ctx.css.rules) {
      if (rule.context.keyframes !== null || rule.context.startingStyle) continue;
      if (!rule.selectors.some((s) => isModalSelector(s))) continue;
      const ov = verticalOverflow(rule);
      if (ov && isScrollValue(ov.value)) candidates.push({ rule, decl: ov.decl });
    }
    if (!candidates.length) return { notApplicable: 'no scrollable modal rules' };
    if (hasScrollLock(ctx)) return [];
    const evidence = new Set(ctx.css.decls.filter((d) => d.rule && OVERSCROLL_PROPS.has(d.prop) && containsOverscroll(d)).map((d) => d.rule));
    const incomplete = !(ctx.css.complete && ctx.js.complete);
    return candidates
      .filter((c) => !hasRuleEvidence(ctx, c.rule, evidence))
      .map((c) => ({
        node: ctx.ref.css(c.decl),
        message: `${c.rule.selectorText} scrolls but has no overscroll-behavior: contain and no body scroll lock was found.`,
        incomplete,
      }));
  },
};

export const webkitOverflowScrollingTouch = {
  id: 'atelier/runtime-ux/webkit-overflow-scrolling-touch',
  area: 'mobile',
  severity: 'minor',
  confidence: 'high',
  methods: ['css'],
  phase: 'static',
  description: '-webkit-overflow-scrolling: touch has been a no-op since iOS 13, where every overflow scroller already uses momentum scrolling.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-overflow-scrolling',
  check(ctx) {
    return ctx.css.declsByProp('-webkit-overflow-scrolling')
      .filter((d) => lower(d.value) === 'touch')
      .map((d) => ({ node: ctx.ref.css(d), message: 'Remove it; iOS 13 and later ignore it.' }));
  },
};

// ---------------------------------------------------------------------------
// Hover-only reveals
// ---------------------------------------------------------------------------

const HOVER_MEDIA_RE = /\((?:any-)?hover(?:\s*:\s*hover)?\)|\((?:any-)?pointer\s*:\s*fine\)/i;
const FOCUS_RE = /:focus(?:-within|-visible)?(?![\w-])/i;
const HOVER_RE = /:hover(?![\w-])/i;
const PSEUDO_ELEMENT_RE = /::[\w-]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![\w-])/gi;
const STATE_CLASS_SRC = '\\.(?:is-|has-)?(?:open|opened|active|show|shown|visible|expanded|toggled|on|in|selected|current)(?![\\w-])';
const STATE_ATTR_SRC = '\\[(?:open|aria-expanded|aria-hidden|aria-selected|aria-pressed|data-state|data-open|data-expanded)(?:[~|^$*]?=[^\\]]*)?\\]';
const STATE_CLASS_RE = new RegExp(STATE_CLASS_SRC, 'gi');
const STATE_ATTR_RE = new RegExp(STATE_ATTR_SRC, 'gi');
const STATEFUL_RE = new RegExp(`:(?:focus|focus-within|focus-visible|checked|target|open|popover-open|modal)(?![\\w-])|${STATE_CLASS_SRC}|${STATE_ATTR_SRC}`, 'i');
const REVEAL_PROPS = ['display', 'visibility', 'opacity'];

/** Remove :not(...) groups so a :hover inside them does not count. */
function stripNot(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 5).toLowerCase() === ':not(') {
      let depth = 0;
      for (let j = i + 4; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) { i = j; break; }
      }
      continue;
    }
    out += text[i];
  }
  return out;
}

const hasHover = (sel) => HOVER_RE.test(stripNot(sel));

/** The first compound holding :hover when it is not the last one, else null. */
function hoverCompound(sel) {
  const parts = compounds(sel);
  for (let i = 0; i < parts.length - 1; i++) {
    const text = stripNot(parts[i].text);
    if (HOVER_RE.test(text)) return text;
  }
  return null;
}

/** The subject compound without state pseudo-classes or pseudo-elements: '.card:hover .tip::after' -> '.tip'. */
function targetKey(sel) {
  const t = stripStatePseudos(subjectCompound(sel)).replace(PSEUDO_ELEMENT_RE, '');
  return t || '*';
}

/** The selector with state pseudo-classes, state-like classes and state attributes removed. */
function looseBase(sel) {
  return stripStatePseudos(sel).replace(PSEUDO_ELEMENT_RE, '').replace(STATE_CLASS_RE, '').replace(STATE_ATTR_RE, '').replace(/\s+/g, ' ').trim();
}

const isBareType = (key) => /^(?:\*|[a-z][a-z0-9-]*)$/i.test(key);

function opacityOf(v) {
  const s = lower(v);
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return s.endsWith('%') ? n / 100 : n;
}

function reveals(rule, prop) {
  const d = rule.get(prop);
  if (!d) return false;
  const v = lower(d.value);
  if (prop === 'display') return v !== 'none';
  if (prop === 'visibility') return v === 'visible';
  const o = opacityOf(v);
  return o !== null && o >= 0.5;
}

const NOT_IN_PAGE = 'no element in the page HTML matches it, so check that the rule is in use';

/**
 * Why a hover finding needs a human look instead of failing the audit, or
 * null. The page HTML (the rendered DOM under --dynamic) must show an element
 * the rule reveals, and one that is more than decoration or a hint inside a
 * link. Unused framework or plugin CSS reveals nothing on this page.
 */
function hoverReviewReason(ctx, sel) {
  if (/::?(?:before|after)(?![\w-])/i.test(subjectCompound(sel))) return 'it reveals ::before or ::after content, which is usually decoration';
  const found = pageMatches(ctx, [sel], stripStatePseudos);
  if (found === null) return null;
  if (!found.length) return NOT_IN_PAGE;
  if (found.every(({ dom, els }) => els.every((el) => looksDecorative(dom, el)))) return 'the revealed elements hold no text or controls, so they may be decoration';
  if (found.every(({ dom, els }) => els.every((el) => dom.ancestors(el).some((a) => isControl(dom, a))))) {
    return 'it sits inside a link or button, so a tap still reaches the action';
  }
  return null;
}

/**
 * Why a vh finding needs a human look, or null: no element in the page uses
 * the rule, or every match is an empty box such as a backdrop, which loses
 * nothing when it runs taller than the visible viewport.
 */
function vhReviewReason(ctx, rule) {
  if (rule.fromStyleAttr) return null;
  const found = pageMatches(ctx, rule.selectors, stripStatePseudos);
  if (found === null) return null;
  if (!found.length) return NOT_IN_PAGE;
  if (found.every(({ dom, els }) => els.every((el) => looksDecorative(dom, el)))) return 'every matching element is empty in the page HTML (a backdrop, or content a script adds later)';
  return null;
}

function hides(rule, prop) {
  const d = rule.get(prop);
  if (!d) return false;
  const v = lower(d.value);
  if (prop === 'display') return v === 'none';
  if (prop === 'visibility') return v === 'hidden' || v === 'collapse';
  const o = opacityOf(v);
  return o !== null && o < 0.5;
}

export const hoverOnlyAffordance = {
  id: 'atelier/runtime-ux/hover-only-affordance',
  area: 'mobile',
  severity: 'serious',
  confidence: 'medium',
  methods: ['css', 'html'],
  phase: 'static',
  description: 'Content hidden by default is revealed only by :hover on an ancestor or sibling, with no :focus, :focus-within or click-state equivalent, so touch users cannot reach it.',
  helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus',
  check(ctx) {
    // Every (rule, selector) pair, indexed by its target: the subject compound
    // without state pseudo-classes (key) and also without state classes (lkey).
    const entries = [];
    for (const rule of ctx.css.rules) {
      if (rule.context.keyframes !== null || rule.context.startingStyle) continue;
      for (const sel of rule.selectors) {
        const key = targetKey(sel);
        entries.push({ rule, sel, key, lkey: looseBase(key) || '*', loose: looseBase(sel), hover: hasHover(sel), stateful: STATEFUL_RE.test(sel) });
      }
    }
    const index = (list, field) => {
      const m = new Map();
      for (const e of list) {
        const bucket = m.get(e[field]);
        if (bucket) bucket.push(e); else m.set(e[field], [e]);
      }
      return m;
    };
    const byLkey = index(entries, 'lkey');
    const byLoose = index(entries, 'loose');
    const hiding = Object.fromEntries(REVEAL_PROPS.map((p) => [p, entries.filter((e) => !e.hover && hides(e.rule, p))]));
    const hidingByLkey = Object.fromEntries(REVEAL_PROPS.map((p) => [p, index(hiding[p], 'lkey')]));
    const hidingByLoose = Object.fromEntries(REVEAL_PROPS.map((p) => [p, index(hiding[p], 'loose')]));
    const statefulReveals = Object.fromEntries(REVEAL_PROPS.map((p) => [p, entries.filter((e) => e.stateful && !e.hover && reveals(e.rule, p))]));

    const out = [];
    for (const rule of ctx.css.rules) {
      if (rule.context.keyframes !== null || rule.context.startingStyle || inMedia(rule, HOVER_MEDIA_RE)) continue;
      const revealing = REVEAL_PROPS.filter((p) => reveals(rule, p));
      if (!revealing.length) continue;
      for (const sel of rule.selectors) {
        const hovered = hoverCompound(sel);
        if (hovered === null || FOCUS_RE.test(hovered)) continue;
        const focusVariants = [':focus', ':focus-visible', ':focus-within'].map((f) => sel.replace(HOVER_RE, f));
        if (focusVariants.some((v) => ctx.css.rulesBySelector(v).length > 0)) continue;
        const lkey = looseBase(targetKey(sel)) || '*';
        const loose = looseBase(sel);
        // Same target: the same selector minus states, or the same non-generic subject.
        const sameTarget = (e) => e.loose === loose || (e.lkey === lkey && !isBareType(lkey));
        // The hover rule reveals something that a base rule (or the hidden attribute) hides.
        let els = null;
        const hidden = revealing.filter((p) => {
          const sameTargetHiders = [...(hidingByLoose[p].get(loose) ?? []), ...(isBareType(lkey) ? [] : hidingByLkey[p].get(lkey) ?? [])];
          if (sameTargetHiders.some((e) => e.rule !== rule)) return true;
          els ??= ctx.html.querySelectorAll(stripStatePseudos(sel));
          if (!els.length) return false;
          if (p === 'display' && els.some((el) => ctx.html.hasAttr(el, 'hidden'))) return true;
          return hiding[p].some((e) => e.rule !== rule && (e.rule.fromStyleAttr ? els.includes(e.rule.fromStyleAttr) : els.some((el) => ctx.html.matches(el, e.sel) === true)));
        });
        if (!hidden.length) continue;
        // A non-hover selector for the same target reveals it too (focus, click toggle, :checked, (hover: none)).
        const peers = new Set([...(byLkey.get(lkey) ?? []), ...(byLoose.get(loose) ?? [])]);
        const guarded = [...peers].some((e) => e.sel !== sel && !e.hover && sameTarget(e) && hidden.some((p) => reveals(e.rule, p)));
        if (guarded) continue;
        // A stateful selector (focus, checked, open, a state class) that reveals the same elements
        // through another name, e.g. utility classes group-hover:block group-focus-within:block.
        const stateful = [...new Set(hidden.flatMap((p) => statefulReveals[p]))].filter((e) => e.rule !== rule);
        if (stateful.length) {
          els ??= ctx.html.querySelectorAll(stripStatePseudos(sel));
          if (stateful.some((e) => els.some((el) => ctx.html.matches(el, e.sel) === true))) continue;
        }
        const review = hoverReviewReason(ctx, sel);
        out.push({
          node: ctx.ref.css(rule.get(hidden[0])),
          message: review
            ? `Hover-only reveal to check: ${review}. If it matters, add :focus-within (or a click toggle) to the same rule.`
            : `${sel} reveals it on hover only; add :focus-within (or a click toggle) to the same rule.`,
          data: { hover: sel, props: hidden },
          incomplete: !ctx.css.complete || review !== null,
        });
        break;
      }
    }
    return out;
  },
};


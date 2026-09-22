/**
 * panels rules that read CSS (some also consult the HTML).
 */
import {
  colorAlpha, compounds, inSupports, parseAnimationList, parseZIndex, selectorBaseKey, splitTopLevel, stripStatePseudos,
} from '../../lib/css-values.mjs';
import {
  DURATION_PROPS, TRANSITION_PROPS, backdropFilterDecl, declDurations, declaredTransition, fmtMs,
  inAnyReducedMotion, inReduce, isAriaModal, isKeyframes, isModal, isOff, isPanel, isPopoverOrDialog,
  joinCompounds, keyCovers, maxDeclMs, panelsRule, parenDepthAt, predicateSelectors, predicateSubjects, varNames,
} from './shared.mjs';

const HELP = Object.freeze({
  topLayer: 'https://drafts.csswg.org/css-position-4/#top-layer',
  startingStyle: 'https://developer.mozilla.org/en-US/docs/Web/CSS/@starting-style',
  entryExit: 'https://web.dev/articles/entry-exit-animations',
  reducedMotion: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion',
  motion: 'https://m3.material.io/styles/motion/overview',
  anchor: 'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning',
  overflow: 'https://developer.mozilla.org/en-US/docs/Web/CSS/overflow',
  backdropFilter: 'https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter',
});

// ---------------------------------------------------------------------------
// z-index
// ---------------------------------------------------------------------------

const Z_CUSTOM_PROP_RE = /^--z(-|index|-index)/i;
/**
 * Skip links and screen-reader text revealed on focus must paint above
 * everything and cannot use the top layer, so their z-index is exempt
 * (WordPress core ships .screen-reader-text:focus { z-index: 100000 }).
 */
const A11Y_HELPER_RE = /skip|screen-reader|sr-only|visually-?hidden/i;

/** z-index decls plus --z-* / --zindex* custom properties, style attributes included, keyframes and a11y helpers excluded. */
function zIndexDecls(ctx) {
  return ctx.css.decls.filter((d) => !isKeyframes(d)
    && (d.prop === 'z-index' || (d.prop.startsWith('--') && Z_CUSTOM_PROP_RE.test(d.prop)))
    && !(d.rule && A11Y_HELPER_RE.test(d.rule.selectorText)));
}

/** The "always on top" literals: 9999, 99999, ..., 2147483647 and 2147483646. */
function isLiteralSmell(value) {
  const v = String(value ?? '').trim();
  return /^9{4,}$/.test(v) || v === '2147483647' || v === '2147483646';
}

const zIndexOverBudget = panelsRule('z-index-over-budget', {
  severity: 'minor',
  confidence: 'high',
  methods: ['css'],
  brand: true,
  description: 'A z-index literal is above the surfaces.zIndexMax budget; top-layer dialogs and popovers need no z-index race.',
  helpUrl: HELP.topLayer,
  check(ctx) {
    const max = ctx.budgets.zIndexMax;
    const source = ctx.brand?.surfaces?.zIndexMax !== undefined ? 'surfaces.zIndexMax' : 'default';
    const out = [];
    for (const d of zIndexDecls(ctx)) {
      const n = parseZIndex(d.value);
      if (n === null || n <= max || isLiteralSmell(d.value)) continue;
      out.push({
        node: ctx.ref.css(d),
        message: `${d.prop} ${n} is above the budget of ${max} (${source})`,
        data: { zIndex: n, budget: max },
      });
    }
    return out;
  },
});

const zIndexLiteralSmell = panelsRule('z-index-literal-smell', {
  severity: 'moderate',
  confidence: 'high',
  methods: ['css'],
  description: 'A magic "always on top" z-index such as 9999 or 2147483647; the top layer (showModal, popover) replaces it.',
  helpUrl: HELP.topLayer,
  check(ctx) {
    return zIndexDecls(ctx).filter((d) => isLiteralSmell(d.value)).map((d) => ({
      node: ctx.ref.css(d),
      message: `${d.prop} ${d.value.trim()} is an "always on top" literal; use a small z-index scale, or the top layer for dialogs and popovers`,
      data: { zIndex: Number(d.value.trim()) },
    }));
  },
});

// ---------------------------------------------------------------------------
// @starting-style
// ---------------------------------------------------------------------------

/**
 * Base keys of every rule that animates the entry: rules inside a
 * @starting-style block, rules holding a nested @starting-style block, and
 * rules with a keyframe animation.
 */
function startingStyleKeys(ctx) {
  const keys = new Set();
  for (const r of ctx.css.rules) {
    if (r.context.startingStyle && !isKeyframes(r)) for (const s of r.selectors) keys.add(selectorBaseKey(s));
  }
  for (const d of ctx.css.decls) {
    if (d.atRule?.name === 'starting-style' && d.rule && !d.rule.fromStyleAttr) for (const s of d.rule.selectors) keys.add(selectorBaseKey(s));
  }
  // A keyframe animation runs on entry by itself, so it animates the entry
  // without @starting-style (calibration: dialog[open] { animation: show .4s }).
  for (const r of ctx.css.rules) {
    if (isKeyframes(r) || r.fromStyleAttr || inReduce(r)) continue;
    const anim = r.get('animation') ?? r.get('animation-name');
    if (!anim) continue;
    const named = anim.prop === 'animation'
      ? parseAnimationList(anim.value).some((a) => a.name !== 'none')
      : splitTopLevel(anim.value, ',').some((n) => !isOff(n));
    if (named) for (const s of r.selectors) keys.add(selectorBaseKey(s));
  }
  return keys;
}

const noStartingStyle = panelsRule('no-starting-style-on-transitioned-popover', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['css'],
  description: 'A popover or dialog declares a transition but no @starting-style, so it appears without its entry animation.',
  helpUrl: HELP.startingStyle,
  check(ctx) {
    const { css, html } = ctx;
    const keys = [...startingStyleKeys(ctx)];
    const out = [];
    for (const r of css.rules) {
      if (isKeyframes(r) || r.context.startingStyle || inReduce(r)) continue;
      if (!predicateSubjects(r).some(isPopoverOrDialog)) continue;
      const decl = r.decls.find((d) => TRANSITION_PROPS.includes(d.prop) && (maxDeclMs(ctx, d) ?? 0) > 0);
      if (!decl) continue;
      let covered;
      if (r.fromStyleAttr) {
        const el = r.fromStyleAttr;
        covered = html.owns(el) && keys.some((k) => !k.includes('::') && html.matches(el, k) !== false);
      } else {
        covered = r.selectors.some((s) => {
          const own = selectorBaseKey(s);
          return keys.some((k) => keyCovers(k, own));
        });
      }
      if (covered) continue;
      out.push({
        node: ctx.ref.css(decl),
        message: `"${r.selectorText}" transitions without a matching @starting-style, so the entry is not animated`,
        incomplete: !css.complete,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// transition: all
// ---------------------------------------------------------------------------

const transitionAllOnPopover = panelsRule('transition-all-on-popover', {
  severity: 'minor',
  confidence: 'high',
  methods: ['css'],
  description: 'transition: all on a popover or dialog animates every changed property, including layout; list the properties instead.',
  helpUrl: HELP.entryExit,
  check(ctx) {
    const out = [];
    for (const r of ctx.css.rules) {
      if (isKeyframes(r)) continue;
      if (!predicateSubjects(r).some(isPopoverOrDialog)) continue;
      for (const d of r.decls) {
        let hit = false;
        if (d.prop === 'transition') {
          hit = declDurations(ctx, d).some((t) => t.property === 'all' && t.ms !== 0);
        } else if (d.prop === 'transition-property') {
          hit = splitTopLevel(d.value, ',').some((p) => p.toLowerCase() === 'all');
        }
        if (hit) {
          out.push({
            node: ctx.ref.css(d),
            message: `${d.prop}: ${d.value} transitions every property; name them (opacity, transform, display, overlay)`,
          });
        }
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * Properties whose change is not perceived as motion (WCAG 2.3.3 excludes
 * color, blur and opacity changes). Everything else counts as motion.
 */
const NON_MOTION_PROPS = new Set([
  'opacity', 'visibility', 'display', 'overlay', 'content-visibility', 'z-index',
  'color', 'background', 'background-color', 'border-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'border-block-color', 'border-inline-color', 'outline',
  'outline-color', 'box-shadow', 'text-shadow', 'filter', 'backdrop-filter', '-webkit-backdrop-filter',
  'fill', 'stroke', 'fill-opacity', 'stroke-opacity', 'text-decoration-color', 'caret-color', 'accent-color',
]);

function isMotionProperty(prop) {
  if (prop === null || prop === undefined) return false;
  const p = String(prop).toLowerCase();
  if (p.startsWith('--')) return false;
  return !NON_MOTION_PROPS.has(p);
}

function keyframesMove(ctx, name) {
  const want = String(name ?? '').replace(/^["']|["']$/g, '');
  const frames = ctx.css.rules.filter((r) => r.context.keyframes !== null
    && r.context.keyframes.replace(/^["']|["']$/g, '') === want);
  if (!frames.length) return true; // unknown keyframes: assume they move
  return frames.some((r) => r.decls.some((d) => isMotionProperty(d.prop)));
}

/**
 * The duration entries of a transition / animation decl that move something
 * (see declDurations for the entry shape). Longhand durations move when the
 * rule's transition-property (default all) or animation-name keyframes do.
 */
function movingEntries(ctx, rule, decl) {
  const entries = declDurations(ctx, decl);
  switch (decl.prop) {
    case 'transition':
      return entries.filter((t) => isMotionProperty(t.property));
    case 'animation':
      return entries.filter((a) => a.name !== 'none' && keyframesMove(ctx, a.name));
    case 'transition-duration': {
      const props = rule.get('transition-property');
      const list = props ? splitTopLevel(props.value, ',') : ['all'];
      return list.some(isMotionProperty) ? entries : [];
    }
    case 'animation-duration': {
      const names = rule.get('animation-name');
      const moves = Boolean(names) && splitTopLevel(names.value, ',').some((n) => n.toLowerCase() !== 'none' && keyframesMove(ctx, n));
      return moves ? entries : [];
    }
    default:
      return [];
  }
}

/** The rule's first decl that moves something for a known, positive duration, or null. */
function firstMotionDecl(ctx, rule) {
  return rule.decls.find((d) => DURATION_PROPS.includes(d.prop) && movingEntries(ctx, rule, d).some((e) => (e.ms ?? 0) > 0)) ?? null;
}

const GLOBAL_COMPOUND_RE = /^(\*|html|:root|body)?(::?(before|after|backdrop|marker))?$/i;

function isGlobalSelector(sel) {
  const parts = compounds(sel);
  return parts.length > 0 && parts.every((p) => GLOBAL_COMPOUND_RE.test(p.text));
}

const isMotionControlProp = (prop) => /^(-webkit-)?(transition|animation)/.test(prop);

/** A custom property used by the decl is redefined inside a reduce block (two hops). */
function tokenGuarded(ctx, decl) {
  const seen = new Set();
  let names = varNames(decl.value);
  for (let depth = 0; depth < 2 && names.length; depth++) {
    const next = [];
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const def of ctx.css.customProps(name)) {
        if (inReduce(def)) return true;
        next.push(...varNames(def.value));
      }
    }
    names = next;
  }
  return false;
}

const motionNoReducedMotionGuard = panelsRule('motion-no-reduced-motion-guard', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['css'],
  description: 'A panel moves (transition or animation) with no prefers-reduced-motion override.',
  helpUrl: HELP.reducedMotion,
  check(ctx) {
    const { css, html } = ctx;
    // Decls inside a reduce block, whether the block wraps the rule or sits
    // nested inside it ('.modal { @media (...: reduce) { transition: none } }').
    const reduceDecls = css.decls.filter((d) => !isKeyframes(d) && inReduce(d) && d.rule && !d.rule.fromStyleAttr);
    const globalReset = reduceDecls.some((d) => isMotionControlProp(d.prop) && d.rule.selectors.some(isGlobalSelector));
    if (globalReset) return [];
    // Global selectors only guard through the transition/animation reset above
    // ('* { scroll-behavior: auto }' says nothing about panel motion).
    const reduceSelectors = [...new Set(reduceDecls.flatMap((d) => d.rule.selectors.filter((s) => !isGlobalSelector(s))))];
    const reduceKeys = reduceSelectors.map(selectorBaseKey);
    const jsChecks = ctx.js.mentions(/prefers-reduced-motion/i);
    const out = [];
    for (const r of css.rules) {
      if (isKeyframes(r) || r.context.startingStyle || inAnyReducedMotion(r)) continue;
      if (!predicateSelectors(r).some(isPanel)) continue;
      const decl = firstMotionDecl(ctx, r);
      if (!decl) continue;
      let guarded;
      if (r.fromStyleAttr) {
        const el = r.fromStyleAttr;
        guarded = html.owns(el) && reduceSelectors.some((s) => html.matches(el, stripStatePseudos(s)) !== false);
      } else {
        guarded = r.selectors.some((s) => {
          const own = selectorBaseKey(s);
          return reduceKeys.some((k) => keyCovers(k, own));
        });
      }
      if (guarded || tokenGuarded(ctx, decl)) continue;
      const finding = {
        node: ctx.ref.css(decl),
        message: `"${r.selectorText}" moves with no prefers-reduced-motion: reduce override`,
        incomplete: !css.complete,
      };
      if (jsChecks) {
        finding.confidence = 'low';
        finding.message += ' (a script reads prefers-reduced-motion; check whether it covers this panel)';
      }
      out.push(finding);
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Exit vs enter
// ---------------------------------------------------------------------------

const OPEN_TOKEN_RE = /(:popover-open|\[open\]|:open|:modal|\.open|\.is-open)(?![\w-])/g;

/** Every selector obtained by removing one top-level open-state token. */
function closedVariants(sel) {
  const parts = compounds(sel);
  const out = [];
  parts.forEach((p, i) => {
    for (const m of p.text.matchAll(OPEN_TOKEN_RE)) {
      if (parenDepthAt(p.text, m.index) > 0) continue;
      const text = p.text.slice(0, m.index) + p.text.slice(m.index + m[0].length);
      if (text === '' || text.startsWith('::') || text.startsWith(':')) continue;
      const next = parts.map((q, j) => (j === i ? { ...q, text } : q));
      out.push(joinCompounds(next));
    }
  });
  return out;
}

const sameScope = (a, b) => JSON.stringify([a.context.media, a.context.supports, a.context.layer, a.context.container])
  === JSON.stringify([b.context.media, b.context.supports, b.context.layer, b.context.container]);

const exitNotFasterThanEnter = panelsRule('exit-not-faster-than-enter', {
  severity: 'minor',
  confidence: 'medium',
  methods: ['css'],
  description: 'A panel closes more slowly than it opens; exits should be as fast as or faster than entries.',
  helpUrl: HELP.motion,
  check(ctx) {
    const { css } = ctx;
    const out = [];
    for (const open of css.rules) {
      if (isKeyframes(open) || open.fromStyleAttr || open.context.startingStyle || inReduce(open)) continue;
      const enter = declaredTransition(ctx, open);
      if (!enter) continue;
      for (const s of open.selectors) {
        if (!isPanel(s)) continue;
        for (const baseSel of closedVariants(s)) {
          for (const base of css.rulesBySelector(baseSel)) {
            if (base === open || base.fromStyleAttr || base.context.startingStyle || inReduce(base) || !sameScope(base, open)) continue;
            const exit = declaredTransition(ctx, base);
            if (!exit || exit.ms <= enter.ms) continue;
            out.push({
              node: ctx.ref.css(exit.decl),
              message: `exit ${fmtMs(exit.ms)}ms > enter ${fmtMs(enter.ms)}ms`,
              data: { exitMs: exit.ms, enterMs: enter.ms, openSelector: s },
            });
          }
        }
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Anchor positioning
// ---------------------------------------------------------------------------

const ANCHOR_SUPPORTS_RE = /anchor|position-area|position-try/i;
const ANCHOR_POLYFILL_RE = /css-anchor-positioning|@oddbird/i;

function hasAnchorPolyfill(ctx) {
  const { html, js } = ctx;
  if (html.byTag('script').some((el) => ANCHOR_POLYFILL_RE.test(html.attr(el, 'src') ?? ''))) return true;
  if (js.imports.some((i) => ANCHOR_POLYFILL_RE.test(i.source))) return true;
  return js.scripts.some((s) => ANCHOR_POLYFILL_RE.test(s.src ?? ''));
}

const anchorNameNoSupports = panelsRule('anchor-name-no-supports', {
  severity: 'moderate',
  confidence: 'high',
  methods: ['css', 'html'],
  description: 'Anchor positioning is used outside @supports and without a polyfill, so browsers without it show an unanchored panel.',
  helpUrl: HELP.anchor,
  check(ctx) {
    const decls = ctx.css.decls.filter((d) => (d.prop === 'anchor-name' || d.prop === 'position-anchor')
      && !isKeyframes(d) && !isOff(d.value) && d.value.trim().toLowerCase() !== 'auto');
    if (!decls.length) return { notApplicable: 'no anchor-name or position-anchor' };
    if (hasAnchorPolyfill(ctx)) return { notApplicable: 'an anchor positioning polyfill is loaded' };
    const seen = new Set();
    const out = [];
    for (const d of decls) {
      if (inSupports(d, ANCHOR_SUPPORTS_RE)) continue;
      const owner = d.rule ?? d.atRule ?? d;
      if (seen.has(owner)) continue;
      seen.add(owner);
      out.push({
        node: ctx.ref.css(d),
        message: `${d.prop} outside @supports (anchor-name: --a) and no polyfill; add a fallback position for older browsers`,
      });
    }
    return out;
  },
});

const staleInsetArea = panelsRule('stale-inset-area', {
  severity: 'minor',
  confidence: 'high',
  methods: ['css'],
  description: 'inset-area is the pre-release name of position-area.',
  helpUrl: HELP.anchor,
  check(ctx) {
    const out = [];
    for (const d of ctx.css.declsByProp('inset-area')) {
      if (isKeyframes(d)) continue;
      const siblings = d.node.parent?.nodes ?? [];
      const hasModern = siblings.some((n) => n.type === 'decl' && String(n.prop).toLowerCase() === 'position-area');
      if (hasModern) continue;
      out.push({ node: ctx.ref.css(d), message: `inset-area: ${d.value} was renamed; use position-area: ${d.value}` });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// max-height without overflow
// ---------------------------------------------------------------------------

const PX_VALUE_RE = /^\d+(\.\d+)?px$/;
const SCROLL_VALUES = new Set(['auto', 'scroll', 'overlay']);

function scrolls(rule) {
  for (const p of ['overflow-y', 'overflow-block']) {
    const d = rule.get(p);
    if (d && SCROLL_VALUES.has(d.value.trim().toLowerCase())) return true;
  }
  const o = rule.get('overflow');
  return Boolean(o) && splitTopLevel(o.value.toLowerCase(), ' ').some((t) => SCROLL_VALUES.has(t));
}

const fixedMaxHeightNoOverflow = panelsRule('fixed-max-height-no-overflow', {
  severity: 'minor',
  confidence: 'medium',
  methods: ['css'],
  description: 'A panel caps its height in px without overflow: auto or scroll, so longer content is clipped or spills out.',
  helpUrl: HELP.overflow,
  check(ctx) {
    const { css } = ctx;
    const out = [];
    for (const r of css.rules) {
      if (isKeyframes(r) || r.context.startingStyle) continue;
      // The panel itself must carry the cap ('.dropdown img { max-height: 40px }' is an icon).
      if (!predicateSubjects(r).some(isPanel)) continue;
      const cap = r.decls.find((d) => (d.prop === 'max-height' || d.prop === 'max-block-size') && PX_VALUE_RE.test(d.value.trim().toLowerCase()));
      if (!cap) continue;
      if (scrolls(r)) continue;
      const own = [r.selectorText, ...r.selectors];
      const same = own.flatMap((s) => css.rulesBySelector(s));
      if (same.some(scrolls)) continue;
      // A scrolling child (".menu .body { overflow: auto }") also handles long content.
      const child = r.fromStyleAttr ? false : css.rules.some((o) => o !== r && !isKeyframes(o) && scrolls(o)
        && o.selectors.some((os) => r.selectors.some((s) => os.startsWith(`${s} `))));
      if (child) continue;
      out.push({
        node: ctx.ref.css(cap),
        message: `${cap.prop}: ${cap.value} without overflow: auto or scroll; taller content is clipped or spills out`,
        data: { maxHeight: cap.value.trim() },
        incomplete: !css.complete,
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Motion tokens
// ---------------------------------------------------------------------------

const motionDurationOffToken = panelsRule('motion-duration-off-token', {
  severity: 'minor',
  confidence: 'high',
  methods: ['css'],
  brand: true,
  description: 'A panel duration is more than 25% away from every brand motion.duration token.',
  helpUrl: HELP.motion,
  check(ctx) {
    const tokens = ctx.budgets.motionDurationsMs;
    if (!tokens) return { notApplicable: 'no brand motion.duration tokens' };
    const list = Object.keys(tokens).sort().map((name) => [name, tokens[name]]).filter(([, v]) => v > 0);
    if (!list.length) return { notApplicable: 'no positive motion.duration tokens' };
    const out = [];
    for (const r of ctx.css.rules) {
      if (isKeyframes(r) || r.context.startingStyle || inReduce(r)) continue;
      if (!predicateSelectors(r).some(isPanel)) continue;
      // On the panel itself every duration counts; on its descendants only
      // motion does ('.menu a { transition: color 80ms }' is a link hover).
      const onPanel = predicateSubjects(r).some(isPanel);
      for (const d of r.decls) {
        if (!DURATION_PROPS.includes(d.prop)) continue;
        let worst = null;
        for (const { ms } of onPanel ? declDurations(ctx, d) : movingEntries(ctx, r, d)) {
          if (ms === null || ms <= 1) continue;
          let best = null;
          for (const [name, t] of list) {
            const dist = Math.abs(ms - t);
            if (!best || dist < best.dist) best = { name, t, dist };
          }
          const off = best.dist / best.t;
          if (off > 0.25 && (!worst || off > worst.off)) worst = { ms, off, ...best };
        }
        if (!worst) continue;
        const pct = Math.round(worst.off * 100);
        out.push({
          node: ctx.ref.css(d),
          message: `${fmtMs(worst.ms)}ms is ${pct}% off ${worst.name}=${fmtMs(worst.t)}ms`,
          data: { durationMs: worst.ms, token: worst.name, tokenMs: worst.t, offPercent: pct },
        });
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// backdrop-filter
// ---------------------------------------------------------------------------

/** The rule's fill color and its source, or null when it cannot be read. */
function fillColor(rule) {
  const bg = rule.get('background-color');
  if (bg) return { prop: bg.prop, color: bg.value.trim() };
  const sh = rule.get('background');
  if (!sh) return null;
  const v = sh.value.trim();
  if (/url\(|gradient\(/i.test(v) || splitTopLevel(v, ',').length > 1) return null;
  const tokens = splitTopLevel(v, ' ');
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (colorAlpha(tokens[i]) !== null) return { prop: 'background', color: tokens[i] };
  }
  return null;
}

const backdropFilterOnOpaqueFill = panelsRule('backdrop-filter-on-opaque-fill', {
  severity: 'moderate',
  confidence: 'high',
  methods: ['css'],
  description: 'backdrop-filter sits behind a fill that is at least 90% opaque, so the blur is invisible but still costs a compositor layer.',
  helpUrl: HELP.backdropFilter,
  check(ctx) {
    const out = [];
    for (const r of ctx.css.rules) {
      if (isKeyframes(r)) continue;
      const bf = backdropFilterDecl(r);
      if (!bf) continue;
      const fill = fillColor(r);
      if (!fill) continue;
      const alpha = colorAlpha(fill.color);
      if (alpha === null || alpha < 0.9) continue;
      out.push({
        node: ctx.ref.css(bf),
        message: `${bf.prop}: ${bf.value} over ${fill.prop}: ${fill.color} (alpha ${alpha}); the blur cannot show through, drop it`,
        data: { alpha, fill: fill.color },
      });
    }
    return out;
  },
});

/** Open-state classes a script usually toggles; removed when the static DOM lacks them. */
const STATE_CLASS_RE = /\.(on|open|is-open|opened|active|is-active|show|shown|visible|is-visible)(?![\w-])/g;

function hasMediaDescendant(html, el) {
  return html.descendants(el, (d) => {
    const t = html.tag(d);
    return t === 'video' || t === 'iframe';
  }).length > 0;
}

const backdropFilterOnVideoModal = panelsRule('backdrop-filter-on-video-modal', {
  severity: 'serious',
  confidence: 'high',
  methods: ['css', 'html'],
  rendered: true,
  description: 'backdrop-filter on a modal that contains a video or iframe, which re-runs the blur on every video frame.',
  helpUrl: HELP.backdropFilter,
  check(ctx) {
    const { css, html } = ctx;
    const out = [];
    for (const r of css.rules) {
      if (isKeyframes(r)) continue;
      const bf = backdropFilterDecl(r);
      if (!bf) continue;
      const containers = [];
      const add = (el) => { if (!containers.includes(el) && hasMediaDescendant(html, el)) containers.push(el); };
      if (r.fromStyleAttr) {
        if (html.owns(r.fromStyleAttr) && predicateSelectors(r).some(isModal)) add(r.fromStyleAttr);
      } else {
        for (const s of r.selectors) {
          if (!isModal(s) || /::backdrop/i.test(s)) continue;
          const plain = stripStatePseudos(s);
          let els = html.querySelectorAll(plain);
          if (!els.length) {
            const loose = plain.replace(STATE_CLASS_RE, '');
            if (loose !== plain && isModal(loose)) els = html.querySelectorAll(loose);
          }
          for (const el of els) add(el);
        }
      }
      if (!containers.length) continue;
      out.push({
        node: ctx.ref.css(bf),
        message: `${bf.prop} on a modal that holds <video> or <iframe> (${html.cssPath(containers[0])}); the blur re-runs every frame`,
        data: { containers: containers.slice(0, 3).map((el) => html.cssPath(el)) },
      });
    }
    return out;
  },
});

function hidesSurface(rule) {
  const display = rule.get('display');
  if (display && display.value.trim().toLowerCase() === 'none') return true;
  const vis = rule.get('visibility');
  if (vis && vis.value.trim().toLowerCase() === 'hidden') return true;
  return ['backdrop-filter', '-webkit-backdrop-filter'].some((p) => {
    const d = rule.get(p);
    return Boolean(d) && d.value.trim().toLowerCase() === 'none';
  });
}

function pageHasModal(ctx) {
  const { html, css } = ctx;
  if (html.byTag('dialog').length || html.byRole('dialog').length || html.byRole('alertdialog').length) return true;
  if (html.withAttr('aria-modal').some((el) => isAriaModal(html, el))) return true;
  return css.rules.some((r) => !isKeyframes(r) && predicateSelectors(r).some(isModal)
    && (parseZIndex(r.get('z-index')?.value) ?? -Infinity) >= 100);
}

const fixedNavBackdropFilterUnderModal = panelsRule('fixed-nav-backdrop-filter-under-modal', {
  severity: 'moderate',
  confidence: 'medium',
  methods: ['css', 'html'],
  description: 'A fixed element keeps its backdrop-filter while a modal covers it, so the blur is recomputed under the modal on every paint.',
  helpUrl: HELP.backdropFilter,
  check(ctx) {
    const { css } = ctx;
    if (!pageHasModal(ctx)) return { notApplicable: 'no modal or dialog on the page' };
    const out = [];
    for (const r of css.rules) {
      if (isKeyframes(r) || r.context.startingStyle) continue;
      const bf = backdropFilterDecl(r);
      if (!bf) continue;
      const preds = predicateSelectors(r);
      if (preds.some((s) => isPanel(s) || /::backdrop/i.test(s))) continue;
      const own = [r.selectorText, ...r.selectors];
      const fixed = [r, ...own.flatMap((s) => css.rulesBySelector(s))]
        .some((x) => x.get('position')?.value.trim().toLowerCase() === 'fixed');
      if (!fixed) continue;
      const navSelectors = r.fromStyleAttr ? [r.selectorText] : r.selectors;
      const unhidden = navSelectors.filter((s) => !css.rules.some((o) => o !== r && !isKeyframes(o)
        && o.selectors.some((os) => os !== s && os.endsWith(` ${s}`)) && hidesSurface(o)));
      if (!unhidden.length) continue;
      out.push({
        node: ctx.ref.css(bf),
        message: `fixed "${unhidden[0]}" keeps ${bf.prop} under an open modal; hide it or set backdrop-filter: none while the modal is open`,
        incomplete: !css.complete,
      });
    }
    return out;
  },
});

export const rules = [
  zIndexOverBudget,
  zIndexLiteralSmell,
  noStartingStyle,
  transitionAllOnPopover,
  motionNoReducedMotionGuard,
  exitNotFasterThanEnter,
  anchorNameNoSupports,
  staleInsetArea,
  fixedMaxHeightNoOverflow,
  motionDurationOffToken,
  backdropFilterOnOpaqueFill,
  backdropFilterOnVideoModal,
  fixedNavBackdropFilterUnderModal,
];

// Exposed for unit tests.
export const _internals = Object.freeze({ isLiteralSmell, isMotionProperty, closedVariants, isGlobalSelector, fillColor });

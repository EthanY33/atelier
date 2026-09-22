/**
 * Mobile rules about the viewport meta, safe areas and the on-screen keyboard.
 */
import {
  fixedBottomCandidates, hasRuleEvidence, viewportOf, viewportRef,
} from './shared.mjs';

const ENV_INSET_RE = /env\(\s*safe-area-inset-/i;
const SAFE_BOTTOM_RE = /(?:env|constant)\(\s*safe-area-inset-bottom/i;
const SAFE_EVIDENCE_PROPS = new Set([
  'padding', 'padding-bottom', 'padding-block', 'padding-block-end',
  'margin', 'margin-bottom', 'margin-block-end',
  'bottom', 'inset', 'inset-block', 'inset-block-end',
  'height', 'min-height', 'block-size',
]);
const NON_TEXT_INPUTS = new Set(['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

const selectorOf = (d) => d.rule?.selectorText ?? 'the element';

export const viewportMetaMissing = {
  id: 'atelier/runtime-ux/viewport-meta-missing',
  area: 'mobile',
  severity: 'serious',
  confidence: 'high',
  methods: ['html'],
  phase: 'static',
  description: 'The page has no viewport meta with width=device-width, so phones lay it out at a 980px desktop width and scale it down.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag',
  check(ctx) {
    const vp = viewportOf(ctx);
    if (!vp.el) {
      return [{ node: viewportRef(ctx, vp), message: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' }];
    }
    const width = vp.props.width;
    if (width === 'device-width') return [];
    // Without a width key, initial-scale makes the layout width follow the device (Chromium and WebKit; Lighthouse accepts it).
    if (width === undefined && vp.props['initial-scale'] !== undefined) return [];
    const why = width === undefined ? 'has no width key' : `sets width=${width}`;
    return [{ node: viewportRef(ctx, vp), message: `The viewport meta ${why}; use width=device-width.`, data: { width: width ?? null } }];
  },
};

export const userScalableNo = {
  id: 'atelier/runtime-ux/user-scalable-no',
  area: 'mobile',
  severity: 'serious',
  confidence: 'high',
  methods: ['html'],
  phase: 'static',
  rendered: true,
  description: 'The viewport meta disables or caps pinch zoom (user-scalable=no or maximum-scale below 2), which fails WCAG 1.4.4 Resize Text.',
  helpUrl: 'https://www.w3.org/TR/WCAG22/#resize-text',
  check(ctx) {
    const vp = viewportOf(ctx);
    if (!vp.el) return { notApplicable: 'no viewport meta' };
    const reasons = [];
    const us = vp.props['user-scalable'];
    if (us !== undefined) {
      const n = Number.parseFloat(us);
      if (us === 'no' || (Number.isFinite(n) && Math.abs(n) < 1)) reasons.push(`user-scalable=${us}`);
    }
    const max = vp.props['maximum-scale'];
    if (max !== undefined) {
      const n = Number.parseFloat(max);
      if (Number.isFinite(n) && n < 2) reasons.push(`maximum-scale=${max}`);
    }
    if (!reasons.length) return [];
    return [{ node: viewportRef(ctx, vp), message: `${reasons.join(' and ')} blocks zooming to 200%; remove it.` }];
  },
};

export const envSafeAreaWithoutViewportFitCover = {
  id: 'atelier/runtime-ux/env-safe-area-without-viewport-fit-cover',
  area: 'mobile',
  severity: 'minor',
  confidence: 'high',
  methods: ['html', 'css'],
  phase: 'static',
  description: 'CSS uses env(safe-area-inset-*) but the viewport meta lacks viewport-fit=cover, so every inset resolves to 0 and the padding is dead code.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/env',
  check(ctx) {
    const envDecls = ctx.css.decls.filter((d) => ENV_INSET_RE.test(d.value));
    if (!envDecls.length) return { notApplicable: 'no env(safe-area-inset-*) in CSS' };
    const vp = viewportOf(ctx);
    if (vp.props['viewport-fit'] === 'cover') return [];
    const first = ctx.ref.css(envDecls[0]);
    const n = envDecls.length;
    return [{
      node: viewportRef(ctx, vp),
      message: `${n} declaration${n === 1 ? '' : 's'} use env(safe-area-inset-*) (first at ${first.location}) but viewport-fit=cover is missing, so the insets are 0.`,
      data: { envDecls: n },
    }];
  },
};

function safeAreaEvidenceRules(ctx) {
  const out = new Set();
  for (const d of ctx.css.decls) {
    if (!d.rule || !SAFE_EVIDENCE_PROPS.has(d.prop) || out.has(d.rule)) continue;
    if (ctx.css.valueMentions(d.value, SAFE_BOTTOM_RE)) out.add(d.rule);
  }
  return out;
}

export const fixedBottomNoSafeArea = {
  id: 'atelier/runtime-ux/fixed-bottom-no-safe-area',
  area: 'mobile',
  severity: 'serious',
  confidence: 'medium',
  methods: ['css', 'html'],
  phase: 'static',
  description: 'A position: fixed element pinned to bottom 0 under viewport-fit=cover never pads for env(safe-area-inset-bottom), so the home indicator overlaps it.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/env',
  check(ctx) {
    const vp = viewportOf(ctx);
    if (vp.props['viewport-fit'] !== 'cover') return { notApplicable: 'viewport-fit is not cover' };
    const evidence = safeAreaEvidenceRules(ctx);
    const out = [];
    for (const c of fixedBottomCandidates(ctx)) {
      if (hasRuleEvidence(ctx, c.rule, evidence, { children: true, descendants: true })) continue;
      out.push({
        node: ctx.ref.css(c.positionDecl),
        message: `${c.rule.selectorText} is fixed at bottom 0 with no env(safe-area-inset-bottom) padding, margin or offset.`,
        incomplete: !ctx.css.complete,
      });
    }
    return out;
  },
};

function isTextEntry(html, el) {
  const tag = html.tag(el);
  if (tag === 'textarea') return true;
  if (tag === 'input') return !NON_TEXT_INPUTS.has(String(html.attr(el, 'type') ?? 'text').trim().toLowerCase());
  const ce = html.attr(el, 'contenteditable');
  return ce !== null && ce.trim().toLowerCase() !== 'false';
}

export const missingInteractiveWidget = {
  id: 'atelier/runtime-ux/missing-interactive-widget',
  area: 'mobile',
  severity: 'minor',
  confidence: 'medium',
  methods: ['html', 'css'],
  phase: 'static',
  rendered: true,
  description: 'A fixed, bottom-anchored bar holds a text field but the viewport meta has no interactive-widget key, so the on-screen keyboard covers it in Chromium.',
  helpUrl: 'https://developer.chrome.com/blog/viewport-resize-behavior',
  check(ctx) {
    const vp = viewportOf(ctx);
    if (!vp.el) return { notApplicable: 'no viewport meta' };
    if (vp.props['interactive-widget'] !== undefined) return [];
    // Pages that move the bar themselves (VisualViewport or VirtualKeyboard API, keyboard-inset env()) handle the keyboard.
    if (ctx.js.mentions(/\bvisualViewport\b|\bvirtualKeyboard\b/) || ctx.css.decls.some((d) => /env\(\s*keyboard-inset-/i.test(d.value))) return [];
    // Walk up from the (few) text fields instead of querying every candidate's subtree.
    const fields = ctx.html.elements.filter((el) => isTextEntry(ctx.html, el));
    if (!fields.length) return [];
    const chains = fields.map((f) => ({ field: f, chain: [f, ...ctx.html.ancestors(f)] }));
    const out = [];
    for (const c of fixedBottomCandidates(ctx)) {
      const inside = c.rule.fromStyleAttr && ctx.html.owns(c.rule.fromStyleAttr)
        ? (chain) => chain.includes(c.rule.fromStyleAttr)
        : (chain) => c.rule.selectors.some((s) => chain.some((el) => ctx.html.matches(el, s) === true));
      const field = chains.find(({ chain }) => inside(chain))?.field ?? null;
      if (!field) continue;
      out.push({
        node: ctx.ref.css(c.positionDecl),
        message: `${selectorOf(c.positionDecl)} is fixed at bottom 0 and holds ${ctx.html.cssPath(field)}; add interactive-widget=resizes-content to the viewport meta.`,
      });
    }
    return out;
  },
};

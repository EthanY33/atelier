/**
 * View Transition API rules: feature checks, reduced-motion overrides,
 * transformed root and duplicate view-transition-name values.
 */
import {
  STATE_PSEUDOS, isRootSelector, parseAnimationList, parseTimeList, splitTopLevel,
} from '../../lib/css-values.mjs';
import { HELP, compareSpecificity, inNoPreference, inReduceMotion, specificity } from './shared.mjs';

const VT_SELECTOR_RE = /::view-transition/i;
const START_VT = 'document.startViewTransition';
const START_VT_RE = /startViewTransition/;
const GLOBAL_KEYWORDS = new Set(['initial', 'inherit', 'unset', 'revert', 'revert-layer']);

const lower = (v) => String(v ?? '').trim().toLowerCase();

/** A style rule (not a keyframe) with a ::view-transition* selector. */
function hasVtSelector(rule) {
  return Boolean(rule) && rule.context.keyframes === null && rule.selectors.some((s) => VT_SELECTOR_RE.test(s));
}

/** Any @view-transition, ::view-transition* rule or startViewTransition call. */
function usesViewTransitions(ctx) {
  return ctx.css.atRulesByName('view-transition').length > 0
    || ctx.css.rules.some(hasVtSelector)
    || ctx.js.callsByCallee(START_VT).length > 0;
}

// ---------------------------------------------------------------------------
// vta-no-feature-check
// ---------------------------------------------------------------------------

/** Name of the function a call sits in, when it is a named declaration or a const/let/var function. */
function wrapperName(call, fn) {
  if (fn.type === 'FunctionDeclaration') return fn.id?.name ?? null;
  const idx = call.ancestors.lastIndexOf(fn);
  const parent = call.ancestors[idx - 1];
  if (parent?.type === 'VariableDeclarator' && parent.init === fn && parent.id.type === 'Identifier') return parent.id.name;
  return null;
}

/**
 * One level of indirection: the call sits in a named helper that is only
 * ever called (never passed around) and every call site is guarded.
 */
function guardedByCallers(js, call, cache) {
  const fn = js.enclosingFunctions(call.ancestors)[0];
  if (!fn || fn.__iife === true) return false;
  // Exported helpers can be called from other modules.
  if (call.ancestors.slice(0, call.ancestors.indexOf(fn)).some((a) => a.type.startsWith('Export'))) return false;
  const name = wrapperName(call, fn);
  if (!name) return false;
  if (!cache.has(call.script)) cache.set(call.script, new Map());
  const perScript = cache.get(call.script);
  if (perScript.has(name)) return perScript.get(name);
  const callers = js.callsByCallee(name).filter((c) => c.script === call.script);
  let ok = callers.length > 0 && callers.every((c) => js.isGuarded(c, START_VT_RE, { tryCounts: true }));
  if (ok) {
    // Any other reference (a callback, an export list) could call it unguarded.
    const calleeNodes = new Set(callers.map((c) => c.node.callee));
    js.walkFunction(call.script.ast, (node, ancestors) => {
      if (!ok) return false;
      if (node.type !== 'Identifier' || node.name !== name || calleeNodes.has(node)) return true;
      const parent = ancestors[ancestors.length - 1];
      if (parent?.type === 'FunctionDeclaration' && parent.id === node) return true;
      if (parent?.type === 'VariableDeclarator' && parent.id === node) return true;
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return true;
      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return true;
      ok = false;
      return false;
    }, { nested: true });
  }
  perScript.set(name, ok);
  return ok;
}

export const vtaNoFeatureCheck = {
  id: 'atelier/runtime-ux/vta-no-feature-check',
  area: 'transitions',
  severity: 'serious',
  confidence: 'high',
  methods: ['js'],
  phase: 'static',
  description: 'document.startViewTransition() is called without checking that the browser supports it.',
  helpUrl: HELP.vtUsing,
  check(ctx) {
    const { js } = ctx;
    const calls = js.callsByCallee(START_VT);
    if (!calls.length) return { notApplicable: 'no startViewTransition calls' };
    const cache = new Map();
    return calls
      .filter((c) => !c.isNew && !c.optional && !js.isGuarded(c, START_VT_RE, { tryCounts: true }) && !guardedByCallers(js, c, cache))
      .map((c) => ({
        node: ctx.ref.js(c),
        message: 'startViewTransition throws where the API is missing; guard it: if (!document.startViewTransition) { update(); return; }',
      }));
  },
};

// ---------------------------------------------------------------------------
// vta-no-reduced-motion-guard
// ---------------------------------------------------------------------------

const MOTION_PROPS = new Set(['animation', 'animation-name', 'animation-duration']);

/** A declaration that removes motion instead of adding it (none, or a duration of 1ms or less). */
function isNeutralAnimation(d) {
  const v = lower(d.value);
  if (GLOBAL_KEYWORDS.has(v)) return true;
  if (v.includes('var(')) return false;
  if (d.prop === 'animation-name') return splitTopLevel(v, ',').every((n) => n === 'none');
  if (d.prop === 'animation-duration') {
    const times = parseTimeList(v);
    return times.length > 0 && times.every((ms) => ms !== null && ms <= 1);
  }
  const list = parseAnimationList(v);
  return list.length > 0 && list.every((a) => a.name === 'none' || (a.durationMs !== null && a.durationMs <= 1));
}

export const vtaNoReducedMotionGuard = {
  id: 'atelier/runtime-ux/vta-no-reduced-motion-guard',
  area: 'transitions',
  severity: 'moderate',
  confidence: 'high',
  methods: ['css', 'js'],
  phase: 'static',
  description: 'View transitions with custom motion have no prefers-reduced-motion: reduce override.',
  helpUrl: HELP.reducedMotion,
  check(ctx) {
    const { css, js } = ctx;
    // Candidates: @view-transition { navigation: auto } ...
    const navCandidates = css.declsByProp('navigation')
      .filter((d) => d.atRule?.name === 'view-transition' && lower(d.value) === 'auto' && !inReduceMotion(d.context));
    // ... and ::view-transition* rules that add motion, one per rule.
    const ruleCandidates = new Map();
    for (const d of css.decls) {
      if (!MOTION_PROPS.has(d.prop) || d.context.startingStyle || !hasVtSelector(d.rule)) continue;
      if (inReduceMotion(d.context) || isNeutralAnimation(d)) continue;
      if (!ruleCandidates.has(d.rule)) ruleCandidates.set(d.rule, []);
      ruleCandidates.get(d.rule).push(d);
    }
    if (!navCandidates.length && !ruleCandidates.size) return { notApplicable: 'no custom view transition CSS' };

    // A page-wide override passes every candidate.
    const cssGuard = css.decls.some((d) => inReduceMotion(d.context) && (hasVtSelector(d.rule)
      || (d.prop === 'navigation' && d.atRule?.name === 'view-transition' && lower(d.value) === 'none')));
    if (cssGuard) return [];
    // Script guards: skip the transition (or never start it) under reduced motion.
    const jsReduce = js.mentions(/prefers-reduced-motion/);
    const jsGuardsSameDoc = jsReduce && js.mentions(/startViewTransition|skipTransition/);
    const jsGuardsNav = jsReduce && js.mentions(/skipTransition/);
    const incomplete = !css.complete || !js.complete;

    const out = [];
    if (!jsGuardsNav) {
      for (const d of navCandidates) {
        if (inNoPreference(d.context)) continue;
        out.push({
          node: ctx.ref.css(d),
          message: 'Cross-document view transitions have no reduced-motion override; add @media (prefers-reduced-motion: reduce) { @view-transition { navigation: none } }.',
          incomplete,
        });
      }
    }
    if (!jsGuardsSameDoc) {
      for (const decls of ruleCandidates.values()) {
        const d = decls.find((x) => !inNoPreference(x.context));
        if (!d) continue;
        out.push({
          node: ctx.ref.css(d),
          message: 'This view transition animation has no reduced-motion override; remove or shorten it under @media (prefers-reduced-motion: reduce).',
          incomplete,
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// vta-root-transformed
// ---------------------------------------------------------------------------

const ROOT_PROPS = ['transform', 'translate', 'rotate', 'scale', 'filter', 'opacity', 'will-change'];
const WILL_CHANGE_TRANSFORM = new Set(['transform', 'translate', 'rotate', 'scale']);

/** Label for a problematic root declaration, or null when it is harmless or unknown (var()). */
function rootProblem(d) {
  const v = lower(d.value);
  if (!v || GLOBAL_KEYWORDS.has(v) || v.includes('var(')) return null;
  switch (d.prop) {
    case 'opacity': {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(v);
      if (!m) return null;
      const n = Number(m[1]) / (m[2] ? 100 : 1);
      return n < 1 ? 'Opacity below 1' : null;
    }
    case 'will-change':
      return splitTopLevel(v, ',').some((t) => WILL_CHANGE_TRANSFORM.has(t)) ? `will-change: ${v}` : null;
    case 'filter':
      return v === 'none' ? null : 'A filter';
    default:
      return v === 'none' ? null : 'A transform';
  }
}

export const vtaRootTransformed = {
  id: 'atelier/runtime-ux/vta-root-transformed',
  area: 'transitions',
  severity: 'moderate',
  confidence: 'high',
  methods: ['css'],
  phase: 'static',
  description: 'The root element has a transform, filter, opacity below 1 or will-change: transform on a page that uses view transitions.',
  helpUrl: HELP.vtUsing,
  check(ctx) {
    if (!usesViewTransitions(ctx)) return { notApplicable: 'no view transitions' };
    const out = [];
    for (const prop of ROOT_PROPS) {
      for (const d of ctx.css.declsByProp(prop)) {
        const r = d.rule;
        if (!r || r.context.keyframes !== null || d.context.keyframes !== null || d.context.startingStyle) continue;
        if (!r.selectors.some(isRootSelector)) continue;
        const label = rootProblem(d);
        if (!label) continue;
        out.push({
          node: ctx.ref.css(d),
          message: `${label} on the root element can break the root view transition snapshot; apply it to an inner wrapper instead.`,
          data: { property: d.prop },
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// vta-duplicate-names
// ---------------------------------------------------------------------------

const NAME_KEYWORDS = new Set(['none', 'auto', 'match-element', ...GLOBAL_KEYWORDS]);
const IDENT_RE = /^-?(?:[A-Za-z_]|[^\x00-\x7f]|\\.)(?:[\w-]|[^\x00-\x7f]|\\.)*$/;
const STATE_SEL_RE = new RegExp(`(^|[^:]):(${STATE_PSEUDOS.join('|')})(?![\\w-])`, 'i');
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);
const NOT_RENDERED = new Set(['head', 'script', 'style', 'template', 'title', 'meta', 'link', 'base', 'noscript']);
const MAX_LISTED = 5;
const UA_ROOT_DECL = Object.freeze({ value: 'root' });

/** The name a declaration assigns, or null for keywords, var() and other non-idents. */
function fixedName(value) {
  const v = String(value ?? '').trim();
  if (!v || NAME_KEYWORDS.has(v.toLowerCase()) || v.includes('(') || !IDENT_RE.test(v)) return null;
  return v;
}

/** Trailing pseudo-element of a selector ('::before'), or ''. */
function pseudoElementOf(sel) {
  const m = /(::?)([A-Za-z-]+)(\([^)]*\))?$/.exec(sel);
  if (!m) return '';
  const name = m[2].toLowerCase();
  if (m[1] === '::') return `::${name}${m[3] ?? ''}`;
  return LEGACY_PSEUDO_ELEMENTS.has(name) ? `::${name}` : '';
}

/**
 * Elements that generate no box before any script runs: non-rendered tags,
 * [hidden], [popover], closed <dialog>, closed <details> content, and
 * everything inside them.
 */
function hiddenChecker(html) {
  const memo = new Map();
  const selfHidden = (el) => {
    const tag = html.tag(el);
    if (NOT_RENDERED.has(tag) || html.hasAttr(el, 'hidden') || html.hasAttr(el, 'popover')) return true;
    if (tag === 'dialog' && !html.hasAttr(el, 'open')) return true;
    const p = html.parent(el);
    if (p && html.tag(p) === 'details' && !html.hasAttr(p, 'open')) {
      const summary = html.children(p).find((c) => html.tag(c) === 'summary');
      return summary !== el;
    }
    return false;
  };
  return (el) => {
    const chain = [];
    let result = false;
    for (let cur = el; cur; cur = html.parent(cur)) {
      if (memo.has(cur)) { result = memo.get(cur); break; }
      chain.push(cur);
      if (selfHidden(cur)) { result = true; break; }
    }
    for (const c of chain) memo.set(c, result);
    return result;
  };
}

/** Media and container conditions of a declaration (outer to inner). */
function conditionsOf(d) {
  return [...d.context.media, ...d.context.container.map((c) => `container ${c}`)];
}

/**
 * Static duplicates: resolve the winning view-transition-name per element
 * (importance, layers, inline style, specificity, order) for the base
 * conditions and for each distinct media/container condition set, then
 * group the fixed names.
 * @returns {Array<{ name: string, decl: object, labels: string[], count: number, conditions: string[] }>}
 */
function staticDuplicates(ctx) {
  const { css, html } = ctx;
  const decls = css.declsByProp('view-transition-name')
    .filter((d) => d.rule && d.context.keyframes === null && !d.context.startingStyle);
  if (!decls.some((d) => fixedName(d.value))) return [];

  const isHidden = hiddenChecker(html);
  const entries = [];
  decls.forEach((d, order) => {
    const layered = d.context.layer.length > 0;
    const base = [d.important ? 1 : 0, d.important === layered ? 1 : 0];
    const found = new Map(); // el -> Map(pseudo -> specificity)
    const add = (el, pseudo, spec) => {
      if (isHidden(el)) return;
      if (!found.has(el)) found.set(el, new Map());
      const prev = found.get(el).get(pseudo);
      if (!prev || compareSpecificity(spec, prev) > 0) found.get(el).set(pseudo, spec);
    };
    if (d.rule.fromStyleAttr) add(d.rule.fromStyleAttr, '', [Infinity, 0, 0]);
    else {
      for (const sel of d.rule.selectors) {
        if (STATE_SEL_RE.test(sel) || VT_SELECTOR_RE.test(sel)) continue;
        const pseudo = pseudoElementOf(sel);
        const spec = specificity(sel);
        for (const el of html.querySelectorAll(sel)) add(el, pseudo, spec);
      }
    }
    for (const [el, byPseudo] of found) {
      for (const [pseudo, spec] of byPseudo) entries.push({ el, pseudo, decl: d, rank: [...base, ...spec, order], conds: conditionsOf(d) });
    }
  });
  // The UA stylesheet names the root element 'root' (:root { view-transition-name: root }).
  const rootEl = html.byTag('html')[0];
  if (rootEl && decls.some((d) => fixedName(d.value) === 'root')) {
    entries.unshift({ el: rootEl, pseudo: '', decl: UA_ROOT_DECL, rank: [0, -1, 0, 0, 0, -1], conds: [] });
  }

  const scenarios = [[]];
  const seenKeys = new Set(['']);
  for (const d of decls) {
    const conds = conditionsOf(d);
    const key = [...conds].sort().join(' && ');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    scenarios.push(conds);
  }
  const cmpRank = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };

  const reported = new Set();
  const out = [];
  for (const scenario of scenarios) {
    const active = new Set(scenario);
    const winners = new Map(); // el -> Map(pseudo -> entry)
    for (const e of entries) {
      if (!e.conds.every((c) => active.has(c))) continue;
      if (!winners.has(e.el)) winners.set(e.el, new Map());
      const cur = winners.get(e.el).get(e.pseudo);
      if (!cur || cmpRank(e.rank, cur.rank) >= 0) winners.get(e.el).set(e.pseudo, e);
    }
    const byName = new Map();
    for (const byPseudo of winners.values()) {
      for (const e of byPseudo.values()) {
        const name = fixedName(e.decl.value);
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(e);
      }
    }
    for (const [name, list] of byName) {
      if (list.length < 2 || reported.has(name)) continue;
      reported.add(name);
      const sorted = [...list].sort((a, b) => (html.indexOf(a.el) - html.indexOf(b.el)) || (a.pseudo < b.pseudo ? -1 : a.pseudo > b.pseudo ? 1 : 0));
      const authored = list.filter((e) => e.decl !== UA_ROOT_DECL);
      const first = authored.reduce((m, e) => (e.rank[e.rank.length - 1] < m.rank[m.rank.length - 1] ? e : m), authored[0]);
      out.push({
        name,
        decl: first.decl,
        labels: sorted.slice(0, MAX_LISTED).map((e) => `${html.cssPath(e.el)}${e.pseudo}`),
        count: list.length,
        conditions: scenario,
      });
    }
  }
  return out;
}

export const vtaDuplicateNames = {
  id: 'atelier/runtime-ux/vta-duplicate-names',
  area: 'transitions',
  severity: 'serious',
  confidence: 'medium',
  methods: ['css', 'html', 'dom'],
  phase: 'static',
  description: 'The same view-transition-name is set on more than one element, which makes the browser skip the transition.',
  helpUrl: HELP.vtName,
  check(ctx) {
    const sweep = ctx.dynamic?.sweep ?? null;
    const runtime = sweep && Array.isArray(sweep.viewTransitionNames) ? sweep.viewTransitionNames : null;
    const runtimeNames = new Set((runtime ?? []).map((e) => String(e?.name ?? '')));
    const hasDecls = ctx.css.declsByProp('view-transition-name').length > 0;
    if (!hasDecls && !runtimeNames.size) return { notApplicable: 'no view-transition-name declarations' };

    const out = [];
    for (const dup of staticDuplicates(ctx)) {
      if (runtimeNames.has(dup.name)) continue;
      const data = { count: dup.count, elements: dup.labels, name: dup.name };
      if (dup.conditions.length) data.conditions = dup.conditions.join(' and ');
      const finding = {
        node: ctx.ref.css(dup.decl),
        message: `view-transition-name "${dup.name}" is on ${dup.count} elements; names must be unique, or the browser skips the transition.`,
        data,
      };
      // The runtime sweep ran and did not see this duplicate (hidden at load, or another viewport).
      if (runtime) {
        finding.confidence = 'low';
        finding.message = `view-transition-name "${dup.name}" is on ${dup.count} elements in the CSS, but not on 2 rendered boxes at runtime (Pixel 7).`;
      }
      out.push(finding);
    }
    for (const e of runtime ?? []) {
      const name = String(e?.name ?? '');
      if (!name) continue;
      const selectors = Array.isArray(e.selectors) ? e.selectors.map(String).slice(0, MAX_LISTED) : [];
      out.push({
        node: ctx.ref.dynamic({ selector: selectors[0] ?? 'document', snippet: `view-transition-name: ${name}` }),
        message: `view-transition-name "${name}" is on more than one rendered element, so the browser skips the transition.`,
        confidence: 'high',
        data: { elements: selectors, name },
      });
    }
    return out;
  },
};

export const rules = [vtaNoFeatureCheck, vtaNoReducedMotionGuard, vtaRootTransformed, vtaDuplicateNames];

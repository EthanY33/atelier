/**
 * inp rules about field measurement (RUM): web-vitals without onINP, and the
 * Long Tasks API without Long Animation Frames.
 */
import { defineRule, objectProp, sourceWithoutComments, stringValue, unwrap, cmp } from './shared.mjs';

// ---------------------------------------------------------------------------
// missing-webvitals-oninp
// ---------------------------------------------------------------------------

// npm and CDN specifiers (web-vitals, web-vitals/attribution, .../web-vitals@4?module)
// plus vendored builds (web-vitals.js, web-vitals.attribution.iife.js).
const WEB_VITALS_SOURCE_RE = /(^|\/)web-vitals(@[^/?#]*)?(\/|\.(?:[\w-]+\.)*m?js(?=$|[?#])|[?#]|$)/;
const OTHER_METRICS = new Set(['onLCP', 'onCLS', 'onFCP', 'onTTFB', 'onFID', 'getLCP', 'getCLS', 'getFID', 'getFCP', 'getTTFB']);
const INP_NAMES = new Set(['onINP', 'getINP']);
const METRIC_NAME_RE = /\b(?:on|get)(?:LCP|CLS|FCP|TTFB|FID|INP)\b/g;
const UMD_RE = /^webVitals\.([A-Za-z]+)$/;

export const missingWebVitalsOnInp = defineRule({
  id: 'missing-webvitals-oninp',
  severity: 'moderate',
  confidence: 'high',
  methods: ['js'],
  description: 'The page reports Core Web Vitals with web-vitals but never registers onINP, so field responsiveness is not measured.',
  helpUrl: 'https://www.npmjs.com/package/web-vitals',
  check(ctx) {
    const { js } = ctx;
    const used = new Set();
    const evidence = [];
    const namespaces = new Map(); // script -> Set(local)
    const scanned = new Set();
    const scan = (script) => {
      // Names reached through destructuring, dynamic import(), require() or
      // re-exports have no specifier list; read them from the source.
      if (scanned.has(script)) return;
      scanned.add(script);
      for (const m of sourceWithoutComments(script).matchAll(METRIC_NAME_RE)) used.add(m[0]);
    };
    for (const imp of js.imports) {
      if (!WEB_VITALS_SOURCE_RE.test(imp.source)) continue;
      evidence.push(imp);
      for (const s of imp.specifiers) {
        if (s.imported === '*' || s.imported === 'default') {
          if (!namespaces.has(imp.script)) namespaces.set(imp.script, new Set());
          namespaces.get(imp.script).add(s.local);
        } else {
          used.add(s.imported);
        }
      }
      if (imp.kind !== 'static' || imp.specifiers.length === 0) scan(imp.script);
    }
    for (const call of js.calls) {
      const umd = UMD_RE.exec(call.callee);
      if (umd) {
        used.add(umd[1]);
        evidence.push(call);
        continue;
      }
      const locals = namespaces.get(call.script);
      const dot = call.callee.indexOf('.');
      if (locals && dot > 0 && locals.has(call.callee.slice(0, dot))) used.add(call.callee.slice(dot + 1));
    }
    if (!evidence.length) return { notApplicable: 'no web-vitals usage' };
    if ([...INP_NAMES].some((n) => used.has(n))) return [];
    const others = [...used].filter((n) => OTHER_METRICS.has(n)).sort(cmp);
    if (!others.length) return [];
    return [{
      node: ctx.ref.js(evidence[0]),
      message: `web-vitals reports ${others.join(', ')} but never onINP; add onINP (the attribution build also reports long animation frames).`,
      incomplete: !js.complete,
      data: { metrics: others },
    }];
  },
});

// ---------------------------------------------------------------------------
// longtask-without-loaf
// ---------------------------------------------------------------------------

function observesLongTask(call) {
  const arg = unwrap(call.args[0]);
  if (arg?.type !== 'ObjectExpression') return false;
  const type = objectProp(arg, 'type');
  if (type.found && stringValue(type.value) === 'longtask') return true;
  const types = objectProp(arg, 'entryTypes');
  const list = unwrap(types.value);
  return types.found && list?.type === 'ArrayExpression' && list.elements.some((e) => stringValue(e) === 'longtask');
}

export const longtaskWithoutLoaf = defineRule({
  id: 'longtask-without-loaf',
  severity: 'minor',
  confidence: 'high',
  methods: ['js'],
  description: 'A PerformanceObserver watches longtask entries with no long-animation-frame observer, so slow frames are not attributed to scripts.',
  helpUrl: 'https://developer.chrome.com/docs/web-platform/long-animation-frames',
  check(ctx) {
    const { js } = ctx;
    const calls = js.callsByMethod('observe').filter((c) => !c.isNew && observesLongTask(c));
    if (!calls.length) return { notApplicable: 'no longtask observer' };
    if (js.stringLiterals('long-animation-frame').length) return [];
    return calls.map((call) => ({
      node: ctx.ref.js(call),
      message: "Observes 'longtask' only; also observe 'long-animation-frame' (LoAF), which names the scripts and forced layout behind slow frames.",
      incomplete: !js.complete,
    }));
  },
});

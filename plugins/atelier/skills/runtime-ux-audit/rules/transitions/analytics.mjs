/**
 * Analytics page views sent at script start without a prerendering check.
 * gtag() is left out: Google's tag library already holds hits until a
 * prerendered page is activated.
 */
import { HELP, stringValue } from './shared.mjs';

const PRERENDER_RE = /\bprerendering\b|prerenderingchange/;

function keyName(p) {
  if (p.type !== 'Property' || p.computed) return null;
  if (p.key.type === 'Identifier') return p.key.name;
  return typeof p.key.value === 'string' ? p.key.value : null;
}

/** ga('send', 'pageview') or ga('send', { hitType: 'pageview' }). */
function isPageviewHit(node) {
  if (String(stringValue(node) ?? '').toLowerCase() === 'pageview') return true;
  return node?.type === 'ObjectExpression'
    && node.properties.some((p) => keyName(p) === 'hitType' && String(stringValue(p.value) ?? '').toLowerCase() === 'pageview');
}

/** Known page-view calls: [CallInfo, label]. */
function pageViewCalls(js) {
  const hits = [];
  for (const c of js.callsByCallee('fbq')) {
    if (stringValue(c.args[0]) === 'track') hits.push([c, 'fbq("track")']);
  }
  for (const c of js.callsByCallee('_paq.push')) {
    const a = c.args[0];
    if (a?.type === 'ArrayExpression' && stringValue(a.elements[0]) === 'trackPageView') hits.push([c, '_paq.push(["trackPageView"])']);
  }
  for (const c of js.callsByCallee('ga')) {
    if (/^([\w-]+\.)?send$/.test(stringValue(c.args[0]) ?? '') && isPageviewHit(c.args[1])) hits.push([c, 'ga("send", "pageview")']);
  }
  for (const c of js.callsByCallee('analytics.page')) hits.push([c, 'analytics.page()']);
  return hits.filter(([c]) => !c.isNew);
}

export const analyticsWithoutPrerenderGuard = {
  id: 'atelier/runtime-ux/analytics-without-prerender-guard',
  area: 'transitions',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js'],
  phase: 'static',
  description: 'Analytics send a page view at script start without checking document.prerendering, so prerendered pages that are never viewed are counted.',
  helpUrl: HELP.prerendering,
  check(ctx) {
    const { js } = ctx;
    const hits = pageViewCalls(js);
    if (!hits.length) return { notApplicable: 'no known analytics page view calls' };
    if (js.mentions(PRERENDER_RE)) return [];
    const incomplete = !js.complete;
    return hits
      .filter(([c]) => c.topLevel)
      .map(([c, label]) => ({
        node: ctx.ref.js(c),
        message: `${label} runs at script start, so prerendered pages that are never viewed are counted; send it once document.prerendering is false (prerenderingchange).`,
        incomplete,
      }));
  },
};

export const rules = [analyticsWithoutPrerenderGuard];

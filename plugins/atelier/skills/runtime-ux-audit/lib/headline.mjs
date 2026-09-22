/**
 * Headline groups for the report table: area -> [{ label, ruleIds }].
 * Counts are instances of failed rules in each group.
 */
import { AREAS, toFullRuleId } from './options.mjs';

const g = (label, ids) => Object.freeze({ label, ruleIds: Object.freeze(ids.map(toFullRuleId)) });

export const HEADLINES = Object.freeze({
  transitions: Object.freeze([
    g('bfcache blockers', ['no-unload-handler', 'no-beforeunload-always-attached', 'cache-control-no-store-on-html', 'bfcache-not-restored']),
    g('view-transition gaps', ['vta-no-feature-check', 'vta-no-reduced-motion-guard', 'vta-root-transformed', 'vta-duplicate-names']),
    g('speculation rules', ['speculation-rules-immediate-abuse', 'speculation-rules-csp-gap']),
    g('prerender analytics', ['analytics-without-prerender-guard']),
  ]),
  inp: Object.freeze([
    g('non-passive listeners', ['non-passive-scroll-listener']),
    g('main-thread smells', ['settimeout-zero-as-yield', 'click-handler-forced-layout', 'scroll-listener-animates-transform', 'no-sync-xhr', 'requestidlecallback-no-timeout', 'mouse-and-touch-pair']),
    g('long scripts', ['loaf-long-script']),
    g('RUM gaps', ['missing-webvitals-oninp', 'longtask-without-loaf']),
  ]),
  panels: Object.freeze([
    g('z-index smells', ['z-index-over-budget', 'z-index-literal-smell']),
    g('dialog semantics', ['dialog-missing-label', 'div-role-dialog', 'backdrop-as-sibling-div', 'destructive-dialog-closedby-any', 'inert-with-showmodal', 'focus-lost-after-close', 'focus-trap-library-near-dialog']),
    g('popover/menu behavior', ['custom-outside-click-on-auto-popover', 'custom-escape-on-dialog-popover', 'tooltip-focusable', 'menu-no-arrow-keys']),
    g('motion gaps', ['no-starting-style-on-transitioned-popover', 'transition-all-on-popover', 'motion-no-reduced-motion-guard', 'exit-not-faster-than-enter', 'motion-duration-off-token']),
    g('compositor costs', ['backdrop-filter-on-opaque-fill', 'backdrop-filter-on-video-modal', 'fixed-nav-backdrop-filter-under-modal']),
  ]),
  mobile: Object.freeze([
    g('tap targets under {minTapPx}px', ['tap-target-under-minimum']),
    g('vh without dvh', ['uses-vh-without-dvh', 'fixed-header-vh-sized']),
    g('safe-area gaps', ['env-safe-area-without-viewport-fit-cover', 'fixed-bottom-no-safe-area', 'missing-interactive-widget']),
    g('touch/scroll hijacks', ['non-passive-touch-listener', 'scroll-hijack', 'double-tap-js-override']),
    g('viewport meta', ['viewport-meta-missing', 'user-scalable-no']),
    g('PWA', ['pwa-no-apple-touch-icon', 'push-permission-no-display-mode-guard']),
  ]),
});

/** Every rule id named in HEADLINES. */
export function headlineRuleIds() {
  return AREAS.flatMap((a) => HEADLINES[a].flatMap((h) => h.ruleIds));
}

/**
 * Instance counts per headline group.
 * @param {object[]} violations - runner violations
 * @param {{ minTapPx: number }} budgets
 * @param {string[]} areas
 * @returns {Record<string, Record<string, number>>}
 */
export function computeHighlights(violations, budgets, areas) {
  const instances = new Map();
  for (const v of violations) instances.set(v.ruleId, v.nodes.length + (v.nodesTruncated ?? 0));
  const out = {};
  for (const area of AREAS) {
    if (!areas.includes(area)) continue;
    const row = {};
    for (const h of HEADLINES[area]) {
      const label = h.label.replace('{minTapPx}', String(budgets.minTapPx));
      row[label] = h.ruleIds.reduce((n, id) => n + (instances.get(id) ?? 0), 0);
    }
    out[area] = row;
  }
  return out;
}

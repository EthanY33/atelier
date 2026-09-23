/**
 * The shipped rule registry against its documentation: SKILL.md lists every
 * rule with its severity, HEADLINES groups exactly the ids the design names,
 * and the deferred rules stay out of the registry.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { HEADLINES, headlineRuleIds } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import { AREAS, toShortRuleId } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';
import { REPO_ROOT, SKILL_DIR } from './helpers.mjs';

const SKILL_MD = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const SPEC = readFileSync(join(REPO_ROOT, 'docs', 'specs', 'runtime-ux-audit.md'), 'utf8').replace(/\r\n/g, '\n');

/** Rows of the per-area rule tables in SKILL.md: { id, dynamic, http, severity }. */
function documentedRules() {
  const section = SKILL_MD.slice(SKILL_MD.indexOf('## Rules'), SKILL_MD.indexOf('## Notes'));
  const rows = [];
  for (const line of section.split('\n')) {
    const m = /^\| ([a-z0-9-]+)( \(d\))?( \(h\))? \| (critical|serious|moderate|minor) \| [^|]+ \|$/.exec(line);
    if (m) rows.push({ id: m[1], dynamic: Boolean(m[2]), http: Boolean(m[3]), severity: m[4] });
  }
  return rows;
}

// The HEADLINES table from the design (reportFormat), in short ids.
const DESIGN_HEADLINES = {
  transitions: {
    'bfcache blockers': ['no-unload-handler', 'no-beforeunload-always-attached', 'cache-control-no-store-on-html', 'bfcache-not-restored'],
    'view-transition gaps': ['vta-no-feature-check', 'vta-no-reduced-motion-guard', 'vta-root-transformed', 'vta-duplicate-names'],
    'speculation rules': ['speculation-rules-immediate-abuse', 'speculation-rules-csp-gap'],
    'prerender analytics': ['analytics-without-prerender-guard'],
  },
  inp: {
    'non-passive listeners': ['non-passive-scroll-listener'],
    'main-thread smells': ['settimeout-zero-as-yield', 'click-handler-forced-layout', 'scroll-listener-animates-transform', 'no-sync-xhr', 'requestidlecallback-no-timeout', 'mouse-and-touch-pair'],
    'long scripts': ['loaf-long-script'],
    'RUM gaps': ['missing-webvitals-oninp', 'longtask-without-loaf'],
  },
  panels: {
    'z-index smells': ['z-index-over-budget', 'z-index-literal-smell'],
    'dialog semantics': ['dialog-missing-label', 'div-role-dialog', 'backdrop-as-sibling-div', 'destructive-dialog-closedby-any', 'inert-with-showmodal', 'focus-lost-after-close', 'focus-trap-library-near-dialog'],
    'popover/menu behavior': ['custom-outside-click-on-auto-popover', 'custom-escape-on-dialog-popover', 'tooltip-focusable', 'menu-no-arrow-keys'],
    'motion gaps': ['no-starting-style-on-transitioned-popover', 'transition-all-on-popover', 'motion-no-reduced-motion-guard', 'exit-not-faster-than-enter', 'motion-duration-off-token'],
    'compositor costs': ['backdrop-filter-on-opaque-fill', 'backdrop-filter-on-video-modal', 'fixed-nav-backdrop-filter-under-modal'],
  },
  mobile: {
    'tap targets under {minTapPx}px': ['tap-target-under-minimum'],
    'vh without dvh': ['uses-vh-without-dvh', 'fixed-header-vh-sized'],
    'safe-area gaps': ['env-safe-area-without-viewport-fit-cover', 'fixed-bottom-no-safe-area', 'missing-interactive-widget'],
    'touch/scroll hijacks': ['non-passive-touch-listener', 'scroll-hijack', 'double-tap-js-override'],
    'viewport meta': ['viewport-meta-missing', 'user-scalable-no'],
    PWA: ['pwa-no-apple-touch-icon', 'push-permission-no-display-mode-guard'],
  },
};

// Rules the design ships without a headline group (INP est. has its own cell).
const NO_HEADLINE = [
  'anchor-name-no-supports', 'carousel-no-scroll-snap', 'fixed-max-height-no-overflow', 'framework-hydration-on-static-page',
  'hover-only-affordance', 'inp-estimate-over-budget', 'missing-content-visibility', 'modal-no-overscroll-behavior',
  'stale-inset-area', 'webkit-overflow-scrolling-touch',
];

const DEFERRED = [
  'prefer-pageshow-for-restore', 'close-idb-on-pagehide', 'sync-large-json-parse', 'combobox-focus-in-listbox',
  'video-missing-gpu-hint-in-modal', 'tap-targets-spacing-under-24', 'missing-touch-action-manipulation',
  'pwa-manifest-no-display-override', 'sw-no-fetch-handler',
];
const ADDED = ['no-sync-xhr', 'viewport-meta-missing'];

describe('rule registry', () => {
  it('ships 65 rules with unique ids: 11 transitions, 13 inp, 24 panels, 17 mobile', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(65);
    expect(AREAS.map((a) => RULES.filter((r) => r.area === a).length)).toEqual([11, 13, 24, 17]);
  });

  it('keeps the deferred rules out and ships the two added ones', () => {
    const shorts = RULES.map((r) => toShortRuleId(r.id));
    for (const id of DEFERRED) expect(shorts, id).not.toContain(id);
    for (const id of ADDED) expect(shorts, id).toContain(id);
  });
});

describe('SKILL.md', () => {
  it('documents every shipped rule once, with its severity, area and dynamic or http marker', () => {
    const rows = documentedRules();
    expect(rows.map((r) => r.id).sort()).toEqual(RULES.map((r) => toShortRuleId(r.id)).sort());
    for (const rule of RULES) {
      const row = rows.find((r) => r.id === toShortRuleId(rule.id));
      expect(row.severity, row.id).toBe(rule.severity);
      expect(row.dynamic, row.id).toBe(rule.phase === 'dynamic');
      expect(row.http, row.id).toBe(Boolean(rule.requires?.includes('http')));
    }
    // Each area table lists its own rules.
    const section = SKILL_MD.slice(SKILL_MD.indexOf('## Rules'), SKILL_MD.indexOf('## Notes'));
    const tables = section.split(/\n(?=Transitions:|INP:|Panels:|Mobile:)/).slice(1);
    expect(tables).toHaveLength(4);
    tables.forEach((table, i) => {
      const inTable = [...table.matchAll(/^\| ([a-z0-9-]+)/gm)].map((m) => m[1]).filter((id) => id !== 'rule');
      expect(inTable.sort(), AREAS[i]).toEqual(RULES.filter((r) => r.area === AREAS[i]).map((r) => toShortRuleId(r.id)).sort());
    });
  });

  it('has the frontmatter the plugin loader needs, in plain ASCII without long dashes', () => {
    const fm = /^---\nname: runtime-ux-audit\ndescription: (.+)\n---\n/.exec(SKILL_MD);
    expect(fm).not.toBeNull();
    expect(fm[1].length).toBeLessThanOrEqual(400);
    expect([...SKILL_MD].filter((c) => c.charCodeAt(0) > 0x7e)).toEqual([]);
    expect(SKILL_MD).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" ux');
    expect(SKILL_MD).toContain('"${CLAUDE_SKILL_DIR}/index.mjs"');
    expect(SKILL_MD).not.toMatch(/plugins\/atelier\/|scripts\//);
  });
});

describe('HEADLINES', () => {
  it('groups exactly the rule ids the design names, in its order', () => {
    const actual = Object.fromEntries(AREAS.map((a) => [a, Object.fromEntries(HEADLINES[a].map((h) => [h.label, h.ruleIds.map(toShortRuleId)]))]));
    expect(actual).toEqual(DESIGN_HEADLINES);
  });

  it('names only shipped rules, each once, and leaves out only the rules without a group', () => {
    const ids = headlineRuleIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(RULES.some((r) => r.id === id), id).toBe(true);
    for (const a of AREAS) {
      for (const h of HEADLINES[a]) for (const id of h.ruleIds) expect(RULES.find((r) => r.id === id).area, id).toBe(a);
    }
    const left = RULES.map((r) => r.id).filter((id) => !ids.includes(id)).map(toShortRuleId).sort();
    expect(left).toEqual(NO_HEADLINE);
  });
});

describe('spec', () => {
  it('records the 1.0 implementation deviations, including every deferred and added rule', () => {
    const at = SPEC.indexOf('## Implementation deviations (1.0)');
    expect(at).toBeGreaterThan(0);
    const section = SPEC.slice(at);
    for (const id of [...DEFERRED, ...ADDED]) expect(section, id).toContain(`\`${id}\``);
  });
});

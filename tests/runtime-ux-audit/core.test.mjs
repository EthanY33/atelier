import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FIXED_TS, FIXTURES_DIR, SKILL_DIR, contextFor, runRule, runFixture, expectGolden, rawJson,
  expectAsciiNoDash, tempDir, writeFiles, withServer, readFixtureJson,
} from './helpers.mjs';
import { auditRuntimeUx, RULES, UxAuditError } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { runRules, validateRule, RULE_ID_RE } from '../../plugins/atelier/skills/runtime-ux-audit/lib/runner.mjs';
import { HEADLINES, headlineRuleIds, computeHighlights } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import { DEFAULT_BUDGETS, loadBrand, resolveBudgets } from '../../plugins/atelier/skills/runtime-ux-audit/lib/budgets.mjs';
import { AREAS, USAGE, normalizeOptions, toFullRuleId, toShortRuleId } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';
import { findUnitValues } from '../../plugins/atelier/skills/runtime-ux-audit/lib/css-values.mjs';
import { parseIgnoreIds } from '../../plugins/atelier/skills/runtime-ux-audit/lib/suppress.mjs';
import { code } from '../../plugins/atelier/skills/runtime-ux-audit/lib/report-md.mjs';
import { rules as transitionsRules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/index.mjs';
import { rules as inpRules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/inp/index.mjs';
import { rules as panelsRules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/panels/index.mjs';
import { rules as mobileRules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/mobile/index.mjs';

// ---------------------------------------------------------------------------
// Fake rules (test-local). They exercise every runner path and the report.
// ---------------------------------------------------------------------------

const base = { confidence: 'high', phase: 'static', description: 'Fake rule for the core tests.', helpUrl: 'https://example.com/help' };
const rule = (id, extra) => ({ ...base, id: `atelier/runtime-ux/${id}`, ...extra });

const FAKE_RULES = [
  rule('fake-js-unload', {
    area: 'transitions', severity: 'critical', methods: ['js'],
    check: (ctx) => ctx.js.listenersByEvent('unload').filter((l) => l.target === 'window' && l.via !== 'attribute')
      .map((l) => ({ node: ctx.ref.js(l), message: `unload listener via ${l.via}` })),
  }),
  rule('fake-body-attr', {
    area: 'transitions', severity: 'moderate', methods: ['html'],
    check: (ctx) => ctx.html.eventAttrs.filter((a) => a.name === 'onunload').map((a) => ({ node: ctx.ref.html(a.el, 'onunload') })),
  }),
  rule('fake-css-height', {
    area: 'mobile', severity: 'serious', methods: ['css'],
    check: (ctx) => ['height', 'min-height'].flatMap((p) => ctx.css.declsByProp(p))
      .filter((d) => findUnitValues(d.value, 'vh').some((n) => n >= 90))
      .map((d) => ({ node: ctx.ref.css(d), data: { vh: Math.max(...findUnitValues(d.value, 'vh')) } })),
  }),
  rule('fake-absence', {
    area: 'inp', severity: 'moderate', methods: ['js'], confidence: 'low',
    check: (ctx) => (ctx.js.mentions(/scheduler\.yield/) ? [] : [{ node: ctx.ref.page('scripts', 'no scheduler.yield() anywhere'), incomplete: !ctx.js.complete }]),
  }),
  rule('fake-html-item', {
    area: 'panels', severity: 'minor', methods: ['html'], rendered: true,
    check: (ctx) => ctx.html.querySelectorAll('.item').map((el) => ({ node: ctx.ref.html(el), message: `item ${ctx.html.text(el)}` })),
  }),
  rule('fake-z-index', {
    area: 'panels', severity: 'moderate', methods: ['css'],
    check: (ctx) => ctx.css.declsByProp('z-index').filter((d) => Number(d.value) > ctx.budgets.zIndexMax)
      .map((d) => ({ node: ctx.ref.css(d), message: `${d.value} > ${ctx.budgets.zIndexMax}`, confidence: 'medium' })),
  }),
  rule('fake-na', { area: 'panels', severity: 'moderate', methods: ['html'], check: () => ({ notApplicable: 'no popovers' }) }),
  rule('fake-dynamic', { area: 'inp', severity: 'serious', methods: ['trace'], phase: 'dynamic', check: () => [] }),
  rule('fake-http', { area: 'transitions', severity: 'moderate', methods: ['headers'], requires: ['http'], check: () => [] }),
  rule('fake-throws', { area: 'mobile', severity: 'minor', methods: ['css'], check: () => { throw new Error('boom'); } }),
  rule('fake-pass', { area: 'transitions', severity: 'minor', methods: ['html'], check: () => [] }),
  rule('fake-ignored', { area: 'mobile', severity: 'critical', methods: ['html'], check: (ctx) => [{ node: ctx.ref.page('document', 'x') }] }),
];

const auditCore = (extra = {}) => runFixture('core', { rules: FAKE_RULES, ignore: ['fake-ignored'], ...extra });

// ---------------------------------------------------------------------------

describe('registry', () => {
  const byDir = { transitions: transitionsRules, inp: inpRules, panels: panelsRules, mobile: mobileRules };

  it('is frozen and every rule is valid, prefixed and unique', () => {
    expect(Object.isFrozen(RULES)).toBe(true);
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(validateRule(r), r.id).toEqual([]);
      expect(r.id).toMatch(RULE_ID_RE);
      expectAsciiNoDash(r.description, `${r.id} description`);
    }
  });

  it('keeps each rule in the directory of its area', () => {
    for (const [area, list] of Object.entries(byDir)) {
      expect(Array.isArray(list)).toBe(true);
      for (const r of list) expect(r.area, r.id).toBe(area);
    }
    expect(RULES.length).toBe(Object.values(byDir).reduce((n, l) => n + l.length, 0));
  });

  it('headline ids resolve against the registry for every area that has rules', () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const area of AREAS) {
      if (!RULES.some((r) => r.area === area)) continue;
      for (const h of HEADLINES[area]) for (const id of h.ruleIds) expect(ids.has(id), `${area}: ${id}`).toBe(true);
    }
    expect(headlineRuleIds().every((id) => RULE_ID_RE.test(id))).toBe(true);
  });

  it('validateRule reports every broken field', () => {
    expect(validateRule(null)).toEqual(['rule must be an object']);
    const problems = validateRule({ id: 'x', area: 'nope', severity: 'bad', confidence: 'x', methods: ['sql'], phase: 'later', requires: ['ftp'], description: '', helpUrl: 'http://x', check: 1 });
    expect(problems.length).toBe(10);
  });
});

describe('runner', () => {
  const site = {
    'index.html': `<!doctype html><html><head>
<link rel="stylesheet" href="a.css">
</head><body>
<div id="keep" class="x">one</div>
<div data-atelier-ignore="r-html"><p class="x">two</p></div>
<section data-atelier-ignore><p class="x">three</p></section>
<script src="a.js"></script>
</body></html>`,
    'a.css': '.a { color: red }\n/* atelier-ignore r-css */\n.b { color: blue }\n.c {\n  /* atelier-ignore */\n  color: green;\n}\n',
    'a.js': 'go(1);\n// atelier-ignore r-js\ngo(2);\ngo(3); // atelier-ignore r-js\n\ngo(4);\n',
  };
  const mk = (id, check, extra = {}) => rule(id, { area: 'panels', severity: 'serious', methods: ['html'], check, ...extra });

  it('suppresses via data-atelier-ignore, CSS comments and JS comments, and counts it', async () => {
    const ctx = await contextFor(site);
    const html = runRule(mk('r-html', (c) => c.html.querySelectorAll('.x').map((el) => ({ node: c.ref.html(el) }))), ctx);
    expect(html.nodes.map((n) => n.selector)).toEqual(['#keep']);
    expect(html.suppressed).toBe(2);
    const css = runRule(mk('r-css', (c) => c.css.declsByProp('color').map((d) => ({ node: c.ref.css(d) }))), ctx);
    expect(css.nodes.map((n) => n.snippet)).toEqual(['.a { color: red }']);
    expect(css.suppressed).toBe(2);
    const js = runRule(mk('r-js', (c) => c.js.callsByCallee('go').map((call) => ({ node: c.ref.js(call) }))), ctx);
    expect(js.nodes.map((n) => n.snippet)).toEqual(['go(1)', 'go(4)']);
    expect(js.suppressed).toBe(2);
    expect(js.nodes[0].location).toBe('a.js:1:1');
  });

  it('isolates a throwing rule and keeps running the others', async () => {
    const ctx = await contextFor(site);
    const run = runRules(ctx, [mk('r-a', () => { throw new Error('nope'); }), mk('r-b', (c) => [{ node: c.ref.page('document', 'ok') }])]);
    expect(run.rules.map((r) => [r.id.slice(19), r.status])).toEqual([['r-a', 'error'], ['r-b', 'failed']]);
    expect(run.errors).toEqual([{ phase: 'rule', ruleId: 'atelier/runtime-ux/r-a', message: 'nope' }]);
  });

  it('routes incomplete findings, notApplicable, dynamic-only and requires-http', async () => {
    const ctx = await contextFor(site);
    const inc = runRule(mk('r-inc', (c) => [{ node: c.ref.page('document', 'absent'), incomplete: true }]), ctx);
    expect(inc.status).toBe('incomplete');
    expect(inc.nodes).toEqual([]);
    expect(inc.incomplete).toHaveLength(1);
    expect(runRule(mk('r-na', () => ({ notApplicable: 'no dialogs' })), ctx)).toMatchObject({ status: 'notApplicable', reason: 'no dialogs' });
    expect(runRule(mk('r-dyn', () => [], { phase: 'dynamic' }), ctx)).toMatchObject({ status: 'skipped', reason: 'dynamic-only' });
    expect(runRule(mk('r-http', () => [], { requires: ['http'] }), ctx)).toMatchObject({ status: 'notApplicable', reason: 'requires-http' });
    const dynCtx = await contextFor(site, { dynamic: { errors: [] } });
    expect(runRule(mk('r-dyn', (c) => [{ node: c.ref.dynamic({ selector: 'button', snippet: '10x10' }) }], { phase: 'dynamic' }), dynCtx).nodes)
      .toEqual([{ selector: 'button', snippet: '10x10', location: '(runtime)' }]);
  });

  it('honors ignore by short and full id', async () => {
    const ctx = await contextFor(site);
    const r = mk('r-ign', (c) => [{ node: c.ref.page('document', 'x') }]);
    expect(runRule(r, ctx, { ignore: ['r-ign'] })).toMatchObject({ status: 'skipped', reason: 'ignored' });
    expect(runRule(r, ctx, { ignore: ['atelier/runtime-ux/r-ign'] })).toMatchObject({ status: 'skipped', reason: 'ignored' });
    expect(runRule(r, ctx).status).toBe('failed');
  });

  it('rejects findings whose node was not built by ctx.ref, and invalid or duplicate rules', async () => {
    const ctx = await contextFor(site);
    const bad = runRule(mk('r-bad', () => [{ node: { selector: 'x', snippet: 'y', location: 'z' } }]), ctx);
    expect(bad.status).toBe('error');
    expect(bad.errors[0].message).toMatch(/ctx\.ref/);
    const shape = runRule(mk('r-shape', () => 'nope'), ctx);
    expect(shape.status).toBe('error');
    const run = runRules(ctx, [mk('r-dup', () => []), mk('r-dup', () => []), { id: 'bad id' }]);
    expect(run.errors.map((e) => e.message)).toEqual(expect.arrayContaining(['duplicate rule id', expect.stringMatching(/^invalid rule/)]));
  });

  it('dedupes nodes, caps them at 50, truncates messages and sanitizes data', async () => {
    const ctx = await contextFor({ 'index.html': `<body>${'<i></i>'.repeat(60)}</body>` });
    const r = runRule(mk('r-cap', (c) => [
      ...c.html.byTag('i').map((el) => ({ node: c.ref.html(el) })),
      { node: c.ref.html(c.html.byTag('i')[0]) },
    ]), ctx);
    expect(r.nodes).toHaveLength(50);
    expect(r.nodesTruncated).toBe(10);
    const long = runRule(mk('r-msg', (c) => [{ node: c.ref.page('document', 'x'), message: 'a'.repeat(300), data: { n: 1.23456, list: [1.5, 'x', {}], skip: {}, nil: null } }]), ctx);
    expect(long.nodes[0].message).toHaveLength(200);
    expect(long.nodes[0].message.endsWith('...')).toBe(true);
    expect(long.nodes[0].data).toEqual({ list: [1.5, 'x'], n: 1.235, nil: null });
  });

  it('re-runs rendered rules on ctx.rendered and drops nodes already seen', async () => {
    const dynamic = { errors: [], rendered: { html: '<body><dialog id="d1"></dialog><dialog id="late"></dialog></body>' } };
    const ctx = await contextFor({ 'index.html': '<body><dialog id="d1"></dialog></body>' }, { dynamic });
    const r = runRule(mk('r-rendered', (c) => c.html.byTag('dialog').map((el) => ({ node: c.ref.html(el) })), { rendered: true }), ctx);
    expect(r.nodes.map((n) => [n.selector, n.location])).toEqual([['#d1', 'index.html:1:7'], ['#late', '(rendered DOM)']]);
    const na = runRule(mk('r-rendered-na', (c) => (c.html.byTag('dialog').length > 1 ? [] : { notApplicable: 'no dialogs' }), { rendered: true }), ctx);
    expect(na.status).toBe('passed');
  });
});

describe('determinism', () => {
  it('gives identical output for shuffled rule order', async () => {
    const a = await auditCore();
    const b = await auditCore({ rules: [...FAKE_RULES].reverse() });
    const c = await auditCore({ rules: [FAKE_RULES[3], ...FAKE_RULES.slice(5), ...FAKE_RULES.slice(0, 3), FAKE_RULES[4]] });
    expect(rawJson(b.raw)).toBe(rawJson(a.raw));
    expect(rawJson(c.raw)).toBe(rawJson(a.raw));
    expect(b.markdown).toBe(a.markdown);
  });

  it('gives identical output when responses arrive in a different order', async () => {
    const files = {
      '/': '<!doctype html><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><script src="/a.js"></script><script src="/b.js"></script>',
      '/a.css': '.a { height: 100vh }', '/b.css': '.b { min-height: 95vh }', '/a.js': 'window.addEventListener("unload", f)', '/b.js': 'window.addEventListener("unload", g)',
    };
    const run = (delays) => withServer((req, res) => {
      const body = files[req.url];
      setTimeout(() => {
        if (body === undefined) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(body);
      }, delays[req.url] ?? 0);
    }, (url) => auditRuntimeUx({ url, rules: FAKE_RULES, timestamp: FIXED_TS, write: false }));
    const one = await run({ '/a.css': 60, '/a.js': 40 });
    const two = await run({ '/b.css': 60, '/b.js': 40 });
    const strip = (raw) => rawJson(raw).replace(/127\.0\.0\.1:\d+/g, 'HOST');
    expect(strip(two.raw)).toBe(strip(one.raw));
    expect(one.raw.violations.map((v) => v.ruleId)).toContain('atelier/runtime-ux/fake-css-height');
  });
});

describe('report', () => {
  it('matches the core goldens', async () => {
    const res = await auditCore();
    expectGolden('core.report.md', res.markdown);
    expectGolden('core.raw.json', rawJson(res.raw));
  });

  it('summarizes, groups and returns the documented API shape', async () => {
    const res = await auditCore();
    expect(Object.keys(res).sort()).toEqual(['incomplete', 'markdown', 'metrics', 'pass', 'raw', 'rawPath', 'reportPath', 'summary', 'violations']);
    expect(res.reportPath).toBeNull();
    expect(res.pass).toBe(false);
    expect(res.violations.critical.map((v) => v.ruleId)).toEqual(['atelier/runtime-ux/fake-js-unload']);
    expect(res.violations.all).toHaveLength(res.summary.rules.critical + res.summary.rules.serious + res.summary.rules.moderate + res.summary.rules.minor);
    expect(res.incomplete.map((v) => v.ruleId)).toEqual(['atelier/runtime-ux/fake-absence']);
    const statuses = Object.fromEntries(res.raw.rules.map((r) => [toShortRuleId(r.id), r.status]));
    expect(statuses).toMatchObject({ 'fake-ignored': 'skipped', 'fake-dynamic': 'skipped', 'fake-http': 'notApplicable', 'fake-throws': 'error', 'fake-pass': 'passed', 'fake-na': 'notApplicable' });
    expect(res.metrics).toMatchObject({ inpP75Ms: null, inp: null, bfcache: null });
    expect(res.markdown).toContain('... and 2 more');
    expect(res.raw.budgets).toMatchObject({ minTapPx: 44, minTapPxSource: 'brand', zIndexMax: 50, motionDurationsMs: { long: 400, short: 150 } });
  });

  it('keeps tool-authored text ASCII with no em or en dash', async () => {
    const res = await auditCore();
    expectAsciiNoDash(res.markdown, 'report');
    expectAsciiNoDash(USAGE, 'usage');
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(SKILL_DIR);
    for (const f of files) expectAsciiNoDash(readFileSync(f, 'utf8'), relative(SKILL_DIR, f));
  });

  it('fences code spans past any backtick run and computes highlights', () => {
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`x`')).toBe('`` `x` ``');
    expect(code('')).toBe('``');
    const hl = computeHighlights([{ ruleId: toFullRuleId('tap-target-under-minimum'), nodes: [{}, {}], nodesTruncated: 3 }], { minTapPx: 44 }, ['mobile']);
    expect(hl).toEqual({ mobile: { 'tap targets under 44px': 5, 'vh without dvh': 0, 'safe-area gaps': 0, 'touch/scroll hijacks': 0, 'viewport meta': 0, PWA: 0 } });
  });

  it('writes both files when write is true', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const res = await auditRuntimeUx({ url: join(FIXTURES_DIR, 'core', 'clean', 'index.html'), outDir: join(dir, 'out'), timestamp: FIXED_TS });
      expect(existsSync(res.reportPath)).toBe(true);
      expect(JSON.parse(readFileSync(res.rawPath, 'utf8'))).toEqual(res.raw);
      expect(readFileSync(res.reportPath, 'utf8')).toBe(res.markdown);
      expect(res.markdown.endsWith('\n')).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('budgets', () => {
  it('uses the defaults without a brand', () => {
    expect(resolveBudgets(null)).toEqual(DEFAULT_BUDGETS);
    expect(DEFAULT_BUDGETS).toEqual({ minTapPx: 24, minTapPxSource: 'default', inpBudgetMs: 200, inpBudgetMsSource: 'default', lcpBudgetMs: 2500, clsBudget: 0.1, zIndexMax: 100, longScriptMs: 100, motionDurationsMs: null });
  });

  it('reads a brand object and a brand path', () => {
    const b = resolveBudgets({ targets: { minTapPx: 44, inpBudgetMs: 150, lcpBudgetMs: 2000, clsBudget: 0.05 }, surfaces: { zIndexMax: 10 }, motion: { duration: { short: '180ms', long: '0.32s' } } });
    expect(b).toEqual({ minTapPx: 44, minTapPxSource: 'brand', inpBudgetMs: 150, inpBudgetMsSource: 'brand', lcpBudgetMs: 2000, clsBudget: 0.05, zIndexMax: 10, longScriptMs: 100, motionDurationsMs: { long: 320, short: 180 } });
    const loaded = loadBrand(join(FIXTURES_DIR, 'core', 'brand.json'));
    expect(resolveBudgets(loaded)).toMatchObject({ minTapPx: 44, zIndexMax: 50 });
    expect(loadBrand(null)).toBeNull();
  });

  it('rejects invalid brands with BRAND_INVALID and a JSON path', () => {
    const cases = [
      [{ targets: { minTapPx: '44' } }, 'targets.minTapPx'],
      [{ targets: { minTapPx: 0 } }, 'targets.minTapPx'],
      [{ targets: { inpBudgetMs: 0 } }, 'targets.inpBudgetMs'],
      [{ targets: [] }, 'targets'],
      [{ surfaces: { zIndexMax: 1.5 } }, 'surfaces.zIndexMax'],
      [{ motion: { duration: { short: 'fast' } } }, 'motion.duration.short'],
      [{ motion: { duration: { '1x': '1s' } } }, 'motion.duration.1x'],
      [{ motion: 3 }, 'motion'],
    ];
    for (const [brand, path] of cases) {
      let err;
      try { resolveBudgets(brand); } catch (e) { err = e; }
      expect(err, path).toBeInstanceOf(UxAuditError);
      expect(err.code).toBe('BRAND_INVALID');
      expect(err.path).toBe(path);
      expect(err.message).toContain(path);
    }
    expect(() => loadBrand('does/not/exist.json')).toThrow(expect.objectContaining({ code: 'BRAND_INVALID' }));
    expect(() => loadBrand(42)).toThrow(expect.objectContaining({ code: 'BRAND_INVALID' }));
  });

  it('fails the audit on an invalid brand before collecting', async () => {
    await expect(auditRuntimeUx({ url: 'nowhere.html', brand: { targets: { minTapPx: -1 } }, write: false }))
      .rejects.toMatchObject({ code: 'BRAND_INVALID' });
  });
});

describe('options', () => {
  it('normalizes ids, areas, origins and timestamps', () => {
    const o = normalizeOptions({ url: 'x.html', areas: ['mobile', 'inp'], ignore: ['b', 'atelier/runtime-ux/a', 'b'], allowOrigins: ['https://cdn.example.com/x', 'https://a.example.com'], timestamp: '2026-01-01T00:00:00Z' });
    expect(o.areas).toEqual(['inp', 'mobile']);
    expect(o.ignore).toEqual(['atelier/runtime-ux/a', 'atelier/runtime-ux/b']);
    expect(o.allowOrigins).toEqual(['https://a.example.com', 'https://cdn.example.com']);
    expect(o.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(o.outDir).toBe('ux-report');
    expect(o.write).toBe(true);
    expect(o.limits.maxBytes).toBe(2 * 1024 * 1024);
  });

  it('throws USAGE for bad options', () => {
    const bad = [
      undefined, {}, { url: '' }, { url: 'x', areas: ['nav'] }, { url: 'x', areas: [] }, { url: 'x', timestamp: 'yesterday' },
      { url: 'x', limits: { timeoutMs: -1 } }, { url: 'x', limits: { nope: 1 } }, { url: 'x', rules: 'r' }, { url: 'x', allowOrigins: ['ftp://x'] },
      { url: 'x', dynamicLimits: { maxTabs: 0 } }, { url: 'x', fetchImpl: 1 }, { url: 'x', outDir: '' },
    ];
    for (const b of bad) expect(() => normalizeOptions(b), JSON.stringify(b)).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });

  it('parses ignore markers', () => {
    expect(parseIgnoreIds('')).toEqual({ all: true, ids: new Set() });
    expect(parseIgnoreIds('a-b, c -- because')).toEqual({ all: false, ids: new Set(['atelier/runtime-ux/a-b', 'atelier/runtime-ux/c']) });
  });
});

describe('contextFor and the ctx contract', () => {
  it('builds a full ctx with every contract field and method', async () => {
    const ctx = await contextFor({
      'index.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="manifest" href="m.json"></head><body><button>Go</button><script src="app.js"></script></body></html>',
      'app.js': 'document.querySelector("button").addEventListener("click", () => {});',
      'm.json': '{"name":"x","icons":[]}',
    }, { brand: { targets: { minTapPx: 44 } } });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.keys(ctx).sort()).toEqual(['brand', 'budgets', 'css', 'dynamic', 'html', 'js', 'manifest', 'options', 'page', 'ref', 'rendered', 'resources']);
    expect(ctx.page).toMatchObject({ kind: 'file', displayUrl: 'index.html', origin: null, status: null, headers: {}, csp: [] });
    for (const fn of ['resolve', 'isSameOrigin', 'toDisplay']) expect(typeof ctx.page[fn]).toBe('function');
    expect(ctx.options).toEqual({ dynamic: false, areas: AREAS });
    expect(ctx.budgets.minTapPx).toBe(44);
    expect(ctx.brand).toEqual({ targets: { minTapPx: 44 } });
    expect(ctx.manifest).toEqual({ displayPath: 'm.json', json: { name: 'x', icons: [] }, error: null });
    expect(ctx.dynamic).toBeNull();
    expect(ctx.rendered).toBeNull();
    for (const fn of ['byTag', 'byRole', 'withAttr', 'byId', 'querySelectorAll', 'matches', 'attr', 'hasAttr', 'tag', 'parent', 'prevSibling', 'nextSibling', 'children', 'ancestors', 'descendants', 'closest', 'text']) {
      expect(typeof ctx.html[fn], `html.${fn}`).toBe('function');
    }
    for (const k of ['source', 'displayPath', 'document', 'elements', 'viewport', 'links', 'speculationRules', 'eventAttrs']) expect(ctx.html).toHaveProperty(k);
    for (const fn of ['declsByProp', 'customProps', 'rulesBySelector', 'atRulesByName', 'valueMentions']) expect(typeof ctx.css[fn], `css.${fn}`).toBe('function');
    for (const k of ['complete', 'sheets', 'rules', 'decls', 'atRules']) expect(ctx.css).toHaveProperty(k);
    for (const fn of ['callsByCallee', 'callsByMethod', 'listenersByEvent', 'stringLiterals', 'mentions', 'sourceOf', 'walkFunction', 'resolveFunction', 'initializerOf', 'listenerForFunction', 'enclosingFunctions', 'isConditional', 'isGuarded', 'locate']) {
      expect(typeof ctx.js[fn], `js.${fn}`).toBe('function');
    }
    for (const k of ['complete', 'scripts', 'calls', 'listeners', 'assignments', 'imports']) expect(ctx.js).toHaveProperty(k);
    for (const fn of ['html', 'css', 'js', 'page', 'dynamic']) expect(typeof ctx.ref[fn], `ref.${fn}`).toBe('function');
    const button = ctx.html.byTag('button')[0];
    const ref = ctx.ref.html(button);
    expect(ref).toEqual({ selector: 'body > button', snippet: '<button>', location: 'index.html:1:127' });
    expect(Object.keys(ref)).toEqual(['selector', 'snippet', 'location']);
    expect(ref.anchorEl).toBe(button);
    expect(typeof ref.order).toBe('number');
    const l = ctx.js.listenersByEvent('click')[0];
    expect(ctx.ref.js(l)).toMatchObject({ selector: 'script[src="app.js"]', location: 'app.js:1:1' });
    expect(ctx.ref.page('head', 'no viewport meta')).toEqual({ selector: 'document', snippet: 'no viewport meta', location: 'index.html' });
    expect(() => ctx.ref.html({})).toThrow(TypeError);
    expect(() => ctx.ref.css({})).toThrow(TypeError);
    expect(() => ctx.ref.js(null)).toThrow(TypeError);
  });

  it('attaches synthetic dynamic facts and a rendered model', async () => {
    const facts = { engine: { name: 'chromium', version: '153.0.0.0', headless: 'new' }, rendered: { html: '<body><p id="x">late</p></body>' }, sweep: null, interactions: null, dialogs: null, bfcache: { supported: true, restored: false, reasons: ['masked'] }, errors: [] };
    const ctx = await contextFor({ 'index.html': '<body></body>' }, { dynamic: facts });
    expect(ctx.options.dynamic).toBe(true);
    expect(ctx.dynamic.bfcache.reasons).toEqual(['masked']);
    expect(Object.isFrozen(ctx.dynamic.bfcache)).toBe(true);
    expect(ctx.rendered.source).toBe('rendered');
    expect(ctx.ref.html(ctx.rendered.byId('x'))).toEqual({ selector: '#x', snippet: '<p id="x">', location: '(rendered DOM)' });
  });
});

describe('performance', () => {
  it('finishes the static pass on a ~100 KB page well under 5 s', async () => {
    const css = Array.from({ length: 400 }, (_, i) => `.c${i} .d${i} > a:hover, .panel-${i}[open] { transition: opacity ${i}ms ease; height: ${i % 100}vh; z-index: ${i}; }`).join('\n');
    const js = Array.from({ length: 300 }, (_, i) => `document.querySelector('.c${i}').addEventListener('click', function h${i}(e) { if (window.x${i}) { e.target.style.opacity = '0.5'; } return e.target.offsetTop; }, { passive: true });`).join('\n');
    const body = Array.from({ length: 300 }, (_, i) => `<div class="c${i} card"><a href="/p${i}" class="d${i}">Item ${i}</a></div>`).join('\n');
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>${body}<script>${js}</script></body></html>`;
    expect(html.length).toBeGreaterThan(90_000);
    const { dir, cleanup } = tempDir();
    try {
      writeFiles(dir, { 'index.html': html });
      const heavy = [
        rule('perf-css', { area: 'panels', severity: 'minor', methods: ['css'], check: (c) => c.css.rules.flatMap((r) => r.selectors.filter((s) => c.html.querySelectorAll(s).length > 0).map(() => ({ node: c.ref.css(r) }))) }),
        rule('perf-js', { area: 'inp', severity: 'minor', methods: ['js'], check: (c) => c.js.listeners.filter((l) => l.handler && !c.js.isGuarded(l, /never/)).map((l) => ({ node: c.ref.js(l) })) }),
      ];
      const t0 = performance.now();
      const res = await auditRuntimeUx({ url: join(dir, 'index.html'), rules: [...RULES, ...heavy], write: false, timestamp: FIXED_TS });
      const ms = performance.now() - t0;
      expect(res.raw.violations.length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(5000);
    } finally {
      cleanup();
    }
  });
});

describe('dynamic reporting (synthetic facts, no browser)', () => {
  const facts = () => ({ ...readFixtureJson('core/facts/sample.json'), errors: [{ probe: 'dialogs', message: 'trigger  not\nfound' }] });
  const DYNAMIC_RULES = [
    ...FAKE_RULES,
    rule('fake-tap', {
      area: 'mobile', severity: 'serious', methods: ['dom'], phase: 'dynamic',
      check: (ctx) => ctx.dynamic.sweep.interactive.filter((i) => i.rect.width < ctx.budgets.minTapPx)
        .map((i) => ({ node: ctx.ref.dynamic({ selector: i.selector, snippet: `${i.rect.width}x${i.rect.height} px < ${ctx.budgets.minTapPx}` }) })),
    }),
    rule('fake-rendered-dialog', {
      area: 'panels', severity: 'serious', methods: ['html'], rendered: true,
      check: (ctx) => ctx.html.byTag('dialog').map((el) => ({ node: ctx.ref.html(el) })),
    }),
    rule('fake-loaf', {
      area: 'inp', severity: 'moderate', methods: ['trace'], phase: 'dynamic',
      check: (ctx) => ctx.dynamic.interactions.loaf.flatMap((f) => f.scripts).map((s) => {
        const pos = ctx.js.locate(s.sourceURL, s.sourceCharPosition);
        return { node: ctx.ref.dynamic({ selector: s.sourceURL, snippet: `${s.invoker} ${s.durationMs} ms`, location: pos ? `${s.sourceURL}:${pos.line}:${pos.column}` : s.sourceURL }) };
      }),
    }),
  ];

  it('passes the documented input to the dynamic pass and reports its facts', async () => {
    let input;
    const res = await runFixture('core', {
      rules: DYNAMIC_RULES, ignore: ['fake-ignored'], dynamic: true,
      dynamicImpl: async (i) => { input = i; return facts(); },
    });
    expect(input.page).toMatchObject({ kind: 'file', url: expect.stringMatching(/^file:\/\/.*index\.html$/) });
    expect(input.page.filePath.endsWith('index.html')).toBe(true);
    expect(input.page.root).toBeTruthy();
    expect(input.toDisplay(new URL('js/app.js', input.page.url).href)).toBe('js/app.js');
    expect(input.limits).toEqual({ navigationTimeoutMs: 30000, dynamicTimeoutMs: 90000, settleMs: 1000, maxTabs: 12, maxTaps: 12, maxDialogTriggers: 5, maxInteractive: 500 });
    expect(input.budgets.minTapPx).toBe(44);
    expect(typeof input.launch).toBe('function');
    expect(res.metrics.inpP75Ms).toBe(288);
    expect(res.metrics.bfcache).toEqual({ restored: false, reasons: ['masked'] });
    expect(res.raw.mode.engine).toEqual({ name: 'chromium', version: '153.0.7000.0', device: 'Pixel 7', cpuThrottle: 4 });
    expect(res.markdown).toContain('Mode: static + dynamic (Chromium 153, Pixel 7, 4x CPU)');
    expect(res.markdown).toContain('INP est. 288 ms (budget 150 ms)');
    expect(res.markdown).toContain('- Dynamic findings reflect Chromium-only APIs.');
    expect(res.markdown).toContain('- Probe errors: dialogs: trigger not found');
    const dialog = res.raw.violations.find((v) => v.ruleId.endsWith('fake-rendered-dialog'));
    expect(dialog.nodes).toEqual([{ selector: '#late', snippet: '<dialog id="late">', location: '(rendered DOM)' }]);
    expectGolden('core.dynamic.report.md', res.markdown);
    expectGolden('core.dynamic.raw.json', rawJson(res.raw));
  });

  it('reports INP below threshold and a missing estimate', async () => {
    const below = { ...facts(), interactions: { ...facts().interactions, inp: { estimateMs: null, p75InteractionMs: null, maxMs: null, count: 0, belowThreshold: true, worst: null } } };
    const a = await runFixture('core', { rules: [], dynamic: true, dynamicImpl: async () => below });
    expect(a.markdown).toContain('INP est. < 16 ms (budget 150 ms)');
    const none = await runFixture('core', { rules: [], dynamic: true, dynamicImpl: async () => ({ ...facts(), engine: null, interactions: null, bfcache: null }) });
    expect(none.markdown).toContain('INP est. n/a |');
    expect(none.markdown).toContain('Mode: static + dynamic\n');
    expect(none.metrics).toMatchObject({ inpP75Ms: null, inp: null, bfcache: null });
  });

  it('maps dynamic failures to DYNAMIC_FAILED and keeps UxAuditError codes', async () => {
    await expect(runFixture('core', { rules: [], dynamic: true, dynamicImpl: async () => { throw new Error('page crashed'); } }))
      .rejects.toMatchObject({ code: 'DYNAMIC_FAILED', message: expect.stringContaining('page crashed') });
    await expect(runFixture('core', { rules: [], dynamic: true, dynamicImpl: async () => { throw new UxAuditError('CHROMIUM_MISSING', 'no browser', { hint: 'install' }); } }))
      .rejects.toMatchObject({ code: 'CHROMIUM_MISSING', hint: 'install' });
  });
});

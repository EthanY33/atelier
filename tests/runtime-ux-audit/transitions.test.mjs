import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { rules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/index.mjs';
import {
  compareSpecificity, compileHrefPattern, inNoPreference, inReduceMotion, motionPreferenceOf, specificity, stripQueryHash,
} from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/shared.mjs';
import { HEADLINES } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import {
  FIXED_TS, contextFor, expectAsciiNoDash, expectGolden, rawJson, readFixtureJson, runFixture, runRule, withServer,
} from './helpers.mjs';

const R = Object.fromEntries(rules.map((r) => [r.id.replace('atelier/runtime-ux/', ''), r]));
const page = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const script = (js) => `<script>\n${js}\n</script>`;
const style = (css) => `<style>\n${css}\n</style>`;

/** Run one transitions rule on an in-memory site. */
async function check(id, files, opts) {
  const ctx = await contextFor(typeof files === 'string' ? { 'index.html': files } : files, { areas: ['transitions'], ...opts });
  return runRule(R[id], ctx);
}

const snippets = (res) => res.nodes.map((n) => n.snippet);

// ---------------------------------------------------------------------------

describe('transitions registry', () => {
  it('ships the eleven designed rules, all in the transitions area', () => {
    expect(Object.keys(R).sort()).toEqual([
      'analytics-without-prerender-guard', 'bfcache-not-restored', 'cache-control-no-store-on-html',
      'no-beforeunload-always-attached', 'no-unload-handler', 'speculation-rules-csp-gap',
      'speculation-rules-immediate-abuse', 'vta-duplicate-names', 'vta-no-feature-check',
      'vta-no-reduced-motion-guard', 'vta-root-transformed',
    ]);
    for (const r of rules) {
      expect(r.area).toBe('transitions');
      expectAsciiNoDash(r.description, r.id);
    }
    const headline = HEADLINES.transitions.flatMap((h) => h.ruleIds);
    expect([...headline].sort()).toEqual(rules.map((r) => r.id).sort());
  });

  it('marks the dynamic and http-only rules', () => {
    expect(R['bfcache-not-restored'].phase).toBe('dynamic');
    expect(R['cache-control-no-store-on-html'].requires).toEqual(['http']);
    expect(rules.filter((r) => r.phase === 'dynamic').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('no-unload-handler', () => {
  it('flags every way of registering unload on the window', async () => {
    const res = await check('no-unload-handler', page(`<p>x</p>${script([
      "window.addEventListener('unload', beacon);",
      "self.addEventListener('unload', beacon);",
      "addEventListener('unload', beacon);",
      'onunload = beacon;',
      'window.onunload = function () { save(); };',
      'document.body.onunload = beacon;',
      "$(window).on('unload.app', beacon);",
      '$(window).unload(beacon);',
      'function beacon() {}',
    ].join('\n'))}`, ''));
    expect(res.status).toBe('failed');
    expect(res.nodes.length).toBe(8);
    expect(res.nodes.map((n) => n.data.via)).toEqual(['addEventListener', 'addEventListener', 'addEventListener', 'property', 'property', 'property', 'jquery', 'jquery']);
  });

  it('flags <body onunload> at the attribute', async () => {
    const res = await check('no-unload-handler', '<!doctype html><html><head></head><body onunload="bye()"><p>x</p></body></html>');
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toMatchObject({ selector: 'body', snippet: '<body onunload="bye()">', location: 'index.html:1:41' });
  });

  it('ignores listeners that never block the bfcache', async () => {
    const res = await check('no-unload-handler', page(`<div onunload="x()"></div>${script([
      "document.addEventListener('unload', a);",
      "el.addEventListener('unload', a);",
      "document.body.addEventListener('unload', a);",
      'document.documentElement.onunload = a;',
      'window.onunload = null;',
      "window.addEventListener('pagehide', a);",
    ].join('\n'))}`));
    expect(res.status).toBe('passed');
  });

  it('honors atelier-ignore comments', async () => {
    const res = await check('no-unload-handler', page(script("// atelier-ignore no-unload-handler -- legacy\nwindow.addEventListener('unload', a);")));
    expect(res).toMatchObject({ status: 'passed', suppressed: 1 });
  });
});

// ---------------------------------------------------------------------------

describe('no-beforeunload-always-attached', () => {
  it('flags top-level, IIFE and ready-handler registrations', async () => {
    const res = await check('no-beforeunload-always-attached', page(script([
      "window.addEventListener('beforeunload', warn);",
      "(function () { addEventListener('beforeunload', warn); })();",
      "document.addEventListener('DOMContentLoaded', () => { window.addEventListener('beforeunload', warn); });",
      "window.onload = function () { window.onbeforeunload = warn; };",
      "$(function () { $(window).on('beforeunload', warn); });",
      "function init() { self.addEventListener('beforeunload', warn); }",
      "window.addEventListener('load', init);",
      "window.removeEventListener('beforeunload', warn);",
      'function warn(e) { if (dirty) e.preventDefault(); }',
    ].join('\n'))));
    expect(res.nodes.map((n) => n.location)).toEqual(['index.html:2:1', 'index.html:3:16', 'index.html:4:55', 'index.html:5:31', 'index.html:6:17', 'index.html:7:19']);
  });

  it('flags <body onbeforeunload> and document.body.onbeforeunload', async () => {
    const res = await check('no-beforeunload-always-attached', '<!doctype html><html><head></head><body onbeforeunload="return 1"><script>document.body.onbeforeunload = warn;</script></body></html>');
    expect(res.nodes.map((n) => n.data.via)).toEqual(['attribute', 'property']);
  });

  it('passes conditional and on-demand registrations', async () => {
    const res = await check('no-beforeunload-always-attached', page(script([
      "if (dirty) window.addEventListener('beforeunload', warn);",
      "dirty && addEventListener('beforeunload', warn);",
      "form.addEventListener('input', () => { window.addEventListener('beforeunload', warn); });",
      "function markDirty() { window.addEventListener('beforeunload', warn); }",
      "document.addEventListener('beforeunload', warn);",
      "window.addEventListener('load', () => { if (editor.dirty) window.onbeforeunload = warn; });",
      "try { x(); } catch (e) { addEventListener('beforeunload', warn); }",
    ].join('\n'))));
    expect(res.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------

describe('cache-control-no-store-on-html', () => {
  const serve = (cacheControl) => (req, res) => {
    const headers = { 'content-type': 'text/html' };
    if (cacheControl) headers['cache-control'] = cacheControl;
    res.writeHead(200, headers);
    res.end(page('<p>hi</p>'));
  };
  const audit = (url) => auditRuntimeUx({ url, areas: ['transitions'], rules: [R['cache-control-no-store-on-html']], timestamp: FIXED_TS, write: false });

  it('flags no-store on an http document at the response headers', async () => {
    const res = await withServer(serve('private, No-Store, max-age=0'), audit);
    expect(res.raw.violations).toHaveLength(1);
    expect(res.raw.violations[0].nodes).toEqual([{
      selector: 'document',
      snippet: 'Cache-Control: private, No-Store, max-age=0',
      location: '(response headers)',
      message: expect.stringContaining('verified on Chromium 153'),
    }]);
  });

  it('passes other directives and a missing header', async () => {
    for (const value of ['no-cache', 'private, max-age=0', 'no-storefront', null]) {
      const res = await withServer(serve(value), audit);
      expect(res.raw.rules[0].status, String(value)).toBe('passed');
    }
  });

  it('is not applicable to local files', async () => {
    const res = await check('cache-control-no-store-on-html', page('<p>x</p>'));
    expect(res).toMatchObject({ status: 'notApplicable', reason: 'requires-http' });
  });
});

// ---------------------------------------------------------------------------

describe('bfcache-not-restored', () => {
  const facts = (bfcache) => ({ ...readFixtureJson('transitions/facts/restored.json'), bfcache });

  it('reports a masked restore failure with a pointer to the static rules', async () => {
    const res = await check('bfcache-not-restored', page('<p>x</p>'), { dynamic: readFixtureJson('transitions/facts/masked.json') });
    expect(res.status).toBe('failed');
    expect(res.nodes).toEqual([{
      selector: 'document', snippet: 'notRestoredReasons: masked', location: '(runtime)',
      message: expect.stringContaining('no-unload-handler'), data: { reasons: ['masked'] },
    }]);
  });

  it('lists concrete reasons, or says none were reported', async () => {
    let res = await check('bfcache-not-restored', page('<p>x</p>'), { dynamic: facts({ supported: true, restored: false, reasons: ['broadcastchannel-message', 'unload-listener'] }) });
    expect(res.nodes[0]).toMatchObject({ snippet: 'notRestoredReasons: broadcastchannel-message, unload-listener', message: expect.stringContaining('fix the reported') });
    res = await check('bfcache-not-restored', page('<p>x</p>'), { dynamic: facts({ supported: true, restored: false, reasons: [] }) });
    expect(res.nodes[0]).toMatchObject({ snippet: 'notRestoredReasons: (none reported)', message: expect.stringContaining('no reason') });
  });

  it('passes a restored page and is not applicable without probe data', async () => {
    expect((await check('bfcache-not-restored', page('<p>x</p>'), { dynamic: readFixtureJson('transitions/facts/restored.json') })).status).toBe('passed');
    for (const bf of [null, { supported: false, restored: false, reasons: [] }, { supported: true, restored: null, reasons: [] }]) {
      const res = await check('bfcache-not-restored', page('<p>x</p>'), { dynamic: facts(bf) });
      expect(res.status, JSON.stringify(bf)).toBe('notApplicable');
    }
  });

  it('is skipped by the static pass', async () => {
    expect(await check('bfcache-not-restored', page('<p>x</p>'))).toMatchObject({ status: 'skipped', reason: 'dynamic-only' });
  });
});

// ---------------------------------------------------------------------------

describe('vta-no-feature-check', () => {
  it('flags unguarded calls, including inside handlers and unguarded helpers', async () => {
    const res = await check('vta-no-feature-check', page(script([
      'document.startViewTransition(update);',
      "btn.addEventListener('click', () => window.document.startViewTransition(update));",
      'function go(fn) { return document.startViewTransition(fn); }',
      'go(update);',
      'const run = (fn) => document.startViewTransition(fn);',
      'if (document.startViewTransition) run(update);',
      'link.onclick = run;',
    ].join('\n'))));
    expect(snippets(res)).toEqual(['document.startViewTransition(update)', 'window.document.startViewTransition(update)', 'document.startViewTransition(fn)', 'document.startViewTransition(fn)']);
  });

  it('passes the documented guard forms', async () => {
    const res = await check('vta-no-feature-check', page(script([
      'function a() { if (!document.startViewTransition) { update(); return; } document.startViewTransition(update); }',
      'if (document.startViewTransition) { document.startViewTransition(update); } else { update(); }',
      "typeof document.startViewTransition === 'function' ? document.startViewTransition(update) : update();",
      'document.startViewTransition && document.startViewTransition(update);',
      "const supportsVT = 'startViewTransition' in document;",
      'if (supportsVT) document.startViewTransition(update);',
      'try { document.startViewTransition(update); } catch (e) { update(); }',
      'document.startViewTransition?.(update);',
      'function vt(fn) { return document.startViewTransition(fn); }',
      'if (document.startViewTransition) vt(update); else update();',
      "function supported() { return 'startViewTransition' in document; }",
      'if (supported()) document.startViewTransition(update);',
    ].join('\n'))));
    expect(res.status).toBe('passed');
  });

  it('does not count an optional call of the helper as a guard', async () => {
    const res = await check('vta-no-feature-check', page(script([
      'function vt(fn) { return document.startViewTransition(fn); }',
      'vt?.(update);',
      'if (document.startViewTransition) vt(update);',
    ].join('\n'))));
    expect(res.nodes).toHaveLength(1);
  });

  it('does not trust helpers that are exported', async () => {
    const res = await check('vta-no-feature-check', page('<script type="module">\nexport function vt(fn) { return document.startViewTransition(fn); }\nif (document.startViewTransition) vt(u);\n</script>'));
    expect(res.nodes).toHaveLength(1);
  });

  it('is not applicable without startViewTransition calls', async () => {
    expect((await check('vta-no-feature-check', page(script('update();')))).status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------

describe('vta-no-reduced-motion-guard', () => {
  const run = (css, extra = '', files = {}) => check('vta-no-reduced-motion-guard', { 'index.html': page(`<p>x</p>${extra}`, style(css)), ...files });

  it('flags @view-transition navigation: auto and custom ::view-transition animations', async () => {
    const res = await run([
      '@view-transition { navigation: auto; }',
      '::view-transition-old(root) { animation: 300ms ease both slide-out; }',
      '::view-transition-group(card) { animation-duration: .5s; animation-timing-function: ease; }',
      '::view-transition-new(*) { animation-name: fade-in; }',
    ].join('\n'));
    expect(snippets(res)).toEqual([
      '@view-transition { navigation: auto }',
      '::view-transition-old(root) { animation: 300ms ease both slide-out }',
      '::view-transition-group(card) { animation-duration: .5s }',
      '::view-transition-new(*) { animation-name: fade-in }',
    ]);
    expect(res.incomplete).toEqual([]);
  });

  it('passes with a reduce override, a no-preference wrapper or a script guard', async () => {
    const cases = [
      ['@view-transition { navigation: auto; }\n@media (prefers-reduced-motion: reduce) { @view-transition { navigation: none; } }'],
      ['::view-transition-old(root) { animation: 1s slide; }\n@media (prefers-reduced-motion: reduce) { ::view-transition-group(*) { animation: none; } }'],
      ['::view-transition-old(root) { animation: 1s slide; }\n@media (prefers-reduced-motion) { ::view-transition-old(root) { animation-duration: 0s; } }'],
      ['::view-transition-old(root) { animation: 1s slide; @media (prefers-reduced-motion: reduce) { animation: none; } }'],
      ['@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } ::view-transition-old(root) { animation: 1s slide; } }'],
      ['@media not all and (prefers-reduced-motion: reduce) { ::view-transition-old(root) { animation: 1s slide; } }'],
      ["::view-transition-old(root) { animation: 1s slide; }", script("if (matchMedia('(prefers-reduced-motion: reduce)').matches) update(); else document.startViewTransition(update);")],
      ['@view-transition { navigation: auto; }', script("addEventListener('pagereveal', (e) => { if (matchMedia('(prefers-reduced-motion: reduce)').matches) e.viewTransition?.skipTransition(); });")],
    ];
    for (const [css, extra] of cases) {
      const res = await run(css, extra);
      expect(res.status, css).toBe('passed');
    }
  });

  it('ignores animations that remove motion', async () => {
    const res = await run('::view-transition-group(*) { animation-duration: 0.001s; } ::view-transition-old(root) { animation: none; } ::view-transition-new(root) { animation-name: none; } ::view-transition-image-pair(x) { animation: slide; } ::view-transition-old(y) { animation-name: initial; }');
    expect(res).toMatchObject({ status: 'notApplicable', reason: 'no custom view transition CSS' });
  });

  it('does not treat a startViewTransition script guard as covering cross-document transitions', async () => {
    const res = await run('@view-transition { navigation: auto; }', script("if (!matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition?.(u);"));
    expect(res.nodes).toHaveLength(1);
  });

  it('routes findings to incomplete when a stylesheet could not be read', async () => {
    const res = await run('@view-transition { navigation: auto; }', '', { 'index.html': page('<p>x</p>', `<link rel="stylesheet" href="css/missing.css">${style('@view-transition { navigation: auto; }')}`) });
    expect(res.status).toBe('incomplete');
    expect(res.nodes).toEqual([]);
    expect(res.incomplete).toHaveLength(1);
  });

  it('is not applicable without custom view transition CSS', async () => {
    const res = await run('.a { animation: 1s spin; }', script('document.startViewTransition?.(u);'));
    expect(res.status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------

describe('vta-root-transformed', () => {
  const run = (css, { html = '<html>', vt = '@view-transition { navigation: auto; }' } = {}) => check('vta-root-transformed', `<!doctype html>${html}<head>${style(`${vt}\n${css}`)}</head><body><p>x</p></body></html>`);

  it('flags transforms, filters, opacity below 1 and will-change: transform on the root', async () => {
    const res = await run([
      'html { transform: translateZ(0); }',
      ':root { filter: saturate(1.1); }',
      'html.dark { opacity: .98; }',
      ':root[data-theme] { opacity: 90%; }',
      'html { will-change: scroll-position, transform; }',
      'html { scale: 1.01; }',
      'html, body { rotate: 1deg; }',
    ].join('\n'));
    expect(res.nodes.map((n) => n.data.property)).toEqual(['transform', 'filter', 'opacity', 'opacity', 'will-change', 'scale', 'rotate']);
  });

  it('flags a transform in the html style attribute', async () => {
    const res = await run('', { html: '<html style="transform: scale(1)">' });
    expect(res.nodes).toEqual([expect.objectContaining({ selector: 'html', snippet: 'style="transform: scale(1)"' })]);
  });

  it('passes harmless and unrelated declarations', async () => {
    const res = await run([
      'html { transform: none; filter: none; opacity: 1; will-change: scroll-position; translate: none; }',
      ':root { opacity: 100%; transform: var(--root-shift); filter: initial; }',
      'html::before { transform: scale(2); }',
      'html body { transform: translateZ(0); }',
      '::view-transition-old(root) { transform: scale(.9); opacity: .5; }',
      '@keyframes k { from { transform: none; } to { transform: scale(2); } }',
      '@starting-style { html { opacity: 0; } }',
    ].join('\n'));
    expect(res.status).toBe('passed');
  });

  it('is not applicable when the page does not use view transitions', async () => {
    const res = await run('html { transform: translateZ(0); }', { vt: '' });
    expect(res).toMatchObject({ status: 'notApplicable', reason: 'no view transitions' });
    const viaJs = await check('vta-root-transformed', page(script('document.startViewTransition(u);'), style('html { filter: blur(1px); }')));
    expect(viaJs.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------

describe('vta-duplicate-names', () => {
  const run = (css, body, opts) => check('vta-duplicate-names', page(body, style(css)), opts);

  it('flags a name shared by rendered elements, once, at its first declaration', async () => {
    const res = await run('.card { view-transition-name: card; }\n.feature { view-transition-name: card; }', '<div class="card"></div><div class="card"></div><section class="feature"></section>');
    expect(res.nodes).toEqual([{
      selector: '.card', snippet: '.card { view-transition-name: card }', location: 'index.html:2:9',
      message: 'view-transition-name "card" is on 3 elements; names must be unique, or the browser skips the transition.',
      data: { count: 3, elements: ['body > div.card:nth-of-type(1)', 'body > div.card:nth-of-type(2)', 'body > section.feature'], name: 'card' },
    }]);
  });

  it('flags duplicate inline style names and reports the media conditions', async () => {
    let res = await run('', '<div style="view-transition-name: hero"></div><p style="view-transition-name:hero"></p>');
    expect(res.nodes).toHaveLength(1);
    res = await run('@media (min-width: 800px) { .a, .b { view-transition-name: side; } }', '<div class="a"></div><div class="b"></div>');
    expect(res.nodes[0].data.conditions).toBe('(min-width: 800px)');
  });

  it('lists at most five elements and counts pseudo-elements separately', async () => {
    let res = await run('li { view-transition-name: item; }', `<ul>${'<li>x</li>'.repeat(8)}</ul>`);
    expect(res.nodes[0].data).toMatchObject({ count: 8 });
    expect(res.nodes[0].data.elements).toHaveLength(5);
    res = await run('.x { view-transition-name: pair; } .x::before { view-transition-name: pair; }', '<div class="x"></div>');
    expect(res.nodes[0].data.elements).toEqual(['body > div.x', 'body > div.x::before']);
  });

  it('resolves the cascade before grouping', async () => {
    const res = await run([
      '.thumb { view-transition-name: photo; }',
      '.gallery .thumb { view-transition-name: none; }',
      '.gallery .thumb.selected { view-transition-name: photo; }',
      '#only { view-transition-name: solo; }',
      '.solo { view-transition-name: solo !important; }',
      '@layer base { .tile.big { view-transition-name: tile; } }',
      '.tile { view-transition-name: none; }',
    ].join('\n'), '<div class="gallery"><img class="thumb"><img class="thumb selected"><img class="thumb"></div><div id="only" class="solo"></div><div class="tile big"></div><div class="tile big"></div>');
    expect(res.status).toBe('passed');
  });

  it('skips hidden elements, state selectors, keywords and var()', async () => {
    const res = await run([
      '.card { view-transition-name: card; }',
      '.item:hover { view-transition-name: lift; }',
      '.a { view-transition-name: var(--n); } .b { view-transition-name: match-element; } .c { view-transition-name: auto; }',
    ].join('\n'), [
      '<div class="card"></div>',
      '<div class="card" hidden></div>',
      '<dialog><div class="card"></div></dialog>',
      '<div popover><div class="card"></div></div>',
      '<details><summary>s</summary><div class="card"></div></details>',
      '<template><div class="card"></div></template>',
      '<a class="item"></a><a class="item"></a>',
      '<i class="a"></i><i class="a"></i><i class="b"></i><i class="b"></i><i class="c"></i><i class="c"></i>',
    ].join(''));
    expect(res.status).toBe('passed');
  });

  it('counts the open details content and open dialogs', async () => {
    const res = await run('.card { view-transition-name: card; }', '<details open><summary>s</summary><div class="card"></div></details><dialog open><div class="card"></div></dialog>');
    expect(res.nodes).toHaveLength(1);
  });

  it('counts the implicit root name from the UA stylesheet', async () => {
    let res = await run('.page { view-transition-name: root; }', '<div class="page"></div>');
    expect(res.nodes).toEqual([expect.objectContaining({ selector: '.page', data: { count: 2, elements: ['html', 'body > div.page'], name: 'root' } })]);
    res = await run(':root { view-transition-name: none; }\n.page { view-transition-name: root; }', '<div class="page"></div>');
    expect(res.status).toBe('passed');
  });

  it('keeps mutually exclusive media queries apart', async () => {
    const res = await run('@media (min-width: 800px) { .side { view-transition-name: hero; } }\n@media (max-width: 799px) { .main { view-transition-name: hero; } }', '<div class="side"></div><div class="main"></div>');
    expect(res.status).toBe('passed');
  });

  it('prefers runtime evidence under --dynamic', async () => {
    const facts = readFixtureJson('transitions/facts/masked.json');
    facts.sweep.viewTransitionNames = [{ name: 'card', selectors: ['body > div.card:nth-of-type(1)', 'body > div.card:nth-of-type(2)'] }];
    const res = await run('.card { view-transition-name: card; }\n.hero, .promo { view-transition-name: hero; }', '<div class="card"></div><div class="card"></div><div class="hero"></div><div class="promo"></div>', { dynamic: facts });
    expect(res.nodes).toEqual([
      expect.objectContaining({ selector: '.hero, .promo', confidence: 'low', message: expect.stringContaining('not on 2 rendered boxes') }),
      { selector: 'body > div.card:nth-of-type(1)', snippet: 'view-transition-name: card', location: '(runtime)', confidence: 'high', message: expect.stringContaining('rendered element'), data: { elements: facts.sweep.viewTransitionNames[0].selectors, name: 'card' } },
    ]);
  });

  it('reports runtime duplicates without any CSS declaration, and keeps static findings when the sweep failed', async () => {
    const facts = readFixtureJson('transitions/facts/masked.json');
    let res = await run('', '<p>x</p>', { dynamic: facts });
    expect(res.nodes.map((n) => n.snippet)).toEqual(['view-transition-name: product-card']);
    facts.sweep = null;
    res = await run('.card { view-transition-name: card; }', '<div class="card"></div><div class="card"></div>', { dynamic: facts });
    expect(res.nodes[0].confidence).toBeUndefined();
  });

  it('is not applicable without view-transition-name', async () => {
    expect((await run('.a { color: red; }', '<p>x</p>')).status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------

describe('speculation-rules-immediate-abuse', () => {
  const links = (n, prefix = '/p/') => Array.from({ length: n }, (_, i) => `<a class="p" href="${prefix}${i + 1}.html">${i + 1}</a>`).join('');
  const rulesTag = (json) => `<script type="speculationrules">${JSON.stringify(json)}</script>`;
  const run = (json, body) => check('speculation-rules-immediate-abuse', page(body, rulesTag(json)));

  it('flags an immediate prerender document rule over 10 links', async () => {
    const res = await run({ prerender: [{ where: { href_matches: '/p/*' }, eagerness: 'immediate' }] }, links(11));
    expect(res.nodes).toEqual([expect.objectContaining({
      selector: 'head > script', snippet: '<script type="speculationrules">',
      data: { action: 'prerender', candidates: 11, limit: 10, source: 'document' },
    })]);
  });

  it('treats list rules as immediate by default and prefetch caps at 50', async () => {
    const urls = Array.from({ length: 51 }, (_, i) => `/u/${i}`);
    const res = await run({ prerender: [{ urls: urls.slice(0, 11) }], prefetch: [{ urls }, { urls: urls.slice(0, 50) }] }, '<p>x</p>');
    expect(res.nodes.map((n) => `${n.data.action}:${n.data.candidates}`)).toEqual(['prefetch:51', 'prerender:11']);
  });

  it('supports selector_matches, :name segments, and/or/not and <base href>', async () => {
    const pred = { and: [{ selector_matches: 'a.p' }, { not: { href_matches: 'items/1.html' } }, { or: [{ href_matches: 'items/:id' }, { href_matches: ['/never/*'], relative_to: 'document' }] }] };
    let res = await check('speculation-rules-immediate-abuse', page(`${links(12, 'items/')}<a href="items/2.html">dup</a><a href="other/1.html">o</a>`, `<base href="https://shop.example.com/">${rulesTag({ prerender: [{ where: pred, eagerness: 'immediate' }] })}`));
    expect(res.nodes[0].data.candidates).toBe(11);
    res = await check('speculation-rules-immediate-abuse', page(links(12), rulesTag({ prerender: [{ source: 'document', eagerness: 'immediate' }] })));
    expect(res.nodes[0].data.candidates).toBe(12);
  });

  it('passes at the cap, with softer eagerness, duplicate URLs and unsupported predicates', async () => {
    const cases = [
      [{ prerender: [{ where: { href_matches: '/p/*' }, eagerness: 'immediate' }] }, links(10)],
      [{ prerender: [{ where: { href_matches: '/p/*' }, eagerness: 'moderate' }] }, links(20)],
      [{ prerender: [{ where: { href_matches: '/p/*' } }] }, links(20)],
      [{ prerender: [{ where: { href_matches: '/p/*' }, eagerness: 'immediate' }] }, `${links(5)}${links(5)}${links(5)}<a href="#top">top</a><a href="mailto:a@b.c">m</a><a href="index.html">self</a>`],
      [{ prerender: [{ where: { href_matches: { pathname: '/p/*' } }, eagerness: 'immediate' }] }, links(20)],
      [{ prerender: [{ where: { href_matches: '/p/(\\d+)' }, eagerness: 'immediate' }] }, links(20)],
      [{ prerender: [{ where: { selector_matches: 'a:has(img)' }, eagerness: 'immediate' }] }, links(20)],
      [{ prerender: [{ where: { href_matches: '/p/*', selector_matches: 'a' }, eagerness: 'immediate' }] }, links(20)],
      [{ prerender: [{ where: { href_matches: '/p/*', relative_to: 'nowhere' }, eagerness: 'immediate' }] }, links(20)],
      [{ prerender: [{ urls: ['/a'], where: { href_matches: '/*' }, eagerness: 'immediate' }, { source: 'list', eagerness: 'immediate' }, 'junk'] }, links(20)],
      [{ prerender: [{ where: { not: { href_matches: '/x/*' } }, eagerness: 'immediate' }] }, links(3)],
    ];
    for (const [json, body] of cases) {
      const res = await run(json, body);
      expect(res.status, JSON.stringify(json)).toBe('passed');
    }
  });

  it('resolves patterns against the final URL of an http page', async () => {
    const body = page(`${links(12)}<a href="/p/1.html#top">dup</a><a href="/list.html">self</a>`, rulesTag({ prerender: [{ where: { href_matches: '/*' }, eagerness: 'immediate' }] }));
    const res = await withServer((req, res2) => {
      res2.writeHead(200, { 'content-type': 'text/html' });
      res2.end(body);
    }, (base) => auditRuntimeUx({ url: `${base}/list.html`, areas: ['transitions'], rules: [R['speculation-rules-immediate-abuse']], timestamp: FIXED_TS, write: false }));
    expect(res.raw.violations[0].nodes[0].data.candidates).toBe(12);
  });

  it('is not applicable without parsed speculation rules', async () => {
    expect((await check('speculation-rules-immediate-abuse', page('<script type="speculationrules">{nope</script>'))).status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------

describe('speculation-rules-csp-gap', () => {
  const RULES_JSON = '{"prefetch":[{"source":"document","where":{"href_matches":"/*"}}]}';
  const run = (csp, attrs = '', text = RULES_JSON) => check('speculation-rules-csp-gap', page('<a href="/a">a</a>', `${csp === null ? '' : `<meta http-equiv="Content-Security-Policy" content="${csp}">`}<script type="speculationrules"${attrs}>${text}</script>`));
  const sha = (alg, text) => createHash(alg).update(text).digest('base64');

  it('flags inline rules blocked by a meta policy and suggests the hash', async () => {
    const res = await run("script-src 'self'");
    expect(res.nodes).toEqual([expect.objectContaining({
      selector: 'head > script',
      message: "Blocked by the meta CSP script-src: add 'inline-speculation-rules', a matching nonce or the sha256 hash to script-src.",
      data: { directive: 'script-src', policy: 'meta', sha256: `'sha256-${sha('sha256', RULES_JSON)}'` },
    })]);
  });

  it('checks script-src-elem first and default-src last', async () => {
    expect((await run("default-src 'self'")).nodes[0].data.directive).toBe('default-src');
    expect((await run("script-src 'self'; script-src-elem 'inline-speculation-rules'")).status).toBe('passed');
    expect((await run("script-src 'inline-speculation-rules'; script-src-elem 'self'")).nodes[0].data.directive).toBe('script-src-elem');
  });

  it('flags unsafe-inline when a nonce, a hash or strict-dynamic disables it', async () => {
    expect((await run("script-src 'unsafe-inline' 'nonce-abc'")).status).toBe('failed');
    expect((await run("script-src 'unsafe-inline' 'strict-dynamic'")).status).toBe('failed');
    expect((await run("script-src 'nonce-abc'", ' nonce="xyz"')).status).toBe('failed');
  });

  it('passes allowed rules: keyword, unsafe-inline, nonce and hashes', async () => {
    const cases = [
      ["script-src 'self' 'INLINE-SPECULATION-RULES'"],
      ["script-src 'unsafe-inline'"],
      ["script-src 'nonce-abc'", ' nonce="abc"'],
      [`script-src 'sha256-${sha('sha256', RULES_JSON)}'`],
      [`script-src 'SHA384-${sha('sha384', RULES_JSON).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}'`],
      ["img-src 'self'"],
    ];
    for (const [csp, attrs] of cases) {
      const res = await run(csp, attrs);
      expect(res.status, csp).toBe('passed');
    }
  });

  it('reads header policies over http and ignores report-only ones', async () => {
    const body = page('<a href="/a">a</a>', `<script type="speculationrules">${RULES_JSON}</script>`);
    const audit = (url) => auditRuntimeUx({ url, areas: ['transitions'], rules: [R['speculation-rules-csp-gap']], timestamp: FIXED_TS, write: false });
    const blocked = await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "img-src 'self', script-src 'self'" });
      res.end(body);
    }, audit);
    expect(blocked.raw.violations[0].nodes[0].data).toMatchObject({ directive: 'script-src', policy: 'header' });
    const reportOnly = await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy-report-only': "script-src 'self'" });
      res.end(body);
    }, audit);
    expect(reportOnly.raw.rules[0]).toMatchObject({ status: 'notApplicable', reason: 'no Content-Security-Policy' });
  });

  it('is not applicable without inline rules or without a policy', async () => {
    expect((await run(null)).reason).toBe('no Content-Security-Policy');
    const res = await check('speculation-rules-csp-gap', page('<p>x</p>', `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`));
    expect(res.reason).toBe('no inline speculation rules');
  });
});

// ---------------------------------------------------------------------------

describe('analytics-without-prerender-guard', () => {
  const run = (js, extra = '') => check('analytics-without-prerender-guard', page(`${script(js)}${extra}`));

  it('flags top-level page views from the known libraries', async () => {
    const res = await run([
      "ga('create', 'UA-1', 'auto');",
      "ga('send', 'pageview');",
      "ga('t0.send', { hitType: 'pageview', page: '/x' });",
      "(function () { fbq('track', 'PageView'); })();",
      "window._paq.push(['trackPageView']);",
      "!function () { analytics.page(); }();",
    ].join('\n'));
    expect(snippets(res)).toEqual([
      "ga('send', 'pageview')", "ga('t0.send', { hitType: 'pageview', page: '/x' })", "fbq('track', 'PageView')",
      "window._paq.push(['trackPageView'])", 'analytics.page()',
    ]);
  });

  it('passes guarded pages, gtag, events and calls made later', async () => {
    const cases = [
      ["if (document.prerendering) { document.addEventListener('prerenderingchange', () => ga('send', 'pageview'), { once: true }); } else { ga('send', 'pageview'); }", 'passed'],
      ["button.addEventListener('click', () => { analytics.page(); fbq('track', 'Lead'); });", 'passed'],
      ["ga('send', 'event', 'cta', 'click'); fbq('trackCustom', 'x'); _paq.push(['trackEvent', 'a']); _paq.push(tracker); ga('send', { hitType: 'event' }); new ga('send', 'pageview');", 'notApplicable'],
      ["gtag('config', 'G-1'); gtag('event', 'page_view');", 'notApplicable'],
    ];
    for (const [js, want] of cases) {
      const res = await run(js);
      expect(res.status, js).toBe(want);
    }
  });

  it('routes findings to incomplete when a script could not be read', async () => {
    const res = await run("ga('send', 'pageview');", '<script src="js/missing.js"></script>');
    expect(res.status).toBe('incomplete');
    expect(res.incomplete).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('shared helpers', () => {
  it('computes selector specificity', () => {
    const cases = [
      ['*', [0, 0, 0]], ['li', [0, 0, 1]], ['ul li.a', [0, 1, 2]], ['#x .y[z] a:hover', [1, 3, 1]],
      ['a::before', [0, 0, 2]], ['a:before', [0, 0, 2]], [':is(#a, .b) p', [1, 0, 1]], [':where(#a) p', [0, 0, 1]],
      [':not(.a, #b)', [1, 0, 0]], ['li:nth-child(2n of .x, #y)', [1, 1, 1]], [':nth-of-type(2)', [0, 1, 0]],
      ['svg|rect', [0, 0, 1]], ['[data-x="a b"] > .c', [0, 2, 0]], ['::part(label)', [0, 0, 1]], ['.a\\:b', [0, 1, 0]],
    ];
    for (const [sel, want] of cases) expect(specificity(sel), sel).toEqual(want);
    expect(compareSpecificity([0, 1, 0], [0, 0, 9])).toBeGreaterThan(0);
  });

  it('reads the motion preference of media preludes', () => {
    const cases = [
      ['(prefers-reduced-motion: reduce)', 'reduce'], ['(prefers-reduced-motion)', 'reduce'],
      ['screen and (prefers-reduced-motion: reduce)', 'reduce'], ['not (prefers-reduced-motion: reduce)', 'no-preference'],
      ['not all and (prefers-reduced-motion: no-preference)', 'reduce'], ['(prefers-reduced-motion: no-preference)', 'no-preference'],
      ['(prefers-reduced-motion: reduce), print', null], ['(min-width: 600px)', null], ['(prefers-reduced-motion: bogus)', null],
      ['(prefers-reduced-motion: reduce), (prefers-reduced-motion)', 'reduce'],
    ];
    for (const [m, want] of cases) expect(motionPreferenceOf(m), m).toBe(want);
    expect(inReduceMotion({ context: { media: ['(min-width: 1px)', '(prefers-reduced-motion: reduce)'] } })).toBe(true);
    expect(inNoPreference({ media: [] })).toBe(false);
    expect(inReduceMotion(null)).toBe(false);
  });

  it('compiles the supported URL pattern subset', () => {
    const resolve = (h) => new URL(h, 'https://a.example/dir/page.html').href;
    expect(compileHrefPattern('/p/*', resolve).test('https://a.example/p/x/y')).toBe(true);
    expect(compileHrefPattern('/p/*', resolve).test('https://b.example/p/x')).toBe(false);
    expect(compileHrefPattern('items/:id', resolve).test('https://a.example/dir/items/7')).toBe(true);
    expect(compileHrefPattern('items/:id', resolve).test('https://a.example/dir/items/7/x')).toBe(false);
    expect(compileHrefPattern('https://*.example/*', resolve).test('https://cdn.example/x')).toBe(true);
    for (const bad of ['/p/(\\d+)', '/p?q=*', '/a/{b}?', '', 42, '/p/:id+']) expect(compileHrefPattern(bad, resolve), String(bad)).toBeNull();
    expect(compileHrefPattern('/x', () => null)).toBeNull();
    expect(stripQueryHash('https://a/b?c#d')).toBe('https://a/b');
  });
});

// ---------------------------------------------------------------------------

describe('transitions fixture', () => {
  it('matches the static golden report', async () => {
    const res = await runFixture('transitions');
    expectGolden('transitions.report.md', res.markdown);
    expectGolden('transitions.raw.json', rawJson(res.raw));
    expect(res.pass).toBe(false);
    expectAsciiNoDash(res.markdown, 'transitions report');
    const ids = new Set(res.raw.violations.map((v) => v.ruleId.replace('atelier/runtime-ux/', '')));
    for (const id of Object.keys(R)) {
      if (R[id].phase === 'dynamic' || R[id].requires) continue;
      expect(ids.has(id), id).toBe(true);
    }
    expect(res.raw.rules.find((r) => r.id.endsWith('analytics-without-prerender-guard')).suppressed).toBe(1);
  });

  it('matches the dynamic golden report with synthetic facts', async () => {
    const facts = readFixtureJson('transitions/facts/masked.json');
    const res = await runFixture('transitions', { dynamic: true, dynamicImpl: async () => facts });
    expectGolden('transitions.dynamic.report.md', res.markdown);
    expectGolden('transitions.dynamic.raw.json', rawJson(res.raw));
    const ids = res.raw.violations.map((v) => v.ruleId);
    expect(ids).toContain('atelier/runtime-ux/bfcache-not-restored');
  });

  it('keeps every finding message within the report limit', async () => {
    const res = await runFixture('transitions', { dynamic: true, dynamicImpl: async () => readFixtureJson('transitions/facts/masked.json') });
    for (const v of [...res.raw.violations, ...res.raw.incomplete]) {
      for (const n of v.nodes) {
        expect(n.message?.length ?? 0, v.ruleId).toBeLessThanOrEqual(200);
        expect(n.message?.endsWith('...'), v.ruleId).not.toBe(true);
      }
    }
  });
});

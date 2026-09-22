import { describe, it, expect } from 'vitest';
import { sharp } from '../helpers/plugin-deps.mjs';
import {
  contextFor, runRule, runFixture, expectGolden, rawJson, readFixtureJson, expectAsciiNoDash,
} from './helpers.mjs';
import { RULES } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { headlineRuleIds } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import { rules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/mobile/index.mjs';
import { largestIconSize } from '../../plugins/atelier/skills/runtime-ux-audit/rules/mobile/pwa.mjs';
import { selectorWords, hasEarlyExit } from '../../plugins/atelier/skills/runtime-ux-audit/rules/mobile/shared.mjs';

const PREFIX = 'atelier/runtime-ux/';
const R = Object.fromEntries(rules.map((r) => [r.id.slice(PREFIX.length), r]));

const VP = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const COVER = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';

/** A page with a head, a body and extra files. */
const page = (head, body = '', extra = {}) => ({
  'index.html': `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  ...extra,
});
/** A page that links site.css. */
const withCss = (css, { head = VP, body = '', extra = {} } = {}) => page(`${head}<link rel="stylesheet" href="site.css">`, body, { 'site.css': css, ...extra });
/** A page that loads app.js. */
const withJs = (js, { head = VP, body = '' } = {}) => page(head, `${body}<script src="app.js"></script>`, { 'app.js': js });

async function run(id, files, opts) {
  const ctx = await contextFor(files, opts);
  return runRule(R[id], ctx);
}

const snippets = (r) => r.nodes.map((n) => n.snippet);

// ---------------------------------------------------------------------------

describe('mobile registry', () => {
  it('ships the 17 designed rules, valid and in the mobile area', () => {
    expect(Object.keys(R).sort()).toEqual([
      'carousel-no-scroll-snap', 'double-tap-js-override', 'env-safe-area-without-viewport-fit-cover', 'fixed-bottom-no-safe-area',
      'fixed-header-vh-sized', 'hover-only-affordance', 'missing-interactive-widget', 'modal-no-overscroll-behavior',
      'non-passive-touch-listener', 'push-permission-no-display-mode-guard', 'pwa-no-apple-touch-icon', 'scroll-hijack',
      'tap-target-under-minimum', 'user-scalable-no', 'uses-vh-without-dvh', 'viewport-meta-missing', 'webkit-overflow-scrolling-touch',
    ]);
    for (const r of rules) {
      expect(r.area).toBe('mobile');
      expect(RULES).toContain(r);
      expectAsciiNoDash(r.description, r.id);
      expect(r.description.length).toBeLessThan(200);
    }
    const mobileHeadlines = headlineRuleIds().filter((id) => rules.some((r) => r.id === id) || id.includes('tap-target'));
    for (const id of mobileHeadlines) expect(RULES.some((r) => r.id === id), id).toBe(true);
  });
});

describe('uses-vh-without-dvh', () => {
  it('flags 100vh and calc(100vh - x) heights with no dynamic fallback', async () => {
    const body = '<section class="hero"><h1>Hi</h1></section><main class="app">App</main><aside class="side">Side</aside>';
    const r = await run('uses-vh-without-dvh', withCss('.hero { min-height: 100vh }\n.app { height: calc(100vh - 64px) }\n.side { max-block-size: 95vh }', { body }));
    expect(r.status).toBe('failed');
    expect(snippets(r)).toEqual(['.hero { min-height: 100vh }', '.app { height: calc(100vh - 64px) }', '.side { max-block-size: 95vh }']);
    expect(r.nodes[0]).toMatchObject({ location: 'site.css:1:9', data: { prop: 'min-height', vh: 100 } });
  });

  it('passes a later dvh, svh, lvh, fill-available or scripted fallback in the same rule or a same-selector rule', async () => {
    const css = [
      '.a { height: 100vh; height: 100dvh }',
      '.b { min-height: 100vh; min-height: 100svh }',
      '.c { height: 100vh; height: -webkit-fill-available }',
      '.d { min-height: 100vh }',
      '@supports (height: 100dvh) { .d { min-height: 100dvh } }',
      ':root { --full: 100lvh }',
      '.e { height: 100vh; height: var(--full) }',
      '.f { height: 100vh; height: calc(var(--vh) * 100) }',
      '.g { height: calc(var(--vh, 1vh) * 100) }',
      '.h { height: 50vh; width: 100vw }',
      '@supports not (height: 1dvh) { .i { height: 100vh } }',
      '@keyframes grow { from { height: 0 } to { height: 100vh } }',
    ].join('\n');
    const files = withCss(css, { body: '<script src="app.js"></script>', extra: { 'app.js': "document.documentElement.style.setProperty('--vh', innerHeight / 100 + 'px');" } });
    const r = await run('uses-vh-without-dvh', files);
    expect(r.status).toBe('passed');
  });

  it('passes a vh utility class when the same element also gets a dvh utility, and flags it otherwise', async () => {
    const css = '.min-h-screen { min-height: 100vh }\n.min-h-dvh { min-height: 100dvh }';
    expect((await run('uses-vh-without-dvh', withCss(css, { body: '<main class="min-h-screen min-h-dvh"></main>' }))).status).toBe('passed');
    const alone = await run('uses-vh-without-dvh', withCss(css, { body: '<main class="min-h-screen">Main</main><div class="min-h-dvh"></div>' }));
    expect(snippets(alone)).toEqual(['.min-h-screen { min-height: 100vh }']);
  });

  it('still flags a dvh declaration that the vh one overrides', async () => {
    const r = await run('uses-vh-without-dvh', withCss('.a { height: 100dvh; height: 100vh }\n.b { height: 100vh !important }\n.b { height: 100dvh }', { body: '<div class="a">A</div><div class="b">B</div>' }));
    expect(snippets(r)).toEqual(['.a { height: 100vh }', '.b { height: 100vh !important }']);
  });

  it('sends unused CSS and empty boxes to review (calibration: framework utilities and backdrops)', async () => {
    const css = '.vh-100 { height: 100vh }\n.modal-backdrop { position: fixed; height: 100vh }\n.hero { min-height: 100vh }\n.x:has(p) { height: 100vh }';
    const r = await run('uses-vh-without-dvh', withCss(css, { body: '<div class="modal-backdrop"></div><section class="hero">Hero</section>' }));
    expect(snippets(r)).toEqual(['.hero { min-height: 100vh }', '.x:has(p) { height: 100vh }']);
    expect(r.incomplete.map((n) => [n.snippet, n.message])).toEqual([
      ['.vh-100 { height: 100vh }', 'height uses 100vh with no dvh or svh fallback; check it: no element in the page HTML matches it, so check that the rule is in use.'],
      ['.modal-backdrop { height: 100vh }', 'height uses 100vh with no dvh or svh fallback; check it: every matching element is empty in the page HTML (a backdrop, or content a script adds later).'],
    ]);
    // Style attributes always apply to their element.
    const inline = await run('uses-vh-without-dvh', page(VP, '<div style="height: 100vh"></div>'));
    expect(inline.status).toBe('failed');
  });
});

describe('fixed-header-vh-sized', () => {
  it('flags fixed and sticky elements sized in vh below 90', async () => {
    const css = [
      '.header { position: fixed; top: 0; height: 12vh }',
      '.rail { position: sticky }',
      '.rail { max-height: 60vh }',
    ].join('\n');
    const r = await run('fixed-header-vh-sized', withCss(css));
    expect(snippets(r)).toEqual(['.header { height: 12vh }', '.rail { max-height: 60vh }']);
    expect(r.nodes[0].message).toBe('position: fixed element sized with height: 12vh; use svh or dvh.');
    expect(r.nodes[1].data).toEqual({ position: 'sticky', prop: 'max-height', vh: 60 });
  });

  it('passes static boxes, dvh sizes, 100vh (uses-vh territory) and position set only in a desktop query', async () => {
    const css = [
      '.box { height: 12vh }',
      '.h1 { position: fixed; height: 12svh }',
      '.h2 { position: fixed; height: 100vh }',
      '.h3 { position: fixed; height: 12vh; height: 12dvh }',
      '@media (min-width: 900px) { .h4 { position: fixed } }',
      '.h4 { height: 10vh }',
      '.h5 { position: relative; height: 10vh }',
      '.h6 { position: fixed; height: 0vh }',
    ].join('\n');
    expect((await run('fixed-header-vh-sized', withCss(css))).status).toBe('passed');
  });
});

describe('env-safe-area-without-viewport-fit-cover', () => {
  const css = ':root { --sab: env(safe-area-inset-bottom) }\n.bar { padding-bottom: env( safe-area-inset-bottom, 8px) }';

  it('flags env() insets without viewport-fit=cover once, at the viewport meta', async () => {
    const r = await run('env-safe-area-without-viewport-fit-cover', withCss(css));
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]).toMatchObject({ selector: 'head > meta', data: { envDecls: 2 } });
    expect(r.nodes[0].message).toContain('first at site.css:1:9');
  });

  it('points at the document when there is no viewport meta', async () => {
    const r = await run('env-safe-area-without-viewport-fit-cover', withCss(css, { head: '' }));
    expect(r.nodes[0]).toMatchObject({ selector: 'document', snippet: 'no viewport meta', location: 'index.html' });
  });

  it('passes with viewport-fit=cover and is not applicable without env()', async () => {
    expect((await run('env-safe-area-without-viewport-fit-cover', withCss(css, { head: COVER }))).status).toBe('passed');
    expect(await run('env-safe-area-without-viewport-fit-cover', withCss('.a { padding: 8px }'))).toMatchObject({ status: 'notApplicable', reason: 'no env(safe-area-inset-*) in CSS' });
  });
});

describe('fixed-bottom-no-safe-area', () => {
  it('is not applicable without viewport-fit=cover', async () => {
    const r = await run('fixed-bottom-no-safe-area', withCss('.bar { position: fixed; bottom: 0 }'));
    expect(r).toMatchObject({ status: 'notApplicable', reason: 'viewport-fit is not cover' });
  });

  it('flags bottom-pinned fixed bars via bottom, inset and inset-block, with position from a same-selector rule', async () => {
    const css = [
      '.tabbar { position: fixed; left: 0; right: 0; bottom: 0 }',
      '.sheet { position: fixed; inset: auto 0 0 }',
      '.dock { position: fixed; inset-block: auto 0px }',
      '.toast { position: fixed }',
      '.toast { bottom: 0 }',
    ].join('\n');
    const r = await run('fixed-bottom-no-safe-area', withCss(css, { head: COVER }));
    expect(snippets(r)).toEqual(['.tabbar { position: fixed }', '.sheet { position: fixed }', '.dock { position: fixed }', '.toast { position: fixed }']);
    expect(r.nodes[0].message).toContain('.tabbar is fixed at bottom 0');
  });

  it('passes overlays, offset bars, hidden bars and every accepted form of safe-area evidence', async () => {
    const css = [
      ':root { --sab: env(safe-area-inset-bottom) }',
      '.overlay { position: fixed; inset: 0 }',
      '.split { position: fixed; top: 0 }',
      '.split { bottom: 0 }',
      '.fab { position: fixed; bottom: 16px }',
      '.hidden-bar { position: fixed; bottom: 0; display: none }',
      '.a { position: fixed; bottom: 0; padding-bottom: env(safe-area-inset-bottom) }',
      '.b { position: fixed; bottom: 0; padding: 8px 8px max(8px, var(--sab)) }',
      '.c { position: fixed; bottom: 0 }',
      '.c > .inner { padding-bottom: constant(safe-area-inset-bottom) }',
      '.d { position: fixed; bottom: 0 }',
      '#d-el { margin-bottom: env(safe-area-inset-bottom) }',
      '.e { position: fixed; bottom: 0 }',
      '.e-inner { height: calc(56px + env(safe-area-inset-bottom)) }',
      '.f { position: fixed; bottom: 0 }',
      '@supports (padding: env(safe-area-inset-bottom)) { .f { padding-bottom: env(safe-area-inset-bottom) } }',
      '.g { position: absolute; bottom: 0 }',
    ].join('\n');
    const body = '<div class="d" id="d-el"></div><div class="e"><div class="e-inner"></div></div><div class="s" style="position: fixed; bottom: 0; padding-bottom: var(--sab)"></div>';
    const r = await run('fixed-bottom-no-safe-area', withCss(css, { head: COVER, body }));
    expect(r.status).toBe('passed');
  });

  it('flags a style attribute bar and reports incomplete when a stylesheet is missing', async () => {
    const body = '<nav id="bar" style="position: fixed; bottom: 0"></nav>';
    const r = await run('fixed-bottom-no-safe-area', page(`${COVER}<link rel="stylesheet" href="missing.css">`, body));
    expect(r.status).toBe('incomplete');
    expect(r.incomplete[0]).toMatchObject({ selector: '#bar', snippet: 'style="position: fixed"' });
  });

  it('honors a CSS atelier-ignore comment', async () => {
    const r = await run('fixed-bottom-no-safe-area', withCss('/* atelier-ignore fixed-bottom-no-safe-area */\n.bar { position: fixed; bottom: 0 }', { head: COVER }));
    expect(r).toMatchObject({ status: 'passed', suppressed: 1 });
  });
});

describe('tap-target-under-minimum', () => {
  const facts = () => readFixtureJson('mobile/facts/tap-targets.json');
  const site = { 'index.html': `<!doctype html><html><head>${VP}</head><body><button>x</button></body></html>` };

  it('is dynamic only', async () => {
    expect(await run('tap-target-under-minimum', site)).toMatchObject({ status: 'skipped', reason: 'dynamic-only' });
  });

  it('applies the WCAG 2.5.8 spacing exception at the default 24px floor', async () => {
    const r = await run('tap-target-under-minimum', site, { dynamic: facts() });
    expect(r.nodes.map((n) => [n.selector, n.message, n.data.overlaps])).toEqual([
      // Runtime findings keep the sweep's DOM order.
      ['#menu-toggle', '12x12 px < 24', '#search'],
      ['#search', '12x12 px < 24', '#menu-toggle'],
      ['#prev', '20x20 px < 24', '#next'],
    ]);
    expect(r.nodes[0]).toMatchObject({ snippet: 'button "Menu"', location: '(runtime)', data: { width: 12, height: 12, minTapPx: 24 } });
  });

  it('checks size only against a brand floor', async () => {
    const r = await run('tap-target-under-minimum', site, { dynamic: facts(), brand: { targets: { minTapPx: 44 } } });
    expect(r.nodes.map((n) => [n.selector, n.message])).toEqual([
      ['#menu-toggle', '12x12 px < 44'],
      ['#search', '12x12 px < 44'],
      ['#prev', '20x20 px < 44'],
      ['#next', '60x30 px < 44'],
      ['#lone-help', '16x16 px < 44'],
      ['body > main > a.card > button.fav', '16x16 px < 44'],
      ['#tab-map', '40x20 px < 44'],
      ['#tab-list', '40x20 px < 44'],
    ]);
    expect(r.nodes.every((n) => n.data.overlaps === undefined)).toBe(true);
  });

  it('passes targets exactly 24px apart, allows sub-pixel slack and flags overlapping ones', async () => {
    const item = (selector, x, y, width, height) => ({ selector, tag: 'button', role: null, type: null, text: '', rect: { x, y, width, height }, visible: true, disabled: false, inlineInText: false });
    const sweep = (interactive) => ({ ...facts(), sweep: { interactive, interactiveTruncated: false, repeatedGroups: [], viewTransitionNames: [] } });
    const spaced = await run('tap-target-under-minimum', site, { dynamic: sweep([item('#a', 0, 0, 20, 20), item('#b', 24, 0, 20, 20), item('#c', 100, 0, 23.6, 23.6)]) });
    expect(spaced.status).toBe('passed');
    const touching = await run('tap-target-under-minimum', site, { dynamic: sweep([item('#a', 0, 0, 20, 20), item('#b', 20, 0, 20, 20)]) });
    expect(touching.nodes.map((n) => n.selector)).toEqual(['#a', '#b']);
    const rectHit = await run('tap-target-under-minimum', site, { dynamic: sweep([item('#a', 0, 0, 10, 10), item('#big', 12, 0, 100, 100)]) });
    expect(rectHit.nodes.map((n) => [n.selector, n.data.overlaps])).toEqual([['#a', '#big']]);
  });

  it('reports a truncated sweep as incomplete and a missing sweep as not applicable', async () => {
    const truncated = { ...facts(), sweep: { ...facts().sweep, interactive: [], interactiveTruncated: true } };
    const r = await run('tap-target-under-minimum', site, { dynamic: truncated });
    expect(r.status).toBe('incomplete');
    expect(r.incomplete[0]).toMatchObject({ selector: 'document', location: '(runtime)' });
    expect(await run('tap-target-under-minimum', site, { dynamic: { ...facts(), sweep: null } })).toMatchObject({ status: 'notApplicable' });
  });
});

describe('non-passive-touch-listener', () => {
  it('flags root touchstart/touchmove listeners with explicit passive: false', async () => {
    const js = [
      "window.addEventListener('touchmove', onMove, { passive: false });",
      'function onMove(e) { if (e.touches.length > 1) e.preventDefault(); }',
      "document.addEventListener('touchstart', function (e) { track(e); }, { passive: !1 });",
      "document.body.addEventListener('touchmove', (e) => { if (!dragging) return; e.preventDefault(); }, { passive: false });",
      "addEventListener('touchstart', handler, { passive: false, capture: true });",
    ].join('\n');
    const r = await run('non-passive-touch-listener', withJs(js));
    expect(r.nodes.map((n) => [n.location, n.data.event, n.data.target])).toEqual([
      ['app.js:1:1', 'touchmove', 'window'],
      ['app.js:3:1', 'touchstart', 'document'],
      ['app.js:4:1', 'touchmove', 'root-element'],
      ['app.js:5:1', 'touchstart', 'window'],
    ]);
    expect(r.nodes[0].message).toContain('touchmove on window with passive: false');
  });

  it('passes default (passive) root listeners, element listeners, other events and scroll-hijack cases', async () => {
    const js = [
      "window.addEventListener('touchmove', onMove);",
      "window.addEventListener('touchstart', onMove, { passive: true });",
      "window.addEventListener('touchstart', onMove, false);",
      "slider.addEventListener('touchmove', onMove, { passive: false });",
      "window.addEventListener('wheel', onMove, { passive: false });",
      "document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });",
      'window.ontouchmove = onMove;',
      'function onMove() {}',
    ].join('\n');
    expect((await run('non-passive-touch-listener', withJs(js))).status).toBe('passed');
  });
});

describe('scroll-hijack', () => {
  it('flags root listeners with passive: false that always call preventDefault()', async () => {
    const js = [
      "document.addEventListener('wheel', (e) => { e.preventDefault(); scroller.scrollBy(0, e.deltaY); }, { passive: false });",
      "document.body.addEventListener('touchmove', function (e) {",
      '  e.preventDefault();',
      '}, { passive: false });',
      "window.addEventListener('DOMMouseScroll', stop, { passive: false });",
      'function stop(e) { e?.preventDefault(); }',
      "window.addEventListener('mousewheel', (e) => e.preventDefault(), { passive: false });",
    ].join('\n');
    const r = await run('scroll-hijack', withJs(js));
    expect(r.nodes.map((n) => [n.location, n.data.event])).toEqual([
      ['app.js:1:1', 'wheel'], ['app.js:2:1', 'touchmove'], ['app.js:5:1', 'dommousescroll'], ['app.js:7:1', 'mousewheel'],
    ]);
    expect(r.nodes[1].message).toContain('calls preventDefault() unconditionally (app.js:3:3)');
  });

  it('passes conditional, early-return guarded, async, passive-by-default and element listeners', async () => {
    const js = [
      "document.addEventListener('wheel', (e) => { if (zooming) e.preventDefault(); }, { passive: false });",
      "document.addEventListener('touchmove', (e) => { if (!dragging) return; e.preventDefault(); }, { passive: false });",
      "document.addEventListener('touchmove', (e) => { dragging && e.preventDefault(); }, { passive: false });",
      "document.addEventListener('touchmove', (e) => { requestAnimationFrame(() => e.preventDefault()); }, { passive: false });",
      "document.addEventListener('wheel', (e) => { e.preventDefault(); });",
      "map.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });",
      "document.addEventListener('touchmove', handlers.move, { passive: false });",
    ].join('\n');
    expect((await run('scroll-hijack', withJs(js))).status).toBe('passed');
  });

  it('passes the drag pattern: a root touchmove blocker attached only while a gesture lasts', async () => {
    const js = [
      "handle.addEventListener('pointerdown', startDrag);",
      'function startDrag() {',
      "  document.addEventListener('touchmove', block, { passive: false });",
      "  window.addEventListener('wheel', block, { passive: false });",
      '}',
      "slider.addEventListener('touchstart', () => { document.addEventListener('touchmove', block, { passive: false }); });",
      'function block(e) { e.preventDefault(); }',
    ].join('\n');
    expect((await run('scroll-hijack', withJs(js))).status).toBe('passed');
    expect((await run('non-passive-touch-listener', withJs(js.replace(/e\.preventDefault\(\);/, 'if (e.scale) e.preventDefault();')))).status).toBe('passed');
    const later = await run('scroll-hijack', withJs("button.addEventListener('click', () => { document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false }); });"));
    expect(later.status).toBe('failed');
  });

  it('treats an early return inside a handler as a guard', () => {
    const block = { type: 'BlockStatement', body: [] };
    const guard = { type: 'IfStatement', consequent: { type: 'ReturnStatement' }, alternate: null };
    const call = { type: 'ExpressionStatement' };
    block.body.push(guard, call);
    expect(hasEarlyExit([{ type: 'ArrowFunctionExpression' }, block], call)).toBe(true);
    block.body.reverse();
    expect(hasEarlyExit([{ type: 'ArrowFunctionExpression' }, block], call)).toBe(false);
  });
});

describe('user-scalable-no', () => {
  const vp = (content) => page(`<meta name="viewport" content="${content}">`);

  it('flags user-scalable=no or 0 and maximum-scale below 2', async () => {
    for (const [content, msg] of [
      ['width=device-width, user-scalable=no', 'user-scalable=no blocks zooming to 200%; remove it.'],
      ['width=device-width, maximum-scale=1.0', 'maximum-scale=1.0 blocks zooming to 200%; remove it.'],
      ['width=device-width; user-scalable=0; maximum-scale=1', 'user-scalable=0 and maximum-scale=1 blocks zooming to 200%; remove it.'],
    ]) {
      const r = await run('user-scalable-no', vp(content));
      expect(r.nodes, content).toHaveLength(1);
      expect(r.nodes[0].message).toBe(msg);
      expect(r.nodes[0].location).toMatch(/^index\.html:1:\d+$/);
    }
  });

  it('passes zoomable viewports and is not applicable without a viewport meta', async () => {
    for (const content of ['width=device-width, initial-scale=1', 'width=device-width, maximum-scale=5', 'user-scalable=yes, maximum-scale=2', 'maximum-scale=device-width']) {
      expect((await run('user-scalable-no', vp(content))).status, content).toBe('passed');
    }
    expect((await run('user-scalable-no', page(''))).status).toBe('notApplicable');
  });

  it('also checks a viewport meta injected into the rendered DOM', async () => {
    const dynamic = { errors: [], rendered: { html: '<html><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body></body></html>' } };
    const r = await run('user-scalable-no', page(''), { dynamic });
    expect(r.nodes).toEqual([expect.objectContaining({ location: '(rendered DOM)' })]);
  });
});

describe('viewport-meta-missing', () => {
  it('flags a missing meta at the document and a fixed width at the meta', async () => {
    const none = await run('viewport-meta-missing', page('<title>x</title>'));
    expect(none.nodes).toEqual([expect.objectContaining({ selector: 'document', snippet: 'no viewport meta', location: 'index.html' })]);
    const fixed = await run('viewport-meta-missing', page('<meta name="viewport" content="width=1024">'));
    expect(fixed.nodes[0]).toMatchObject({ selector: 'head > meta', data: { width: '1024' } });
    expect(fixed.nodes[0].message).toBe('The viewport meta sets width=1024; use width=device-width.');
    const empty = await run('viewport-meta-missing', page('<meta name="viewport" content="">'));
    expect(empty.nodes[0].message).toBe('The viewport meta has no width key; use width=device-width.');
  });

  it('passes width=device-width, initial-scale alone and a meta the rendered DOM adds', async () => {
    expect((await run('viewport-meta-missing', page(VP))).status).toBe('passed');
    expect((await run('viewport-meta-missing', page('<META NAME="Viewport" content="initial-scale=1">'))).status).toBe('passed');
    const dynamic = { errors: [], rendered: { html: `<html><head>${VP}</head><body></body></html>` } };
    expect((await run('viewport-meta-missing', page(''), { dynamic })).status).toBe('passed');
  });
});

describe('carousel-no-scroll-snap', () => {
  it('flags scroll-snap-align without any snap container (high confidence)', async () => {
    const r = await run('carousel-no-scroll-snap', withCss('.slide { scroll-snap-align: start }\n.other { scroll-snap-align: center }'));
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]).toMatchObject({ snippet: '.slide { scroll-snap-align: start }', confidence: 'high' });
  });

  it('flags carousel-named horizontal scrollers with no scroll-snap-type', async () => {
    const css = [
      '.carousel { display: flex; overflow-x: auto }',
      '.productCarousel { display: inline-flex; overflow: scroll hidden; flex-direction: row }',
      '.gallery__track { display: grid; grid-auto-flow: column; overflow-x: auto }',
      '.swiper-wrapper { display: flex; flex-flow: row nowrap; overflow-x: scroll }',
    ].join('\n');
    const r = await run('carousel-no-scroll-snap', withCss(css));
    expect(snippets(r)).toEqual([
      '.carousel { overflow-x: auto }', '.productCarousel { overflow: scroll hidden }', '.gallery__track { overflow-x: auto }', '.swiper-wrapper { overflow-x: scroll }',
    ]);
    expect(r.nodes[0].confidence).toBeUndefined();
  });

  it('passes snapping carousels, wrapping or vertical rows, other names and script-driven snapping', async () => {
    const css = [
      '.carousel { display: flex; overflow-x: auto; scroll-snap-type: x mandatory }',
      '.slides { display: flex; overflow-x: auto }',
      '@media (min-width: 1px) { .slides { scroll-snap-type: x proximity } }',
      '.slider { display: flex; flex-wrap: wrap; overflow-x: auto }',
      '.reel { display: flex; flex-direction: column; overflow-x: auto }',
      '.rail { display: flex; flex-flow: column; overflow-x: auto }',
      '.tracks { display: grid; overflow-x: auto }',
      '.strip { display: block; overflow-x: auto }',
      '.gallery { display: flex; overflow-x: hidden }',
      '.stripe, .trail, .tracker { display: flex; overflow-x: auto }',
      '.chips { display: flex; overflow-x: auto }',
      '.slide { scroll-snap-align: start }',
      '.x-scroller { display: flex; overflow-x: auto }',
    ].join('\n');
    const body = '<div class="x-scroller" id="xs"></div>';
    const r = await run('carousel-no-scroll-snap', withCss(`${css}\n#xs { scroll-snap-type: x mandatory }`, { body }));
    expect(r.status).toBe('passed');
    const js = await run('carousel-no-scroll-snap', { ...withCss('.carousel { display: flex; overflow-x: auto }', { body: '<script src="a.js"></script>' }), 'a.js': "el.style.scrollSnapType = 'x mandatory';" });
    expect(js.status).toBe('passed');
  });
});

describe('modal-no-overscroll-behavior', () => {
  const modalCss = '.modal { position: fixed; overflow-y: auto }\ndialog { overflow: auto }\n[role="dialog"] .body { overflow: hidden scroll }';

  it('flags scrollable modals with no overscroll-behavior and no scroll lock', async () => {
    const r = await run('modal-no-overscroll-behavior', withCss(modalCss));
    expect(snippets(r)).toEqual(['.modal { overflow-y: auto }', 'dialog { overflow: auto }', '[role="dialog"] .body { overflow: hidden scroll }']);
  });

  it('passes overscroll-behavior on the rule, a same-selector rule or a rule for the same element', async () => {
    const css = [
      '.modal { overflow-y: auto; overscroll-behavior: contain }',
      'dialog { overflow: auto }',
      'dialog { overscroll-behavior-y: none }',
      '.lightbox { overflow: auto }',
      '#gallery { overscroll-behavior-block: contain }',
      '.drawer.modal { overflow-y: hidden }',
    ].join('\n');
    const r = await run('modal-no-overscroll-behavior', withCss(css, { body: '<div class="lightbox" id="gallery"></div>' }));
    expect(r.status).toBe('passed');
  });

  it('still flags overscroll-behavior that leaves the block axis on auto', async () => {
    const r = await run('modal-no-overscroll-behavior', withCss('.modal { overflow-y: auto; overscroll-behavior: contain auto }'));
    expect(r.status).toBe('failed');
  });

  it('passes when the page locks body scrolling in CSS or script', async () => {
    const locks = [
      withCss(`${modalCss}\nbody.modal-open { overflow: hidden }`),
      withCss(`${modalCss}\nhtml:has(dialog[open]) { overflow: clip }`),
      withCss(`${modalCss}\n.no-scroll { overflow: hidden }`),
      { ...withCss(`${modalCss}\n.frozen { overflow-y: hidden }`, { body: '<script src="a.js"></script>' }), 'a.js': "document.body.classList.add('frozen');" },
      { ...withCss(modalCss, { body: '<script src="a.js"></script>' }), 'a.js': "document.body.style.overflow = 'hidden';" },
      { ...withCss(modalCss, { body: '<script src="a.js"></script>' }), 'a.js': "document.documentElement.style.setProperty('overflow', 'hidden');" },
      { ...withCss(modalCss, { body: '<script src="a.js"></script>' }), 'a.js': "$('body').css('overflow', 'hidden');" },
      { ...withCss(modalCss, { body: '<script type="module" src="a.js"></script>' }), 'a.js': "import { disableBodyScroll } from 'body-scroll-lock';" },
      { ...withCss(modalCss, { body: '<script src="a.js"></script>' }), 'a.js': "class Helper { hide() { this._element.style.overflow = 'hidden'; } }" },
      withCss(modalCss, { body: '<script src="https://cdn.example.com/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>' }),
    ];
    for (const files of locks) expect((await run('modal-no-overscroll-behavior', files)).status, files['site.css']).toBe('passed');
  });

  it('reports incomplete when a stylesheet is missing and not applicable without scrollable modals', async () => {
    const r = await run('modal-no-overscroll-behavior', { ...withCss(modalCss), 'index.html': withCss(modalCss)['index.html'].replace('</head>', '<link rel="stylesheet" href="gone.css"></head>') });
    expect(r.status).toBe('incomplete');
    expect(await run('modal-no-overscroll-behavior', withCss('.modal { overflow: hidden }\n.list { overflow: auto }'))).toMatchObject({ status: 'notApplicable' });
  });
});

describe('pwa-no-apple-touch-icon', () => {
  const png = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  const manifest = (icons) => JSON.stringify({ name: 'x', icons });
  const site = (head, icons, extra = {}) => ({ ...page(`<link rel="manifest" href="m.json">${head}`), 'm.json': manifest(icons), ...extra });

  it('is not applicable without a manifest', async () => {
    expect(await run('pwa-no-apple-touch-icon', page(VP))).toMatchObject({ status: 'notApplicable', reason: 'no web app manifest' });
  });

  it('flags an installable page with no large icon anywhere', async () => {
    const r = await run('pwa-no-apple-touch-icon', site('', [{ src: 'a.png', sizes: '48x48' }, { src: 'b.png', sizes: '96x96 144x144' }]));
    expect(r.nodes[0]).toMatchObject({ selector: 'head > link', message: expect.stringContaining('No <link rel="apple-touch-icon"> and no manifest icon is 180x180') });
  });

  it('flags touch icons that are all known to be small (sizes attribute or PNG header)', async () => {
    const bySizes = await run('pwa-no-apple-touch-icon', site('<link rel="apple-touch-icon" sizes="120x120" href="t.png"><link rel="apple-touch-icon-precomposed" sizes="152x152" href="u.png">', []));
    expect(bySizes.nodes[0]).toMatchObject({ data: { largestPx: 152 }, message: expect.stringContaining('The largest apple-touch-icon is 152x152') });
    expect(bySizes.nodes[0].snippet).toContain('152x152');
    const byPng = await run('pwa-no-apple-touch-icon', site('<link rel="apple-touch-icon" href="t.png">', [], { 't.png': await png(120, 120) }));
    expect(byPng.nodes[0]).toMatchObject({ data: { largestPx: 120 } });
  });

  it('passes large touch icons, large or "any" manifest icons, and touch icons of unknown size', async () => {
    const cases = [
      site('<link rel="apple-touch-icon" href="t.png">', [], { 't.png': await png(180, 180) }),
      site('<link rel="apple-touch-icon" sizes="180x180" href="t.png">', []),
      site('<link rel="apple-touch-icon" sizes="120x120" href="t.png">', [{ src: 'i.png', sizes: '192x192' }]),
      site('', [{ src: 'i.svg', sizes: 'any' }]),
      site('<link rel="apple-touch-icon" href="t.jpg">', [], { 't.jpg': 'not a png' }),
      site('<link rel="apple-touch-icon" href="missing.png">', []),
    ];
    for (const files of cases) expect((await run('pwa-no-apple-touch-icon', files)).status, files['index.html']).toBe('passed');
  });

  it('reports incomplete when the manifest cannot be read', async () => {
    const r = await run('pwa-no-apple-touch-icon', page('<link rel="manifest" href="gone.json">'));
    expect(r.status).toBe('incomplete');
    expect(r.incomplete[0].message).toContain('the manifest could not be read (not-found)');
  });

  it('parses icon sizes', () => {
    expect(largestIconSize('any')).toBe(Number.POSITIVE_INFINITY);
    expect(largestIconSize('16x16 180x180')).toBe(180);
    expect(largestIconSize('200x100')).toBe(100);
    expect(largestIconSize('big')).toBeNull();
    expect(largestIconSize(undefined)).toBeNull();
  });
});

describe('push-permission-no-display-mode-guard', () => {
  it('flags permission prompts and push subscriptions with no standalone check', async () => {
    const js = [
      "button.addEventListener('click', () => Notification.requestPermission());",
      'window.Notification.requestPermission().then(done);',
      'async function sub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.subscribe({ userVisibleOnly: true }); }',
      "if ('Notification' in window) Notification.requestPermission();",
    ].join('\n');
    const r = await run('push-permission-no-display-mode-guard', withJs(js));
    expect(r.nodes.map((n) => n.location)).toEqual(['app.js:1:40', 'app.js:2:1', 'app.js:3:80', 'app.js:4:31']);
    expect(r.nodes[0].message).toContain('Notification.requestPermission() is not gated');
  });

  it('passes calls gated on display-mode: standalone or navigator.standalone', async () => {
    const js = [
      "if (matchMedia('(display-mode: standalone)').matches) Notification.requestPermission();",
      "const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;",
      'function ask() { if (!installed) return; Notification.requestPermission(); }',
      "function isApp() { return window.matchMedia('(display-mode: standalone)').matches; }",
      'async function sub(reg) { if (isApp()) await reg.pushManager.subscribe({}); }',
      'isApp() && Notification.requestPermission();',
      'someManager.subscribe(listener);',
    ].join('\n');
    expect((await run('push-permission-no-display-mode-guard', withJs(js))).status).toBe('passed');
  });
});

describe('hover-only-affordance', () => {
  it('flags hover reveals of hidden content with no focus or click path', async () => {
    const css = [
      '.menu { display: none }',
      '.nav:hover .menu { display: block }',
      '.tip { opacity: 0 }',
      '.card:hover .tip { opacity: 1 }',
      '.panel { visibility: hidden }',
      '.trigger:hover + .panel { visibility: visible }',
    ].join('\n');
    const body = '<nav class="nav"><ul class="menu"><li>Docs</li></ul></nav><div class="card"><p class="tip">Tip</p></div><a class="trigger" href="/">More</a><div class="panel">Panel</div>';
    const r = await run('hover-only-affordance', withCss(css, { body }));
    expect(snippets(r)).toEqual(['.nav:hover .menu { display: block }', '.card:hover .tip { opacity: 1 }', '.trigger:hover + .panel { visibility: visible }']);
    expect(r.nodes[0].message).toBe('.nav:hover .menu reveals it on hover only; add :focus-within (or a click toggle) to the same rule.');
    expect(r.nodes[1].data).toEqual({ hover: '.card:hover .tip', props: ['opacity'] });
  });

  it('flags a hover reveal of an element hidden in the DOM or by a rule for the same elements', async () => {
    const css = '.card:hover .x { display: block }\n.nav ul ul { display: none }\n.nav li:hover > ul { display: block }\nfooter ul { display: flex }';
    const body = '<div class="card"><div class="x" hidden>Share</div></div><nav class="nav"><ul><li><a href="/">A</a><ul><li>B</li></ul></li></ul></nav><footer><ul></ul></footer>';
    const r = await run('hover-only-affordance', withCss(css, { body }));
    expect(snippets(r)).toEqual(['.card:hover .x { display: block }', '.nav li:hover > ul { display: block }']);
  });

  it('passes focus, focus-within and click-state equivalents, hover media and non-reveals', async () => {
    const css = [
      '.m1, .m2, .m3, .m4, .m5, .m6, .m7 { display: none }',
      '.a:hover .m1, .a:focus-within .m1 { display: block }',
      '.b:is(:hover, :focus-within) .m2 { display: block }',
      '.c:hover .m3 { display: block }',
      '.c:focus-visible .m3 { display: block }',
      '.d:hover .m4 { display: block }',
      '.d.is-open .m4 { display: block }',
      '@media (hover: hover) { .e:hover .m5 { display: block } }',
      '@media (any-pointer: fine) { .f:hover .m6 { display: block } }',
      '.g:hover .m7 { display: block }',
      '@media (hover: none) { .m7 { display: block } }',
      '.row:hover .cell { opacity: 1 }',
      '.btn:hover { opacity: 1 }',
      '.h:not(:hover) .m8 { opacity: 1 }',
      '.m8 { opacity: 0 }',
      '.k:hover .m9 { opacity: 0.2 }',
      '.m9 { opacity: 0 }',
    ].join('\n');
    expect((await run('hover-only-affordance', withCss(css))).status).toBe('passed');
  });

  it('passes utility classes that add a focus path on the same element, but not an unconditional rule', async () => {
    const css = [
      '.hidden { display: none }',
      '.group:hover .group-hover\\:block { display: block }',
      '.group:focus-within .group-focus-within\\:block { display: block }',
      'div { display: block }',
    ].join('\n');
    const both = '<div class="group"><a href="/">A</a><div class="hidden group-hover:block group-focus-within:block">Details</div></div>';
    expect((await run('hover-only-affordance', withCss(css, { body: both }))).status).toBe('passed');
    const hoverOnly = await run('hover-only-affordance', withCss(css, { body: both.replace(' group-focus-within:block', '') }));
    expect(snippets(hoverOnly)).toEqual(['.group:hover .group-hover\\:block { display: block }']);
  });

  it('reports incomplete when a stylesheet is missing', async () => {
    const files = withCss('.menu { display: none }\n.nav:hover .menu { display: block }');
    files['index.html'] = files['index.html'].replace('</head>', '<link rel="stylesheet" href="gone.css"></head>');
    expect((await run('hover-only-affordance', files)).status).toBe('incomplete');
  });

  it('sends unused CSS and decorative reveals to review, but not content found in the rendered DOM', async () => {
    const css = '.menu { display: none }\n.nav:hover .menu { display: block }\n.shade { opacity: 0 }\n.card:hover .shade { opacity: 1 }';
    // Calibration: plugin CSS for markup the page does not have, and a Tailwind group-hover gradient overlay.
    const unused = await run('hover-only-affordance', withCss(css, { body: '<div class="card"><div class="shade"></div><h2>Title</h2></div>' }));
    expect(unused.status).toBe('incomplete');
    expect(unused.incomplete.map((n) => n.message)).toEqual([
      'Hover-only reveal to check: no element in the page HTML matches it, so check that the rule is in use. If it matters, add :focus-within (or a click toggle) to the same rule.',
      'Hover-only reveal to check: the revealed elements hold no text or controls, so they may be decoration. If it matters, add :focus-within (or a click toggle) to the same rule.',
    ]);
    const icon = await run('hover-only-affordance', withCss(css, { body: '<div class="card"><span class="shade icon-delete"></span></div>' }));
    expect(snippets(icon)).toEqual(['.card:hover .shade { opacity: 1 }']);
    const rendered = { ...readFixtureJson('mobile/facts/tap-targets.json'), rendered: { html: '<!doctype html><html><head></head><body><nav class="nav"><ul class="menu"><li>Docs</li></ul></nav></body></html>' } };
    const dyn = await run('hover-only-affordance', withCss(css, { body: '<div class="card"><h2>x</h2></div>' }), { dynamic: rendered });
    expect(snippets(dyn)).toEqual(['.nav:hover .menu { display: block }']);
  });
});

describe('missing-interactive-widget', () => {
  const css = '.composer { position: fixed; left: 0; right: 0; bottom: 0 }';

  it('flags a bottom-pinned bar that holds a text field', async () => {
    const r = await run('missing-interactive-widget', withCss(css, { body: '<form class="composer"><input name="m"><button>Send</button></form>' }));
    expect(r.nodes[0]).toMatchObject({ snippet: '.composer { position: fixed }' });
    expect(r.nodes[0].message).toContain('holds body > form.composer > input');
    const ta = await run('missing-interactive-widget', withCss(css, { body: '<textarea class="composer"></textarea>' }));
    expect(ta.status).toBe('failed');
    const ce = await run('missing-interactive-widget', withCss(css, { body: '<div class="composer"><div contenteditable="true"></div></div>' }));
    expect(ce.status).toBe('failed');
  });

  it('passes with interactive-widget, non-text controls, keyboard-aware pages and no viewport meta', async () => {
    const withWidget = '<meta name="viewport" content="width=device-width, interactive-widget=resizes-content">';
    expect((await run('missing-interactive-widget', withCss(css, { head: withWidget, body: '<form class="composer"><input></form>' }))).status).toBe('passed');
    const controls = '<form class="composer"><input type="checkbox"><input type="submit"><div contenteditable="false"></div><button>Go</button></form>';
    expect((await run('missing-interactive-widget', withCss(css, { body: controls }))).status).toBe('passed');
    const vv = { ...withCss(css, { body: '<form class="composer"><input></form><script src="a.js"></script>' }), 'a.js': "visualViewport.addEventListener('resize', place);" };
    expect((await run('missing-interactive-widget', vv)).status).toBe('passed');
    const envKb = withCss(`${css}\n.composer { bottom: env(keyboard-inset-height, 0px) }`, { body: '<form class="composer"><input></form>' });
    expect((await run('missing-interactive-widget', envKb)).status).toBe('passed');
    expect((await run('missing-interactive-widget', withCss(css, { head: '', body: '<form class="composer"><input></form>' }))).status).toBe('notApplicable');
  });

  it('finds a text field that only exists in the rendered DOM', async () => {
    const dynamic = { errors: [], rendered: { html: `<html><head>${VP}</head><body><div class="composer"><input type="search"></div></body></html>` } };
    const r = await run('missing-interactive-widget', withCss(css, { body: '<div class="composer"></div>' }), { dynamic });
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].message).toContain('holds body > div.composer > input');
  });
});

describe('webkit-overflow-scrolling-touch', () => {
  it('flags the dead declaration and ignores other values', async () => {
    const r = await run('webkit-overflow-scrolling-touch', withCss('.a { overflow: auto; -webkit-overflow-scrolling: touch }\n.b { -webkit-overflow-scrolling: auto }'));
    expect(snippets(r)).toEqual(['.a { -webkit-overflow-scrolling: touch }']);
    expect((await run('webkit-overflow-scrolling-touch', withCss('.b { -webkit-overflow-scrolling: auto }'))).status).toBe('passed');
  });
});

describe('double-tap-js-override', () => {
  it('flags a touchend double-tap timer that cancels the tap', async () => {
    const js = [
      'let lastTap = 0;',
      "el.addEventListener('touchend', (e) => {",
      '  const now = Date.now();',
      '  if (now - lastTap <= 300) { e.preventDefault(); }',
      '  lastTap = now;',
      '});',
      "$(doc).on('touchend', function (e) { if (500 > e.timeStamp - this.prev) e.preventDefault(); });",
    ].join('\n');
    const r = await run('double-tap-js-override', withJs(js));
    expect(r.nodes.map((n) => [n.location, n.data.windowMs])).toEqual([['app.js:2:1', 300], ['app.js:7:1', 500]]);
  });

  it('flags FastClick loaded by script tag, import or attach()', async () => {
    const r = await run('double-tap-js-override', {
      ...page(VP, '<script src="https://cdn.example.com/fastclick.min.js"></script><script type="module" src="app.js"></script>'),
      'app.js': "import FastClick from 'fastclick';\nFastClick.attach(document.body);",
    });
    expect(r.nodes.map((n) => n.selector)).toEqual(['body > script:nth-of-type(1)', 'script[src="app.js"]', 'script[src="app.js"]']);
    expect(r.nodes[0].message).toContain('FastClick removes a 300 ms delay');
  });

  it('passes swipe thresholds, timers without preventDefault and short windows', async () => {
    const js = [
      "el.addEventListener('touchend', (e) => { if (dx > 300) e.preventDefault(); });",
      "el.addEventListener('touchend', () => { if (Date.now() - last < 300) zoom(); });",
      "el.addEventListener('touchend', (e) => { if (Date.now() - last < 100) e.preventDefault(); });",
      "el.addEventListener('click', (e) => { if (Date.now() - last < 300) e.preventDefault(); });",
    ].join('\n');
    expect((await run('double-tap-js-override', withJs(js))).status).toBe('passed');
  });
});

describe('helpers', () => {
  it('splits class and id names into words', () => {
    expect([...selectorWords('#heroCarousel .swiper-wrapper > .gallery__track:hover')].sort())
      .toEqual(['carousel', 'gallery', 'hero', 'swiper', 'track', 'wrapper']);
  });
});

describe('mobile golden', () => {
  it('matches the mobile goldens', async () => {
    const res = await runFixture('mobile');
    expectGolden('mobile.report.md', res.markdown);
    expectGolden('mobile.raw.json', rawJson(res.raw));
    expectAsciiNoDash(res.markdown, 'mobile report');
  });

  it('fails every static rule the fixture exercises and keeps its near misses clean', async () => {
    const res = await runFixture('mobile');
    const status = Object.fromEntries(res.raw.rules.map((r) => [r.id.slice(PREFIX.length), r.status]));
    expect(status).toEqual({
      'carousel-no-scroll-snap': 'failed',
      'double-tap-js-override': 'failed',
      'env-safe-area-without-viewport-fit-cover': 'passed',
      'fixed-bottom-no-safe-area': 'failed',
      'fixed-header-vh-sized': 'failed',
      'hover-only-affordance': 'failed',
      'missing-interactive-widget': 'failed',
      'modal-no-overscroll-behavior': 'failed',
      'non-passive-touch-listener': 'failed',
      'push-permission-no-display-mode-guard': 'failed',
      'pwa-no-apple-touch-icon': 'failed',
      'scroll-hijack': 'failed',
      'tap-target-under-minimum': 'skipped',
      'uses-vh-without-dvh': 'failed',
      'user-scalable-no': 'failed',
      'viewport-meta-missing': 'passed',
      'webkit-overflow-scrolling-touch': 'failed',
    });
    const nodes = (id) => res.raw.violations.find((v) => v.ruleId === PREFIX + id).nodes.map((n) => n.snippet);
    expect(nodes('uses-vh-without-dvh')).toEqual(['.hero { min-height: 100vh }']);
    expect(nodes('fixed-bottom-no-safe-area')).toEqual(['.composer { position: fixed }', '.tabbar { position: fixed }']);
    expect(nodes('hover-only-affordance')).toEqual(['.nav-item:hover .dropdown { display: block }']);
    expect(res.raw.rules.find((r) => r.id === `${PREFIX}webkit-overflow-scrolling-touch`).suppressed).toBe(1);
    expect(res.pass).toBe(false);
  });

  it('reports the tap-target rule from synthetic facts through the full pipeline', async () => {
    const res = await runFixture('mobile', { dynamic: true, dynamicImpl: async () => readFixtureJson('mobile/facts/tap-targets.json') });
    const tap = res.raw.violations.find((v) => v.ruleId === `${PREFIX}tap-target-under-minimum`);
    expect(tap.nodes.map((n) => n.selector)).toEqual(['#menu-toggle', '#search', '#prev']);
    expect(res.raw.metrics.highlights.mobile['tap targets under 24px']).toBe(3);
  });
});

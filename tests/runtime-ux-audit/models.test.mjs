import { describe, it, expect } from 'vitest';
import { contextFor } from './helpers.mjs';
import * as V from '../../plugins/atelier/skills/runtime-ux-audit/lib/css-values.mjs';
import { buildHtmlModel, cssEscape, collapseSnippet } from '../../plugins/atelier/skills/runtime-ux-audit/lib/html-model.mjs';
import { compileSelector } from '../../plugins/atelier/skills/runtime-ux-audit/lib/selector-match.mjs';
import { parseCsp } from '../../plugins/atelier/skills/runtime-ux-audit/lib/csp.mjs';
import { parseJs, pathOf, childNodes } from '../../plugins/atelier/skills/runtime-ux-audit/lib/js-model.mjs';
import { parseCss, isPrintOnlyMedia, normalizePrelude } from '../../plugins/atelier/skills/runtime-ux-audit/lib/css-model.mjs';

// ---------------------------------------------------------------------------
// Pure value helpers
// ---------------------------------------------------------------------------

describe('css-values: selectors', () => {
  it.each([
    ['  a>b  +  c ~d ,  e', 'a > b + c ~ d, e'],
    ['e[ data-x = "a > b" i ]', 'e[data-x="a > b" i]'],
    [':is( .x , .y )  :nth-child( 2n + 1 )', ':is(.x, .y) :nth-child(2n + 1)'],
    ['a /* c */ b', 'a b'],
    ['> .x', '> .x'],
  ])('normalizeSelector(%j) = %j', (input, out) => expect(V.normalizeSelector(input)).toBe(out));

  it('splits lists and compounds', () => {
    expect(V.splitSelectorList('a, b > c, :is(d, e)')).toEqual(['a', 'b > c', ':is(d, e)']);
    expect(V.compounds('.card:hover > .tip ~ p a')).toEqual([
      { text: '.card:hover', combinator: null }, { text: '.tip', combinator: '>' }, { text: 'p', combinator: '~' }, { text: 'a', combinator: ' ' },
    ]);
    expect(V.compounds('> .x')).toEqual([{ text: '.x', combinator: '>' }]);
    expect(V.compounds('a[title="x y"] b')).toEqual([{ text: 'a[title="x y"]', combinator: null }, { text: 'b', combinator: ' ' }]);
  });

  it.each([
    ['.card:hover .tip', '.card .tip'],
    [':focus-visible', '*'],
    ['dialog:modal::backdrop', 'dialog::backdrop'],
    ['a:not(:hover)', 'a:not(:hover)'],
    ['a:hover, b:checked', 'a, b'],
  ])('stripStatePseudos(%j) = %j', (input, out) => expect(V.stripStatePseudos(input)).toBe(out));

  it.each([
    ['dialog[open]::backdrop', 'dialog::backdrop'],
    ['[popover]:popover-open', '[popover]'],
    [':popover-open', '*'],
    ['.menu.open:hover', '.menu.open'],
    ['dialog:modal', 'dialog'],
    ['.x:focus-within .y', '.x .y'],
  ])('selectorBaseKey(%j) = %j', (input, out) => expect(V.selectorBaseKey(input)).toBe(out));

  it('classifies root, popover/dialog, modal and panel selectors', () => {
    expect(['html', ':root', 'html.dark', ':root[data-x]', 'html body', 'html::before', 'body'].map(V.isRootSelector))
      .toEqual([true, true, true, true, false, false, false]);
    expect(['[popover]', 'dialog[open]', 'mydialog', '.dialog', 'div > dialog', ':popover-open'].map(V.isPopoverOrDialogSelector))
      .toEqual([true, true, false, false, true, true]);
    expect(['[role=dialog]', "[role='alertdialog']", '[aria-modal=true]', '.modal', '.modal-body', '.lightbox'].map(V.isModalSelector))
      .toEqual([true, true, true, true, false, true]);
    expect(['.drawer', '.menu', '.menu-item', '.tooltip', '.card', 'dialog'].map(V.isPanelSelector))
      .toEqual([true, true, false, true, false, true]);
    // Invoker buttons are not popovers.
    expect(['button[popovertarget]', '[popovertarget=m]', '[popovertargetaction=hide]', '[popover=auto]', '[ popover ]', '[popovertarget] + [popover]'].map(V.isPopoverOrDialogSelector))
      .toEqual([false, false, false, true, true, true]);
    expect(['.btn[popovertarget]'].map(V.isModalSelector)).toEqual([false]);
  });
});

describe('css-values: values', () => {
  it('parses times', () => {
    expect(['200ms', '.2s', '0', '2', 'var(--x)', '1.5S', '-1s'].map(V.parseTimeMs)).toEqual([200, 200, 0, null, null, 1500, -1000]);
    expect(V.parseTimeList('.1s, 200ms, var(--d)')).toEqual([100, 200, null]);
  });

  it('parses transition lists, including the implicit all', () => {
    expect(V.parseTransitionList('opacity .2s ease, transform 300ms cubic-bezier(0.2, 0, 0, 1) 50ms, .3s')).toEqual([
      { property: 'opacity', durationMs: 200, delayMs: 0, timing: 'ease', behavior: null, durationToken: '.2s' },
      { property: 'transform', durationMs: 300, delayMs: 50, timing: 'cubic-bezier(0.2, 0, 0, 1)', behavior: null, durationToken: '300ms' },
      { property: 'all', durationMs: 300, delayMs: 0, timing: null, behavior: null, durationToken: '.3s' },
    ]);
    expect(V.parseTransitionList('all var(--dur) ease')[0]).toMatchObject({ property: 'all', durationMs: null, durationToken: 'var(--dur)' });
    expect(V.parseTransitionList('none')[0]).toMatchObject({ property: 'none', durationMs: 0 });
    expect(V.parseTransitionList('inherit')).toEqual([]);
    expect(V.parseTransitionList('display .2s allow-discrete')[0]).toMatchObject({ property: 'display', behavior: 'allow-discrete' });
    expect(V.parseTransitionList('--my-prop 1s')[0].property).toBe('--my-prop');
    // An omitted property with a var() in the item: the var may hold the property.
    expect(V.parseTransitionList('var(--t)')[0]).toMatchObject({ property: null, durationMs: null, durationToken: 'var(--t)' });
    expect(V.parseTransitionList('opacity var(--d)')[0].property).toBe('opacity');
  });

  it('parses animation lists', () => {
    expect(V.parseAnimationList('fade 1s ease-in infinite, none, slide .5s 1s both')).toEqual([
      { name: 'fade', durationMs: 1000, delayMs: 0, durationToken: '1s' },
      { name: 'none', durationMs: 0, delayMs: 0, durationToken: null },
      { name: 'slide', durationMs: 500, delayMs: 1000, durationToken: '.5s' },
    ]);
    expect(V.parseAnimationList('var(--a)')[0]).toMatchObject({ name: 'none', durationMs: null, durationToken: 'var(--a)' });
    expect(V.parseAnimationList('unset')).toEqual([]);
  });

  it('parses lengths, unit values and zero lengths', () => {
    expect(V.parseLength('12px')).toEqual({ value: 12, unit: 'px' });
    expect(V.parseLength('-1.5REM')).toEqual({ value: -1.5, unit: 'rem' });
    expect(V.parseLength('0')).toEqual({ value: 0, unit: '' });
    expect(V.parseLength('auto')).toBeNull();
    expect(V.findUnitValues('calc(100vh - 64px)', 'vh')).toEqual([100]);
    expect(V.findUnitValues('100dvh', 'vh')).toEqual([]);
    expect(V.findUnitValues('max(90vh, 50svh) 10lvh -20vh', 'vh')).toEqual([90, -20]);
    expect(V.findUnitValues('50% 1.5%', '%')).toEqual([50, 1.5]);
    expect(['0', '0px', '-0', '0.0rem', '0%', '1px', 'auto'].map(V.isZeroLength)).toEqual([true, true, true, true, true, false, false]);
  });

  it('extracts inset components', () => {
    expect([
      ['inset', '0'], ['inset', '10px 0'], ['inset', 'auto 0 0'], ['inset', '1px 2px 3px 4px'], ['inset-block', '0 auto'],
      ['inset-block', '5px'], ['bottom', '0'], ['inset-block-end', '0'], ['top', '0'],
    ].map(([p, v]) => V.parseInsetBottom(p, v))).toEqual(['0', '10px', '0', '3px', 'auto', '5px', '0', '0', null]);
    expect([['inset', 'auto 0 0'], ['inset', '0'], ['top', '1px'], ['inset-block-start', '2px'], ['bottom', '0']].map(([p, v]) => V.parseInsetTop(p, v)))
      .toEqual(['auto', '0', '1px', '2px', null]);
  });

  it('parses z-index and color alpha', () => {
    expect(['10', '-5', '+3', 'auto', '1.5', 'var(--z)'].map(V.parseZIndex)).toEqual([10, -5, 3, null, null, null]);
    expect(['#fff', '#ffffff', '#fff8', '#00000080', 'red', 'RebeccaPurple', 'transparent', 'rgba(0,0,0,.5)', 'rgb(0 0 0 / 50%)',
      'hsla(0, 0%, 0%, 0.96)', 'rgb(1,2,3)', 'var(--c)', 'color-mix(in srgb, red, blue)', 'oklch(0.5 0.1 20 / .2)', 'currentcolor', 'rgb(0 0 0 / none)']
      .map(V.colorAlpha)).toEqual([1, 1, 0.533, 0.502, 1, 1, null, 0.5, 0.5, 0.96, 1, null, null, 0.2, null, 0]);
  });

  it('splits top-level values and reads contexts', () => {
    expect(V.splitTopLevel('a, rgba(0,0,0,.5), b', ',')).toEqual(['a', 'rgba(0,0,0,.5)', 'b']);
    expect(V.splitTopLevel('1px  solid rgb(0 0 0)', ' ')).toEqual(['1px', 'solid', 'rgb(0 0 0)']);
    expect(V.splitTopLevel('a / "b/c"', '/')).toEqual(['a', '"b/c"']);
    const c = { media: ['(prefers-reduced-motion: reduce)'], supports: ['(anchor-name: --x)'], layer: [], container: [], startingStyle: false, keyframes: null };
    expect([V.isReducedMotionReduce(c), V.isReducedMotionNoPreference(c), V.inSupports(c, /anchor/), V.inMedia({ context: c }, /reduce/), V.inMedia(null, /x/)])
      .toEqual([true, false, true, true, false]);
    expect(V.isReducedMotionNoPreference({ context: { ...c, media: ['(prefers-reduced-motion:no-preference)'] } })).toBe(true);
    const pref = (m) => [V.isReducedMotionReduce({ ...c, media: [m] }), V.isReducedMotionNoPreference({ ...c, media: [m] })];
    expect(pref('(prefers-reduced-motion)')).toEqual([true, false]);
    expect(pref('not (prefers-reduced-motion)')).toEqual([false, true]);
    expect(pref('not all and (prefers-reduced-motion: reduce)')).toEqual([false, true]);
    expect(pref('screen and (prefers-reduced-motion: reduce), print')).toEqual([false, false]);
    expect(['(prefers-reduced-motion: reduce)', 'not all and (prefers-reduced-motion: no-preference)', '(min-width: 1px)'].map(V.motionPreferenceOf)).toEqual(['reduce', 'reduce', null]);
  });

  it('reads boolean literals including minified !0 and !1', () => {
    const lit = (value) => ({ type: 'Literal', value });
    const not = (argument) => ({ type: 'UnaryExpression', operator: '!', argument });
    expect([lit(true), lit(false), not(lit(0)), not(lit(1)), not(not(lit(0))), { type: 'Identifier', name: 'x' }, null].map(V.boolLiteral))
      .toEqual([true, false, true, false, false, null, null]);
  });
});

// ---------------------------------------------------------------------------
// HTML model and selector matching
// ---------------------------------------------------------------------------

describe('html model and selector-match', () => {
  const h = buildHtmlModel(`<!doctype html><html><head>
<meta name="viewport" content="width=device-width">
<meta name="VIEWPORT" content="width=device-width; initial-scale=1, viewport-fit=COVER, user-scalable">
<link rel="Apple-Touch-Icon Icon" href="/icon.png" sizes="180x180">
<script type="speculationrules">{"prefetch":[{"urls":["/a"]}]}</script>
<script type="speculationrules">{bad</script>
</head><body onload="init()" onUnload="bye()"><nav id="n"><ul class="menu main extra" role="Menubar Menu"><li><a href="/a" class="x">A</a></li><li class="on"><a href="/b" data-k="Hello World">B</a></li><li><button disabled>C</button></li></ul></nav><p></p><p> x <script>ignored()</script></p><template><div class="tpl"></div></template><div id="dup"></div><div id="dup"></div><div id="1st" class="md:flex w-1/2"></div></body></html>`, {
    resolve: (href) => `https://example.com${href}`,
  });
  const q = (s) => h.querySelectorAll(s).map((e) => h.cssPath(e));

  it.each([
    ['nav a', 2], ['ul > li:nth-child(2) > a', 1], ['li + li', 2], ['li ~ li', 2], ['a[href^="/"]', 2], ['[data-k~=World]', 1],
    ['[data-k*=world i]', 1], ['[data-k*=world]', 0], ['a[href$="b"]', 1], ['[class|=menu]', 0], ['[class|="menu main extra"]', 1], ['[class^=menu]', 1], ['a:hover', 2], ['li:not(.on)', 2],
    [':is(.x, [data-k])', 2], [':where(nav) a', 2], ['li:first-child a, li:last-child button', 2], ['p:empty', 1], ['button:disabled', 1],
    ['button:enabled', 0], ['.tpl', 0], [':root', 1], ['li:nth-of-type(odd)', 2], ['li:nth-last-child(1)', 1], ['li:only-child', 0],
    ['a:not(:hover)', 2], ['nav a::before', 2], ['a:before', 2], ['*', 23], ['li:nth-child(-n+2)', 2], ['li:first-of-type', 1],
  ])('querySelectorAll(%j) finds %i', (sel, n) => expect(q(sel)).toHaveLength(n));

  it('returns null / [] for unsupported selectors', () => {
    for (const sel of ['a:has(b)', '& a', 'li:nth-child(2n of .on)', 'svg|a', 'a::slotted(b)', ':lang(en)', 'a >> b', '[x', 'a,', ':is()']) {
      expect(compileSelector(sel), sel).toBeNull();
      expect(h.querySelectorAll(sel)).toEqual([]);
      expect(h.matches(h.byTag('a')[0], sel)).toBeNull();
    }
    expect(h.matches(h.byTag('a')[0], 'nav a')).toBe(true);
  });

  it('builds css paths, text and tree navigation', () => {
    expect(h.cssPath(h.byTag('ul')[0])).toBe('#n > ul.menu.main');
    expect(h.cssPath(h.byTag('div')[0])).toBe('body > div:nth-of-type(1)');
    expect(h.cssPath(h.byId('1st'))).toBe('#\\31 st');
    expect(h.cssPath(h.byTag('html')[0])).toBe('html');
    expect(h.cssPath(h.byTag('meta')[0])).toBe('head > meta:nth-of-type(1)');
    expect(q('.md\\:flex')).toEqual(['#\\31 st']);
    expect(cssEscape('md:flex')).toBe('md\\:flex');
    expect(cssEscape('-1a')).toBe('-\\31 a');
    expect(h.text(h.byTag('ul')[0])).toBe('A B C');
    expect(h.text(h.byTag('p')[1])).toBe('x');
    expect(h.descendants(h.byTag('ul')[0])).toHaveLength(6);
    expect(h.descendants(h.byTag('ul')[0], (e) => h.tag(e) === 'a')).toHaveLength(2);
    expect(h.ancestors(h.byTag('a')[0]).map(h.tag)).toEqual(['li', 'ul', 'nav', 'body', 'html']);
    expect(h.closest(h.byTag('a')[0], (e) => h.tag(e) === 'nav')).toBe(h.byId('n'));
    expect(h.closest(h.byTag('a')[0], () => false)).toBeNull();
    expect(h.children(h.byTag('ul')[0])).toHaveLength(3);
    expect(h.nextSibling(h.byTag('li')[0])).toBe(h.byTag('li')[1]);
    expect(h.prevSibling(h.byTag('li')[0])).toBeNull();
    expect(h.parent(h.byTag('html')[0])).toBeNull();
    expect(h.byTag('template')).toHaveLength(1);
    expect(h.byRole('menubar')).toHaveLength(1);
    expect(h.byRole('menu')).toHaveLength(0);
    expect(h.withAttr('disabled')).toHaveLength(1);
    expect(h.attr(h.byTag('button')[0], 'DISABLED')).toBe('');
    expect(h.hasAttr(h.byTag('a')[0], 'data-k')).toBe(false);
    expect(h.byId('nope')).toBeNull();
    expect(() => h.tag({})).toThrow(TypeError);
  });

  it('parses viewport, links, speculation rules and event attributes', () => {
    expect(h.viewport.content).toBe('width=device-width; initial-scale=1, viewport-fit=COVER, user-scalable');
    expect(h.viewport.props).toEqual({ width: 'device-width', 'initial-scale': '1', 'viewport-fit': 'cover', 'user-scalable': '' });
    expect(h.links[0]).toMatchObject({ rel: ['apple-touch-icon', 'icon'], href: '/icon.png', url: 'https://example.com/icon.png', sizes: '180x180', imageSize: null });
    expect(h.speculationRules.map((s) => [s.json, s.error])).toEqual([[{ prefetch: [{ urls: ['/a'] }] }, null], [null, 'invalid JSON']]);
    expect(h.eventAttrs.map((a) => [a.name, a.value])).toEqual([['onload', 'init()'], ['onunload', 'bye()']]);
    expect(h.locationOf(h.byTag('body')[0], 'onunload')).toMatchObject({ line: 7 });
    expect(collapseSnippet(`  a \n  b  ${'x'.repeat(200)}`)).toHaveLength(160);
  });
});

// ---------------------------------------------------------------------------
// CSS model through the real collector
// ---------------------------------------------------------------------------

describe('css model', () => {
  const css = `:root { --pad: env(safe-area-inset-bottom); --pad2: var(--pad); --loop: var(--loop); }
.a { color: red !important; color: blue; padding-bottom: var(--pad2); }
.b { & .c { x: 1 } &:hover { y: 2 } > .d { z: 3 } .e & { w: 4 } }
.l1, .l2 { .n { q: 1 } }
@media print { .p { display: none } }
@media screen, print { .sp { a: 1 } }
@media (prefers-reduced-motion:  reduce ) { * { transition: none } }
@supports (anchor-name: --x) { @layer base { .anchor { anchor-name: --x } } }
@container card (min-width: 400px) { .cq { c: 1 } }
@starting-style { dialog[open] { opacity: 0 } }
dialog[open] { opacity: 1; transition: opacity .2s; @starting-style { opacity: 0; } @media (width > 600px) { margin: 0 } }
@keyframes fade { from { opacity: 0 } to { opacity: 1 } }
@view-transition { navigation: auto; }
@position-try --x { inset-area: top; }
.hero { height: 100vh } @supports (height: 100dvh) { .hero { height: 100dvh } }
`;
  const files = {
    'index.html': `<!doctype html><html style="transform: scale(1)"><head>
<link rel="stylesheet" href="a.css">
<link rel="stylesheet" href="small.css" media="(max-width: 600px)">
<link rel="stylesheet" href="print.css" media="print">
<link rel="alternate stylesheet" href="alt.css">
<style media="print">.never { x: 1 }</style>
</head><body><div id="hero" style="z-index: 5; height: 100vh">x</div></body></html>`,
    'a.css': css,
    'small.css': '.m { margin: 0 }',
    'print.css': '.pr { x: 1 }',
    'alt.css': '.alt { x: 1 }',
  };

  it('tracks contexts, nesting, @starting-style and print exclusion', async () => {
    const { css: m } = await contextFor(files);
    const rows = m.rules.map((r) => [r.selectorText, r.context.media, r.context.supports, r.context.layer, r.context.container, r.context.startingStyle, r.context.keyframes]);
    expect(rows).toContainEqual(['.b .c', [], [], [], [], false, null]);
    expect(rows).toContainEqual(['.b:hover', [], [], [], [], false, null]);
    expect(rows).toContainEqual(['.b > .d', [], [], [], [], false, null]);
    expect(rows).toContainEqual(['.e .b', [], [], [], [], false, null]);
    expect(rows).toContainEqual(['.l1 .n, .l2 .n', [], [], [], [], false, null]);
    expect(rows).toContainEqual(['.sp', ['screen, print'], [], [], [], false, null]);
    expect(rows).toContainEqual(['*', ['(prefers-reduced-motion: reduce)'], [], [], [], false, null]);
    expect(rows).toContainEqual(['.anchor', [], ['(anchor-name: --x)'], ['base'], [], false, null]);
    expect(rows).toContainEqual(['.cq', [], [], [], ['card (min-width: 400px)'], false, null]);
    expect(rows).toContainEqual(['dialog[open]', [], [], [], [], true, null]);
    expect(rows).toContainEqual(['from', [], [], [], [], false, 'fade']);
    expect(rows).toContainEqual(['.m', ['(max-width: 600px)'], [], [], [], false, null]);
    const sels = m.rules.map((r) => r.selectorText);
    for (const gone of ['.p', '.pr', '.alt', '.never']) expect(sels).not.toContain(gone);
    const nested = m.decls.filter((d) => d.atRule && d.rule?.selectorText === 'dialog[open]').map((d) => [d.prop, d.atRule.name, d.context.startingStyle, d.context.media]);
    expect(nested).toEqual([['opacity', 'starting-style', true, []], ['margin', 'media', false, ['(width > 600px)']]]);
    const dialogRule = m.rules.find((r) => r.selectorText === 'dialog[open]' && !r.context.startingStyle);
    expect(dialogRule.decls.map((d) => d.prop)).toEqual(['opacity', 'transition']);
    expect(m.declsByProp('navigation')[0]).toMatchObject({ rule: null, atRule: { name: 'view-transition' } });
    expect(m.declsByProp('inset-area')[0].atRule.params).toBe('--x');
    expect(m.atRulesByName('MEDIA').map((a) => a.params)).toEqual(['print', 'screen, print', '(prefers-reduced-motion: reduce)', '(width > 600px)']);
    expect(m.complete).toBe(true);
  });

  it('indexes declarations, custom properties, selectors and style attributes', async () => {
    const { css: m, ref } = await contextFor(files);
    const a = m.rulesBySelector('.a')[0];
    expect(a.get('color').value).toBe('red');
    expect(a.get('COLOR').important).toBe(true);
    expect(a.get('margin')).toBeNull();
    expect(m.declsByProp('COLOR')).toHaveLength(2);
    expect(m.customProps('--pad')).toHaveLength(1);
    expect(m.customProps('--PAD')).toHaveLength(0);
    expect(m.valueMentions('var(--pad2)', /safe-area-inset-bottom/)).toBe(true);
    expect(m.valueMentions('var(--loop)', /x/)).toBe(false);
    expect(m.valueMentions('var(--pad2)', /safe-area/, 1)).toBe(false);
    expect(m.rulesBySelector('.hero').map((r) => r.context.supports)).toEqual([[], ['(height: 100dvh)']]);
    expect(m.rulesBySelector('.l1 .n')).toHaveLength(1);
    expect(m.rulesBySelector('.l1,.l2')).toHaveLength(1);
    const attrRules = m.rules.filter((r) => r.fromStyleAttr);
    expect(attrRules.map((r) => r.selectorText)).toEqual(['html', '#hero']);
    const z = m.declsByProp('z-index')[0];
    expect(z.rule.fromStyleAttr).not.toBeNull();
    expect(ref.css(z)).toEqual({ selector: '#hero', snippet: 'style="z-index: 5"', location: 'index.html:7:29' });
    expect(ref.css(m.declsByProp('navigation')[0])).toEqual({ selector: '@view-transition', snippet: '@view-transition { navigation: auto }', location: 'a.css:13:20' });
    expect(ref.css(m.atRulesByName('keyframes')[0])).toMatchObject({ selector: '@keyframes fade', location: 'a.css:12:1' });
    expect(ref.css(a)).toMatchObject({ selector: '.a', snippet: '.a { ... }', location: 'a.css:2:1' });
    expect(ref.css(a.get('color').node).snippet).toBe('.a { color: red !important }');
  });

  it('maps inline <style> positions to the document and exposes helpers', async () => {
    const { css: m, ref } = await contextFor({ 'index.html': '<html><head>\n<style>\n\n  .x { height: 100vh }</style><style>.y{a:1}</style></head></html>' });
    expect(ref.css(m.declsByProp('height')[0]).location).toBe('index.html:4:8');
    expect(ref.css(m.declsByProp('a')[0]).location).toBe('index.html:4:41');
    expect(parseCss('.a {').error).toEqual({ reason: 'Unclosed block', line: 1, column: 1 });
    expect(isPrintOnlyMedia('only print and (color)')).toBe(true);
    expect(isPrintOnlyMedia('screen, print')).toBe(false);
    expect(normalizePrelude('( Prefers-Reduced-Motion:  Reduce )')).toBe('(prefers-reduced-motion: reduce)');
  });
});

// ---------------------------------------------------------------------------
// JS model through the real collector
// ---------------------------------------------------------------------------

describe('js model: listeners', () => {
  const src = `window.addEventListener('touchstart', a, { passive: false });
self.addEventListener('wheel', b, !1);
addEventListener('scroll', c, true);
document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: true, once: !0, signal: ctl.signal });
document.body.addEventListener('click', d, opts);
el.addEventListener('keydown', handler.bind(this));
document.querySelector('.x').addEventListener('Click', () => {});
function outer() { this.addEventListener('click', f); }
this.addEventListener('focus', g);
window.onbeforeunload = function () { return 'x'; };
onunload = bye;
window.onpagehide = null;
$(window).on('scroll.ns resize', onScroll);
$(document).ready(init);
$(function () { go(); });
jQuery('body').one('click', '.btn', {a: 1}, clicked);
el.addEventListener(type, nope);
function handler() {}
function init() {}
const bye = () => {};
function onScroll() {}
`;

  it('classifies via, event, target, options and handlers', async () => {
    const { js } = await contextFor({ 'index.html': '<body onscroll="s()" onclick="c()"><div onclick="x()"></div><script src="a.js"></script></body>', 'a.js': src });
    const rows = js.listeners.map((l) => [l.via, l.event, l.target, l.targetText, l.options.kind, l.options.passive ?? 'unset', Boolean(l.handler), l.topLevel]);
    expect(rows).toEqual([
      ['addEventListener', 'touchstart', 'window', 'window', 'object', false, false, true],
      ['addEventListener', 'wheel', 'window', 'self', 'boolean', 'unset', false, true],
      ['addEventListener', 'scroll', 'window', 'window', 'boolean', 'unset', false, true],
      ['addEventListener', 'touchmove', 'document', 'document', 'object', true, true, true],
      ['addEventListener', 'click', 'root-element', 'document.body', 'unknown', 'unset', false, true],
      ['addEventListener', 'keydown', 'element', 'el', 'none', 'unset', true, true],
      ['addEventListener', 'click', 'element', "document.querySelector('.x')", 'none', 'unset', true, true],
      ['addEventListener', 'click', 'unknown', 'this', 'none', 'unset', false, false],
      ['addEventListener', 'focus', 'window', 'this', 'none', 'unset', false, true],
      ['property', 'beforeunload', 'window', 'window', 'none', 'unset', true, true],
      ['property', 'unload', 'window', 'window', 'none', 'unset', true, true],
      ['jquery', 'scroll', 'window', '$(window)', 'none', 'unset', true, true],
      ['jquery', 'resize', 'window', '$(window)', 'none', 'unset', true, true],
      ['jquery', 'domcontentloaded', 'document', '$(document)', 'none', 'unset', true, true],
      ['jquery', 'domcontentloaded', 'document', 'document', 'none', 'unset', true, true],
      ['jquery', 'click', 'root-element', "jQuery('body')", 'none', 'unset', false, true],
      ['attribute', 'scroll', 'window', 'body', 'none', 'unset', true, true],
      ['attribute', 'click', 'root-element', 'body', 'none', 'unset', true, true],
      ['attribute', 'click', 'element', 'body > div', 'none', 'unset', true, true],
    ]);
    const tm = js.listenersByEvent('TOUCHMOVE')[0];
    expect(tm.options).toEqual({ kind: 'object', passive: true, capture: false, once: true, signal: true });
    expect(js.listenersByEvent('scroll')[0].options).toEqual({ kind: 'boolean', passive: undefined, capture: true, once: false, signal: false });
    expect(js.listenerForFunction(tm.handler)).toBe(tm);
    expect(js.listenersByEvent('domcontentloaded')[1].handlerText).toBe('function () { go(); }');
    expect(js.listenersByEvent('keydown')[0].handler.id.name).toBe('handler');
    const attr = js.listeners.find((l) => l.via === 'attribute' && l.event === 'scroll');
    expect(attr.handler.type).toBe('Program');
    expect(attr.handlerText).toBe('s()');
    expect(js.assignments.map((a) => [a.target, a.normalizedTarget, a.property])).toEqual([
      ['window.onbeforeunload', 'onbeforeunload', 'onbeforeunload'], ['onunload', 'onunload', 'onunload'], ['window.onpagehide', 'onpagehide', 'onpagehide'],
    ]);
  });
});

describe('js model: structure', () => {
  const src = `(function () { setTimeout(a, 0); window.document.startViewTransition(); })();
!function(){ x(); }();
(() => { y(); }).call(this);
function f() { z(); for (const i of list) { setTimeout(q); } }
document.querySelector('a').focus();
a?.b?.c();
document.startViewTransition?.(() => {});
new XMLHttpRequest();
obj['open']('GET', u, false);
const vt = 'startViewTransition' in document;
if (vt) document.startViewTransition(one);
if (!document.startViewTransition) { fallback(); } else { document.startViewTransition(two); }
'startViewTransition' in document && document.startViewTransition(three);
try { document.startViewTransition(four); } catch (e) {}
function early() { if (!document.startViewTransition) return; document.startViewTransition(five); }
document.startViewTransition(six);
switch (typeof document.startViewTransition) { case 'function': document.startViewTransition(seven); }
const vt2 = document.startViewTransition ? 1 : 0; document.startViewTransition ? document.startViewTransition(eight) : 0;
function supports() { return 'startViewTransition' in document; }
if (supports()) document.startViewTransition(nine);
const s = 'long-animation-frame'; const t = \`long-animation-frame\`; const u2 = \`long-\${x}\`;
import('./x.js');
require('y');
importScripts('w.js', 'v.js');
`;

  it('computes callee paths, topLevel, inLoop, optional and isNew', async () => {
    const { js } = await contextFor({ 'index.html': '<script src="a.js"></script>', 'a.js': src });
    const row = (callee) => js.calls.filter((c) => c.callee === callee).map((c) => [c.topLevel, c.inLoop, c.optional, c.isNew]);
    expect(row('setTimeout')).toEqual([[true, false, false, false], [false, true, false, false]]);
    expect(row('x')).toEqual([[true, false, false, false]]);
    expect(row('y')).toEqual([[true, false, false, false]]);
    expect(row('z')).toEqual([[false, false, false, false]]);
    expect(row('XMLHttpRequest')).toEqual([[true, false, false, true]]);
    expect(js.calls.map((c) => c.callee)).toEqual(expect.arrayContaining(['?', '?.call', '?.focus', 'a.b.c', 'obj.open', 'document.querySelector']));
    expect(js.callsByCallee('window.document.startViewTransition')).toHaveLength(11);
    expect(js.callsByMethod('open')[0].args).toHaveLength(3);
    expect(js.callsByCallee('document.startViewTransition').filter((c) => c.optional)).toHaveLength(1);
    const xCall = js.callsByCallee('x')[0];
    const fns = js.enclosingFunctions(xCall.ancestors);
    expect(fns.map((fn) => fn.__iife)).toEqual([true]);
    expect(Object.keys(fns[0])).not.toContain('__iife');
    expect(js.enclosingFunctions(js.callsByCallee('z')[0].ancestors).map((fn) => fn.__iife)).toEqual([false]);
  });

  it('isGuarded covers the (a) to (e) guard forms', async () => {
    const { js } = await contextFor({ 'index.html': '<script src="a.js"></script>', 'a.js': src });
    const vts = js.callsByCallee('document.startViewTransition');
    const label = (c) => (c.args[0] ? js.sourceOf(c.script, c.args[0]) : 'iife');
    const guarded = Object.fromEntries(vts.map((c) => [label(c), [js.isGuarded(c, /startViewTransition/), js.isGuarded(c, /startViewTransition/, { tryCounts: true })]]));
    expect(guarded).toEqual({
      iife: [false, false], '() => {}': [true, true], one: [true, true], two: [true, true], three: [true, true], four: [false, true],
      five: [true, true], six: [false, false], seven: [true, true], eight: [true, true], nine: [true, true],
    });
  });

  it('finds string literals, mentions, imports and sources', async () => {
    const { js } = await contextFor({ 'index.html': '<script src="a.js"></script>', 'a.js': src });
    expect(js.stringLiterals('long-animation-frame')).toHaveLength(2);
    expect(js.stringLiterals('nope')).toEqual([]);
    expect(js.mentions(/XMLHttpRequest/g)).toBe(true);
    expect(js.mentions(/XMLHttpRequest/g)).toBe(true);
    expect(js.mentions(/nothere/)).toBe(false);
    expect(js.imports.map((i) => [i.kind, i.source])).toEqual([['dynamic', './x.js'], ['require', 'y'], ['importScripts', 'w.js'], ['importScripts', 'v.js']]);
  });

  it('walks functions, resolves handlers, tests conditions and locates raw offsets', async () => {
    const raw = "function h(e) {\r\n  if (e.x) { e.preventDefault(); }\r\n  e.stopPropagation();\r\n  e.x && e.a();\r\n  requestAnimationFrame(() => { e.target.style.transform = 'x'; });\r\n}\r\nwindow.addEventListener('click', h);\r\n";
    const { js } = await contextFor({ 'index.html': '<script src="a.js"></script>', 'a.js': raw });
    const l = js.listeners[0];
    const script = l.script;
    expect(l.handler.type).toBe('FunctionDeclaration');
    expect(js.resolveFunction(script, { type: 'Identifier', name: 'h' })).toBe(l.handler);
    expect(js.resolveFunction(script, { type: 'Identifier', name: 'nope' })).toBeNull();
    expect(js.initializerOf(script, 'h')).toBe(l.handler);
    expect(js.initializerOf(script, 'nope')).toBeNull();
    const calls = [];
    js.walkFunction(l.handler, (n, anc) => {
      if (n.type === 'CallExpression') calls.push([js.sourceOf(script, n.callee), js.isConditional(anc, l.handler, n), anc[0] === l.handler]);
    });
    expect(calls).toEqual([['e.preventDefault', true, true], ['e.stopPropagation', false, true], ['e.a', true, true], ['requestAnimationFrame', false, true]]);
    const assigns = [];
    js.walkFunction(l.handler, (n) => { if (n.type === 'AssignmentExpression') assigns.push(js.sourceOf(script, n)); });
    expect(assigns).toEqual([]);
    js.walkFunction(l.handler, (n) => { if (n.type === 'AssignmentExpression') assigns.push(js.sourceOf(script, n)); }, { nested: true });
    expect(assigns).toEqual(["e.target.style.transform = 'x'"]);
    const seen = [];
    js.walkFunction(l.handler, (n) => {
      if (n.type === 'CallExpression') seen.push(js.sourceOf(script, n.callee));
      return n.type !== 'IfStatement';
    });
    expect(seen).toEqual(['e.stopPropagation', 'e.a', 'requestAnimationFrame']);
    const pd = js.callsByMethod('preventDefault')[0];
    expect(js.isConditional(pd)).toBe(true);
    expect(js.isConditional(pd, pd.ancestors[pd.ancestors.length - 1])).toBe(false);
    expect(js.locate('a.js', raw.indexOf('window'))).toEqual({ line: 7, column: 1 });
    expect(js.locate('a.js', 0)).toEqual({ line: 1, column: 1 });
    expect(js.locate('a.js', raw.length + 5)).toBeNull();
    expect(js.locate('index.html', 1)).toBeNull();
    expect(js.locate('nope.js', 1)).toBeNull();
    expect(js.sourceOf(script, l.node)).toBe("window.addEventListener('click', h)");
  });

  it('parses modules, event attributes and reports syntax errors', () => {
    expect(parseJs('let x = <div/>;').error).toEqual({ message: 'Unexpected token', line: 1, column: 9 });
    expect(parseJs('import x from "y"; export default 1;')).toMatchObject({ sourceType: 'module', error: null });
    expect(parseJs('return false', { eventAttr: true }).error).toBeNull();
    expect(parseJs('return false').error).not.toBeNull();
    const ast = parseJs('a.b["c"][d]().e').ast;
    expect(pathOf(ast.body[0].expression)).toBe('?.e');
    expect(pathOf(ast.body[0].expression.object.callee)).toBe('a.b.c.?');
    expect(childNodes(ast.body[0])).toHaveLength(1);
    expect(childNodes({ type: 'Nope' })).toEqual([]);
  });
});

describe('csp', () => {
  it('parses header and meta policies, first directive wins, report-only never passed', () => {
    const policies = parseCsp("script-src 'self' 'nonce-abc'; SCRIPT-SRC 'none'; default-src 'self', script-src-elem 'inline-speculation-rules'", ["default-src 'self' 'sha256-xyz='", '']);
    expect(policies).toEqual([
      { source: 'header', directives: { 'script-src': ["'self'", "'nonce-abc'"], 'default-src': ["'self'"] } },
      { source: 'header', directives: { 'script-src-elem': ["'inline-speculation-rules'"] } },
      { source: 'meta', directives: { 'default-src': ["'self'", "'sha256-xyz='"] } },
    ]);
    expect(parseCsp(null, [])).toEqual([]);
    expect(parseCsp('  ;  ', [])).toEqual([]);
  });

  it('exposes header CSP on http pages and meta CSP on file pages', async () => {
    const ctx = await contextFor({ 'index.html': `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">` });
    expect(ctx.page.csp).toEqual([{ source: 'meta', directives: { 'script-src': ["'self'"] } }]);
  });
});

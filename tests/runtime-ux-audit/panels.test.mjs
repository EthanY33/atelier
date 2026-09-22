import { describe, it, expect } from 'vitest';
import {
  contextFor, runRule, runFixture, expectGolden, rawJson, readFixtureJson, expectAsciiNoDash,
} from './helpers.mjs';
import { rules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/panels/index.mjs';
import { _internals } from '../../plugins/atelier/skills/runtime-ux-audit/rules/panels/css.mjs';
import {
  keyCovers, simpleParts, styleAttrSelector, declDurations, resolveTimeToken, parenDepthAt,
} from '../../plugins/atelier/skills/runtime-ux-audit/rules/panels/shared.mjs';
import { HEADLINES } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import { toShortRuleId } from '../../plugins/atelier/skills/runtime-ux-audit/lib/options.mjs';

const byShort = Object.fromEntries(rules.map((r) => [toShortRuleId(r.id), r]));

/** A one-file site: inline <style>, body markup and an inline classic script. */
function page({ css = '', body = '', js = '', head = '' } = {}) {
  const style = css ? `<style>\n${css}\n</style>\n` : '';
  const script = js ? `<script>\n${js}\n</script>\n` : '';
  return { 'index.html': `<!doctype html>\n<html><head>\n${head}${style}</head><body>\n${body}\n${script}</body></html>\n` };
}

async function check(short, files, opts = {}) {
  const rule = byShort[short];
  if (!rule) throw new Error(`no rule ${short}`);
  return runRule(rule, await contextFor(files, opts));
}

const snippets = (res) => res.nodes.map((n) => n.snippet);
const messages = (res) => res.nodes.map((n) => n.message);

// ---------------------------------------------------------------------------

describe('panels registry', () => {
  const DESIGN = {
    'z-index-over-budget': ['minor', 'high', 'static'],
    'z-index-literal-smell': ['moderate', 'high', 'static'],
    'dialog-missing-label': ['serious', 'high', 'static'],
    'div-role-dialog': ['moderate', 'medium', 'static'],
    'focus-trap-library-near-dialog': ['minor', 'high', 'static'],
    'custom-outside-click-on-auto-popover': ['moderate', 'medium', 'static'],
    'custom-escape-on-dialog-popover': ['minor', 'low', 'static'],
    'tooltip-focusable': ['serious', 'high', 'static'],
    'menu-no-arrow-keys': ['serious', 'medium', 'static'],
    'no-starting-style-on-transitioned-popover': ['moderate', 'medium', 'static'],
    'transition-all-on-popover': ['minor', 'high', 'static'],
    'motion-no-reduced-motion-guard': ['moderate', 'medium', 'static'],
    'exit-not-faster-than-enter': ['minor', 'medium', 'static'],
    'backdrop-as-sibling-div': ['moderate', 'medium', 'static'],
    'inert-with-showmodal': ['minor', 'medium', 'static'],
    'focus-lost-after-close': ['serious', 'high', 'dynamic'],
    'anchor-name-no-supports': ['moderate', 'high', 'static'],
    'stale-inset-area': ['minor', 'high', 'static'],
    'fixed-max-height-no-overflow': ['minor', 'medium', 'static'],
    'destructive-dialog-closedby-any': ['serious', 'medium', 'static'],
    'motion-duration-off-token': ['minor', 'high', 'static'],
    'backdrop-filter-on-opaque-fill': ['moderate', 'high', 'static'],
    'backdrop-filter-on-video-modal': ['serious', 'high', 'static'],
    'fixed-nav-backdrop-filter-under-modal': ['moderate', 'medium', 'static'],
  };

  it('ships every panels rule of the design with its severity, confidence and phase', () => {
    expect(Object.keys(byShort).sort()).toEqual(Object.keys(DESIGN).sort());
    for (const [id, [severity, confidence, phase]] of Object.entries(DESIGN)) {
      expect(byShort[id], id).toMatchObject({ area: 'panels', severity, confidence, phase });
      expectAsciiNoDash(byShort[id].description, `${id} description`);
      expect(byShort[id].helpUrl).toMatch(/^https:\/\//);
    }
  });

  it('marks the rendered re-run and brand rules', () => {
    const rendered = rules.filter((r) => r.rendered).map((r) => toShortRuleId(r.id)).sort();
    expect(rendered).toEqual([
      'backdrop-as-sibling-div', 'backdrop-filter-on-video-modal', 'destructive-dialog-closedby-any',
      'dialog-missing-label', 'div-role-dialog', 'menu-no-arrow-keys', 'tooltip-focusable',
    ]);
    expect(rules.filter((r) => r.brand).map((r) => toShortRuleId(r.id)).sort()).toEqual(['motion-duration-off-token', 'z-index-over-budget']);
  });

  it('covers every panels headline id', () => {
    const ids = new Set(rules.map((r) => r.id));
    for (const h of HEADLINES.panels) for (const id of h.ruleIds) expect(ids.has(id), id).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('panels helpers', () => {
  it('splits compounds into simple selectors', () => {
    expect(simpleParts('dialog.a[open]:hover::backdrop')).toEqual(['dialog', '.a', '[open]', ':hover', '::backdrop']);
    expect(simpleParts('.x:not(.y, .z)[data-a="b.c"]')).toEqual(['.x', ':not(.y, .z)', '[data-a="b.c"]']);
    expect(simpleParts('a\\.b')).toEqual(['a\\.b']);
  });

  it('decides when a key covers a selector', () => {
    expect(keyCovers('dialog', 'dialog')).toBe(true);
    expect(keyCovers('[popover]', '.menu[popover]')).toBe(true);
    expect(keyCovers('*', 'dialog')).toBe(true);
    expect(keyCovers('dialog', 'dialog::backdrop')).toBe(false);
    expect(keyCovers('dialog::backdrop', 'dialog.x::backdrop')).toBe(true);
    expect(keyCovers('.a .b', '.c .a .b')).toBe(false);
    expect(keyCovers('.menu', '.dropdown')).toBe(false);
  });

  it('builds predicate selectors for style attributes', () => {
    const el = { tagName: 'div', attrs: [{ name: 'popover', value: '' }, { name: 'role', value: 'Dialog x' }, { name: 'aria-modal', value: 'true' }, { name: 'class', value: 'a b-c $bad' }] };
    expect(styleAttrSelector(el)).toBe('div[popover][role=dialog][aria-modal].a.b-c');
    expect(styleAttrSelector({ tagName: 'DIALOG', attrs: [] })).toBe('dialog');
  });

  it('knows which properties move and which selectors are global resets', () => {
    expect(_internals.isMotionProperty('transform')).toBe(true);
    expect(_internals.isMotionProperty('all')).toBe(true);
    expect(_internals.isMotionProperty('opacity')).toBe(false);
    expect(_internals.isMotionProperty('--x')).toBe(false);
    expect(_internals.isMotionProperty(null)).toBe(false);
    for (const s of ['*', '*::before', '::after', 'html', ':root', 'html *', 'body *']) expect(_internals.isGlobalSelector(s), s).toBe(true);
    for (const s of ['.modal', 'html.x', '* .modal']) expect(_internals.isGlobalSelector(s), s).toBe(false);
  });

  it('removes one open-state token to find the closed selector', () => {
    expect(_internals.closedVariants('.drawer.is-open')).toEqual(['.drawer']);
    expect(_internals.closedVariants('dialog[open]')).toEqual(['dialog']);
    expect(_internals.closedVariants('[popover]:popover-open')).toEqual(['[popover]']);
    expect(_internals.closedVariants('.modal.open .panel')).toEqual(['.modal .panel']);
    expect(_internals.closedVariants('.menu:not(.open)')).toEqual([]);
    expect(_internals.closedVariants('.opener')).toEqual([]);
    expect(_internals.closedVariants('[open]')).toEqual([]);
    expect(parenDepthAt('a:not(.b', 7)).toBe(1);
    expect(parenDepthAt('a[x="("] .b', 10)).toBe(0);
  });

  it('flags only the always-on-top literals as smells', () => {
    for (const v of ['9999', '99999', '2147483647', '2147483646']) expect(_internals.isLiteralSmell(v), v).toBe(true);
    for (const v of ['999', '9998', '10000', '-9999', 'auto']) expect(_internals.isLiteralSmell(v), v).toBe(false);
  });

  it('reads fill colors from background shorthands', () => {
    const rule = (props) => ({ get: (p) => (props[p] === undefined ? null : { prop: p, value: props[p] }) });
    expect(_internals.fillColor(rule({ background: '#000 center / cover no-repeat' }))).toEqual({ prop: 'background', color: '#000' });
    expect(_internals.fillColor(rule({ 'background-color': 'white', background: 'red' }))).toEqual({ prop: 'background-color', color: 'white' });
    expect(_internals.fillColor(rule({ background: 'url(x.png) #000' }))).toBeNull();
    expect(_internals.fillColor(rule({ background: 'linear-gradient(red, blue)' }))).toBeNull();
    expect(_internals.fillColor(rule({ background: '#000, #fff' }))).toBeNull();
    expect(_internals.fillColor(rule({ background: 'center' }))).toBeNull();
    expect(_internals.fillColor(rule({}))).toBeNull();
  });

  it('resolves durations through var() one hop and keeps the transitioned property honest', async () => {
    const ctx = await contextFor(page({
      css: ':root { --d: 200ms; --t: opacity .3s; --n: var(--d); }\n@media (prefers-reduced-motion: reduce) { :root { --d: 0ms } }',
    }));
    expect(resolveTimeToken(ctx, '120ms')).toBe(120);
    expect(resolveTimeToken(ctx, 'var(--d)')).toBe(200);
    expect(resolveTimeToken(ctx, 'var(--missing, 80ms)')).toBe(80);
    expect(resolveTimeToken(ctx, 'var(--missing)')).toBeNull();
    expect(resolveTimeToken(ctx, 'var(--n)')).toBeNull();
    const dur = (prop, value) => declDurations(ctx, { prop, value }).map((d) => [d.property, d.ms]);
    expect(dur('transition', 'var(--d)')).toEqual([['all', 200]]);
    expect(dur('transition', 'var(--t)')).toEqual([[null, null]]);
    expect(dur('transition', 'var(--p) .2s')).toEqual([[null, 200]]);
    expect(dur('transition', 'all var(--missing)')).toEqual([['all', null]]);
    expect(dur('transition', 'opacity var(--d), transform 1s')).toEqual([['opacity', 200], ['transform', 1000]]);
    expect(declDurations(ctx, { prop: 'animation', value: 'spin var(--d) infinite' }).map((d) => [d.name, d.ms])).toEqual([['spin', 200]]);
    expect(declDurations(ctx, { prop: 'animation-duration', value: '1s, var(--d)' }).map((d) => d.ms)).toEqual([1000, 200]);
    expect(declDurations(ctx, { prop: 'color', value: 'red' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// z-index
// ---------------------------------------------------------------------------

describe('z-index-over-budget', () => {
  it('flags integers above the default budget of 100', async () => {
    const res = await check('z-index-over-budget', page({ css: '.a { z-index: 150 }\n.b { z-index: 100 }\n.c { z-index: auto }\n.d { z-index: var(--z) }' }));
    expect(res.status).toBe('failed');
    expect(snippets(res)).toEqual(['.a { z-index: 150 }']);
    expect(res.nodes[0].message).toBe('z-index 150 is above the budget of 100 (default)');
    expect(res.nodes[0].data).toEqual({ budget: 100, zIndex: 150 });
  });

  it('uses surfaces.zIndexMax from the brand', async () => {
    const res = await check('z-index-over-budget', page({ css: '.a { z-index: 60 }\n.b { z-index: 40 }' }), { brand: { surfaces: { zIndexMax: 50 } } });
    expect(snippets(res)).toEqual(['.a { z-index: 60 }']);
    expect(res.nodes[0].message).toContain('(surfaces.zIndexMax)');
  });

  it('covers --z custom properties and style attributes but not keyframes or smells', async () => {
    const res = await check('z-index-over-budget', page({
      css: ':root { --z-modal: 500; --zindex-top: 300; --z-index-toast: 200; --zoom: 500; --size: 900 }\n.s { z-index: 99999 }\n@keyframes k { from { z-index: 500 } }',
      body: '<div style="z-index: 1000">x</div>',
    }));
    expect(snippets(res)).toEqual([':root { --z-modal: 500 }', ':root { --zindex-top: 300 }', ':root { --z-index-toast: 200 }', 'style="z-index: 1000"']);
  });

  it('passes when nothing is over budget', async () => {
    const res = await check('z-index-over-budget', page({ css: '.a { z-index: 10 }' }));
    expect(res.status).toBe('passed');
  });
});

describe('z-index-literal-smell', () => {
  it('flags the always-on-top literals, including custom properties', async () => {
    const res = await check('z-index-literal-smell', page({
      css: '.a { z-index: 9999 }\n.b { z-index: 2147483647 }\n.c { z-index: 999 }\n.d { z-index: 10000 }\n:root { --z-top: 2147483646 }',
    }));
    expect(snippets(res)).toEqual(['.a { z-index: 9999 }', '.b { z-index: 2147483647 }', ':root { --z-top: 2147483646 }']);
    expect(res.nodes[0].data).toEqual({ zIndex: 9999 });
  });

  it('passes ordinary values', async () => {
    expect((await check('z-index-literal-smell', page({ css: '.a { z-index: 20 }' }))).status).toBe('passed');
  });

  it('exempts skip links and screen-reader text in both z-index rules', async () => {
    const css = '.skip-link { z-index: 9999 }\n.screen-reader-text:focus { z-index: 100000 }\n.sr-only:focus { z-index: 500 }\n.visually-hidden:focus-within { z-index: 2147483647 }';
    expect((await check('z-index-literal-smell', page({ css }))).status).toBe('passed');
    expect((await check('z-index-over-budget', page({ css }))).status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Dialog semantics (HTML)
// ---------------------------------------------------------------------------

describe('dialog-missing-label', () => {
  it('flags a dialog without a name and passes labelled ones', async () => {
    const res = await check('dialog-missing-label', page({
      body: [
        '<dialog id="a"><p>No name</p></dialog>',
        '<dialog id="b" aria-labelledby="bt"><h2 id="bt">Settings</h2></dialog>',
        '<dialog id="c" aria-label="Search"></dialog>',
        '<dialog id="d" title="Help"></dialog>',
        '<dialog id="e" aria-labelledby="missing"></dialog>',
        '<dialog id="f" aria-labelledby="empty"><h2 id="empty"> </h2></dialog>',
        '<dialog id="g" aria-labelledby="icon"><span id="icon" aria-label="Close tab"></span></dialog>',
        '<dialog id="h" aria-label="  "></dialog>',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['#a', '#e', '#f', '#h']);
    expect(res.nodes[1].message).toBe('aria-labelledby="missing" does not point at an element with text');
    expect(res.nodes[0].message).toContain('no aria-labelledby, aria-label or title');
  });

  it('is not applicable without dialogs', async () => {
    const res = await check('dialog-missing-label', page({ body: '<p>x</p>' }));
    expect(res).toMatchObject({ status: 'notApplicable', reason: 'no <dialog> elements' });
  });
});

describe('div-role-dialog', () => {
  it('flags aria-modal and backdrop-adjacent role=dialog elements', async () => {
    const res = await check('div-role-dialog', page({
      body: [
        '<div id="m" role="dialog" aria-modal="true">A</div>',
        '<section><div class="modal-backdrop"></div><div id="n" role="alertdialog">B</div></section>',
        '<div class="overlay"><div id="o" role="dialog">C</div></div>',
        '<aside><div id="chat" role="dialog" aria-label="Chat">D</div></aside>',
        '<dialog role="dialog" aria-modal="true">E</dialog>',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['#m', '#n', '#o']);
    expect(res.nodes[0].message).toBe('<div role="dialog" aria-modal="true">: use <dialog> with showModal()');
    expect(res.nodes[1].message).toBe('<div role="alertdialog"> next to backdrop ".modal-backdrop": use <dialog> with showModal() and ::backdrop');
    expect(res.nodes[2].message).toContain('".overlay"');
  });

  it('honors data-atelier-ignore and is not applicable without role=dialog', async () => {
    const res = await check('div-role-dialog', page({ body: '<div data-atelier-ignore="div-role-dialog"><div role="dialog" aria-modal="true">x</div></div>' }));
    expect(res).toMatchObject({ status: 'passed', suppressed: 1 });
    const na = await check('div-role-dialog', page({ body: '<dialog open>x</dialog>' }));
    expect(na.status).toBe('notApplicable');
  });
});

describe('backdrop-as-sibling-div', () => {
  it('flags backdrop elements next to or around a modal', async () => {
    const res = await check('backdrop-as-sibling-div', page({
      body: [
        '<section><div class="modal-backdrop"></div><div class="modal">A</div></section>',
        '<div id="page-scrim"><div role="dialog">B</div></div>',
        '<section><div id="backdrop"></div><dialog>C</dialog></section>',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['body > section:nth-of-type(1) > div.modal-backdrop:nth-of-type(1)', '#page-scrim', '#backdrop']);
    expect(res.nodes[0].message).toBe('".modal-backdrop" backs modal body > section:nth-of-type(1) > div.modal:nth-of-type(2); style dialog::backdrop instead');
  });

  it('ignores overlays that are not next to a modal, page elements and look-alike names', async () => {
    const res = await check('backdrop-as-sibling-div', page({
      body: [
        '<div class="card"><img src="a.png" alt=""><div class="card-overlay">caption</div></div>',
        '<div class="hero-overlay-text"></div><div class="overlayed"></div>',
        '<main class="has-overlay"><dialog>x</dialog></main>',
        '<section><div class="overlay" role="dialog"></div><div class="modal"></div></section>',
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });

  it('prefers the nearest following modal in the message', async () => {
    const res = await check('backdrop-as-sibling-div', page({
      body: '<section><dialog id="early">x</dialog><div class="scrim"></div><div class="modal" id="late">y</div></section>',
    }));
    expect(res.nodes[0].message).toContain('backs modal #late');
  });
});

describe('destructive-dialog-closedby-any', () => {
  it('flags destructive confirmations that close on any click', async () => {
    const res = await check('destructive-dialog-closedby-any', page({
      body: [
        '<dialog id="a" closedby="any"><h2>Delete project?</h2></dialog>',
        '<dialog id="b" closedby="ANY" aria-labelledby="bt"><h2 id="bt">Remove member</h2></dialog>',
        '<dialog id="c" closedby="any" aria-label="Destroy session"></dialog>',
        '<dialog id="d" closedby="closerequest"><h2>Delete project?</h2></dialog>',
        '<dialog id="e" closedby="any"><h2>Newsletter</h2><p>Your data was removed from the list.</p></dialog>',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['#a', '#b', '#c']);
    expect(res.nodes[0].message).toBe('closedby="any" on a "delete" confirmation; use closedby="closerequest" so only Escape or a button closes it');
    expect(res.nodes[0].location).toMatch(/^index\.html:\d+:\d+$/);
  });

  it('is not applicable without closedby="any"', async () => {
    const res = await check('destructive-dialog-closedby-any', page({ body: '<dialog closedby="none">Delete?</dialog>' }));
    expect(res.status).toBe('notApplicable');
  });
});

describe('tooltip-focusable', () => {
  it('flags focusable tooltip elements', async () => {
    const res = await check('tooltip-focusable', page({
      body: [
        '<div id="t1" role="tooltip" tabindex="0">a</div>',
        '<div id="t2" role="tooltip" tabindex="-1">b</div>',
        '<button id="t3" role="tooltip">c</button>',
        '<a id="t4" role="tooltip">d</a>',
        '<a id="t5" role="tooltip" href="#x">e</a>',
        '<input id="t6" role="tooltip" type="hidden">',
        '<input id="t7" role="tooltip">',
        '<div id="t8" role="tooltip" contenteditable>f</div>',
        '<div id="t9" role="tooltip" contenteditable="false">g</div>',
        '<select id="t10" role="tooltip"></select>',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['#t1', '#t3', '#t5', '#t7', '#t8', '#t10']);
    expect(messages(res).slice(0, 2)).toEqual(['role="tooltip" element is focusable (tabindex="0")', 'role="tooltip" element is focusable (native <button>)']);
  });

  it('flags scripts that focus a tooltip', async () => {
    const res = await check('tooltip-focusable', page({
      body: '<div id="tip" class="tip" role="tooltip">a</div><button id="btn">b</button>',
      js: [
        "document.getElementById('tip').focus();",
        "document.querySelector('.tip').focus();",
        "const t = document.getElementById('tip'); t.focus();",
        "document.getElementById('btn').focus();",
        "document.querySelector('.missing').focus();",
        "someEl.focus();",
        "document.getElementById(id).focus();",
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => n.snippet)).toEqual([
      "document.getElementById('tip').focus()",
      "document.querySelector('.tip').focus()",
      't.focus()',
    ]);
    expect(res.nodes[0].message).toBe('focus() moves focus into role="tooltip" element #tip');
  });

  it('is not applicable without tooltips', async () => {
    const res = await check('tooltip-focusable', page({ body: '<p>x</p>' }));
    expect(res.status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------
// JS behavior
// ---------------------------------------------------------------------------

describe('menu-no-arrow-keys', () => {
  const menus = '<ul id="m1" role="menu"><li role="menuitem">a</li></ul><div id="m2" role="menubar"></div>';

  it('flags menus when no script handles the arrow keys', async () => {
    const res = await check('menu-no-arrow-keys', page({ body: menus, js: "document.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });" }));
    expect(res.status).toBe('failed');
    expect(res.nodes.map((n) => n.selector)).toEqual(['#m1', '#m2']);
    expect(res.nodes[0].message).toBe('role="menu" but no keydown handler for ArrowUp/ArrowDown');
  });

  it('passes when a handler or any script tests the arrow keys', async () => {
    for (const js of [
      "menu.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') next(); });",
      "menu.addEventListener('keyup', function (e) { if (e.keyCode === 40) next(); });",
      "menu.onkeydown = function (e) { switch (e.which) { case 38: prev(); } };",
    ]) {
      const res = await check('menu-no-arrow-keys', page({ body: menus, js }));
      expect(res.status, js).toBe('passed');
    }
    const attr = await check('menu-no-arrow-keys', page({ body: `${menus}<div onkeydown="if (event.key === 'ArrowUp') prev()"></div>` }));
    expect(attr.status).toBe('passed');
  });

  it('passes when an unresolved handler lives in another script', async () => {
    const files = {
      'index.html': `<!doctype html><html><body>${menus}<script>menu.addEventListener('keydown', onKey);</script><script src="keys.js"></script></body></html>`,
      'keys.js': "function onKey(e) { if (e.key.startsWith('Arrow')) move(e); }\n",
    };
    expect((await check('menu-no-arrow-keys', files)).status).toBe('passed');
    const lonely = await check('menu-no-arrow-keys', page({ body: menus, js: "menu.addEventListener('keydown', onKey);" }));
    expect(lonely.status).toBe('failed');
  });

  it('routes to incomplete when scripts could not be read', async () => {
    const cross = await check('menu-no-arrow-keys', page({ body: `${menus}<script src="https://cdn.example.com/menu.js"></script>` }));
    expect(cross.status).toBe('incomplete');
    expect(cross.incomplete[0].message).toBe('role="menu" but no keydown handler for ArrowUp/ArrowDown (1 script was not read: cross-origin)');
    const failed = await check('menu-no-arrow-keys', page({ body: `${menus}<script src="missing.js"></script>` }));
    expect(failed.status).toBe('incomplete');
    expect(failed.incomplete[0].message).toContain('some same-origin scripts could not be read');
  });

  it('routes to incomplete when a script loads more scripts at run time (calibration: web.dev loader)', async () => {
    const loader = "(function (d, e, v, s) { var t = e.createElement(v); t.async = 1; t.src = s; d.head.appendChild(t); })(window, document, 'script', 'https://cdn.example.com/app.js');";
    const res = await check('menu-no-arrow-keys', page({ body: menus, js: loader }));
    expect(res.status).toBe('incomplete');
    expect(res.incomplete[0].message).toContain('a script loads more scripts at run time');
    expect((await check('menu-no-arrow-keys', page({ body: menus, js: "const s = document.createElement('SCRIPT'); s.src = '/m.js';" }))).status).toBe('incomplete');
    expect((await check('menu-no-arrow-keys', page({ body: menus, js: 'import(`./menus/${name}.js`).then(init);' }))).status).toBe('incomplete');
    // Creating other elements is not a loader.
    expect((await check('menu-no-arrow-keys', page({ body: menus, js: "document.body.append(document.createElement('div'));" }))).status).toBe('failed');
  });

  it('reports at most five menus and is not applicable without menus', async () => {
    const many = Array.from({ length: 7 }, (_, i) => `<ul id="x${i}" role="menu"></ul>`).join('');
    const res = await check('menu-no-arrow-keys', page({ body: many }));
    expect(res.nodes.map((n) => n.selector)).toEqual(['#x0', '#x1', '#x2', '#x3', '#x4']);
    expect((await check('menu-no-arrow-keys', page({ body: '<nav>x</nav>' }))).status).toBe('notApplicable');
  });
});

describe('focus-trap-library-near-dialog', () => {
  it('flags focus-trap imports, script tags and createFocusTrap next to a dialog', async () => {
    const res = await check('focus-trap-library-near-dialog', page({
      body: [
        '<dialog id="d">x</dialog>',
        '<script src="https://unpkg.com/focus-trap@7/dist/focus-trap.umd.min.js"></script>',
        "<script type=\"module\">import { createFocusTrap } from 'focus-trap';\nimport FocusLock from 'react-focus-lock';\nimport x from 'my-focus-trapper';\nconst t = createFocusTrap('#d');</script>",
        "<script>const lock = require('@acme/focus-lock/dist');</script>",
      ].join('\n'),
    }));
    expect(res.status).toBe('failed');
    expect(messages(res)).toEqual([
      'loads https://unpkg.com/focus-trap@7/dist/focus-trap.umd.min.js next to a native <dialog>',
      'static import of "focus-trap" next to a native <dialog>',
      'static import of "react-focus-lock" next to a native <dialog>',
      'createFocusTrap() next to a native <dialog>',
      'require import of "@acme/focus-lock/dist" next to a native <dialog>',
    ]);
  });

  it('counts showModal() as native evidence and needs some native dialog', async () => {
    const withCall = await check('focus-trap-library-near-dialog', page({ js: "import('focus-trap');\nel.showModal();" }));
    expect(withCall.status).toBe('failed');
    const none = await check('focus-trap-library-near-dialog', page({ js: "import('focus-trap');" }));
    expect(none).toMatchObject({ status: 'notApplicable', reason: 'no <dialog> element or showModal() call' });
    const clean = await check('focus-trap-library-near-dialog', page({ body: '<dialog>x</dialog>', js: "import('my-focus-trapper');" }));
    expect(clean.status).toBe('passed');
  });
});

describe('custom-outside-click-on-auto-popover', () => {
  const pop = '<div id="p" popover>menu</div>';

  it('flags page-level listeners that light-dismiss popovers by hand', async () => {
    const res = await check('custom-outside-click-on-auto-popover', page({
      body: pop,
      js: [
        "document.addEventListener('click', (e) => { if (!p.contains(e.target)) p.hidePopover(); });",
        "function onDown(e) { if (!e.composedPath().includes(p)) p.togglePopover(false); }",
        "window.addEventListener('pointerdown', onDown);",
        "document.body.addEventListener('touchstart', (e) => { if (!e.target.closest('[popover]')) close(); });",
      ].join('\n'),
    }));
    expect(messages(res)).toEqual([
      'document click listener dismisses popovers by hand; popover="auto" already closes on an outside click',
      'window pointerdown listener dismisses popovers by hand; popover="auto" already closes on an outside click',
      'document.body touchstart listener dismisses popovers by hand; popover="auto" already closes on an outside click',
    ]);
  });

  it('ignores element listeners, other surfaces and unresolved handlers', async () => {
    const res = await check('custom-outside-click-on-auto-popover', page({
      body: pop,
      js: [
        "p.addEventListener('click', (e) => { if (!p.contains(e.target)) p.hidePopover(); });",
        "document.addEventListener('click', (e) => { if (!nav.contains(e.target)) nav.classList.remove('open'); });",
        "document.addEventListener('keydown', (e) => { if (!p.contains(e.target)) p.hidePopover(); });",
        "document.addEventListener('click', imported);",
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });

  it('needs an auto or hint popover', async () => {
    const js = "document.addEventListener('click', (e) => { if (!p.contains(e.target)) p.hidePopover(); });";
    expect((await check('custom-outside-click-on-auto-popover', page({ body: '<div id="p" popover="manual">x</div>', js }))).status).toBe('notApplicable');
    expect((await check('custom-outside-click-on-auto-popover', page({ body: '<div id="p" popover="hint">x</div>', js }))).status).toBe('failed');
  });
});

describe('custom-escape-on-dialog-popover', () => {
  const esc = "document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dlg.close(); });";

  it('flags Escape handlers that close modal-only dialogs', async () => {
    const res = await check('custom-escape-on-dialog-popover', page({ body: '<dialog id="dlg">x</dialog>', js: `${esc}\nbtn.onclick = () => dlg.showModal();` }));
    expect(res.status).toBe('failed');
    expect(res.nodes[0].message).toContain('every dialog opens with showModal()');
  });

  it('accepts keyCode 27, case 27 and command="show-modal" as evidence', async () => {
    const res = await check('custom-escape-on-dialog-popover', page({
      body: '<button commandfor="dlg" command="show-modal">open</button><dialog id="dlg">x</dialog>',
      js: [
        "dlg.addEventListener('keyup', function (e) { if (e.keyCode === 27) { dlg.close(); } });",
        "document.addEventListener('keydown', (e) => { switch (e.which) { case 27: dlg.close(); } });",
        "document.addEventListener('keydown', (e) => { if (27 == e.keyCode) dlg.close(); });",
      ].join('\n'),
    }));
    expect(res.nodes.length).toBe(3);
  });

  it('passes when some dialog is non-modal or the handler is not about Escape', async () => {
    const shown = await check('custom-escape-on-dialog-popover', page({ body: '<dialog id="dlg">x</dialog>', js: `${esc}\ndlg.showModal();\nother.show();` }));
    expect(shown.status).toBe('passed');
    const open = await check('custom-escape-on-dialog-popover', page({ body: '<dialog id="dlg" open>x</dialog>', js: `${esc}\ndlg.showModal();` }));
    expect(open.status).toBe('passed');
    const enter = await check('custom-escape-on-dialog-popover', page({
      body: '<dialog id="dlg">x</dialog>',
      js: "document.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.close(); });\ndlg.showModal();",
    }));
    expect(enter.status).toBe('passed');
  });

  it('flags Escape handlers that hide auto popovers, unless a manual popover exists', async () => {
    const js = "document.addEventListener('keydown', (e) => { if (e.key === 'Esc') pop.hidePopover(); });";
    const auto = await check('custom-escape-on-dialog-popover', page({ body: '<div id="pop" popover>x</div>', js }));
    expect(auto.nodes[0].message).toContain('every popover is auto or hint');
    const mixed = await check('custom-escape-on-dialog-popover', page({ body: '<div id="pop" popover>x</div><div popover="manual">y</div>', js }));
    expect(mixed.status).toBe('passed');
  });

  it('is not applicable without dialogs or popovers', async () => {
    const res = await check('custom-escape-on-dialog-popover', page({ js: esc }));
    expect(res.status).toBe('notApplicable');
  });
});

describe('inert-with-showmodal', () => {
  it('flags showModal() next to a manual inert toggle in the same function', async () => {
    const res = await check('inert-with-showmodal', page({
      js: [
        "function a() { main.inert = true; dlg.showModal(); }",
        "function b() { main.setAttribute('inert', ''); dlg.showModal(); }",
        "function c() { main.toggleAttribute('inert', true); dlg.showModal(); }",
        "function d() { main.inert = !0; dlg.showModal(); }",
        "function e() { main['inert'] = true; dlg?.showModal(); }",
      ].join('\n'),
    }));
    expect(res.nodes.length).toBe(5);
    expect(res.nodes[0].snippet).toBe('dlg.showModal()');
    expect(res.nodes[0].message).toBe('showModal() already makes the rest of the page inert; drop the manual inert toggle next to it');
  });

  it('passes inert work in other functions, removals and false values', async () => {
    const res = await check('inert-with-showmodal', page({
      js: [
        "function open() { dlg.showModal(); }",
        "function lock() { main.inert = true; }",
        "function f() { main.inert = false; main.removeAttribute('inert'); main.toggleAttribute('inert', false); dlg.showModal(); }",
        "function g() { const inner = () => { main.inert = true; }; dlg.showModal(); }",
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });

  it('treats top-level code as one scope and needs showModal()', async () => {
    const top = await check('inert-with-showmodal', page({ js: "main.inert = true;\ndlg.showModal();" }));
    expect(top.status).toBe('failed');
    const na = await check('inert-with-showmodal', page({ js: 'main.inert = true;' }));
    expect(na).toMatchObject({ status: 'notApplicable', reason: 'no showModal() call' });
  });
});

// ---------------------------------------------------------------------------
// Motion (CSS)
// ---------------------------------------------------------------------------

describe('no-starting-style-on-transitioned-popover', () => {
  const rule = 'no-starting-style-on-transitioned-popover';

  it('flags a transitioned popover without entry styles', async () => {
    const res = await check(rule, page({ css: '[popover] { opacity: 1; transition: opacity .2s, display .2s allow-discrete }' }));
    expect(res.status).toBe('failed');
    expect(res.nodes[0]).toMatchObject({
      selector: '[popover]',
      snippet: '[popover] { transition: opacity .2s, display .2s allow-discrete }',
      message: '"[popover]" transitions without a matching @starting-style, so the entry is not animated',
    });
  });

  it('accepts block, nested and broader @starting-style rules', async () => {
    for (const css of [
      '[popover] { transition: opacity .2s }\n@starting-style { [popover]:popover-open { opacity: 0 } }',
      '[popover] { transition: opacity .2s; &:popover-open { @starting-style { opacity: 0 } } }',
      'dialog[open] { transition: opacity .2s; @starting-style { opacity: 0 } }',
      '.menu[popover] { transition: opacity .2s }\n@starting-style { [popover]:popover-open { opacity: 0 } }',
      'dialog.big { transition: opacity .2s }\n@starting-style { :modal { opacity: 0 } }',
      'dialog::backdrop { transition: opacity .2s }\n@starting-style { dialog[open]::backdrop { opacity: 0 } }',
    ]) {
      const res = await check(rule, page({ css }));
      expect(res.status, css).toBe('passed');
    }
  });

  it('keeps ::backdrop separate, skips zero, unknown and reduced-motion transitions', async () => {
    const backdrop = await check(rule, page({ css: 'dialog::backdrop { transition: opacity .2s }\n@starting-style { dialog[open] { opacity: 0 } }' }));
    expect(backdrop.nodes.map((n) => n.selector)).toEqual(['dialog::backdrop']);
    const quiet = await check(rule, page({
      css: 'dialog { transition: none }\n[popover] { transition: opacity 0s }\ndialog.x { transition: opacity var(--nope) }\n@media (prefers-reduced-motion: reduce) { dialog { transition: opacity .1s } }\n.card { transition: opacity .2s }',
    }));
    expect(quiet.status).toBe('passed');
  });

  it('looks at the styled element, not its descendants or invoker buttons', async () => {
    const res = await check(rule, page({
      css: 'dialog .btn { transition: background-color .2s }\nbutton[popovertarget] { transition: background-color .2s }\n[popover] > li { transition: opacity .2s }',
    }));
    expect(res.status).toBe('passed');
  });

  it('resolves var() durations and handles style attributes', async () => {
    const res = await check(rule, page({
      css: ':root { --d: 180ms }\ndialog { transition: opacity var(--d) }',
      body: '<div id="p1" popover style="transition: opacity .2s">x</div><div id="p2" class="lit" popover style="transition: opacity .2s">y</div>',
    }));
    expect(res.nodes.map((n) => n.snippet)).toEqual(['dialog { transition: opacity var(--d) }', 'style="transition: opacity .2s"', 'style="transition: opacity .2s"']);
    const covered = await check(rule, page({
      css: '@starting-style { [popover]:popover-open { opacity: 0 } }',
      body: '<div popover style="transition: opacity .2s">x</div>',
    }));
    expect(covered.status).toBe('passed');
  });

  it('routes to incomplete when a stylesheet failed', async () => {
    const res = await check(rule, { ...page({ css: '[popover] { transition: opacity .2s }', head: '<link rel="stylesheet" href="missing.css">\n' }) });
    expect(res.status).toBe('incomplete');
    expect(res.incomplete.length).toBe(1);
  });
});

describe('transition-all-on-popover', () => {
  const rule = 'transition-all-on-popover';

  it('flags explicit and implicit all on popovers and dialogs', async () => {
    const res = await check(rule, page({
      css: 'dialog { transition: all .3s }\n[popover] { transition: .2s ease }\n:popover-open { transition-property: opacity, all }\n.menu[popover] { transition: all var(--missing) }',
    }));
    expect(snippets(res)).toEqual([
      'dialog { transition: all .3s }',
      '[popover] { transition: .2s ease }',
      ':popover-open { transition-property: opacity, all }',
      '.menu[popover] { transition: all var(--missing) }',
    ]);
  });

  it('passes named properties, zero durations, var-hidden properties and non-popovers', async () => {
    const res = await check(rule, page({
      css: 'dialog { transition: opacity .2s, overlay .2s allow-discrete }\n[popover] { transition: all 0s }\ndialog.x { transition: var(--t) }\n.card { transition: all .2s }\ndialog .btn { transition: all .2s }\n[popovertarget] { transition: all .2s }',
      body: '<div popover style="transition: opacity .2s">x</div>',
    }));
    expect(res.status).toBe('passed');
  });

  it('checks style attributes on dialogs', async () => {
    const res = await check(rule, page({ body: '<dialog style="transition: all .2s">x</dialog>' }));
    expect(snippets(res)).toEqual(['style="transition: all .2s"']);
  });
});

describe('motion-no-reduced-motion-guard', () => {
  const rule = 'motion-no-reduced-motion-guard';

  it('flags panels that move with no reduced-motion override', async () => {
    const res = await check(rule, page({
      css: '.modal { transition: transform .3s }\n.drawer { animation: slide 400ms }\n@keyframes slide { from { transform: translateX(100%) } }\n.menu { transition-duration: 200ms }',
    }));
    expect(snippets(res)).toEqual(['.modal { transition: transform .3s }', '.drawer { animation: slide 400ms }', '.menu { transition-duration: 200ms }']);
    expect(res.nodes[0].message).toBe('".modal" moves with no prefers-reduced-motion: reduce override');
  });

  it('passes a global reset, a matching override, the boolean media form and nested overrides', async () => {
    for (const css of [
      '.modal { transition: transform .3s }\n@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important } }',
      '.modal { transition: transform .3s }\n@media (prefers-reduced-motion: reduce) { .modal { transition: none } }',
      '.modal.is-open .panel { transition: transform .3s }\n@media (prefers-reduced-motion) { .panel { transform: none } }',
      '.modal { transition: transform .3s; @media (prefers-reduced-motion: reduce) { transition: none } }',
      '@media (prefers-reduced-motion: no-preference) { .modal { transition: transform .3s } }',
      ':root { --dur: 300ms }\n@media (prefers-reduced-motion: reduce) { :root { --dur: 0ms } }\n.modal { transition: transform var(--dur) }',
      ':root { --ease-dur: var(--base); --base: 300ms }\n@media (prefers-reduced-motion: reduce) { :root { --base: 0ms } }\n.modal { transition: transform var(--ease-dur) }',
    ]) {
      const res = await check(rule, page({ css }));
      expect(res.status, css).toBe('passed');
    }
  });

  it('does not treat a global reduce rule without motion properties as a guard', async () => {
    const res = await check(rule, page({
      css: '.modal { transition: transform .3s }\n@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important } html { scroll-behavior: auto } }',
    }));
    expect(res.status).toBe('failed');
  });

  it('does not count opacity or color fades, empty animations or non-panels as motion', async () => {
    const res = await check(rule, page({
      css: [
        '.modal { transition: opacity .3s, background-color .3s, box-shadow .2s }',
        '.popover { animation: fade 200ms }',
        '@keyframes fade { from { opacity: 0 } }',
        '.tooltip { animation: none }',
        '.menu { transition-property: opacity; transition-duration: 200ms }',
        '.dropdown { animation-name: fade; animation-duration: 200ms }',
        '.card { transition: transform .3s }',
        '.sheet { transition: transform 0s }',
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });

  it('treats unknown keyframes and animation longhands as motion', async () => {
    const res = await check(rule, page({ css: '.sheet { animation: mystery 300ms }\n.flyout { animation-name: slide; animation-duration: 300ms }\n@keyframes slide { to { translate: 0 10px } }' }));
    expect(snippets(res)).toEqual(['.sheet { animation: mystery 300ms }', '.flyout { animation-duration: 300ms }']);
  });

  it('lowers confidence when a script reads prefers-reduced-motion, and handles style attributes', async () => {
    const res = await check(rule, page({
      body: '<div class="drawer" style="transition: transform .3s">x</div>',
      js: "const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;",
    }));
    expect(res.nodes[0].confidence).toBe('low');
    expect(res.nodes[0].message).toContain('a script reads prefers-reduced-motion');
    const covered = await check(rule, page({
      css: '@media (prefers-reduced-motion: reduce) { .drawer { transition: none } }',
      body: '<div class="drawer" style="transition: transform .3s">x</div>',
    }));
    expect(covered.status).toBe('passed');
  });

  it('routes to incomplete when a stylesheet failed', async () => {
    const res = await check(rule, page({ css: '.modal { transition: transform .3s }', head: '<link rel="stylesheet" href="missing.css">\n' }));
    expect(res.status).toBe('incomplete');
  });
});

describe('exit-not-faster-than-enter', () => {
  const rule = 'exit-not-faster-than-enter';

  it('flags a base rule whose exit is slower than the open-state entry', async () => {
    const res = await check(rule, page({
      css: '.drawer { transition: transform .4s }\n.drawer.is-open { transition: transform 200ms }\ndialog { transition-duration: 300ms }\ndialog[open] { transition: opacity 150ms }',
    }));
    expect(res.nodes.map((n) => [n.snippet, n.message])).toEqual([
      ['.drawer { transition: transform .4s }', 'exit 400ms > enter 200ms'],
      ['dialog { transition-duration: 300ms }', 'exit 300ms > enter 150ms'],
    ]);
    expect(res.nodes[0].data).toEqual({ enterMs: 200, exitMs: 400, openSelector: '.drawer.is-open' });
  });

  it('passes symmetric, faster exits and pairs without explicit durations', async () => {
    const res = await check(rule, page({
      css: [
        '[popover] { transition: opacity .2s }', '[popover]:popover-open { transition: opacity .2s }',
        '.menu { transition: opacity 100ms }', '.menu.open { transition: opacity 250ms }',
        '.sheet { transition: transform .5s }', '.sheet.open { transform: none }',
        '.card { transition: opacity .5s }', '.card.open { transition: opacity .1s }',
        '@media (min-width: 600px) { .flyout { transition: opacity .5s } }', '.flyout.open { transition: opacity .1s }',
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });
});

describe('anchor-name-no-supports', () => {
  const rule = 'anchor-name-no-supports';

  it('flags anchor positioning outside @supports, once per rule', async () => {
    const res = await check(rule, page({
      css: '.a { anchor-name: --a }\n.b { position-anchor: --a; anchor-name: --b }\n@supports (anchor-name: --x) { .c { anchor-name: --c } }\n@supports (position-area: top) { .d { position-anchor: --a } }',
    }));
    expect(snippets(res)).toEqual(['.a { anchor-name: --a }', '.b { position-anchor: --a }']);
  });

  it('is not applicable with a polyfill or without anchor properties', async () => {
    const css = '.a { anchor-name: --a }';
    const bySrc = await check(rule, page({ css, body: '<script src="https://unpkg.com/@oddbird/css-anchor-positioning"></script>' }));
    expect(bySrc).toMatchObject({ status: 'notApplicable', reason: 'an anchor positioning polyfill is loaded' });
    const byImport = await check(rule, page({ css, js: "import('css-anchor-positioning/fn');" }));
    expect(byImport.status).toBe('notApplicable');
    const none = await check(rule, page({ css: '.a { anchor-name: none; position-anchor: auto }' }));
    expect(none).toMatchObject({ status: 'notApplicable', reason: 'no anchor-name or position-anchor' });
  });
});

describe('stale-inset-area', () => {
  it('flags inset-area in rules and @position-try, unless position-area sits next to it', async () => {
    const res = await check('stale-inset-area', page({
      css: '.a { inset-area: top }\n@position-try --b { inset-area: bottom span-all }\n.c { inset-area: top; position-area: top }',
    }));
    expect(snippets(res)).toEqual(['.a { inset-area: top }', '@position-try --b { inset-area: bottom span-all }']);
    expect(res.nodes[0].message).toBe('inset-area: top was renamed; use position-area: top');
  });

  it('passes pages without inset-area', async () => {
    expect((await check('stale-inset-area', page({ css: '.a { position-area: top }' }))).status).toBe('passed');
  });
});

describe('fixed-max-height-no-overflow', () => {
  const rule = 'fixed-max-height-no-overflow';

  it('flags panels capped in px without a scroll container', async () => {
    const res = await check(rule, page({
      css: '.dropdown { max-height: 300px }\n.sheet { max-block-size: 480.5px; overflow: hidden }\ndialog { max-height: 90vh }',
    }));
    expect(snippets(res)).toEqual(['.dropdown { max-height: 300px }', '.sheet { max-block-size: 480.5px }']);
    expect(res.nodes[0].data).toEqual({ maxHeight: '300px' });
  });

  it('passes when the panel, a same-selector rule or a child scrolls', async () => {
    const res = await check(rule, page({
      css: [
        '.dropdown { max-height: 300px; overflow-y: auto }',
        '.menu { max-height: 300px }', '.menu { overflow: hidden scroll }',
        '.drawer { max-height: 400px; display: flex }', '.drawer .body { overflow: auto }',
        '.popover { max-height: 200px; overflow-block: scroll }',
        '.card { max-height: 100px }',
        '.dropdown img { max-height: 40px }',
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });

  it('routes to incomplete when a stylesheet failed', async () => {
    const res = await check(rule, page({ css: '.dropdown { max-height: 300px }', head: '<link rel="stylesheet" href="missing.css">\n' }));
    expect(res.status).toBe('incomplete');
  });
});

describe('motion-duration-off-token', () => {
  const rule = 'motion-duration-off-token';
  const brand = { motion: { duration: { short: '150ms', medium: '250ms', long: '0.4s' } } };

  it('is not applicable without brand motion tokens', async () => {
    const res = await check(rule, page({ css: '.modal { transition: opacity 999ms }' }));
    expect(res).toMatchObject({ status: 'notApplicable', reason: 'no brand motion.duration tokens' });
  });

  it('flags panel durations more than 25% away from the nearest token', async () => {
    const res = await check(rule, page({
      css: [
        '.modal { transition: opacity 600ms }',
        '.menu { transition: opacity 180ms }',
        ':root { --slow: 1s }', '.drawer { transition: transform var(--slow) }',
        '.sheet { animation-duration: 90ms, 250ms }',
        '.popover { transition: opacity 1ms, transform 0s }',
        '.card { transition: opacity 999ms }',
        '@media (prefers-reduced-motion: reduce) { .modal { transition: opacity 999ms } }',
      ].join('\n'),
    }), { brand });
    expect(res.nodes.map((n) => [n.snippet, n.message])).toEqual([
      ['.modal { transition: opacity 600ms }', '600ms is 50% off long=400ms'],
      ['.drawer { transition: transform var(--slow) }', '1000ms is 150% off long=400ms'],
      ['.sheet { animation-duration: 90ms, 250ms }', '90ms is 40% off short=150ms'],
    ]);
    expect(res.nodes[0].data).toEqual({ durationMs: 600, offPercent: 50, token: 'long', tokenMs: 400 });
  });

  it('reports the worst duration of a decl once', async () => {
    const res = await check(rule, page({ css: '.modal { transition: opacity 600ms, transform 1s }' }), { brand });
    expect(messages(res)).toEqual(['1000ms is 150% off long=400ms']);
  });

  it('counts only motion on descendants of a panel', async () => {
    const res = await check(rule, page({
      css: [
        '.menu a { transition: color 80ms }',
        '.modal.fade .modal-dialog { transition: transform 600ms, opacity 80ms }',
        '.dropdown .item { transition-property: transform; transition-duration: 700ms }',
        '.dropdown .hint { transition-property: opacity; transition-duration: 700ms }',
        '.sheet .body { animation: pop 700ms }', '@keyframes pop { to { scale: 1.1 } }',
        '.sheet .fade { animation-name: fade; animation-duration: 700ms }', '@keyframes fade { to { opacity: 0 } }',
      ].join('\n'),
    }), { brand });
    expect(res.nodes.map((n) => [n.selector, n.message])).toEqual([
      ['.modal.fade .modal-dialog', '600ms is 50% off long=400ms'],
      ['.dropdown .item', '700ms is 75% off long=400ms'],
      ['.sheet .body', '700ms is 75% off long=400ms'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Compositor costs
// ---------------------------------------------------------------------------

describe('backdrop-filter-on-opaque-fill', () => {
  const rule = 'backdrop-filter-on-opaque-fill';

  it('flags blur behind fills that are at least 90% opaque', async () => {
    const res = await check(rule, page({
      css: [
        '.modal { background: rgba(2, 3, 7, 0.96); backdrop-filter: blur(10px) }',
        '.nav { background-color: #111; -webkit-backdrop-filter: blur(8px) }',
        '.bar { background: #000000e6; backdrop-filter: saturate(2) }',
        '.sheet { background: hsl(0 0% 0% / 95%); backdrop-filter: blur(4px) }',
        '.menu { background: white; backdrop-filter: blur(2px) }',
      ].join('\n'),
    }));
    expect(res.nodes.map((n) => [n.selector, n.data.alpha])).toEqual([['.modal', 0.96], ['.nav', 1], ['.bar', 0.902], ['.sheet', 0.95], ['.menu', 1]]);
    expect(res.nodes[0].message).toBe('backdrop-filter: blur(10px) over background: rgba(2, 3, 7, 0.96) (alpha 0.96); the blur cannot show through, drop it');
  });

  it('skips see-through, unreadable and filter-free rules', async () => {
    const res = await check(rule, page({
      css: [
        '.a { background: rgba(0, 0, 0, .5); backdrop-filter: blur(10px) }',
        '.b { background: url(x.png) #000; backdrop-filter: blur(10px) }',
        '.c { background: linear-gradient(#000, #000); backdrop-filter: blur(10px) }',
        '.d { background: transparent; backdrop-filter: blur(10px) }',
        '.e { background: var(--bg); backdrop-filter: blur(10px) }',
        '.f { background: #000; backdrop-filter: none }',
        '.g { background: #000 }',
        '.h { backdrop-filter: blur(3px) }',
      ].join('\n'),
    }));
    expect(res.status).toBe('passed');
  });
});

describe('backdrop-filter-on-video-modal', () => {
  const rule = 'backdrop-filter-on-video-modal';

  it('flags blur on a modal that contains video or iframe', async () => {
    const res = await check(rule, page({
      css: '.modal { backdrop-filter: blur(10px) }\n[role=dialog]:hover { -webkit-backdrop-filter: blur(4px) }',
      body: '<div id="m1" class="modal"><video src="a.mp4"></video></div><div id="m2" class="modal"><p>x</p></div><div id="m3" role="dialog"><iframe src="https://example.com"></iframe></div>',
    }));
    expect(res.nodes.map((n) => [n.selector, n.data.containers])).toEqual([['.modal', ['#m1']], ['[role=dialog]:hover', ['#m3']]]);
    expect(res.nodes[0].message).toBe('backdrop-filter on a modal that holds <video> or <iframe> (#m1); the blur re-runs every frame');
  });

  it('matches script-toggled state classes and style attributes', async () => {
    const res = await check(rule, page({
      css: '.lightbox.on { backdrop-filter: blur(10px) }',
      body: '<div class="lightbox"><video></video></div><dialog id="d" style="backdrop-filter: blur(2px)"><video></video></dialog>',
    }));
    expect(res.nodes.map((n) => n.snippet)).toEqual(['.lightbox.on { backdrop-filter: blur(10px) }', 'style="backdrop-filter: blur(2px)"']);
  });

  it('ignores ::backdrop, non-modal selectors, unsupported selectors and still content', async () => {
    const res = await check(rule, page({
      css: 'dialog::backdrop { backdrop-filter: blur(4px) }\n.hero { backdrop-filter: blur(4px) }\n.modal:has(video) { backdrop-filter: blur(4px) }\n.lightbox { backdrop-filter: blur(4px) }',
      body: '<dialog open><video></video></dialog><div class="hero"><video></video></div><div class="lightbox"><img src="a.png" alt=""></div>',
    }));
    expect(res.status).toBe('passed');
  });
});

describe('fixed-nav-backdrop-filter-under-modal', () => {
  const rule = 'fixed-nav-backdrop-filter-under-modal';

  it('flags a fixed blurred bar that stays under a modal', async () => {
    const res = await check(rule, page({
      css: '.nav { position: fixed; backdrop-filter: blur(16px) }\n.bar { backdrop-filter: blur(4px) }\n.bar { position: fixed }',
      body: '<dialog>x</dialog>',
    }));
    expect(res.nodes.map((n) => n.snippet)).toEqual(['.nav { backdrop-filter: blur(16px) }', '.bar { backdrop-filter: blur(4px) }']);
    expect(res.nodes[0].message).toBe('fixed ".nav" keeps backdrop-filter under an open modal; hide it or set backdrop-filter: none while the modal is open');
  });

  it('passes when a modal-state rule hides the bar or drops the blur', async () => {
    for (const hide of [
      'body:has(.modal.on) .nav { display: none }',
      '.modal-open .nav { backdrop-filter: none }',
      'html.locked > body > .nav { visibility: hidden }',
      ':root:has(dialog[open]) .nav { -webkit-backdrop-filter: none }',
    ]) {
      const res = await check(rule, page({ css: `.nav { position: fixed; backdrop-filter: blur(16px) }\n${hide}`, body: '<div role="dialog">x</div>' }));
      expect(res.status, hide).toBe('passed');
    }
  });

  it('skips non-fixed elements and the modal itself', async () => {
    const res = await check(rule, page({
      css: '.nav { position: sticky; backdrop-filter: blur(8px) }\n.modal { position: fixed; z-index: 200; backdrop-filter: blur(8px) }\ndialog::backdrop { position: fixed; backdrop-filter: blur(2px) }',
    }));
    expect(res.status).toBe('passed');
  });

  it('needs a modal on the page, from HTML or a high z-index modal rule', async () => {
    const css = '.nav { position: fixed; backdrop-filter: blur(16px) }';
    expect((await check(rule, page({ css }))).status).toBe('notApplicable');
    expect((await check(rule, page({ css: `${css}\n.modal { z-index: 1000 }` }))).status).toBe('failed');
    expect((await check(rule, page({ css, body: '<div aria-modal="true">x</div>' }))).status).toBe('failed');
    expect((await check(rule, page({ css: `${css}\n.modal { z-index: 10 }` }))).status).toBe('notApplicable');
  });

  it('checks fixed style attributes and routes to incomplete on failed sheets', async () => {
    const attr = await check(rule, page({ body: '<nav id="top" style="position: fixed; backdrop-filter: blur(4px)"></nav><dialog>x</dialog>' }));
    expect(attr.nodes.map((n) => n.snippet)).toEqual(['style="backdrop-filter: blur(4px)"']);
    const inc = await check(rule, page({ css: '.nav { position: fixed; backdrop-filter: blur(16px) }', body: '<dialog>x</dialog>', head: '<link rel="stylesheet" href="missing.css">\n' }));
    expect(inc.status).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
// Dynamic and rendered DOM
// ---------------------------------------------------------------------------

describe('focus-lost-after-close', () => {
  const rule = 'focus-lost-after-close';
  const facts = readFixtureJson('panels/facts/dialogs.json');

  it('is skipped without the dynamic pass', async () => {
    const res = await check(rule, page());
    expect(res).toMatchObject({ status: 'skipped', reason: 'dynamic-only' });
  });

  it('flags dialogs that dropped focus to body, html or nothing', async () => {
    const res = await check(rule, page(), { dynamic: facts });
    expect(res.nodes.map((n) => [n.selector, n.snippet, n.location])).toEqual([
      // Runtime findings keep the probe order.
      ['#open-settings', 'closed via escape; focus on body', '(runtime)'],
      ['main > button:nth-of-type(3)', 'closed via escape; focus on nothing', '(runtime)'],
      ['#legacy-open', 'closed via close-button; focus on html', '(runtime)'],
    ]);
    expect(res.nodes[0].message).toBe('focus did not return to the trigger after the dialog closed');
  });

  it('is not applicable when the probe did not run or nothing opened', async () => {
    const failed = await check(rule, page(), { dynamic: { ...facts, dialogs: null, errors: [{ probe: 'dialogs', message: 'timeout' }] } });
    expect(failed).toMatchObject({ status: 'notApplicable', reason: 'the dialog focus probe did not run' });
    const closed = await check(rule, page(), { dynamic: { ...facts, dialogs: facts.dialogs.filter((d) => !d.opened) } });
    expect(closed).toMatchObject({ status: 'notApplicable', reason: 'no dialog opened during the probe' });
    const restored = await check(rule, page(), { dynamic: { ...facts, dialogs: [facts.dialogs[1]] } });
    expect(restored.status).toBe('passed');
  });
});

describe('rendered DOM re-run', () => {
  const facts = readFixtureJson('panels/facts/rendered.json');
  const site = page({
    css: '.modal { backdrop-filter: blur(10px) }',
    body: '<main><h1>App</h1><button id="open">Open</button><dialog id="static-dialog"><p>Static</p></dialog></main>',
  });

  it('finds script-built surfaces in the rendered DOM', async () => {
    const ctx = await contextFor(site, { dynamic: facts });
    const run = (short) => runRule(byShort[short], ctx);
    const label = run('dialog-missing-label');
    expect(label.nodes.map((n) => [n.selector, n.location])).toEqual([['#static-dialog', expect.stringMatching(/^index\.html:/)], ['#late', '(rendered DOM)']]);
    expect(run('destructive-dialog-closedby-any').nodes.map((n) => n.selector)).toEqual(['#late']);
    expect(run('div-role-dialog').nodes.map((n) => n.location)).toEqual(['(rendered DOM)']);
    expect(run('backdrop-as-sibling-div').nodes.map((n) => n.selector)).toEqual(['body > div.modal-overlay']);
    expect(run('tooltip-focusable').nodes.map((n) => n.selector)).toEqual(['#tip']);
    expect(run('menu-no-arrow-keys').nodes.map((n) => n.snippet)).toEqual(['<ul role="menubar">']);
    const video = run('backdrop-filter-on-video-modal');
    expect(video.nodes.map((n) => n.data.containers)).toEqual([['body > div.modal-overlay > div.modal']]);
  });

  it('stays not applicable when neither DOM has the surface', async () => {
    const ctx = await contextFor(page({ body: '<p>x</p>' }), { dynamic: { ...facts, rendered: { html: '<!doctype html><html><body><p>y</p></body></html>' } } });
    expect(runRule(byShort['tooltip-focusable'], ctx).status).toBe('notApplicable');
    expect(runRule(byShort['dialog-missing-label'], ctx).status).toBe('notApplicable');
  });
});

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

describe('panels fixture', () => {
  it('matches the golden report and raw JSON', async () => {
    const res = await runFixture('panels');
    expectGolden('panels.report.md', res.markdown);
    expectGolden('panels.raw.json', rawJson(res.raw));
    expectAsciiNoDash(res.markdown, 'panels report');
  });

  it('fails every static panels rule once and keeps the near misses quiet', async () => {
    const res = await runFixture('panels');
    const status = Object.fromEntries(res.raw.rules.map((r) => [toShortRuleId(r.id), r.status]));
    for (const r of rules) expect(status[toShortRuleId(r.id)], r.id).toBe(r.phase === 'static' ? 'failed' : 'skipped');
    const count = Object.fromEntries(res.raw.violations.map((v) => [toShortRuleId(v.ruleId), v.nodes.length]));
    expect(count).toMatchObject({
      'z-index-over-budget': 1,
      'z-index-literal-smell': 2,
      'dialog-missing-label': 1,
      'div-role-dialog': 1,
      'backdrop-as-sibling-div': 1,
      'destructive-dialog-closedby-any': 1,
      'tooltip-focusable': 2,
      'menu-no-arrow-keys': 1,
      'custom-escape-on-dialog-popover': 1,
      'custom-outside-click-on-auto-popover': 1,
      'inert-with-showmodal': 1,
      'no-starting-style-on-transitioned-popover': 1,
      'motion-no-reduced-motion-guard': 1,
      'exit-not-faster-than-enter': 1,
      'backdrop-filter-on-opaque-fill': 1,
      'backdrop-filter-on-video-modal': 1,
      'fixed-nav-backdrop-filter-under-modal': 1,
    });
    const suppressed = Object.fromEntries(res.raw.rules.filter((r) => r.suppressed).map((r) => [toShortRuleId(r.id), r.suppressed]));
    expect(suppressed).toEqual({ 'backdrop-as-sibling-div': 1, 'z-index-over-budget': 1 });
    expect(res.pass).toBe(false);
  });

  it('adds focus-lost-after-close under the dynamic pass', async () => {
    const facts = readFixtureJson('panels/facts/dialogs.json');
    const res = await runFixture('panels', { dynamic: true, dynamicImpl: async () => facts });
    const v = res.raw.violations.find((x) => x.ruleId === 'atelier/runtime-ux/focus-lost-after-close');
    expect(v.nodes.length).toBe(3);
    expect(res.markdown).toContain('Dynamic findings reflect Chromium-only APIs.');
  });
});

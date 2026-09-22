import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FIXTURES_DIR, contextFor, runRule, runFixture, expectGolden, rawJson, readFixtureJson, expectAsciiNoDash,
} from './helpers.mjs';
import { rules } from '../../plugins/atelier/skills/runtime-ux-audit/rules/inp/index.mjs';
import { HEADLINES } from '../../plugins/atelier/skills/runtime-ux-audit/lib/headline.mjs';
import { validateRule } from '../../plugins/atelier/skills/runtime-ux-audit/lib/runner.mjs';

const R = Object.fromEntries(rules.map((r) => [r.id.replace('atelier/runtime-ux/', ''), r]));

/** A one-script site: body markup plus app.js (classic, or module with { module: true }). */
const site = (js, body = '', { module = false, head = '', extra = {} } = {}) => ({
  'index.html': `<!doctype html><html><head>${head}</head><body>${body}<script ${module ? 'type="module" ' : ''}src="app.js"></script></body></html>`,
  'app.js': js,
  ...extra,
});

async function check(id, js, body, opts = {}) {
  const ctx = await contextFor(site(js, body, opts), { dynamic: opts.dynamic ?? null, brand: opts.brand ?? null });
  return runRule(R[id], ctx);
}

const snippets = (res) => res.nodes.map((n) => n.snippet);
const facts = () => readFixtureJson('inp/facts/slow.json');

describe('inp registry', () => {
  it('ships the 13 designed rules, valid, in area inp, with ASCII text', () => {
    expect(Object.keys(R).sort()).toEqual([
      'click-handler-forced-layout', 'framework-hydration-on-static-page', 'inp-estimate-over-budget', 'loaf-long-script',
      'longtask-without-loaf', 'missing-content-visibility', 'missing-webvitals-oninp', 'mouse-and-touch-pair', 'no-sync-xhr',
      'non-passive-scroll-listener', 'requestidlecallback-no-timeout', 'scroll-listener-animates-transform', 'settimeout-zero-as-yield',
    ]);
    for (const r of rules) {
      expect(validateRule(r), r.id).toEqual([]);
      expect(r.area).toBe('inp');
      expect(Object.isFrozen(r)).toBe(true);
      expectAsciiNoDash(r.description, r.id);
    }
    expect(rules.filter((r) => r.phase === 'dynamic').map((r) => r.id.slice(19)).sort()).toEqual(['inp-estimate-over-budget', 'loaf-long-script', 'missing-content-visibility']);
    const ids = new Set(rules.map((r) => r.id));
    for (const h of HEADLINES.inp) for (const id of h.ruleIds) expect(ids.has(id), id).toBe(true);
  });
});

describe('non-passive-scroll-listener', () => {
  it('flags element touch and wheel listeners that never cancel', async () => {
    const res = await check('non-passive-scroll-listener', `
      carousel.addEventListener('touchmove', function (e) { x = e.touches[0].clientX; });
      slider.addEventListener('wheel', onWheel, { passive: false });
      function onWheel(e) { zoom += e.deltaY; }
      $('.strip').on('touchstart', function (e) { start = e.originalEvent.touches[0].pageX; });
      pane.ontouchmove = function (e) { y = e.touches[0].clientY; };
    `);
    expect(res.status).toBe('failed');
    expect(res.nodes.map((n) => n.data.event)).toEqual(['touchmove', 'wheel', 'touchstart', 'touchmove']);
    expect(res.nodes[0].location).toBe('app.js:2:7');
    expect(res.nodes[0].message).toMatch(/can be passive/);
    expect(res.nodes.map((n) => n.data.via)).toEqual(['addEventListener', 'addEventListener', 'jquery', 'property']);
  });

  it('flags a touch attribute handler on an element', async () => {
    const res = await check('non-passive-scroll-listener', '', '<div class="rail" ontouchstart="track()"></div><div ontouchmove="return false"></div>');
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0].selector).toBe('body > div.rail:nth-of-type(1)[ontouchstart]');
  });

  it('leaves listeners that cancel, delegate the event, are passive, or have unknown options', async () => {
    const res = await check('non-passive-scroll-listener', `
      a.addEventListener('touchmove', (e) => { x = 1; }, { passive: true });
      b.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
      c.addEventListener('touchmove', (e) => handle(e));
      d.addEventListener('wheel', onWheel, supportsPassive ? { passive: true } : false);
      e.addEventListener('touchmove', handlers.move);
      $('.f').on('touchmove', function () { return false; });
      g.addEventListener('touchmove', function (ev) { ev.returnValue = false; });
      h.addEventListener('touchend', function () {});
      window.addEventListener('touchstart', function (e) { t = e.timeStamp; });
      document.addEventListener('touchmove', function () {}, { passive: false });
      document.addEventListener('wheel', function () {});
      function onWheel(e) { z = e.deltaY; }
    `);
    expect(res.status).toBe('passed');
  });

  it('flags a root wheel listener that opts out of passive without an unconditional cancel', async () => {
    const res = await check('non-passive-scroll-listener', `
      window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
      document.addEventListener('mousewheel', function (e) { log(e.deltaY); }, { passive: !1 });
      window.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    `);
    expect(res.nodes).toHaveLength(2);
    expect(res.nodes[0]).toMatchObject({ confidence: 'medium', data: { event: 'wheel', target: 'window' } });
    expect(res.nodes[0].message).toMatch(/only cancels conditionally/);
    expect(res.nodes[1].confidence).toBeUndefined();
    expect(res.nodes[1].message).toMatch(/never calls preventDefault/);
  });

  it('honors an atelier-ignore comment', async () => {
    const res = await check('non-passive-scroll-listener', `
      // atelier-ignore non-passive-scroll-listener -- measured, fine
      a.addEventListener('touchmove', function (e) { x = e.touches[0].clientX; });
    `);
    expect(res.status).toBe('passed');
    expect(res.suppressed).toBe(1);
  });
});

describe('settimeout-zero-as-yield', () => {
  it('flags setTimeout(fn, 0) in a loop and an awaited setTimeout(0) promise in a loop', async () => {
    const res = await check('settimeout-zero-as-yield', `
      for (const item of items) { setTimeout(() => render(item), 0); }
      async function run(items) {
        for (const i of items) { work(i); await new Promise((r) => setTimeout(r, 0)); }
      }
      async function drain() {
        while (queue.length) { step(); await new Promise(function (resolve) { setTimeout(resolve); }); }
      }
    `);
    expect(res.nodes.map((n) => n.data.pattern)).toEqual(['loop', 'await', 'await']);
    expect(snippets(res)).toEqual(['setTimeout(() => render(item), 0)', 'setTimeout(r, 0)', 'setTimeout(resolve)']);
  });

  it('leaves non-zero delays, yields outside loops and scheduler.yield() fallbacks', async () => {
    const res = await check('settimeout-zero-as-yield', `
      for (const item of items) { setTimeout(() => render(item), 16); }
      async function once() { await new Promise((r) => setTimeout(r, 0)); }
      function yieldToMain() { return new Promise((r) => setTimeout(r, 0)); }
      async function run(items) {
        for (const i of items) {
          work(i);
          if (globalThis.scheduler?.yield) await scheduler.yield();
          else await new Promise((r) => setTimeout(r, 0));
        }
      }
      async function loop2(items) {
        for (const i of items) { items.forEach(() => setTimeout(tick, 0)); await next(); }
      }
    `);
    expect(res.status).toBe('passed');
  });

  it('leaves a call that leaves the loop right after it runs (calibration: svelte.dev tooltip)', async () => {
    const res = await check('settimeout-zero-as-yield', `
      function onOut(e) { let t = e.target; for (; t;) { if (t.classList.contains('hover')) { n = setTimeout(r, 0); return; } t = t.parentElement; } }
      for (const x of xs) { if (x.done) { setTimeout(finish, 0); break; } }
      while (true) { throw setTimeout(fail, 0); }
      for (const y of ys) { switch (y) { case 1: setTimeout(one, 0); break; default: } }
    `);
    // Only the switch case repeats: its break leaves the switch, not the loop.
    expect(snippets(res)).toEqual(['setTimeout(one, 0)']);
  });
});

describe('click-handler-forced-layout', () => {
  it('flags a read after a write, the auto-grow pattern and a read/write loop', async () => {
    const res = await check('click-handler-forced-layout', `
      btn.addEventListener('click', () => {
        panel.classList.add('open');
        const h = panel.offsetHeight;
        panel.style.height = h + 'px';
      });
      ta.addEventListener('input', function () {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      });
      window.addEventListener('resize', () => {
        for (const c of cards) { c.style.height = c.getBoundingClientRect().width + 'px'; }
      });
    `);
    expect(res.nodes.map((n) => [n.snippet, n.data.loop])).toEqual([
      ['panel.offsetHeight', false], ['ta.scrollHeight', false], ['c.getBoundingClientRect()', true],
    ]);
    expect(res.nodes[0].data).toMatchObject({ event: 'click', read: 'offsetHeight', write: 'panel.classList.add()' });
    expect(res.nodes[1].data.write).toBe('ta.style.height');
    expect(res.nodes[2].message).toMatch(/same loop/);
  });

  it('leaves read-then-write, rAF reads, exclusive branches, early returns and non-input events', async () => {
    const res = await check('click-handler-forced-layout', `
      a.addEventListener('click', () => { const h = panel.offsetHeight; panel.style.height = h + 'px'; });
      b.addEventListener('click', () => {
        panel.classList.add('open');
        requestAnimationFrame(() => { const r = panel.getBoundingClientRect(); });
      });
      c.addEventListener('click', () => {
        if (open) { panel.style.height = '0'; } else { h = panel.scrollHeight; }
      });
      d.addEventListener('keydown', () => {
        if (closing) { panel.classList.remove('open'); return; }
        const r = panel.getBoundingClientRect();
      });
      e.addEventListener('click', () => {
        for (const r of panel.getClientRects()) { mark(r); }
        panel.className = 'done';
      });
      window.addEventListener('load', () => { panel.classList.add('x'); const w = panel.offsetWidth; });
      f.addEventListener('click', () => { el.scrollTop = 0; const t = el.scrollTop; });
    `);
    expect(res.status).toBe('passed');
  });

  it('reports a shared handler once and reads attribute handlers', async () => {
    const res = await check('click-handler-forced-layout', `
      function onPress(e) { e.target.style.transform = 'scale(0.98)'; return e.target.offsetWidth; }
      btn.addEventListener('pointerdown', onPress);
      btn.addEventListener('mousedown', onPress);
    `, '<button onclick="this.classList.add(\'x\'); console.log(this.offsetWidth)">Go</button>');
    expect(res.nodes).toHaveLength(2);
    expect(res.nodes[0]).toMatchObject({ selector: 'body > button[onclick]', snippet: 'this.offsetWidth', location: 'index.html:1:95' });
    expect(res.nodes[1].data.event).toBe('pointerdown');
  });
});

describe('scroll-listener-animates-transform', () => {
  it('flags scroll-linked transform and opacity, including through a rAF callback', async () => {
    const res = await check('scroll-listener-animates-transform', `
      window.addEventListener('scroll', () => {
        hero.style.transform = \`translateY(\${window.scrollY * 0.4}px)\`;
      }, { passive: true });
      window.addEventListener('scroll', onScroll, { passive: true });
      function onScroll() { if (!ticking) requestAnimationFrame(update); }
      function update() { bar.style.setProperty('opacity', String(1 - window.scrollY / 400)); }
      $(window).scroll(function () { el.style.webkitTransform = 'rotate(' + y + 'deg)'; });
    `);
    expect(res.nodes.map((n) => n.data.write)).toEqual(['hero.style.transform', "style.setProperty('opacity')", 'el.style.webkitTransform']);
    expect(res.nodes[0].snippet.startsWith("window.addEventListener('scroll'")).toBe(true);
  });

  it('leaves guarded fallbacks, discrete toggles and non-compositor properties', async () => {
    const res = await check('scroll-listener-animates-transform', `
      if (!CSS.supports('animation-timeline: scroll()')) {
        window.addEventListener('scroll', () => { a.style.transform = 'translateY(' + scrollY + 'px)'; });
      }
      const hasTimeline = CSS.supports('animation-timeline', 'view()');
      window.addEventListener('scroll', () => {
        if (hasTimeline) return;
        b.style.opacity = String(1 - scrollY / 300);
      });
      window.addEventListener('scroll', () => { c.style.transform = scrollY > 80 ? 'translateY(-100%)' : 'none'; });
      window.addEventListener('scroll', () => { d.style.top = scrollY + 'px'; });
      window.addEventListener('resize', () => { e.style.transform = 'scale(' + innerWidth / 1000 + ')'; });
    `);
    expect(res.status).toBe('passed');
  });
});

describe('mouse-and-touch-pair', () => {
  it('flags JS pairs on one target and attribute pairs on one element', async () => {
    const res = await check('mouse-and-touch-pair', `
      btn.addEventListener('touchstart', onPress, { passive: true });
      btn.addEventListener('mousedown', onPress);
      $('.knob').on('mousedown touchstart', startDrag);
      document.addEventListener('touchend', go);
      document.addEventListener('click', go);
    `, '<div class="k" onmousedown="go()" ontouchstart="go()"></div>');
    expect(res.nodes.map((n) => n.snippet)).toEqual([
      '<div class="k" onmousedown="go()" ontouchstart="go()">',
      "btn.addEventListener('touchstart', onPress, { passive: true })",
      "$('.knob').on('mousedown touchstart', startDrag)",
      "document.addEventListener('touchend', go)",
    ]);
    expect(res.nodes[0].location).toBe('index.html:1:75');
    expect(res.nodes[1].data).toEqual({ mouse: ['mousedown'], touch: 'touchstart' });
  });

  it('leaves different targets, different scopes, unrelated root handlers and pointer events', async () => {
    const res = await check('mouse-and-touch-pair', `
      a.addEventListener('click', f);
      b.addEventListener('touchstart', g, { passive: true });
      function initA() { el.addEventListener('click', f); }
      function initB() { el.addEventListener('touchstart', g, { passive: true }); }
      document.addEventListener('click', closeMenus);
      document.addEventListener('touchstart', trackSwipe, { passive: true });
      $(document).on('click', '.a', f);
      $(document).on('touchstart', '.b', f);
      c.addEventListener('pointerdown', f);
      c.addEventListener('touchmove', f, { passive: true });
    `, '<div onclick="a()"></div><div ontouchstart="b()"></div>');
    expect(res.status).toBe('passed');
  });
});

describe('requestidlecallback-no-timeout', () => {
  it('flags calls without a timeout', async () => {
    const res = await check('requestidlecallback-no-timeout', `
      requestIdleCallback(flush);
      window.requestIdleCallback(flush, {});
      self.requestIdleCallback?.(flush, { other: 1 });
    `);
    expect(snippets(res)).toEqual(['requestIdleCallback(flush)', 'window.requestIdleCallback(flush, {})', 'self.requestIdleCallback?.(flush, { other: 1 })']);
  });

  it('leaves calls with a timeout, unknown options or a spread', async () => {
    const res = await check('requestidlecallback-no-timeout', `
      requestIdleCallback(flush, { timeout: 2000 });
      requestIdleCallback(flush, opts);
      requestIdleCallback(flush, { ...defaults });
      ric(flush);
    `);
    expect(res.status).toBe('passed');
  });
});

describe('framework-hydration-on-static-page', () => {
  const links = '<nav><a href="/">Home</a><a href="/blog">Blog</a></nav><input type="hidden" name="csrf">';

  it('flags Next.js data on a page with only links', async () => {
    const res = await check('framework-hydration-on-static-page', '', `${links}<script id="__NEXT_DATA__" type="application/json">{}</script>`);
    expect(res.nodes).toEqual([expect.objectContaining({
      selector: '#__NEXT_DATA__', data: { evidence: 'script#__NEXT_DATA__', framework: 'Next.js', interactive: 0 },
    })]);
  });

  it.each([
    ['hydrateRoot', "import { hydrateRoot } from 'react-dom/client';\nhydrateRoot(document.getElementById('root'), app);", 'hydrateRoot()', "hydrateRoot(document.getElementById('root'), app)"],
    ['minified hydrateRoot', '(0, r.hydrateRoot)(el, app);', 'hydrateRoot()', '(0, r.hydrateRoot)(el, app)'],
    ['createSSRApp', 'Vue.createSSRApp(App).mount("#app");', 'createSSRApp()', 'Vue.createSSRApp(App)'],
    ['__NUXT__', 'window.__NUXT__ = { state: {} };', '__NUXT__', 'window.__NUXT__ = { state: {} }'],
    ['hydrate: true', 'new App({ target: document.body, hydrate: !0 });', 'hydrate: true', 'hydrate: !0'],
  ])('flags %s evidence in scripts', async (_name, js, label, snippet) => {
    const res = await check('framework-hydration-on-static-page', js, links);
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]).toMatchObject({ snippet, data: { evidence: label } });
  });

  it('flags server-rendered markers and framework bundle paths', async () => {
    const vue = await check('framework-hydration-on-static-page', '', '<div id="app" data-server-rendered="true"><p>Hi</p></div>');
    expect(vue.nodes[0]).toMatchObject({ selector: '#app', data: { framework: 'Vue' } });
    const next = await check('framework-hydration-on-static-page', '', '<script src="/_next/static/chunks/main.js"></script>');
    expect(next.nodes[0].data.evidence).toBe('script[src*="/_next/static/"]');
  });

  it('passes when the body has interactive elements and skips islands and non-hydrating code', async () => {
    const withButton = await check('framework-hydration-on-static-page', 'hydrateRoot(root, app);', '<button>Buy</button>');
    expect(withButton.status).toBe('passed');
    for (const body of ['<div tabindex="0">x</div>', '<div role="tab">x</div>', '<p onclick="x()">x</p>', '<div contenteditable>x</div>', '<video controls></video>', '<details><summary>x</summary></details>']) {
      expect((await check('framework-hydration-on-static-page', 'hydrateRoot(root, app);', body)).status, body).toBe('passed');
    }
    const island = await check('framework-hydration-on-static-page', 'hydrateRoot(root, app);', '<astro-island></astro-island>');
    expect(island).toMatchObject({ status: 'notApplicable', reason: 'islands hydrate selectively' });
    const defOnly = await check('framework-hydration-on-static-page', [
      '// hydrateRoot( is not called here',
      'function hydrateRoot(container) { return container; }',
      'if (window.__NUXT__ || window.__NEXT_DATA__) framework = "detected";',
      'var opts = { hydrate: false };',
    ].join('\n'), links);
    expect(defOnly).toMatchObject({ status: 'notApplicable', reason: 'no hydration runtime' });
  });
});

describe('missing-webvitals-oninp', () => {
  it('flags web-vitals imports without onINP (static, namespace, dynamic, UMD)', async () => {
    const stat = await check('missing-webvitals-oninp', "import { onLCP, onCLS } from 'web-vitals';\nonLCP(send); onCLS(send);", '', { module: true });
    expect(stat.nodes).toEqual([expect.objectContaining({ snippet: "import { onLCP, onCLS } from 'web-vitals';", data: { metrics: ['onCLS', 'onLCP'] } })]);
    const ns = await check('missing-webvitals-oninp', "import * as wv from 'https://unpkg.com/web-vitals@4/dist/web-vitals.attribution.js?module';\nwv.onLCP(send);", '', { module: true });
    expect(ns.nodes[0].data.metrics).toEqual(['onLCP']);
    const dyn = await check('missing-webvitals-oninp', "import('web-vitals').then(({ onTTFB }) => onTTFB(send));");
    expect(dyn.nodes[0].data.metrics).toEqual(['onTTFB']);
    const vendored = await check('missing-webvitals-oninp', "import { onFCP } from './vendor/web-vitals.attribution.js';\nonFCP(send);", '', {
      module: true, extra: { 'vendor/web-vitals.attribution.js': 'export function onFCP() {}\nexport function onINP() {}\n' },
    });
    expect(vendored.nodes[0].data.metrics).toEqual(['onFCP']);
    const umd = await check('missing-webvitals-oninp', 'webVitals.getCLS(send); webVitals.getLCP(send);');
    expect(umd.nodes).toEqual([expect.objectContaining({ snippet: 'webVitals.getCLS(send)', data: { metrics: ['getCLS', 'getLCP'] } })]);
  });

  it('passes with onINP anywhere on the page and skips pages without web-vitals', async () => {
    const withInp = await check('missing-webvitals-oninp', "import { onLCP } from 'web-vitals';\nonLCP(send);", '', {
      module: true, extra: { 'inp.js': "import('web-vitals/attribution').then(({ onINP }) => onINP(send));" }, head: '<script src="inp.js"></script>',
    });
    expect(withInp.status).toBe('passed');
    const other = await check('missing-webvitals-oninp', "gtag('event', 'lcp'); import('web-vitals-reporter'); import('./web-vitals.json');");
    expect(other).toMatchObject({ status: 'notApplicable', reason: 'no web-vitals usage' });
    const commentOnly = await check('missing-webvitals-oninp', "const { onLCP } = require('web-vitals'); // TODO onINP\nonLCP(send);");
    expect(commentOnly.status).toBe('failed');
  });

  it('routes the finding to incomplete when a same-origin script is missing', async () => {
    const res = await check('missing-webvitals-oninp', "import { onLCP } from 'web-vitals';\nonLCP(send);", '<script src="missing.js"></script>', { module: true });
    expect(res.status).toBe('incomplete');
    expect(res.incomplete).toHaveLength(1);
  });
});

describe('longtask-without-loaf', () => {
  it('flags longtask observers when LoAF is never observed', async () => {
    const res = await check('longtask-without-loaf', `
      new PerformanceObserver(cb).observe({ type: 'longtask', buffered: true });
      po.observe({ entryTypes: ['longtask', 'paint'] });
    `);
    expect(res.nodes).toHaveLength(2);
    expect(res.nodes[1].snippet).toBe("po.observe({ entryTypes: ['longtask', 'paint'] })");
  });

  it('passes with a LoAF observer, skips pages without longtask, and is incomplete on missing scripts', async () => {
    const both = await check('longtask-without-loaf', "po.observe({ type: 'longtask' });\npo2.observe({ type: 'long-animation-frame', buffered: true });");
    expect(both.status).toBe('passed');
    const none = await check('longtask-without-loaf', "io.observe(el); po.observe({ type: 'paint' });");
    expect(none).toMatchObject({ status: 'notApplicable', reason: 'no longtask observer' });
    const partial = await check('longtask-without-loaf', "po.observe({ type: 'longtask' });", '<script src="gone.js"></script>');
    expect(partial.status).toBe('incomplete');
  });
});

describe('no-sync-xhr', () => {
  it('flags synchronous open() by method literal or XMLHttpRequest receiver', async () => {
    const res = await check('no-sync-xhr', `
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api', false);
      req.open('post', url, !1);
      var x = new window.XMLHttpRequest();
      x.open(method, url, 0);
    `);
    expect(snippets(res)).toEqual(["xhr.open('GET', '/api', false)", "req.open('post', url, !1)", 'x.open(method, url, 0)']);
    expect(res.nodes[1].message).toMatch(/'POST'/);
  });

  it('leaves async requests, window.open and unknown receivers', async () => {
    const res = await check('no-sync-xhr', `
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api', true);
      xhr.open('GET', '/api');
      window.open(url, '_blank', 'noopener');
      thing.open(method, url, false);
      dialog.open(false, 1, false);
    `);
    expect(res.status).toBe('passed');
  });
});

describe('dynamic rules (synthetic facts)', () => {
  const withInp = (inp) => ({ ...facts(), interactions: { ...facts().interactions, inp } });

  it('inp-estimate-over-budget flags an estimate over the default or brand budget', async () => {
    const res = await check('inp-estimate-over-budget', '', '', { dynamic: facts() });
    expect(res.nodes).toEqual([{
      selector: '#feed > li.card:nth-of-type(1)',
      snippet: 'pointerup 312 ms (input delay 18, processing 262, presentation 32)',
      location: '(runtime)',
      message: 'INP estimate 312 ms exceeds the 200 ms budget (default). Most of it is handler time: split the work and yield.',
      data: { budgetMs: 200, estimateMs: 312, inputDelayMs: 18, interactions: 2, presentationMs: 32, processingMs: 262 },
    }]);
    const branded = await check('inp-estimate-over-budget', '', '', { dynamic: facts(), brand: { targets: { inpBudgetMs: 400 } } });
    expect(branded.status).toBe('passed');
    const tight = await check('inp-estimate-over-budget', '', '', { dynamic: facts(), brand: { targets: { inpBudgetMs: 100 } } });
    expect(tight.nodes[0].message).toContain('100 ms budget (brand.json targets.inpBudgetMs)');
  });

  it('inp-estimate-over-budget handles missing, below-threshold and worst-less estimates', async () => {
    expect((await check('inp-estimate-over-budget', '', '', { dynamic: withInp({ estimateMs: null, p75InteractionMs: null, maxMs: null, count: 0, belowThreshold: true, worst: null }) })).status).toBe('passed');
    expect(await check('inp-estimate-over-budget', '', '', { dynamic: withInp({ estimateMs: null, p75InteractionMs: null, maxMs: null, count: 0, belowThreshold: false, worst: null }) }))
      .toMatchObject({ status: 'notApplicable', reason: 'no interactions measured' });
    expect(await check('inp-estimate-over-budget', '', '', { dynamic: { ...facts(), interactions: null } })).toMatchObject({ status: 'notApplicable', reason: 'no interaction data' });
    const bare = await check('inp-estimate-over-budget', '', '', { dynamic: withInp({ estimateMs: 640, p75InteractionMs: 640, maxMs: 640, count: 1, belowThreshold: false, worst: null }) });
    expect(bare.nodes[0]).toMatchObject({ selector: 'document', snippet: '640 ms' });
    const presentation = await check('inp-estimate-over-budget', '', '', { dynamic: withInp({ estimateMs: 300, p75InteractionMs: 300, maxMs: 300, count: 1, belowThreshold: false, worst: { name: 'keydown', target: null, inputDelayMs: 90, processingMs: 20, presentationMs: 190 } }) });
    expect(presentation.nodes[0]).toMatchObject({ selector: 'document', message: expect.stringContaining('presentation') });
    const delay = await check('inp-estimate-over-budget', '', '', { dynamic: withInp({ estimateMs: 300, p75InteractionMs: 300, maxMs: 300, count: 1, belowThreshold: false, worst: { name: 'click', target: 'button', inputDelayMs: 200, processingMs: 20, presentationMs: 80 } }) });
    expect(delay.nodes[0].message).toContain('input delay');
  });

  it('dynamic rules are skipped in a static run', async () => {
    for (const id of ['inp-estimate-over-budget', 'loaf-long-script', 'missing-content-visibility']) {
      expect(await check(id, '', '')).toMatchObject({ status: 'skipped', reason: 'dynamic-only' });
    }
  });

  it('loaf-long-script dedupes by source, keeps the longest and locates the script', async () => {
    const js = readFileSync(join(FIXTURES_DIR, 'inp', 'js', 'app.js'), 'utf8');
    const ctx = await contextFor({ 'index.html': '<body><script src="js/app.js"></script></body>', 'js/app.js': js }, { dynamic: facts() });
    const res = runRule(R['loaf-long-script'], ctx);
    // Longest first: runtime findings keep the rule's order.
    expect(res.nodes).toEqual([
      {
        selector: 'js/app.js', snippet: 'DOCUMENT.onclick 240 ms (forced style/layout 36 ms)', location: 'js/app.js:16:36',
        message: 'Script ran 240 ms in one frame during the interaction probe (limit 100 ms); split it and yield to the main thread.',
        data: { durationMs: 240, forcedStyleAndLayoutMs: 36, invoker: 'DOCUMENT.onclick', invokerType: 'event-listener' },
      },
      {
        selector: 'https://cdn.example.com/ads.js', snippet: 'TimerHandler:setTimeout 118 ms (forced style/layout 0 ms)', location: 'https://cdn.example.com/ads.js',
        message: 'tick() ran 118 ms in one frame during the interaction probe (limit 100 ms); split it and yield to the main thread.',
        data: { durationMs: 118, forcedStyleAndLayoutMs: 0, invoker: 'TimerHandler:setTimeout', invokerType: 'user-callback', sourceFunctionName: 'tick' },
      },
    ]);
  });

  it('loaf-long-script handles unsupported LoAF, empty frames and unknown sources', async () => {
    expect(await check('loaf-long-script', '', '', { dynamic: { ...facts(), interactions: { ...facts().interactions, loaf: null } } }))
      .toMatchObject({ status: 'notApplicable', reason: 'long-animation-frame data unavailable' });
    expect((await check('loaf-long-script', '', '', { dynamic: { ...facts(), interactions: { ...facts().interactions, loaf: [] } } })).status).toBe('passed');
    const anon = await check('loaf-long-script', '', '', { dynamic: { ...facts(), interactions: { ...facts().interactions, loaf: [{ startTime: 1, durationMs: 200, blockingDurationMs: 150, scripts: [{ invoker: 'BUTTON.onclick', invokerType: 'event-listener', sourceURL: '', sourceFunctionName: '', sourceCharPosition: -1, durationMs: 150, forcedStyleAndLayoutDurationMs: 0 }] }] } } });
    expect(anon.nodes[0]).toMatchObject({ selector: 'BUTTON.onclick', location: '(runtime)' });
  });

  it('missing-content-visibility flags long below-fold groups without content-visibility', async () => {
    const res = await check('missing-content-visibility', '', '', { dynamic: facts() });
    expect(res.nodes).toEqual([expect.objectContaining({ selector: '#feed', snippet: '48 x li.card', location: '(runtime)', data: { belowFoldCount: 40, count: 48, signature: 'li.card' } })]);
    expect(await check('missing-content-visibility', '', '', { dynamic: { ...facts(), sweep: null } })).toMatchObject({ status: 'notApplicable', reason: 'no DOM sweep' });
  });
});

describe('inp golden', () => {
  it('static fixture fires every static rule once and no near miss', async () => {
    const res = await runFixture('inp');
    const failed = res.raw.rules.filter((r) => r.status === 'failed').map((r) => r.id.slice(19));
    expect(failed).toEqual([
      'click-handler-forced-layout', 'framework-hydration-on-static-page', 'longtask-without-loaf', 'missing-webvitals-oninp',
      'mouse-and-touch-pair', 'no-sync-xhr', 'non-passive-scroll-listener', 'requestidlecallback-no-timeout',
      'scroll-listener-animates-transform', 'settimeout-zero-as-yield',
    ]);
    expect(res.pass).toBe(false);
    expectAsciiNoDash(res.markdown, 'inp report');
    expectGolden('inp.report.md', res.markdown);
    expectGolden('inp.raw.json', rawJson(res.raw));
  });

  it('dynamic fixture adds the three dynamic-phase rules from synthetic facts', async () => {
    const res = await runFixture('inp', { dynamic: true, dynamicImpl: async () => facts() });
    const ids = res.raw.violations.map((v) => v.ruleId.slice(19));
    expect(ids).toEqual(expect.arrayContaining(['inp-estimate-over-budget', 'loaf-long-script', 'missing-content-visibility']));
    expect(res.markdown).toContain('INP est. 312 ms (budget 150 ms)');
    expectAsciiNoDash(res.markdown, 'inp dynamic report');
    expectGolden('inp.dynamic.report.md', res.markdown);
    expectGolden('inp.dynamic.raw.json', rawJson(res.raw));
  });
});

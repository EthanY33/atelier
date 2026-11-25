/**
 * runtime-ux-audit hardening: hostile or huge pages must not hang the static
 * pass, forge report content or reach private addresses, and the fixes must
 * not change results on ordinary input.
 */
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { FIXED_TS, contextFor, runRule, tempDir, writeFiles } from './helpers.mjs';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { collect, parseImport } from '../../plugins/atelier/skills/runtime-ux-audit/lib/collect.mjs';
import { buildCssModel, normalizePrelude, parseCss } from '../../plugins/atelier/skills/runtime-ux-audit/lib/css-model.mjs';
import {
  findUnitValues, normalizeSelector, parseAnimationList, parseLength, parseTimeMs, stripCssComments,
} from '../../plugins/atelier/skills/runtime-ux-audit/lib/css-values.mjs';
import { buildHtmlModel, MAX_HTML_DEPTH } from '../../plugins/atelier/skills/runtime-ux-audit/lib/html-model.mjs';
import { MAX_JS_DEPTH, buildJsModel, parseJs, pathOf } from '../../plugins/atelier/skills/runtime-ux-audit/lib/js-model.mjs';
import { compileSelector, matchesSelector, selectAll } from '../../plugins/atelier/skills/runtime-ux-audit/lib/selector-match.mjs';
import { REF_META } from '../../plugins/atelier/skills/runtime-ux-audit/lib/context.mjs';
import { createSuppressor } from '../../plugins/atelier/skills/runtime-ux-audit/lib/suppress.mjs';
import { code, inline } from '../../plugins/atelier/skills/runtime-ux-audit/lib/report-md.mjs';
import { isInternalHost } from '../../plugins/atelier/skills/runtime-ux-audit/lib/url.mjs';
import { launchUxChromium } from '../../plugins/atelier/skills/runtime-ux-audit/lib/browser.mjs';
import { clickHandlerForcedLayout } from '../../plugins/atelier/skills/runtime-ux-audit/rules/inp/listeners.mjs';
import { analyticsWithoutPrerenderGuard } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/analytics.mjs';
import { noUnloadHandler } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/bfcache.mjs';
import { speculationRulesCspGap, speculationRulesImmediateAbuse } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/speculation.mjs';
import { MATCH_BUDGET, compileHrefPattern, hrefMatchBudget } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/shared.mjs';
import { vtaDuplicateNames } from '../../plugins/atelier/skills/runtime-ux-audit/rules/transitions/view-transitions.mjs';

/** Milliseconds fn takes, and its result. */
function timed(fn) {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

async function timedAsync(fn) {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

// Each input below took from several seconds to hours before the fix; the
// bounds leave room for a slow CI machine.
const FAST_MS = 2000;

// ---------------------------------------------------------------------------

describe('selector matcher (descendant and sibling combinators)', () => {
  const nested = buildHtmlModel(`<!doctype html><html><body>${'<div>'.repeat(40)}x${'</div>'.repeat(40)}</body></html>`);
  const siblings = buildHtmlModel(`<!doctype html><html><body>${'<p>x</p>'.repeat(40)}</body></html>`);

  it('rejects a descendant chain whose first compound never matches in polynomial time', () => {
    const { ms, value } = timed(() => nested.querySelectorAll(`span ${'div '.repeat(10).trim()}`));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
    expect(nested.querySelectorAll('div div')).toHaveLength(39);
    expect(nested.querySelectorAll('body > div div')).toHaveLength(39);
  });

  it('does the same for ~ chains and for selector lists inside :is()', () => {
    const sib = timed(() => siblings.querySelectorAll('span ~ p ~ p ~ p ~ p ~ p ~ p ~ p'));
    expect(sib.value).toEqual([]);
    expect(sib.ms).toBeLessThan(FAST_MS);
    expect(siblings.querySelectorAll('p ~ p ~ p')).toHaveLength(38);
    const is = timed(() => nested.querySelectorAll(`:is(span ${'div '.repeat(8).trim()})`));
    expect(is.value).toEqual([]);
    expect(is.ms).toBeLessThan(FAST_MS);
  });

  it('walks a 20000-deep ancestor chain without overflowing the stack', () => {
    const nodes = [];
    for (let i = 0; i < 20000; i++) {
      nodes.push({
        tag: 'div', id: null, classes: new Set(), attrs: new Map(), parent: nodes[i - 1] ?? null, prev: null,
        childIndex: 1, siblingCount: 1, typeIndex: 1, typeCount: 1, empty: i === 19999,
      });
    }
    const adapter = (el) => el;
    const leaf = nodes[nodes.length - 1];
    expect(matchesSelector(adapter, leaf, 'p div')).toBe(false);
    expect(matchesSelector(adapter, leaf, 'div div')).toBe(true);
    const { ms, value } = timed(() => selectAll(adapter, nodes, 'p div'));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
    expect(selectAll(adapter, nodes, 'div div')).toHaveLength(19999);
  });
});

// ---------------------------------------------------------------------------

describe('@import params', () => {
  it('parses every @import form the same way as before', () => {
    const cases = [
      ['url("a)b.css")', { href: 'a)b.css', media: '' }],
      ['url(a.css) screen', { href: 'a.css', media: 'screen' }],
      ['"b.css" print', { href: 'b.css', media: 'print' }],
      ["'c.css' layer(x)", { href: 'c.css', media: '' }],
      ['url(d.css) supports(display: grid) screen', { href: 'd.css', media: 'screen' }],
      ['URL(a.css)', { href: 'a.css', media: '' }],
      ['url(a.css)print', { href: 'a.css', media: 'print' }],
      ['\nurl(a.css)', { href: 'a.css', media: '' }],
      ["url( 'x.css' ) (min-width: 600px)", { href: 'x.css', media: '(min-width: 600px)' }],
      ['url(  y.css  )', { href: 'y.css', media: '' }],
      ['"a.css" layer(a) layer(b) print', { href: 'a.css', media: 'layer(b) print' }],
      ['"a.css" supports(', { href: 'a.css', media: 'supports(' }],
      ['url(', null],
      ['url("a.css"', null],
      ['a.css', null],
    ];
    for (const [params, want] of cases) expect(parseImport(params), params).toEqual(want);
  });

  it('parses long whitespace runs and repeated supports( in linear time', () => {
    const spaces = timed(() => parseImport(`url(${' '.repeat(200_000)};`));
    expect(spaces.value).toBeNull();
    expect(spaces.ms).toBeLessThan(FAST_MS);
    const supports = timed(() => parseImport(`"a.css" ${'supports('.repeat(100_000)}`));
    expect(supports.value.href).toBe('a.css');
    expect(supports.ms).toBeLessThan(FAST_MS);
  });

  it('collects a page with @import url( and 20000 spaces quickly', async () => {
    const { dir, cleanup } = tempDir('ux-import-');
    try {
      writeFiles(dir, { 'index.html': `<style>@import url(${' '.repeat(20_000)};</style>` });
      const { ms } = await timedAsync(() => collect(join(dir, 'index.html')));
      expect(ms).toBeLessThan(FAST_MS);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------

describe('CSS nesting bounds', () => {
  const model = (text) => {
    const { root, error } = parseCss(text);
    expect(error).toBeNull();
    return buildCssModel([{ order: 0, displayPath: 'x.css', origin: 'style', el: null, root, error, parentOrder: null, inDocument: true, media: null }]);
  };

  it('stops "&" expansion at the selector length bound', () => {
    const amps = '&'.repeat(200);
    const { ms, value: m } = timed(() => model(`.a{${amps}{${amps}{${amps}{color:red}}}}`));
    expect(ms).toBeLessThan(FAST_MS);
    expect(m.truncated).toBe(true);
    expect(m.complete).toBe(false);
    for (const r of m.rules) for (const s of r.selectors) expect(s.length).toBeLessThanOrEqual(4096);
  });

  it('stops at 64 nesting levels instead of overflowing the stack', () => {
    const m = model(`${'a{'.repeat(20_000)}${'}'.repeat(20_000)}`);
    expect(m.rules).toHaveLength(64);
    expect(m.truncated).toBe(true);
    expect(m.complete).toBe(false);
  });

  it('bounds the total of resolved nested selectors', () => {
    const list = Array.from({ length: 256 }, (_, i) => `.p${i}`).join(',');
    const { ms, value: m } = timed(() => model(`${list}{${'&{a:b}'.repeat(50_000)}}`));
    // The resolved-text budget caps the work: unbounded, all 50,001 rules
    // resolve. The time bound is only a backstop, loose because coverage on
    // a Windows runner runs this case about 15 times slower than a laptop.
    expect(m.rules.length).toBeLessThan(5_000);
    expect(m.truncated).toBe(true);
    expect(ms).toBeLessThan(30_000);
  });

  it('leaves ordinary nesting unchanged', () => {
    const m = model('.card{color:red; &:hover{color:blue} & + &{margin:0} .x{a:b} @media (min-width: 1px){ &.y{c:d} }}');
    expect(m.rules.map((r) => r.selectorText)).toEqual(['.card', '.card:hover', '.card + .card', '.card .x', '.card.y']);
    expect(m.truncated).toBe(false);
    expect(m.complete).toBe(true);
    const deep = model(`${'a{'.repeat(60)}color:red${'}'.repeat(60)}`);
    expect(deep.rules).toHaveLength(60);
    expect(deep.complete).toBe(true);
    expect(buildCssModel([], { complete: false }).complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('CSS number grammar', () => {
  it('fails fast on long digit runs with a bad suffix', () => {
    const digits = '1'.repeat(200_000);
    for (const [label, fn] of [
      ['parseTimeMs digits', () => parseTimeMs(`${digits}x`)],
      ['parseTimeMs zeros', () => parseTimeMs(`${'0'.repeat(200_000)}x`)],
      ['findUnitValues', () => findUnitValues(`${digits}x`, 'vh')],
      ['parseLength', () => parseLength(`${digits}!`)],
      ['parseAnimationList', () => parseAnimationList(`fade ${digits}x`)],
    ]) {
      const { ms } = timed(fn);
      expect(ms, label).toBeLessThan(FAST_MS);
    }
  });

  it('parses the same values as before', () => {
    expect(parseTimeMs('200ms')).toBe(200);
    expect(parseTimeMs('.2s')).toBe(200);
    expect(parseTimeMs('1.5s')).toBe(1500);
    expect(parseTimeMs('1e3ms')).toBe(1000);
    expect(parseTimeMs('0')).toBe(0);
    expect(parseTimeMs('-0')).toBe(0);
    expect(parseTimeMs('.0')).toBe(0);
    expect(parseTimeMs('00.00')).toBe(0);
    expect(parseTimeMs('0.')).toBeNull();
    expect(parseTimeMs('1.')).toBeNull();
    expect(parseTimeMs('1.s')).toBe(1000);
    expect(findUnitValues('calc(100vh - 2.5vh) 10dvh', 'vh')).toEqual([100, 2.5]);
    expect(parseLength('12px')).toEqual({ value: 12, unit: 'px' });
    expect(parseAnimationList('fade 2 200ms')[0]).toMatchObject({ name: 'fade', durationMs: 200 });
  });
});

// ---------------------------------------------------------------------------

describe('selector and prelude normalization', () => {
  it('is linear in nested parentheses and unterminated comments inside strings', () => {
    const parens = timed(() => normalizeSelector(`a${'('.repeat(128_000)}${')'.repeat(128_000)}`));
    expect(parens.ms).toBeLessThan(FAST_MS);
    const quoted = `[a="${'/*a'.repeat(100_000)}"]`;
    for (const [label, fn] of [
      ['normalizeSelector', () => normalizeSelector(quoted)],
      ['normalizePrelude', () => normalizePrelude(quoted)],
      ['compileSelector', () => compileSelector(`${quoted}x`)],
      ['long list', () => normalizeSelector(Array.from({ length: 40_000 }, (_, i) => `.c${i}:not(.x)`).join(','))],
    ]) {
      const { ms } = timed(fn);
      expect(ms, label).toBeLessThan(FAST_MS);
    }
  });

  it('strips comments exactly like the lazy regex', () => {
    const regex = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const s of ['a /* c */ b', '/**/x/* y */z', 'a /* x', '/* a */ /* b', '*/ a /* b */', '', 'plain', '/*/ x */y']) {
      expect(stripCssComments(s), s).toBe(regex(s));
    }
  });

  it('keeps the canonical form', () => {
    expect(normalizeSelector('  a>b  +  c ~d ,  e')).toBe('a > b + c ~ d, e');
    expect(normalizeSelector('e[ data-x = "a > b" i ]')).toBe('e[data-x="a > b" i]');
    expect(normalizeSelector(':is( .x , .y )  :nth-child( 2n + 1 )')).toBe(':is(.x, .y) :nth-child(2n + 1)');
    expect(normalizeSelector('a /* c */ b')).toBe('a b');
    expect(normalizeSelector('> .x')).toBe('> .x');
  });
});

// ---------------------------------------------------------------------------

describe('suppression lookups', () => {
  const RULE = 'atelier/runtime-ux/no-unload-handler';
  const refFor = (script, jsLine) => {
    const ref = { selector: '', snippet: '', location: '' };
    Object.defineProperty(ref, REF_META, { value: { script, jsLine } });
    return ref;
  };

  it('reads each script comment once, however many findings the script has', () => {
    const n = 2000;
    const list = Array.from({ length: n }, (_, i) => ({ value: 'c', loc: { end: { line: i + 1 } } }));
    let reads = 0;
    const comments = new Proxy(list, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const script = { comments };
    const isSuppressed = createSuppressor();
    for (let line = 1; line <= n; line++) expect(isSuppressed(RULE, refFor(script, line))).toBe(false);
    expect(reads).toBeLessThanOrEqual(2 * n);
  });

  it('still honors a marker on the same line or the line before', () => {
    const script = {
      comments: [
        { value: ' atelier-ignore no-unload-handler -- legacy', loc: { end: { line: 5 } } },
        { value: ' atelier-ignore some-other-rule', loc: { end: { line: 9 } } },
        { value: ' atelier-ignore', loc: { end: { line: 12 } } },
      ],
    };
    const isSuppressed = createSuppressor();
    const at = (line) => isSuppressed(RULE, refFor(script, line));
    expect([4, 5, 6, 7, 9, 10, 12, 13, 14].map(at)).toEqual([false, true, true, false, false, false, true, true, false]);
  });
});

// ---------------------------------------------------------------------------

describe('speculation-rules-csp-gap on hostile hash sources', () => {
  it('handles a hash source with a long "=" run quickly and still reports the gap', async () => {
    const csp = `script-src 'sha256-${'='.repeat(200_000)}x'`;
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">`
      + '<script type="speculationrules">{"prefetch":[{"source":"document","where":{"href_matches":"/*"}}]}</script></head><body><a href="/a">a</a></body></html>';
    const { ms, value } = await timedAsync(async () => runRule(speculationRulesCspGap, await contextFor({ 'index.html': html })));
    expect(value.status).toBe('failed');
    expect(value.nodes).toHaveLength(1);
    expect(ms).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------

describe('speculation href_matches patterns', () => {
  const resolve = (h) => (h.startsWith('/') ? `https://a.example${h}` : h);
  // 1023 characters, the longest shape the matcher accepts: on a long run of
  // "a" nearly every one of its states stays active.
  const HOSTILE = `/${'*a'.repeat(510)}*z`;
  const rulesTag = (json) => `<script type="speculationrules">${JSON.stringify(json)}</script>`;
  const anchors = (n, href) => Array.from({ length: n }, (_, i) => `<a href="${href(i)}">a</a>`).join('');
  const BUDGET_MESSAGE = (action) => `Too many links and href_matches patterns to count the URLs this immediate ${action} rule matches statically.`;

  /** test() over every link: the answers, or MATCH_BUDGET when the step budget ran out first. */
  const matchAll = (re, links) => {
    try {
      return links.map((l) => re.test(l));
    } catch (e) {
      if (e !== MATCH_BUDGET) throw e;
      return MATCH_BUDGET;
    }
  };

  it('matches a pattern with many wildcards against a long link in linear time', () => {
    const re = compileHrefPattern(`/${'*a'.repeat(30)}*z`, resolve);
    expect(re).not.toBeNull();
    const link = `https://a.example/${'a'.repeat(2000)}`;
    const { ms, value } = timed(() => re.test(link));
    expect(ms).toBeLessThan(FAST_MS);
    expect(value).toBe(false);
    expect(re.test(`${link}z`)).toBe(true);
  });

  it('keeps ordinary wildcard and :name semantics', () => {
    const re = compileHrefPattern('/docs/:id/*/end', resolve);
    expect(re.test('https://a.example/docs/7/x/y/end')).toBe(true);
    expect(re.test('https://a.example/docs/7/end')).toBe(false);
    expect(re.test('https://a.example/docs//x/end')).toBe(false);
    expect(re.test('https://a.example/docs/7/x/end/more')).toBe(false);
  });

  it('does not stall the static pass on a hostile rule', async () => {
    const pattern = `/${'*a'.repeat(30)}*z`;
    const html = `<!doctype html><html><head><script type="speculationrules">${JSON.stringify({ prefetch: [{ where: { href_matches: pattern }, eagerness: 'immediate' }] })}</script></head>`
      + `<body><a href="/${'a'.repeat(2000)}">a</a></body></html>`;
    const { ms } = await timedAsync(async () => runRule(speculationRulesImmediateAbuse, await contextFor({ 'index.html': html })));
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('skips patterns over the length bound and stays fast against many links', () => {
    const resolve = (h) => `https://a.example${h.startsWith('/') ? '' : '/'}${h}`;
    const huge = `/${'*a'.repeat(50000)}*z`;
    expect(huge.length).toBeGreaterThan(100000);
    const { ms, value } = timed(() => compileHrefPattern(huge, resolve));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(FAST_MS);
    const ok = compileHrefPattern(`/${'*a'.repeat(300)}*z`, resolve);
    expect(ok).not.toBeNull();
    const links = Array.from({ length: 2000 }, (_, i) => `https://a.example/${'a'.repeat(100)}${i}`);
    const batch = timed(() => matchAll(ok, links));
    expect(batch.ms).toBeLessThan(10_000);
  });

  it('costs little per link for a maximum-length pattern and bounds a huge href', () => {
    const resolve = (h) => `https://a.example${h.startsWith('/') ? '' : '/'}${h}`;
    const pattern = `/${'*a'.repeat(510)}*z`;
    expect(pattern.length).toBeLessThanOrEqual(1024);
    const re = compileHrefPattern(pattern, resolve);
    expect(re).not.toBeNull();
    const links = Array.from({ length: 2000 }, (_, i) => `https://a.example/${'a'.repeat(100)}${i}`);
    const batch = timed(() => matchAll(re, links));
    expect(batch.ms).toBeLessThan(3000);
    // A fresh matcher: the batch above may have spent the budget of re.
    const huge = timed(() => compileHrefPattern(pattern, resolve).test(`https://a.example/${'a'.repeat(100_000)}`));
    expect(huge.ms).toBeLessThan(FAST_MS);
    expect(huge.value).toBe(false);
  });

  it('stops a maximum-length pattern over 200 links of 8000 characters at the step budget', () => {
    expect(HOSTILE).toHaveLength(1023);
    const links = Array.from({ length: 200 }, (_, i) => `https://a.example/${'a'.repeat(8000)}${i}`);
    const re = compileHrefPattern(HOSTILE, resolve);
    const { ms, value } = timed(() => matchAll(re, links));
    expect(value).toBe(MATCH_BUDGET);
    expect(ms).toBeLessThan(5000);
    // A spent budget stays spent, also for a link that would cost nothing.
    expect(matchAll(re, ['https://a.example/x'])).toBe(MATCH_BUDGET);
  });

  it('stops every matcher that shares a spent budget', () => {
    const shared = hrefMatchBudget();
    const hostile = compileHrefPattern(HOSTILE, resolve, shared);
    const plain = compileHrefPattern('/x', resolve, shared);
    expect(plain.test('https://a.example/x')).toBe(true);
    expect(matchAll(hostile, Array.from({ length: 200 }, () => `https://a.example/${'a'.repeat(8000)}`))).toBe(MATCH_BUDGET);
    expect(matchAll(plain, ['https://a.example/x'])).toBe(MATCH_BUDGET);
    // A matcher with its own budget is not affected.
    expect(compileHrefPattern('/x', resolve).test('https://a.example/x')).toBe(true);
  });

  it('gives the same answers when matchers share a budget and its state arrays', () => {
    const urls = [
      'https://a.example/a/x/b/1/c', 'https://a.example/a/b/1/c', `https://a.example/a/${'x/'.repeat(50)}b/7/zc`,
      'https://a.example/a/x/b//c', 'https://a.example/', 'https://a.example/a/x/b/1/c/d', 'https://a.example/a/aaaa', 'https://b.example/a/x',
    ];
    // The answers of the matcher before it had a budget, one row per pattern.
    const want = {
      '/a/*/b/:id/*c': [true, false, true, false, false, false, false, false],
      '/a/:x': [false, false, false, false, false, false, true, false],
      '/*a*a*a*': [false, false, false, false, false, false, true, false],
      '/*': [true, true, true, true, true, true, true, false],
    };
    const patterns = Object.keys(want);
    for (const p of patterns) expect(urls.map((u) => compileHrefPattern(p, resolve).test(u)), p).toEqual(want[p]);
    const shared = hrefMatchBudget();
    const res = patterns.map((p) => compileHrefPattern(p, resolve, shared));
    // Pattern by pattern, then link by link, so every matcher follows every other.
    for (let round = 0; round < 2; round++) {
      res.forEach((re, i) => expect(urls.map((u) => re.test(u)), `${patterns[i]}, round ${round}`).toEqual(want[patterns[i]]));
      urls.forEach((u, j) => expect(res.map((re) => re.test(u)), `${u}, round ${round}`).toEqual(patterns.map((p) => want[p][j])));
    }
  });

  it('reports the rule as incomplete instead of stalling on 1000 links of 2000 characters', async () => {
    const html = `<!doctype html><html><head>${rulesTag({ prefetch: [{ where: { href_matches: HOSTILE }, eagerness: 'immediate' }] })}</head>`
      + `<body>${anchors(1000, (i) => `/${'a'.repeat(2000)}${i}`)}</body></html>`;
    const { ms, value } = await timedAsync(async () => runRule(speculationRulesImmediateAbuse, await contextFor({ 'index.html': html }, { areas: ['transitions'] })));
    expect(ms).toBeLessThan(10_000);
    expect(value.status).toBe('incomplete');
    expect(value.nodes).toEqual([]);
    expect(value.incomplete).toEqual([expect.objectContaining({ selector: 'head > script', message: BUDGET_MESSAGE('prefetch') })]);
    expect(value.errors).toEqual([]);
  });

  it('spends one budget on every rule and pattern of a page, and still counts list rules', async () => {
    // 16 rules of 4 patterns each, and every rule alone has more work than one
    // budget: a budget per rule or per pattern would allow 16 to 64 times the work.
    const patterns = Array.from({ length: 4 }, (_, i) => `/${'*a'.repeat(500)}*z${i}`);
    const hostileRules = Array.from({ length: 8 }, () => ({ where: { href_matches: patterns }, eagerness: 'immediate' }));
    const urls = Array.from({ length: 51 }, (_, i) => `/u/${i}`);
    const json = {
      prerender: hostileRules,
      prefetch: [...hostileRules, { urls }, { where: { href_matches: patterns }, eagerness: 'moderate' }],
    };
    const html = `<!doctype html><html><head>${rulesTag(json)}</head><body>${anchors(20, (i) => `/${'a'.repeat(2000)}${i}`)}</body></html>`;
    const { ms, value } = await timedAsync(async () => runRule(speculationRulesImmediateAbuse, await contextFor({ 'index.html': html }, { areas: ['transitions'] })));
    expect(ms).toBeLessThan(10_000);
    // The list rule needs no matching, so it is still counted and reported.
    expect(value.status).toBe('failed');
    expect(value.nodes.map((n) => n.data)).toEqual([{ action: 'prefetch', candidates: 51, limit: 50, source: 'list' }]);
    expect(value.incomplete.map((n) => n.message)).toEqual([BUDGET_MESSAGE('prefetch'), BUDGET_MESSAGE('prerender')]);
  });

  it('leaves an ordinary page complete, with the same counts', async () => {
    const json = {
      prefetch: [
        { where: { and: [{ href_matches: ['/docs/*', '/blog/:slug'] }, { not: { href_matches: '/docs/item-3' } }] }, eagerness: 'immediate' },
        { where: { href_matches: '/shop/*' }, eagerness: 'moderate' },
      ],
      prerender: [{ where: { href_matches: '/blog/*' }, eagerness: 'immediate' }, { where: { href_matches: '/none/*' }, eagerness: 'immediate' }],
    };
    const html = `<!doctype html><html><head>${rulesTag(json)}</head><body>${anchors(300, (i) => `/${['docs', 'blog', 'shop'][i % 3]}/item-${i}`)}</body></html>`;
    const { ms, value } = await timedAsync(async () => runRule(speculationRulesImmediateAbuse, await contextFor({ 'index.html': html }, { areas: ['transitions'] })));
    expect(value.status).toBe('failed');
    expect(value.nodes.map((n) => n.data)).toEqual([
      { action: 'prefetch', candidates: 199, limit: 50, source: 'document' },
      { action: 'prerender', candidates: 100, limit: 10, source: 'document' },
    ]);
    expect(value.incomplete).toEqual([]);
    expect(value.errors).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
    // At the limits nothing is reported, as before.
    const atLimit = { prerender: [{ where: { href_matches: '/blog/*' }, eagerness: 'immediate' }] };
    const small = `<!doctype html><html><head>${rulesTag(atLimit)}</head><body>${anchors(30, (i) => `/${['docs', 'blog', 'shop'][i % 3]}/item-${i}`)}</body></html>`;
    expect(runRule(speculationRulesImmediateAbuse, await contextFor({ 'index.html': small }, { areas: ['transitions'] })).status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------

describe('vta-duplicate-names on broad repeated selectors', () => {
  it('stays bounded for hundreds of universal view-transition-name rules over many elements', async () => {
    const css = '*{view-transition-name:a}'.repeat(400);
    const html = `<!doctype html><html><head><style>${css}</style></head><body>${'<i></i>'.repeat(20000)}</body></html>`;
    const ctx = await contextFor({ 'index.html': html }, { areas: ['transitions'] });
    const before = process.memoryUsage().heapUsed;
    const { ms, value } = await timedAsync(async () => runRule(vtaDuplicateNames, ctx));
    expect(ms).toBeLessThan(60_000);
    expect(value.status).toBe('failed');
    expect(value.nodes[0].data).toMatchObject({ name: 'a' });
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(400 * 1024 * 1024);
  }, 90_000);

  it('gives up with an incomplete result for hundreds of distinct condition sets', async () => {
    const css = Array.from({ length: 300 }, (_, i) => `@media (min-width:${400 + i}px){*{view-transition-name:a}}`).join('');
    const html = `<!doctype html><html><head><style>${css}</style></head><body>${'<i></i>'.repeat(20000)}</body></html>`;
    const ctx = await contextFor({ 'index.html': html }, { areas: ['transitions'] });
    const before = process.memoryUsage().heapUsed;
    const { ms, value } = await timedAsync(async () => runRule(vtaDuplicateNames, ctx));
    expect(ms).toBeLessThan(60_000);
    expect(value.status).toBe('incomplete');
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(600 * 1024 * 1024);
  }, 90_000);

  it('gives up in bounded time on 300 distinct selectors that each match every element', async () => {
    const css = Array.from({ length: 300 }, (_, i) => `i:not(.c${i}){view-transition-name:a}`).join('');
    const html = `<!doctype html><html><head><style>${css}</style></head><body>${'<i></i>'.repeat(20000)}</body></html>`;
    const ctx = await contextFor({ 'index.html': html }, { areas: ['transitions'] });
    const { ms, value } = await timedAsync(async () => runRule(vtaDuplicateNames, ctx));
    expect(ms).toBeLessThan(60_000);
    expect(value.status).toBe('incomplete');
  }, 90_000);

  it('gives up in bounded time on thousands of distinct media rules that each match one element', async () => {
    const n = 5000;
    const css = Array.from({ length: n }, (_, i) => `@media (min-width:${400 + i}px){#e${i}{view-transition-name:a}}`).join('');
    const html = `<!doctype html><html><head><style>${css}</style></head><body>${Array.from({ length: n }, (_, i) => `<i id="e${i}"></i>`).join('')}</body></html>`;
    const ctx = await contextFor({ 'index.html': html }, { areas: ['transitions'] });
    const { ms, value } = await timedAsync(async () => runRule(vtaDuplicateNames, ctx));
    expect(ms).toBeLessThan(60_000);
    expect(value.status).toBe('incomplete');
  }, 90_000);
});

// ---------------------------------------------------------------------------

/** A line of the report with its inline code spans blanked out. */
function outsideCode(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i++];
      continue;
    }
    let j = i;
    while (line[j] === '`') j++;
    const fence = line.slice(i, j);
    const end = line.indexOf(fence, j);
    if (end < 0) {
      out += fence;
      i = j;
      continue;
    }
    out += ' ';
    i = end + fence.length;
  }
  return out;
}

const OWN_HEADINGS = [/^# Runtime UX audit$/, /^## \d\. (Transitions|INP|Panels|Mobile)$/, /^## (Needs review|Coverage)$/, /^### (Critical|Serious|Moderate|Minor) \(\d+\)$/, /^#### atelier\/runtime-ux\/[a-z0-9-]+$/];

describe('ux-report.md escaping', () => {
  it('code() keeps page text on one line; inline() escapes Markdown and HTML', () => {
    expect(code('a\n\n# X')).toBe('`a # X`');
    expect(code(' a\r\nb ')).toBe('`a b`');
    expect(inline('# X')).toBe('\\# X');
    expect(inline('#id scrolls')).toBe('#id scrolls');
    expect(inline('> quote')).toBe('\\> quote');
    expect(inline('- item')).toBe('\\- item');
    expect(inline('--z-modal 9999')).toBe('--z-modal 9999');
    expect(inline('---')).toBe('\\---');
    expect(inline('1. first')).toBe('1\\. first');
    expect(inline('2026-01-01 at 9999 > 50')).toBe('2026-01-01 at 9999 > 50');
    expect(inline('a\n\n<img src=x> ![p](https://e.test/x.png)')).toBe('a \\<img src=x> !\\[p\\](https://e.test/x.png)');
    expect(inline('`x` \\')).toBe('\\`x\\` \\\\');
  });

  it('a hostile page cannot add headings, links, images or HTML to the report', async () => {
    const { dir, cleanup } = tempDir('ux-mdinj-');
    try {
      writeFiles(dir, {
        'index.html': '<!doctype html>\n<html lang="en"><head><meta name="viewport" content="width=device-width">\n'
          + '<style>\n.x[title="\n\n# Pass: yes (all checks green)\n\n![pixel](https://attacker.example/track.png) [Fix now](https://attacker.example/phish)\n"] { z-index: 9999; }\n</style>\n'
          + '<script src="a.js\n\n## Injected via script src\n\n"></script>\n'
          + '<script src="b.js?x=1&#10;&#10;# Entity heading&#10;&#10;"></script>\n'
          + '<script type="module">import("left-pad\\n\\n## Injected via import specifier\\n\\n<img src=https://attacker.example/x.png>\\n");</script>\n'
          + '</head><body><p class="x">hi</p></body></html>\n',
        'a.js': 'window.addEventListener("unload", () => {});',
      });
      const res = await auditRuntimeUx({ url: join(dir, 'index.html'), timestamp: FIXED_TS, write: false });
      const lines = res.markdown.split('\n');
      for (const line of lines) {
        if (/^\s*#{1,6}\s/.test(line)) expect(OWN_HEADINGS.some((re) => re.test(line)), line).toBe(true);
        const bare = outsideCode(line);
        expect(bare, line).not.toMatch(/(^|[^\\])<[a-z!/]/i);
        expect(bare, line).not.toMatch(/(^|[^\\])\[/);
      }
      expect(lines.filter((l) => l.startsWith('Pass:'))).toEqual([`Pass: no (${res.summary.rules.critical} critical, ${res.summary.rules.serious} serious)`]);
      expect(res.markdown).toContain('left-pad ## Injected via import specifier \\<img');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------

/** A fetch stand-in: routes maps URL -> Response factory; every requested URL is recorded. */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const make = routes[url];
    if (!make) return new Response('not found', { status: 404 });
    return make();
  };
  return { impl, seen };
}
const redirect = (location, status = 302) => () => new Response(null, { status, headers: { location } });
const htmlPage = (body = '<p>x</p>') => () => new Response(`<!doctype html>${body}`, { status: 200, headers: { 'content-type': 'text/html' } });

describe('document redirect policy', () => {
  it('classifies loopback, link-local and private hosts', () => {
    const internal = ['127.0.0.1', 'localhost', 'localhost.', 'a.localhost', '[::1]', '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[fe80::1]', '[fc00::1]',
      '169.254.169.254', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0'];
    const external = ['8.8.8.8', 'example.com', '[2001:db8::1]', '172.32.0.1', '169.255.0.1', 'localhost.example.com'];
    for (const h of internal) expect(isInternalHost(h), h).toBe(true);
    for (const h of external) expect(isInternalHost(h), h).toBe(false);
    // WHATWG URL parsing normalizes the numeric forms before the check.
    expect(isInternalHost(new URL('http://2130706433/').hostname)).toBe(true);
    expect(isInternalHost(new URL('http://0x7f.1/').hostname)).toBe(true);
  });

  it('refuses a public page that redirects to cloud metadata or loopback, without fetching it', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/admin/', 'http://[::1]/']) {
      const { impl, seen } = fakeFetch({ 'https://public.example/': redirect(target), [target]: htmlPage('<link rel="stylesheet" href="creds">') });
      await expect(collect('https://public.example/', { fetchImpl: impl })).rejects.toMatchObject({
        code: 'COLLECT_FAILED',
        message: expect.stringContaining('redirect-private-address'),
        hint: expect.stringContaining(target),
      });
      expect(seen).toEqual(['https://public.example/']);
    }
  });

  it('refuses an https to http downgrade', async () => {
    const { impl, seen } = fakeFetch({ 'https://a.example/': redirect('http://a.example/', 301), 'http://a.example/': htmlPage() });
    await expect(collect('https://a.example/', { fetchImpl: impl })).rejects.toMatchObject({ message: expect.stringContaining('redirect-downgrade') });
    expect(seen).toEqual(['https://a.example/']);
  });

  it('still follows public redirects, and local ones when the audit starts locally', async () => {
    const pub = fakeFetch({ 'https://a.example/': redirect('https://www.a.example/'), 'https://www.a.example/': htmlPage() });
    expect((await collect('https://a.example/', { fetchImpl: pub.impl })).page.docUrl).toBe('https://www.a.example/');
    const local = fakeFetch({ 'http://localhost:3000/': redirect('/app'), 'http://localhost:3000/app': htmlPage() });
    expect((await collect('http://localhost:3000/', { fetchImpl: local.impl })).page.docUrl).toBe('http://localhost:3000/app');
  });
});

// ---------------------------------------------------------------------------

describe('HTML nesting depth', () => {
  it('stops with COLLECT_FAILED on 100000 unclosed divs instead of parsing for minutes', async () => {
    const { dir, cleanup } = tempDir('ux-deep-');
    try {
      writeFiles(dir, { 'index.html': '<div>'.repeat(100_000) });
      const { ms, value } = await timedAsync(() => collect(join(dir, 'index.html')).then(() => null, (err) => err));
      expect(value).toMatchObject({ code: 'COLLECT_FAILED', message: expect.stringContaining(`more than ${MAX_HTML_DEPTH} deep`) });
      expect(ms).toBeLessThan(FAST_MS);
    } finally {
      cleanup();
    }
  });

  it('parses nesting up to the bound and ordinary misnested markup', () => {
    expect(buildHtmlModel(`${'<div>'.repeat(MAX_HTML_DEPTH - 3)}x`).elements.length).toBe(MAX_HTML_DEPTH);
    const m = buildHtmlModel('<!doctype html><table><tr><td>a<b>x<p>y</b>z</td></tr></table><p>1<p>2');
    expect(m.querySelectorAll('td p')).toHaveLength(1);
    expect(m.querySelectorAll('body > p')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe('long property chains in scripts', () => {
  const chain = `a${'.b'.repeat(50_000)}`;

  it('reads a 50000-segment path without overflowing the stack', () => {
    const { ast, error } = parseJs(`${chain};`);
    expect(error).toBeNull();
    expect(pathOf(ast.body[0].expression) === chain).toBe(true);
  });

  it('audits a page whose scripts use such a chain as a callee and as an assignment target', async () => {
    const { dir, cleanup } = tempDir('ux-chain-');
    try {
      writeFiles(dir, {
        'index.html': '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>'
          + '<body><p>x</p><script src="call.js"></script><script src="assign.js"></script><script>window.addEventListener("unload", () => {});</script></body></html>',
        'call.js': `${chain}();`,
        'assign.js': `${chain} = 1;`,
      });
      const res = await auditRuntimeUx({ url: join(dir, 'index.html'), timestamp: FIXED_TS, write: false });
      // The rest of the page is still audited: the inline unload handler is reported.
      expect(res.violations.critical.map((v) => v.ruleId)).toEqual(['atelier/runtime-ux/no-unload-handler']);
      expect(res.raw.errors).toEqual([]);
      expect(res.pass).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------

describe('JS nesting depth', () => {
  const model = (source) => {
    const { ast, comments, error } = parseJs(source);
    const js = buildJsModel([{ order: 1, displayPath: 'a.js', kind: 'external', type: 'classic', el: null, src: 'a.js', source, rawText: source, ast, comments, selector: 'script', inDocument: false }]);
    return { js, error };
  };
  const chainOf = (n) => `x${'.a()'.repeat(n)};`;

  it('indexes a 20000-call chain down to the depth bound, with no ancestor copy per call', () => {
    const { ms, value: { js, error } } = timed(() => model(chainOf(20_000)));
    expect(error).toBeNull();
    // The depth bound caps the work: unbounded, all 20,000 calls are indexed
    // and each keeps a copy of its path (3.2 GB). The time is only a backstop.
    expect(js.calls.length).toBeGreaterThan(0);
    expect(js.calls.length).toBeLessThanOrEqual(MAX_JS_DEPTH);
    expect(Math.max(...js.calls.map((c) => c.ancestors.length))).toBeLessThanOrEqual(MAX_JS_DEPTH);
    expect(js.complete).toBe(false);
    expect(ms).toBeLessThan(30_000);
  });

  it('does the same for a long run of calls joined by +', () => {
    // 2500 terms nest 2500 deep. A parser that runs out of stack first gives
    // a parse error, which also leaves the model incomplete.
    const { js } = model(`${Array.from({ length: 2500 }, () => 'f()').join('+')};`);
    expect(js.calls.length).toBeLessThanOrEqual(MAX_JS_DEPTH);
    expect(js.complete).toBe(false);
  });

  it('keeps one ancestor list at a time instead of one per record', () => {
    const { js } = model('function a() { if (x) { f(); } }\nfunction b() { for (;;) { g(); } }');
    const [f, g] = js.calls;
    const first = f.ancestors;
    expect(f.ancestors).toBe(first);
    expect(first.map((n) => n.type)).toEqual(['Program', 'FunctionDeclaration', 'BlockStatement', 'IfStatement', 'BlockStatement', 'ExpressionStatement']);
    expect(g.ancestors.map((n) => n.type)).toEqual(['Program', 'FunctionDeclaration', 'BlockStatement', 'ForStatement', 'BlockStatement', 'ExpressionStatement']);
    // Reading g dropped the list of f; it is rebuilt on the next read.
    expect(f.ancestors).not.toBe(first);
    expect(f.ancestors).toEqual(first);
    expect(Object.isFrozen(first) && Object.isFrozen(f.ancestors)).toBe(true);
  });

  it('indexes deep code below the bound completely', () => {
    const { js } = model(`window.addEventListener('unload', bye);\n${chainOf(900)}\nfunction bye() {}`);
    expect(js.complete).toBe(true);
    expect(js.calls).toHaveLength(901);
    expect(js.calls[900].ancestors).toHaveLength(1800);
    expect(js.calls.every((c) => c.topLevel && !c.inLoop)).toBe(true);
    expect(js.listenersByEvent('unload')[0].handler.id.name).toBe('bye');
  });

  it('keeps findings from the part of a script above the bound and sends absence-based ones to review', async () => {
    const ctx = await contextFor({
      'index.html': '<!doctype html><html><head></head><body><p>x</p><script src="a.js"></script></body></html>',
      'a.js': `window.addEventListener('unload', bye);\nga('send', 'pageview');\n${chainOf(20_000)}`,
    });
    expect(ctx.js.complete).toBe(false);
    expect(runRule(noUnloadHandler, ctx).nodes.map((n) => n.location)).toEqual(['a.js:1:1']);
    const analytics = runRule(analyticsWithoutPrerenderGuard, ctx);
    expect(analytics.status).toBe('incomplete');
    expect(analytics.incomplete.map((n) => n.location)).toEqual(['a.js:2:1']);
    // The same page without the deep chain: a plain violation.
    const plain = await contextFor({
      'index.html': '<!doctype html><html><head></head><body><p>x</p><script src="a.js"></script></body></html>',
      'a.js': `ga('send', 'pageview');\n${chainOf(900)}`,
    });
    expect(runRule(analyticsWithoutPrerenderGuard, plain).nodes.map((n) => n.location)).toEqual(['a.js:1:1']);
  });

  const clickHandler = (links) => `btn.addEventListener('click', function () { box.style.width = '10px'; var h = box.offsetHeight; ${chainOf(links)} });`;
  const walk = (js) => {
    const seen = { visits: 0, longest: 0, calls: 0 };
    js.walkFunction(js.listenersByEvent('click')[0].handler, (node, ancestors) => {
      seen.visits += 1;
      seen.longest = Math.max(seen.longest, ancestors.length);
      if (node.type === 'CallExpression') seen.calls += 1;
    });
    return seen;
  };

  it('walks a handler body down to the same bound', () => {
    // Unbounded, the walk copies the path to each of the 12,000 levels of this
    // chain: work that grows with the square of the depth.
    const { js } = model(clickHandler(6000));
    const deep = walk(js);
    expect(deep.longest).toBe(MAX_JS_DEPTH);
    expect(deep.visits).toBeLessThan(2 * MAX_JS_DEPTH);
    expect(js.complete).toBe(false);
    // Below the bound every node is visited, with its whole path.
    const shallow = model(clickHandler(900));
    expect(walk(shallow.js)).toMatchObject({ calls: 900, longest: 3 + 1800 });
    expect(shallow.js.complete).toBe(true);
  });

  it('still reports what a handler does above the bound', async () => {
    const page = (links) => ({
      'index.html': '<!doctype html><html><head></head><body><button id="btn">x</button><div id="box"></div><script src="a.js"></script></body></html>',
      'a.js': clickHandler(links),
    });
    const { ms, value: res } = await timedAsync(async () => runRule(clickHandlerForcedLayout, await contextFor(page(20_000))));
    expect(res.nodes.map((n) => [n.snippet, n.location])).toEqual([['box.offsetHeight', 'a.js:1:79']]);
    expect(ms).toBeLessThan(30_000);
    // A handler that only writes is not reported, deep chain or not.
    const writeOnly = { ...page(0), 'a.js': `btn.addEventListener('click', function () { box.style.width = '10px'; ${chainOf(20_000)} });` };
    expect(runRule(clickHandlerForcedLayout, await contextFor(writeOnly)).status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------

describe('async stylesheets', () => {
  const MAIN_CSS = '.modal{z-index:9999;height:100vh}';
  const pageWith = (link) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>${link}</head><body><div class="modal">x</div></body></html>`;
  const sheetRows = (resources) => resources.filter((r) => r.kind === 'stylesheet').map((r) => [r.displayPath, r.status, r.reason]);

  it('reads media="print" sheets that an onload handler swaps to all', async () => {
    const ctx = await contextFor({ 'index.html': pageWith('<link rel="stylesheet" href="main.css" media="print" onload="this.media=\'all\'">'), 'main.css': MAIN_CSS });
    expect(sheetRows(ctx.resources)).toEqual([['main.css', 'parsed', null]]);
    expect(ctx.css.rulesBySelector('.modal').map((r) => r.context.media)).toEqual([[]]);
  });

  it('keeps the media an onload handler assigns', async () => {
    const ctx = await contextFor({ 'index.html': pageWith('<link rel="stylesheet" href="main.css" media="print" onload="this.onload=null;this.media=\'screen and (min-width: 600px)\'">'), 'main.css': MAIN_CSS });
    expect(ctx.css.rulesBySelector('.modal').map((r) => r.context.media)).toEqual([['screen and (min-width: 600px)']]);
  });

  it('reads rel=preload as=style links whose onload makes them stylesheets', async () => {
    const ctx = await contextFor({ 'index.html': pageWith('<link rel="preload" href="main.css" as="style" onload="this.onload=null;this.rel=\'stylesheet\'">'), 'main.css': MAIN_CSS });
    expect(sheetRows(ctx.resources)).toEqual([['main.css', 'parsed', null]]);
    expect(ctx.css.rulesBySelector('.modal')).toHaveLength(1);
    const plain = await contextFor({ 'index.html': pageWith('<link rel="preload" href="main.css" as="style">'), 'main.css': MAIN_CSS });
    expect(sheetRows(plain.resources)).toEqual([]);
  });

  it('lists print-only sheets as skipped without making coverage incomplete', async () => {
    for (const link of ['<link rel="stylesheet" href="main.css" media="print">', '<link rel="stylesheet" href="main.css" media="print" onload="this.media=\'print\'">']) {
      const ctx = await contextFor({ 'index.html': pageWith(link), 'main.css': MAIN_CSS });
      expect(sheetRows(ctx.resources), link).toEqual([['main.css', 'skipped', 'print-media']]);
      expect(ctx.css.complete).toBe(true);
      expect(ctx.css.rulesBySelector('.modal')).toEqual([]);
    }
  });

  it('audits the async sheet, so a 100vh modal fails the page', async () => {
    const { dir, cleanup } = tempDir('ux-async-');
    try {
      writeFiles(dir, { 'index.html': pageWith('<link rel="stylesheet" href="main.css" media="print" onload="this.media=\'all\'">'), 'main.css': MAIN_CSS });
      const res = await auditRuntimeUx({ url: join(dir, 'index.html'), areas: ['mobile'], timestamp: FIXED_TS, write: false });
      expect(res.violations.all.map((v) => v.ruleId)).toContain('atelier/runtime-ux/uses-vh-without-dvh');
      expect(res.pass).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Chromium sandbox', () => {
  const sandboxError = () => new Error('browserType.launch: Chromium sandboxing failed!\nTo avoid the sandboxing issue, do either of the following: ...');

  it('launches with the sandbox on by default and keeps other options', async () => {
    const calls = [];
    const browser = {};
    const out = await launchUxChromium({ channel: 'chromium' }, { launch: async (o) => { calls.push(o); return browser; }, platform: 'win32' });
    expect(out).toBe(browser);
    expect(calls).toEqual([{ chromiumSandbox: true, channel: 'chromium' }]);
  });

  it('retries once without the sandbox on Linux when it cannot start, with one warning', async () => {
    const calls = [];
    const warnings = [];
    const launch = async (o) => {
      calls.push(o);
      if (o.chromiumSandbox) throw sandboxError();
      return 'browser';
    };
    expect(await launchUxChromium({}, { launch, platform: 'linux', warn: (m) => warnings.push(m) })).toBe('browser');
    expect(calls.map((o) => o.chromiumSandbox)).toEqual([true, false]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/sandbox/);
  });

  it('does not retry on other platforms, for other errors or when the caller chose', async () => {
    for (const [opts, platform, err] of [[{}, 'win32', sandboxError()], [{}, 'darwin', sandboxError()], [{}, 'linux', new Error('boom')], [{ chromiumSandbox: true }, 'linux', sandboxError()]]) {
      let calls = 0;
      const launch = async () => {
        calls++;
        throw err;
      };
      await expect(launchUxChromium(opts, { launch, platform, warn: () => {} })).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });
});

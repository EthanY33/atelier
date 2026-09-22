import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FIXED_TS, FIXTURES_DIR, GOLDEN_DIR, chromiumAvailable, contextFor, expectAsciiNoDash, expectGolden, readFixtureJson,
  runFixture, runRule, withServer,
} from './helpers.mjs';

const probe = {
  id: 'atelier/runtime-ux/helper-probe', area: 'mobile', severity: 'minor', confidence: 'high', methods: ['html'], phase: 'static',
  description: 'Helper probe.', helpUrl: 'https://example.com',
  check: (ctx) => ctx.html.byTag('p').map((el) => ({ node: ctx.ref.html(el) })),
};

describe('test helpers', () => {
  it('contextFor builds a ctx from files, with a brand path relative to the site', async () => {
    const ctx = await contextFor({ 'index.html': '<p>a</p><p data-atelier-ignore>b</p>', 'b.json': '{"surfaces":{"zIndexMax":7}}' }, { brand: 'b.json', areas: ['mobile'] });
    expect(ctx.budgets.zIndexMax).toBe(7);
    expect(ctx.options.areas).toEqual(['mobile']);
    const r = runRule(probe, ctx);
    expect(r).toMatchObject({ status: 'failed', suppressed: 1, incomplete: [], nodesTruncated: 0, errors: [] });
    expect(r.nodes).toEqual([{ selector: 'body > p:nth-of-type(1)', snippet: '<p>', location: 'index.html:1:1' }]);
    expect(r.violation.ruleId).toBe(probe.id);
    expect(runRule(probe, ctx, { ignore: ['helper-probe'] }).status).toBe('skipped');
  });

  it('runFixture audits a fixture folder with its brand.json and a fixed timestamp', async () => {
    const res = await runFixture('core', { rules: [probe] });
    expect(res.raw.timestamp).toBe(FIXED_TS);
    expect(res.raw.budgets.minTapPxSource).toBe('brand');
    expect(res.reportPath).toBeNull();
    const clean = await runFixture('core/clean', { rules: [probe] });
    expect(clean.raw.url).toBe('index.html');
  });

  it('reads JSON fixtures and ships a DynamicFacts sample with every contract key', () => {
    const facts = readFixtureJson('core/facts/sample.json');
    expect(Object.keys(facts).sort()).toEqual(['bfcache', 'dialogs', 'engine', 'errors', 'interactions', 'navigation', 'profile', 'rendered', 'sweep']);
    expect(Object.keys(facts.sweep).sort()).toEqual(['interactive', 'interactiveTruncated', 'repeatedGroups', 'viewTransitionNames']);
    expect(Object.keys(facts.interactions).sort()).toEqual(['attempted', 'entries', 'inp', 'interactionCount', 'loaf']);
  });

  it('expectGolden refuses to invent a missing golden', () => {
    if (process.env.UPDATE_GOLDEN === '1') return;
    expect(existsSync(join(GOLDEN_DIR, 'nope.md'))).toBe(false);
    expect(() => expectGolden('nope.md', 'x')).toThrow(/UPDATE_GOLDEN=1/);
  });

  it('checks ASCII text, serves HTTP and detects Chromium', async () => {
    expectAsciiNoDash('plain, text: ok (1/2)');
    expect(() => expectAsciiNoDash('em — dash')).toThrow();
    const body = await withServer((req, res) => res.end('hi'), async (base) => (await fetch(base)).text());
    expect(body).toBe('hi');
    expect(typeof chromiumAvailable).toBe('boolean');
    expect(existsSync(FIXTURES_DIR)).toBe(true);
  });
});

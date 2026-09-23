/**
 * Checks the generated CSS and Tailwind font lists in a real browser: the
 * values must be valid font-family lists (not one quoted string), and a
 * hostile typography value must stay inside its declaration.
 * Skips when Playwright's Chromium is not installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, PreflightError } from '../../plugins/atelier/lib/preflight.mjs';
import { emitCss } from '../../plugins/atelier/skills/design-token-sync/emitters/css.mjs';
import { emitTailwind } from '../../plugins/atelier/skills/design-token-sync/emitters/tailwind.mjs';

let browser;
let page;
let skipReason = '';

beforeAll(async () => {
  try {
    browser = await launchChromium();
    page = await browser.newPage();
  } catch (err) {
    if (!(err instanceof PreflightError)) throw err;
    skipReason = err.message;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe('generated fonts in Chromium', () => {
  it('--font-* values resolve to the listed families', async (ctx) => {
    if (!browser) ctx.skip(skipReason);
    const css = emitCss({
      palette: { bg: '#110f1b' },
      typography: {
        body: "Silkscreen, 'Courier New', monospace",
        display: '"Geist", system-ui, sans-serif',
        mono: 'monospace',
      },
    });
    await page.setContent(`<style>${css}</style>
      <p id="body" style="font-family: var(--font-body)">x</p>
      <p id="display" style="font-family: var(--font-display)">x</p>
      <p id="mono" style="font-family: var(--font-mono)">x</p>`);
    const computed = await page.evaluate(() => Object.fromEntries(
      ['body', 'display', 'mono'].map((id) => [id, getComputedStyle(document.getElementById(id)).fontFamily]),
    ));
    expect(computed).toEqual({
      body: 'Silkscreen, "Courier New", monospace',
      display: 'Geist, system-ui, sans-serif',
      mono: 'monospace',
    });
  });

  it('a hostile typography value stays inside one :root rule', async (ctx) => {
    if (!browser) ctx.skip(skipReason);
    const css = emitCss({ palette: { bg: '#000' }, typography: { body: 'Inter"; } body { display: none } :root { --x: "' } });
    const rules = await page.evaluate((text) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      return [...sheet.cssRules].map((r) => r.selectorText);
    }, css);
    expect(rules).toEqual([':root']);
  });

  it('Tailwind fontFamily arrays join into valid font-family values', async (ctx) => {
    if (!browser) ctx.skip(skipReason);
    const src = emitTailwind({
      palette: { bg: '#000' },
      typography: { display: 'Press Start 2P', body: 'Source Sans 3', mono: "JetBrains Mono, 'Courier New'" },
    });
    const { fontFamily } = (await import(`data:text/javascript,${encodeURIComponent(src)}`)).default.theme.extend;
    // Tailwind writes `font-family: ${list.join(', ')}`.
    const values = Object.values(fontFamily).map((list) => list.join(', '));
    const supported = await page.evaluate((vals) => vals.map((v) => CSS.supports('font-family', v)), values);
    expect(supported).toEqual(values.map(() => true));
    // The unquoted form the old emitter produced is rejected, so this check has teeth.
    expect(await page.evaluate(() => CSS.supports('font-family', 'Press Start 2P, sans-serif'))).toBe(false);
  });

  // macOS resolves -apple-system and BlinkMacSystemFont, so only other platforms
  // show what happens when the vendor keywords are skipped.
  it.skipIf(process.platform === 'darwin')('Tailwind stacks led by vendor keywords still end in their generic', async (ctx) => {
    if (!browser) ctx.skip(skipReason);
    const src = emitTailwind({
      palette: { bg: '#000' },
      typography: { body: '-apple-system, BlinkMacSystemFont, "Missing Font XYZ"', mono: '-apple-system, "Missing Mono XYZ"' },
    });
    const { fontFamily } = (await import(`data:text/javascript,${encodeURIComponent(src)}`)).default.theme.extend;
    const widths = await page.evaluate((stacks) => stacks.map((stack) => {
      const span = document.createElement('span');
      span.style.cssText = 'font-size: 20px; white-space: nowrap';
      span.style.fontFamily = stack;
      span.textContent = 'mmmmmmmmmmiiiiiiiiii';
      document.body.append(span);
      const w = span.getBoundingClientRect().width;
      span.remove();
      return w;
    }), [fontFamily.body.join(', '), fontFamily.mono.join(', '), 'sans-serif', 'monospace', '-apple-system, "Missing Mono XYZ"']);
    const [body, mono, sans, monospace, oldMono] = widths;
    expect(body).toBe(sans);
    expect(mono).toBe(monospace);
    // Without the appended generic the stack falls through to the browser default, so this check has teeth.
    expect(oldMono).not.toBe(monospace);
  });
});

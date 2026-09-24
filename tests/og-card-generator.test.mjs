import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pluginRequire, sharp } from './helpers/plugin-deps.mjs';
import { launchChromium } from '../plugins/atelier/lib/preflight.mjs';
import {
  buildCardHtml,
  generateCard,
  generateCards,
} from '../plugins/atelier/skills/og-card-generator/index.mjs';

const brand = {
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b', fg: '#f2cc8f' },
  typography: { display: 'system-ui', body: 'system-ui' },
};
const BG = [0x11, 0x0f, 0x1b];
const FG = [0xf2, 0xcc, 0x8f];
// The card puts the brand row (mark, studio, path) at the top and anchors the
// title and subtitle to the bottom margin.
const BRAND_ROWS = [60, 150];
const TITLE_ROWS = [360, 566];

let browser;
let tmp;

beforeAll(async () => {
  browser = await launchChromium();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function scratch() {
  tmp = mkdtempSync(join(tmpdir(), 'og-card-test-'));
  return tmp;
}

/** Render one card with the shared browser; returns raw pixels and warnings. */
async function render(cardBrand, page, options = {}) {
  const dir = tmp ?? scratch();
  const outPath = join(dir, `${Math.random().toString(36).slice(2)}.png`);
  const warnings = [];
  await generateCard({ brand: cardBrand, page, outPath, browser, onWarning: (m) => warnings.push(m), ...options });
  const { data, info } = await sharp(outPath).raw().toBuffer({ resolveWithObject: true });
  return { outPath, data, info, warnings };
}

function px(img, x, y) {
  const i = (y * img.info.width + x) * img.info.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function near(a, b, tol = 6) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

/** Count pixels in rows [y0, y1) that satisfy pred. */
function count(img, pred, y0 = 0, y1 = img.info.height) {
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < img.info.width; x += 1) if (pred(px(img, x, y))) n += 1;
  }
  return n;
}

function rowsDiffer(a, b, y0, y1) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < a.info.width; x += 1) if (!near(px(a, x, y), px(b, x, y), 0)) return true;
  }
  return false;
}

/** Load card HTML in a JS-disabled page (as the renderer does) and read it back. */
async function inspect(html) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.evaluate(() => {
      const text = (id) => document.getElementById(id).textContent;
      return {
        title: text('title'),
        subtitle: text('subtitle'),
        studio: text('studio'),
        slug: text('slug'),
        scripts: document.querySelectorAll('script').length,
        styles: document.querySelectorAll('style').length,
        bodyFont: getComputedStyle(document.body).fontFamily,
        titleFont: getComputedStyle(document.getElementById('title')).fontFamily,
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color,
      };
    });
  } finally {
    await context.close();
  }
}

describe('og-card-generator: rendering', () => {
  it('writes a 1200x630 PNG in the brand colors', async () => {
    const img = await render(brand, { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' });
    expect(readFileSync(img.outPath).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const meta = await sharp(img.outPath).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 630]);
    expect(px(img, 5, 5)).toEqual(BG);
    expect(px(img, 1195, 625)).toEqual(BG);
    // The title is drawn in palette.fg.
    expect(count(img, (p) => near(p, FG, 10), ...TITLE_ROWS)).toBeGreaterThan(1000);
    expect(img.warnings).toEqual([]);
  });

  it('draws different images for different titles', async () => {
    const a = await render(brand, { slug: 'home', title: 'TideWane' });
    const b = await render(brand, { slug: 'home', title: 'Another title' });
    expect(rowsDiffer(a, b, ...TITLE_ROWS)).toBe(true);
  });

  it('reuses a caller-supplied browser and leaves it open', async () => {
    await render(brand, { title: 'x' });
    expect(browser.isConnected()).toBe(true);
  });

  it('puts page and brand text in the right elements', async () => {
    const dom = await inspect(buildCardHtml(brand, { slug: 'blog/launch', title: 'T', subtitle: 'S' }));
    expect(dom).toMatchObject({ title: 'T', subtitle: 'S', studio: 'goneIdle', slug: '/blog/launch' });
  });

  it('accepts description as an alias for subtitle', async () => {
    const dom = await inspect(buildCardHtml(brand, { title: 'T', description: 'From description' }));
    expect(dom.subtitle).toBe('From description');
    const both = await inspect(buildCardHtml(brand, { title: 'T', subtitle: 'Sub', description: 'Desc' }));
    expect(both.subtitle).toBe('Sub');
  });

  it('falls back to brand.product when a page has no title', async () => {
    const dom = await inspect(buildCardHtml({ ...brand, brand: { studio: 's', product: 'TideWane' } }, { slug: 'x' }));
    expect(dom.title).toBe('TideWane');
    expect(dom.slug).toBe('/x');
  });

  it('shows "/" in the footer when the page has no slug', async () => {
    const dom = await inspect(buildCardHtml({ palette: { bg: '#000' }, typography: { body: 'serif' } }, {}));
    expect(dom).toMatchObject({ title: '', subtitle: '', studio: '', slug: '/' });
  });

  it('rejects non-string page fields', () => {
    expect(() => buildCardHtml(brand, { title: 42 })).toThrow(/page\.title must be a string/);
    expect(() => buildCardHtml(brand, null)).toThrow(/page must be an object/);
    expect(() => buildCardHtml(null, {})).toThrow(/brand must be an object/);
  });

  it('prints warnings to stderr when no onWarning is given', async () => {
    const dir = scratch();
    const write = process.stderr.write;
    let err = '';
    process.stderr.write = (chunk) => {
      err += chunk;
      return true;
    };
    try {
      await generateCard({
        brand: { palette: { bg: '#ffffff', fg: '#eeeeee' }, typography: { body: 'system-ui' } },
        page: { title: 'x' },
        outPath: join(dir, 'a.png'),
        browser,
      });
    } finally {
      process.stderr.write = write;
    }
    expect(err).toMatch(/^atelier: warning: text color #eeeeee on background #ffffff/);
  });

  it('rejects a missing outPath', async () => {
    await expect(generateCard({ brand, page: {}, browser })).rejects.toThrow(/outPath/);
  });
});

describe('og-card-generator: injection', () => {
  it('renders </script> in a title as text and runs no script', async () => {
    const title = "</script><script>document.body.style.background='rgb(255,0,0)'</script>";
    const dom = await inspect(buildCardHtml(brand, { slug: 'x', title }));
    expect(dom.title).toBe(title);
    expect(dom.scripts).toBe(0);
    const img = await render(brand, { slug: 'x', title });
    expect(px(img, 5, 5)).toEqual(BG);

    const innocent = await inspect(buildCardHtml(brand, { title: 'Why </script> breaks inline JSON', subtitle: 'Sub here' }));
    expect(innocent).toMatchObject({ title: 'Why </script> breaks inline JSON', subtitle: 'Sub here', studio: 'goneIdle' });
  });

  it('keeps $ replacement patterns literal', async () => {
    for (const title of ['Save $$ now', 'Q&A $&', 'Price $` test', "It$'s", "Save $' today", '$1 $<name>']) {
      const dom = await inspect(buildCardHtml(brand, { title, subtitle: title }));
      expect(dom.title).toBe(title);
      expect(dom.subtitle).toBe(title);
    }
    const dom = await inspect(buildCardHtml({ ...brand, brand: { studio: 'A$&B' } }, { title: 't' }));
    expect(dom.studio).toBe('A$&B');
  });

  it('does not substitute template placeholders found inside values', async () => {
    const dom = await inspect(buildCardHtml(brand, { title: '{{subtitle}}', subtitle: '{{style}}', slug: 'a' }));
    expect(dom.title).toBe('{{subtitle}}');
    expect(dom.subtitle).toBe('{{style}}');
  });

  it('escapes quotes, ampersands and line separators in text', async () => {
    const odd = `"quoted" & 'single' <b>bold</b> ${String.fromCharCode(0x2028)}end`;
    const dom = await inspect(buildCardHtml(brand, { title: odd }));
    expect(dom.title).toBe(odd);
  });

  it('keeps typography values inside a CSS string', async () => {
    const hostile = {
      ...brand,
      typography: {
        body: "x}</style><script>document.body.style.background='rgb(0,0,255)'</script><style>",
        display: 'a";} body{background:rgb(0,255,0)} x{"',
      },
    };
    const html = buildCardHtml(hostile, { title: 'T' });
    const dom = await inspect(html);
    expect(dom.scripts).toBe(0);
    expect(dom.styles).toBe(2);
    expect(dom.bg).toBe('rgb(17, 15, 27)');
    const img = await render(hostile, { title: 'T' });
    expect(px(img, 5, 5)).toEqual(BG);
  });

  it('rejects palette colors that are not hex', () => {
    expect(() => buildCardHtml({ ...brand, palette: { bg: 'red;}</style><script>x()</script>' } }, {})).toThrow(/palette\.bg must be a hex color/);
    expect(() => buildCardHtml({ ...brand, palette: { bg: '#000', fg: 'url(http://127.0.0.1/x)' } }, {})).toThrow(/palette\.fg must be a hex color/);
    expect(() => buildCardHtml({ ...brand, palette: { bg: 17 } }, {})).toThrow(/palette\.bg/);
  });

  it('sends no network request, whatever the page text or fonts say', async () => {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end('SECRET');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const base = `http://127.0.0.1:${port}`;
      await render(
        { ...brand, typography: { body: `x");background:url(${base}/css);x:("`, display: `<img src="${base}/font">` } },
        { title: `<img src="${base}/img"><script>fetch("${base}/js")</script>`, subtitle: `<link rel="stylesheet" href="${base}/link">` },
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(hits).toEqual([]);
  });
});

describe('og-card-generator: fonts', () => {
  it('quotes multi-word family names so the declaration stays valid', async () => {
    const html = buildCardHtml({ ...brand, typography: { body: 'Press Start 2P', display: 'M PLUS 1p' } }, { title: 'T' });
    expect(html).toContain('--font-body:"Press Start 2P"');
    const dom = await inspect(html);
    expect(dom.bodyFont).toContain('"Press Start 2P"');
    expect(dom.bodyFont).toContain('system-ui');
    expect(dom.titleFont).toContain('"M PLUS 1p"');
  });

  it('keeps generic keywords bare and normalizes existing quotes', () => {
    const html = buildCardHtml({ ...brand, typography: { body: "'Inter', Helvetica  Neue, \"Serif\", SANS-SERIF,, " } }, {});
    expect(html).toContain('--font-body:"Inter", "Helvetica Neue", "Serif", sans-serif');
    // display falls back to body
    expect(html).toContain('--font-display:"Inter", "Helvetica Neue", "Serif", sans-serif');
  });

  it('keeps -apple-system and BlinkMacSystemFont bare and never takes them as the brand font', async () => {
    const stack = '-apple-system, BlinkMacSystemFont, "Segoe UI", SANS-SERIF';
    const html = buildCardHtml({ ...brand, typography: { body: stack } }, {});
    expect(html).toContain('--font-body:-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
    // Quoted, it is a family name like any other.
    expect(buildCardHtml({ ...brand, typography: { body: '"-apple-system", serif' } }, {})).toContain('--font-body:"-apple-system", serif');

    // A font file registers under the first named family, not a vendor keyword.
    scratch();
    const file = join(tmp, 'brand.woff2');
    writeFileSync(file, 'placeholder');
    expect(buildCardHtml({ ...brand, typography: { body: stack } }, {}, { fonts: { body: file } })).toContain('@font-face{font-family:"Segoe UI";');

    // The installed-font check skips the keywords too.
    const vendorOnly = await render({ ...brand, typography: { display: stack, body: '-apple-system, BlinkMacSystemFont, sans-serif' } }, { title: 'T' });
    expect(vendorOnly.warnings.join('\n')).not.toMatch(/apple-system|BlinkMacSystemFont/i);
    const named = await render({ ...brand, typography: { body: '-apple-system, BlinkMacSystemFont, NoSuchFontAtelierXyz, sans-serif' } }, { title: 'T' });
    expect(named.warnings.join('\n')).toMatch(/"NoSuchFontAtelierXyz" is not installed/);
    expect(named.warnings.join('\n')).not.toMatch(/apple-system|BlinkMacSystemFont/i);
  });

  it('uses system-ui when typography is empty', () => {
    const html = buildCardHtml({ palette: { bg: '#000' } }, {});
    expect(html).toContain('--font-display:system-ui;--font-body:system-ui');
  });

  it('warns when a brand font is not installed and no file is given', async () => {
    const img = await render({ ...brand, typography: { body: 'NoSuchFontAtelierXyz, sans-serif' } }, { title: 'T' });
    expect(img.warnings.join('\n')).toMatch(/"NoSuchFontAtelierXyz" is not installed/);
  });

  it('rejects a font file it cannot use', () => {
    scratch();
    expect(() => buildCardHtml(brand, {}, { fonts: { body: join(tmp, 'font.txt') } })).toThrow(/Unsupported font file/);
    expect(() => buildCardHtml(brand, {}, { fonts: { body: join(tmp, 'missing.woff2') } })).toThrow(/Cannot read font file .*file not found/);
    expect(() => buildCardHtml(brand, {}, { fonts: { body: 42 } })).toThrow(/fonts\.body must be a font file path/);
  });

  it('warns when a font file does not load', async () => {
    scratch();
    const bad = join(tmp, 'bad.woff2');
    writeFileSync(bad, 'not a font');
    const img = await render({ ...brand, typography: { body: 'Broken Font' } }, { title: 'T' }, { fonts: { body: bad } });
    expect(img.warnings.join('\n')).toMatch(/font file for "Broken Font" could not be loaded/);
  });

  // Any real font works; playwright-core ships an icon font we can borrow.
  const iconFont = (() => {
    try {
      const root = dirname(pluginRequire.resolve('playwright-core/package.json'));
      const dir = join(root, 'lib', 'vite', 'traceViewer');
      const name = readdirSync(dir).find((f) => /^codicon.*\.ttf$/.test(f));
      return name ? join(dir, name) : null;
    } catch {
      return null;
    }
  })();

  it.skipIf(!iconFont)('inlines a font file and renders with it', async () => {
    const iconBrand = { ...brand, typography: { display: 'Codicon', body: 'system-ui' } };
    const page = { title: String.fromCodePoint(0xea60).repeat(4) };
    const withFont = await render(iconBrand, page, { fonts: { display: iconFont } });
    const without = await render(iconBrand, page);
    expect(withFont.warnings).toEqual([]);
    expect(without.warnings.join('\n')).toMatch(/"Codicon" is not installed/);
    expect(rowsDiffer(withFont, without, ...TITLE_ROWS)).toBe(true);
    expect(buildCardHtml(iconBrand, page, { fonts: { display: iconFont } })).toMatch(/@font-face\{font-family:"Codicon";src:url\(data:font\/ttf;base64,/);
  });

  it.skipIf(!iconFont)('registers a font file under a synthetic name when the stack has no named family', () => {
    const html = buildCardHtml({ ...brand, typography: { body: 'sans-serif' } }, {}, { fonts: { body: iconFont } });
    expect(html).toContain('--font-body:"atelier body", sans-serif');
  });
});

describe('og-card-generator: colors', () => {
  it('picks dark text for a light background when palette.fg is absent', async () => {
    const light = { brand: { studio: 'Acme' }, palette: { bg: '#ffffff' }, typography: { body: 'system-ui' } };
    expect(buildCardHtml(light, {})).toContain('--fg:#111111');
    const img = await render(light, { slug: 'launch', title: 'Acme Launch', subtitle: 'sub' });
    expect(px(img, 5, 5)).toEqual([255, 255, 255]);
    expect(count(img, (p) => p.every((v) => v < 80), ...TITLE_ROWS)).toBeGreaterThan(1000);
    expect(img.warnings).toEqual([]);
  });

  it('keeps white text for a dark background and the old defaults', () => {
    expect(buildCardHtml({ palette: { bg: '#110f1b' }, typography: { body: 'x' } }, {})).toContain('--fg:#ffffff');
    expect(buildCardHtml({ typography: { body: 'x' } }, {})).toContain('--bg:#111111;--fg:#ffffff');
  });

  it('accepts 3- and 8-digit hex and composites alpha for contrast', () => {
    expect(buildCardHtml({ palette: { bg: '#FFF' }, typography: { body: 'x' } }, {})).toContain('--bg:#fff;--fg:#111111');
    // 10% black over white is still a light background.
    expect(buildCardHtml({ palette: { bg: '#0000001a' }, typography: { body: 'x' } }, {})).toContain('--fg:#111111');
  });

  it('warns when palette.fg does not contrast with palette.bg', async () => {
    const img = await render({ palette: { bg: '#ffffff', fg: '#eeeeee' }, typography: { body: 'system-ui' } }, { title: 'Pale' });
    expect(img.warnings.join('\n')).toMatch(/contrast 1\.\d+:1, below 4\.5:1/);
  });
});

describe('og-card-generator: layout', () => {
  const long = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation';

  it('keeps the subtitle and brand row on the canvas for very long titles', async () => {
    // Twice the paragraph: more than four lines even at the 48px minimum.
    const title = `${long} ${long}`;
    const a = await render(brand, { slug: 'home', title, subtitle: long });
    const b = await render({ ...brand, brand: { studio: 'ZZZZZZZZZZZZ' } }, { slug: 'zzzzzzzzzz', title, subtitle: long });
    // The brand row is drawn (it differs with the studio and slug text)...
    expect(rowsDiffer(a, b, ...BRAND_ROWS)).toBe(true);
    // ...and nothing spills into the bottom padding.
    expect(count(a, (p) => !near(p, BG, 0), 566, 630)).toBe(0);
    expect(a.warnings.join('\n')).toMatch(/title is too long for the card and was shortened/);
    expect(a.warnings.join('\n')).toMatch(/subtitle is longer than 2 lines/);
  });

  it('draws a subtitle below a four-line title', async () => {
    const title = 'A title that needs a few lines at the full size';
    const withSub = await render(brand, { slug: 'a', title, subtitle: 'Subtitle text' });
    const noSub = await render(brand, { slug: 'a', title });
    expect(rowsDiffer(withSub, noSub, 150, 500)).toBe(true);
    expect(withSub.warnings).toEqual([]);
  });

  it('does not shrink a title that already fits', async () => {
    const short = await render(brand, { slug: 'a', title: 'Why' });
    // The title sits on the bottom margin, so only an 88px title reaches up
    // into rows 480-505; a shrunk one starts lower.
    expect(count(short, (p) => near(p, FG, 10), 480, 505)).toBeGreaterThan(50);
  });
});

describe('og-card-generator: generateCards', () => {
  it('renders every page into outDir with one browser launch', async () => {
    const dir = scratch();
    // Count launches on the BrowserType that lib/preflight launched the shared browser with.
    const chromium = browser.browserType();
    const original = chromium.launch;
    let launches = 0;
    chromium.launch = function countedLaunch(...args) {
      launches += 1;
      return original.apply(this, args);
    };
    let paths;
    try {
      paths = await generateCards({
        brand,
        pages: [{ slug: 'home', title: 'Home' }, { slug: 'blog/launch', title: 'Launch' }, { title: 'Index' }],
        outDir: join(dir, 'og'),
        onWarning: () => {},
      });
    } finally {
      delete chromium.launch;
    }
    expect(launches).toBe(1);
    expect(paths).toEqual([join(dir, 'og', 'home.png'), join(dir, 'og', 'blog/launch.png'), join(dir, 'og', 'index.png')]);
    for (const p of paths) {
      const meta = await sharp(p).metadata();
      expect([meta.width, meta.height]).toEqual([1200, 630]);
    }
  });

  it('reuses a supplied browser', async () => {
    const dir = scratch();
    const paths = await generateCards({ brand, pages: [{ slug: 'a', title: 'A' }], outDir: dir, browser, onWarning: () => {} });
    expect(existsSync(paths[0])).toBe(true);
    expect(browser.isConnected()).toBe(true);
  });

  it.each([
    ['../escaped'],
    ['a/../../escaped'],
    ['blog:post'],
    ['C:/escaped'],
    ['/abs'],
    ['a\\b'],
    ['Home'],
    ['v1.2'],
    ['a//b'],
    ['trailing/'],
  ])('rejects the unsafe slug %j before writing anything', async (slug) => {
    const dir = scratch();
    const outDir = join(dir, 'public', 'og');
    await expect(
      generateCards({ brand, pages: [{ slug: 'ok', title: 'fine' }, { slug, title: 'x' }], outDir, browser }),
    ).rejects.toThrow(/pages\[1\]\.slug .* is not a safe file name/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects two pages that write the same file', async () => {
    const dir = scratch();
    await expect(generateCards({ brand, pages: [{ title: 'a' }, { title: 'b' }], outDir: dir, browser }))
      .rejects.toThrow(/pages\[1\] and pages\[0\] both write/);
    await expect(generateCards({ brand, pages: [{ slug: 'x' }, { slug: 'x' }], outDir: dir, browser }))
      .rejects.toThrow(/both write/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('validates its arguments', async () => {
    await expect(generateCards({ brand, pages: 'nope', outDir: 'x' })).rejects.toThrow(/pages must be an array/);
    await expect(generateCards({ brand, pages: [], outDir: '' })).rejects.toThrow(/outDir must be a directory/);
    await expect(generateCards({ brand, pages: [{ title: 7 }], outDir: 'x' })).rejects.toThrow(/pages\[0\]: page\.title must be a string/);
    await expect(generateCards({ brand, pages: [], outDir: 'x' })).resolves.toEqual([]);
  });
});

describe('og-card-generator: accent and mark', () => {
  // A solid pure-red square: easy to find in the rendered pixels.
  const RED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>';
  const isRed = (p) => p[0] > 230 && p[1] < 40 && p[2] < 40;

  function markFile(name, content) {
    const path = join(tmp ?? scratch(), name);
    writeFileSync(path, content);
    return path;
  }

  it('passes palette.accent to the template and falls back to the text color', () => {
    expect(buildCardHtml({ ...brand, palette: { ...brand.palette, accent: '#E07A5F' } }, {})).toContain('--accent:#e07a5f');
    expect(buildCardHtml(brand, {})).toContain('--accent:#f2cc8f');
    expect(buildCardHtml({ palette: { bg: '#ffffff' }, typography: { body: 'x' } }, {})).toContain('--accent:#111111');
  });

  it('rejects an accent that is not a hex color', () => {
    expect(() => buildCardHtml({ ...brand, palette: { ...brand.palette, accent: 'red' } }, {})).toThrow(/palette\.accent must be a hex color/);
  });

  it('embeds the mark as a data: image and leaves it out by default', () => {
    expect(buildCardHtml(brand, {})).not.toContain('<img');
    const svg = buildCardHtml(brand, {}, { mark: markFile('mark.svg', RED_SVG) });
    expect(svg).toContain('<img class="mark" src="data:image/svg+xml;base64,');
    const png = buildCardHtml(brand, {}, { mark: markFile('mark.PNG', Buffer.from('89504e470d0a1a0a', 'hex')) });
    expect(png).toContain('src="data:image/png;base64,');
  });

  it('draws the mark on the card', async () => {
    const mark = markFile('mark.svg', RED_SVG);
    const withMark = await render(brand, { slug: 'a', title: 'Mark' }, { mark });
    const without = await render(brand, { slug: 'a', title: 'Mark' });
    expect(count(withMark, isRed)).toBeGreaterThan(400);
    expect(count(without, isRed)).toBe(0);
    expect(withMark.warnings).toEqual([]);
  });

  it('rejects marks it cannot embed', () => {
    const dir = tmp ?? scratch();
    expect(() => buildCardHtml(brand, {}, { mark: join(dir, 'missing.svg') })).toThrow(/Cannot read mark .*missing\.svg: file not found/);
    expect(() => buildCardHtml(brand, {}, { mark: markFile('mark.gif', 'GIF89a') })).toThrow(/use an \.svg, \.png, \.jpg or \.webp file/);
    expect(() => buildCardHtml(brand, {}, { mark: markFile('big.svg', Buffer.alloc(2 * 1024 * 1024 + 1)) })).toThrow(/keep it under 2 MB/);
    expect(() => buildCardHtml(brand, {}, { mark: String.raw`\\host\share\mark.svg` })).toThrow(/network path/);
    expect(() => buildCardHtml(brand, {}, { mark: '//host/share/mark.svg' })).toThrow(/network path/);
    expect(() => buildCardHtml(brand, {}, { mark: 7 })).toThrow(/mark must be a file path/);
  });
});

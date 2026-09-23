/**
 * og-card-generator: render 1200x630 Open Graph card PNGs from a brand file.
 *
 * Every page value is HTML-escaped into the template, brand values are
 * validated (colors) or escaped as CSS strings (fonts), and the card page
 * runs with JavaScript disabled, a Content-Security-Policy that forbids
 * network access, and every request aborted. The page itself can never run
 * script or reach the network, whatever a title or brand.json contains.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { formatError, launchChromium } from '../../lib/preflight.mjs';
import { isMain } from '../../lib/cli.mjs';
import { readJsonFile, readTextFile } from '../../lib/io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'template.html');

const WIDTH = 1200;
const HEIGHT = 630;
const TITLE_MAX_PX = 88;
const TITLE_MIN_PX = 48;
const TITLE_STEP_PX = 4;
const TITLE_MAX_LINES = 4;
const SUBTITLE_MAX_LINES = 2;
const MIN_CONTRAST = 4.5;
const DEFAULT_BG = '#111111';
const DARK_TEXT = '#111111';
const LIGHT_TEXT = '#ffffff';

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for an HTML text node or a quoted attribute value. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Quote a value as a CSS string. Backslash, quote, angle brackets and control
 * characters become CSS escapes, so the result can never close the <style>
 * element or the string itself.
 */
function cssString(value) {
  const body = String(value).replace(/[\\"<>\u0000-\u001f\u007f\u2028\u2029]/g, (ch) => {
    if (ch === '\\' || ch === '"') return `\\${ch}`;
    return `\\${ch.codePointAt(0).toString(16)} `;
  });
  return `"${body}"`;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parse a #rgb, #rrggbb or #rrggbbaa color (the forms brand.schema.json allows).
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function parseHex(value, field) {
  if (typeof value !== 'string' || !HEX_RE.test(value)) {
    throw new Error(`${field} must be a hex color such as #112233 (got ${JSON.stringify(value)})`);
  }
  let hex = value.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = (i) => parseInt(hex.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
}

/** Composite a (possibly translucent) color over an opaque one. */
function over(top, under) {
  const mix = (t, u) => Math.round(t * top.a + u * (1 - top.a));
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** WCAG 2 relative luminance of an opaque color. */
function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio between two opaque colors (1 to 21). */
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

// Vendor system-font keywords. Like the generics they stay unquoted (Safari
// ignores -apple-system once quoted) and are never taken as the brand's own
// font, but they keep their spelling: Chromium matches BlinkMacSystemFont as
// a family name.
const VENDOR_SYSTEM_FONTS = new Set(['-apple-system', 'blinkmacsystemfont']);
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
  ...VENDOR_SYSTEM_FONTS,
]);

/**
 * Split a font stack such as `"Press Start 2P", Inter, sans-serif` into
 * families. Commas inside quotes do not split.
 * @returns {Array<{ name: string, generic: boolean }>}
 */
function parseFontStack(stack) {
  const families = [];
  let current = '';
  let quote = null;
  let quoted = false;
  const flush = () => {
    const name = quoted ? current : current.trim().replace(/\s+/g, ' ');
    if (name) families.push({ name, generic: !quoted && GENERIC_FAMILIES.has(name.toLowerCase()) });
    current = '';
    quoted = false;
  };
  for (const ch of String(stack)) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if ((ch === '"' || ch === "'") && current.trim() === '') {
      quote = ch;
      quoted = true;
      current = '';
    } else if (ch === ',') {
      flush();
    } else if (!quoted) {
      current += ch;
    }
  }
  flush();
  return families;
}

/** Render parsed families as a valid CSS font-family value. */
function fontStackCss(families) {
  if (families.length === 0) return 'system-ui';
  return families.map((f) => {
    if (!f.generic) return cssString(f.name);
    return VENDOR_SYSTEM_FONTS.has(f.name.toLowerCase()) ? f.name : f.name.toLowerCase();
  }).join(', ');
}

const FONT_FORMATS = {
  '.woff2': ['font/woff2', 'woff2'],
  '.woff': ['font/woff', 'woff'],
  '.ttf': ['font/ttf', 'truetype'],
  '.otf': ['font/otf', 'opentype'],
};

/** Read a font file into an @font-face rule for `family`. */
function fontFaceRule(family, filePath) {
  const ext = extname(filePath).toLowerCase();
  const format = FONT_FORMATS[ext];
  if (!format) {
    throw new Error(`Unsupported font file ${filePath}: use .woff2, .woff, .ttf or .otf`);
  }
  let data;
  try {
    data = readFileSync(filePath);
  } catch (err) {
    throw new Error(`Cannot read font file ${filePath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`, { cause: err });
  }
  // base64 is [A-Za-z0-9+/=] only, so it is safe inside url().
  const src = `url(data:${format[0]};base64,${data.toString('base64')}) format("${format[1]}")`;
  return `@font-face{font-family:${cssString(family)};src:${src};font-weight:100 900;font-style:normal;font-display:block;}`;
}

// ---------------------------------------------------------------------------
// Card preparation
// ---------------------------------------------------------------------------

function optionalString(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

/**
 * Resolve everything that depends only on the brand (colors, fonts, footer),
 * so a batch does this work once.
 */
function prepareBrand(brand, { fonts = {} } = {}) {
  if (!brand || typeof brand !== 'object') throw new Error('brand must be an object (see loadBrand)');
  const palette = brand.palette ?? {};
  const typography = brand.typography ?? {};
  const warnings = [];

  const bgHex = palette.bg === undefined ? DEFAULT_BG : palette.bg;
  const bgColor = parseHex(bgHex, 'palette.bg');
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const bgSolid = over(bgColor, white); // the viewport behind the card is white

  let fgHex;
  let fgSolid;
  if (palette.fg !== undefined) {
    fgHex = palette.fg;
    fgSolid = over(parseHex(fgHex, 'palette.fg'), bgSolid);
  } else {
    // No text color in the brand: use whichever of near-black and white reads better.
    const dark = parseHex(DARK_TEXT, 'fg');
    const light = parseHex(LIGHT_TEXT, 'fg');
    const useDark = contrastRatio(dark, bgSolid) >= contrastRatio(light, bgSolid);
    fgHex = useDark ? DARK_TEXT : LIGHT_TEXT;
    fgSolid = useDark ? dark : light;
  }
  const contrast = contrastRatio(fgSolid, bgSolid);
  if (contrast < MIN_CONTRAST) {
    warnings.push(
      `text color ${fgHex} on background ${bgHex} has contrast ${contrast.toFixed(2)}:1, below ${MIN_CONTRAST}:1 (WCAG AA). Set palette.fg to a color that reads on palette.bg.`,
    );
  }

  const bodyStack = optionalString(typography.body, 'typography.body');
  const displayStack = optionalString(typography.display, 'typography.display') || bodyStack;
  const body = parseFontStack(bodyStack);
  const display = parseFontStack(displayStack);

  const faces = [];
  const provided = new Set();
  for (const [role, families] of [['display', display], ['body', body]]) {
    const file = fonts?.[role];
    if (file === undefined || file === null || file === '') continue;
    if (typeof file !== 'string') throw new Error(`fonts.${role} must be a font file path`);
    let primary = families.find((f) => !f.generic);
    if (!primary) {
      primary = { name: `atelier ${role}`, generic: false };
      families.unshift(primary);
    }
    faces.push(fontFaceRule(primary.name, resolve(file)));
    provided.add(primary.name);
  }

  // The first named family of each stack is the one the brand intends; check
  // later that the rendering machine actually has it.
  const probe = [];
  for (const families of [display, body]) {
    const primary = families.find((f) => !f.generic);
    if (primary && !provided.has(primary.name) && !probe.some((p) => p.name === primary.name)) {
      probe.push({ name: primary.name, css: cssString(primary.name) });
    }
  }

  const vars = [
    `--bg:${bgHex.toLowerCase()}`,
    `--fg:${fgHex.toLowerCase()}`,
    `--font-display:${fontStackCss(display)}`,
    `--font-body:${fontStackCss(body)}`,
  ];
  const style = `<style>${faces.join('')}:root{${vars.join(';')};}</style>`;

  const studio = optionalString(brand.brand?.studio, 'brand.studio');
  const product = optionalString(brand.brand?.product, 'brand.product');
  return {
    style,
    bg: bgHex,
    fg: fgHex,
    contrast,
    warnings,
    probe,
    studioText: studio ? `${studio} /` : '',
    product,
  };
}

let templateCache = null;
function template() {
  templateCache ??= readTextFile(TEMPLATE_PATH);
  return templateCache;
}

function renderHtml(prepared, page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new Error('page must be an object like { slug, title, subtitle }');
  }
  const slug = optionalString(page.slug, 'page.slug');
  const title = optionalString(page.title, 'page.title') || prepared.product;
  const subtitle = optionalString(page.subtitle, 'page.subtitle') || optionalString(page.description, 'page.description');
  const values = {
    style: prepared.style,
    title: escapeHtml(title),
    subtitle: escapeHtml(subtitle),
    studio: escapeHtml(prepared.studioText),
    slug: escapeHtml(slug ? `/${slug}` : '/'),
  };
  // One pass with a function replacer: `$` patterns in values stay literal and
  // a value that contains `{{title}}` is not substituted again.
  return template().replace(/\{\{(style|title|subtitle|studio|slug)\}\}/g, (_, key) => values[key]);
}

/**
 * Build the card's HTML document without rendering it. Useful for previewing
 * a card in a browser or for tests.
 * @param {object} brand - Brand config (see brand-memory loadBrand).
 * @param {{ slug?: string, title?: string, subtitle?: string, description?: string }} page
 * @param {{ fonts?: { display?: string, body?: string } }} [options]
 * @returns {string}
 */
export function buildCardHtml(brand, page, options = {}) {
  return renderHtml(prepareBrand(brand, options), page);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function newCardContext(browser) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    javaScriptEnabled: false,
  });
  // Defense in depth next to the template's CSP: nothing leaves the page.
  await context.route('**/*', (route) => route.abort());
  return context;
}

/**
 * Runs inside the card page (serialized by page.evaluate), so Node coverage
 * cannot see it; the tests check its effects on the rendered PNG instead.
 * Waits for fonts, then fits the text: the subtitle keeps at most 2 lines, the
 * title steps down from 88px to 48px until it fits in 4 lines above the
 * footer, and anything still too long is shortened with an ellipsis. Also
 * reports brand fonts that failed to load or are not installed.
 */
/* v8 ignore start */
async function settleInPage({ probe, checkFonts, max, min, step, titleLines, subtitleLines }) {
  const faces = [...document.fonts];
  await Promise.allSettled(faces.map((f) => f.load()));
  await document.fonts.ready;

  const title = document.getElementById('title');
  const subtitle = document.getElementById('subtitle');
  const content = document.getElementById('content');
  const ellipsis = String.fromCharCode(0x2026);
  const lines = (el) => {
    const height = el.getBoundingClientRect().height;
    return height === 0 ? 0 : Math.round(height / parseFloat(getComputedStyle(el).lineHeight));
  };
  const used = () => {
    const sub = subtitle.offsetHeight ? subtitle.offsetHeight + parseFloat(getComputedStyle(subtitle).marginTop) : 0;
    return title.offsetHeight + sub;
  };
  // Cut `el` to the longest prefix (by code point) for which ok() holds.
  const shorten = (el, ok) => {
    if (ok()) return false;
    const chars = Array.from(el.textContent);
    const set = (n) => { el.textContent = chars.slice(0, n).join('').trimEnd() + ellipsis; };
    let lo = 0;
    let hi = chars.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      set(mid);
      if (ok()) lo = mid;
      else hi = mid - 1;
    }
    set(lo);
    return true;
  };

  const subtitleShortened = shorten(subtitle, () => lines(subtitle) <= subtitleLines);
  const fits = () => lines(title) <= titleLines && used() <= content.clientHeight;
  let size = max;
  while (!fits() && size > min) {
    size -= step;
    title.style.fontSize = `${size}px`;
  }
  const titleShortened = shorten(title, fits);
  const fit = { titlePx: size, titleShortened, subtitleShortened };

  if (!checkFonts) return { ...fit, failed: [], missing: [] };
  const failed = faces.filter((f) => f.status === 'error').map((f) => f.family.replace(/^"|"$/g, ''));
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli10WQ@#';
  const width = (font) => {
    ctx.font = font;
    return ctx.measureText(sample).width;
  };
  const missing = probe
    .filter((p) => ['monospace', 'serif', 'sans-serif'].every((g) => width(`72px ${p.css}, ${g}`) === width(`72px ${g}`)))
    .map((p) => p.name);
  return { ...fit, failed, missing };
}
/* v8 ignore stop */

function settleCard(browserPage, { probe, checkFonts }) {
  return browserPage.evaluate(
    settleInPage,
    {
      probe,
      checkFonts,
      max: TITLE_MAX_PX,
      min: TITLE_MIN_PX,
      step: TITLE_STEP_PX,
      titleLines: TITLE_MAX_LINES,
      subtitleLines: SUBTITLE_MAX_LINES,
    },
  );
}

async function renderCard(context, prepared, page, outPath, warn) {
  const html = renderHtml(prepared, page);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  const browserPage = await context.newPage();
  try {
    await browserPage.setContent(html, { waitUntil: 'load' });
    const checkFonts = !prepared.fontsChecked;
    const settled = await settleCard(browserPage, { probe: prepared.probe, checkFonts });
    const { failed, missing } = settled;
    const where = `card ${outPath}`;
    if (settled.titleShortened) warn(`${where}: the title is too long for the card and was shortened with an ellipsis.`);
    if (settled.subtitleShortened) warn(`${where}: the subtitle is longer than 2 lines and was shortened with an ellipsis.`);
    if (checkFonts) {
      prepared.fontsChecked = true;
      for (const name of failed) warn(`font file for "${name}" could not be loaded; the card uses a fallback font.`);
      for (const name of missing) {
        warn(`font "${name}" is not installed on this machine and no font file was given, so the card uses a fallback font. Pass a font file (--font-display/--font-body, or the fonts option).`);
      }
    }
    const buf = await browserPage.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    await sharp(buf).png({ compressionLevel: 9 }).toFile(outPath);
  } finally {
    await browserPage.close();
  }
  return outPath;
}

function makeWarn(onWarning) {
  const seen = new Set();
  const sink = typeof onWarning === 'function'
    ? onWarning
    : (message) => process.stderr.write(`atelier: warning: ${message}\n`);
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    sink(message);
  };
}

async function withBrowser(browser, fn) {
  if (browser) return fn(browser);
  const own = await launchChromium();
  try {
    return await fn(own);
  } finally {
    await own.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a single OG card PNG (1200x630) for a brand and page.
 * @param {{
 *   brand: object,
 *   page: { slug?: string, title?: string, subtitle?: string, description?: string },
 *   outPath: string,
 *   fonts?: { display?: string, body?: string },
 *   browser?: import('playwright').Browser,
 *   onWarning?: (message: string) => void,
 * }} opts
 *   fonts: font files (.woff2/.woff/.ttf/.otf) for typography.display/body.
 *   browser: reuse an open Playwright browser (left open); otherwise one is launched and closed.
 *   onWarning: receives contrast and missing-font warnings (default: printed to stderr).
 * @returns {Promise<string>} resolves with outPath
 */
export async function generateCard({ brand, page, outPath, fonts, browser, onWarning } = {}) {
  if (typeof outPath !== 'string' || outPath === '') throw new Error('outPath must be a file path');
  const prepared = prepareBrand(brand, { fonts });
  renderHtml(prepared, page); // validate the page before launching a browser
  const warn = makeWarn(onWarning);
  prepared.warnings.forEach(warn);
  return withBrowser(browser, async (b) => {
    const context = await newCardContext(b);
    try {
      return await renderCard(context, prepared, page, outPath, warn);
    } finally {
      await context.close();
    }
  });
}

// Lowercase letters, digits, '-' and '_', with '/' only between non-empty
// segments for nested output (blog/post). No dots, so no traversal; no ':'
// (an NTFS alternate data stream on Windows); no case-only collisions.
const SLUG_RE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

/**
 * Check a slug and return its output path inside outDir.
 * @returns {string}
 */
function slugOutPath(outDir, slug, index) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(
      `pages[${index}].slug ${JSON.stringify(slug)} is not a safe file name: use lowercase letters, digits, '-' and '_' (with '/' for nested folders)`,
    );
  }
  const outPath = join(outDir, `${slug}.png`);
  const rel = relative(resolve(outDir), resolve(outPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`pages[${index}].slug ${JSON.stringify(slug)} resolves outside ${outDir}`);
  }
  return outPath;
}

/**
 * Batch-render one card per page into outDir as <slug>.png (index.png when a
 * page has no slug). Every slug is checked before anything is written, and one
 * browser renders the whole batch.
 * @param {{
 *   brand: object,
 *   pages: Array<{ slug?: string, title?: string, subtitle?: string, description?: string }>,
 *   outDir: string,
 *   fonts?: { display?: string, body?: string },
 *   browser?: import('playwright').Browser,
 *   onWarning?: (message: string) => void,
 * }} opts
 * @returns {Promise<string[]>} resolves with the output paths, in page order
 */
export async function generateCards({ brand, pages, outDir, fonts, browser, onWarning } = {}) {
  if (!Array.isArray(pages)) throw new Error('pages must be an array of { slug, title, subtitle } objects');
  if (typeof outDir !== 'string' || outDir === '') throw new Error('outDir must be a directory path');
  const prepared = prepareBrand(brand, { fonts });

  const outPaths = [];
  const seen = new Map();
  pages.forEach((page, i) => {
    try {
      renderHtml(prepared, page); // validates the page's fields
    } catch (err) {
      throw new Error(`pages[${i}]: ${err.message}`, { cause: err });
    }
    const slug = page.slug === undefined || page.slug === null || page.slug === '' ? 'index' : page.slug;
    const outPath = slugOutPath(outDir, slug, i);
    const key = resolve(outPath).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`pages[${i}] and pages[${seen.get(key)}] both write ${outPath}; give each page a unique slug`);
    }
    seen.set(key, i);
    outPaths.push(outPath);
  });
  if (pages.length === 0) return [];

  const warn = makeWarn(onWarning);
  prepared.warnings.forEach(warn);
  return withBrowser(browser, async (b) => {
    const context = await newCardContext(b);
    try {
      for (let i = 0; i < pages.length; i += 1) {
        await renderCard(context, prepared, pages[i], outPaths[i], warn);
      }
    } finally {
      await context.close();
    }
    return outPaths;
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  atelier og <pages.json> [outDir] [options]
  atelier og --title <text> [--subtitle <text>] [--slug <slug>] [--out <dir>] [options]

Render 1200x630 Open Graph card PNGs from .atelier/brand.json, one <slug>.png per page.

Arguments:
  pages.json             {"pages": [{"slug", "title", "subtitle"}]} or a bare array of pages
  outDir                 output directory (default: og-cards)

Options:
  --out <dir>            output directory (instead of the outDir argument)
  --title <text>         render one card from flags instead of a manifest
  --subtitle <text>      subtitle for that card
  --slug <slug>          file name and footer path for that card (default: index)
  --project <dir>        project root holding .atelier/brand.json (default: current directory)
  --font-display <file>  font file (.woff2, .woff, .ttf, .otf) for typography.display
  --font-body <file>     font file for typography.body
  -h, --help             show this help

Exit codes: 0 cards written, 2 usage or runtime error.`;

const CLI_OPTIONS = {
  out: { type: 'string' },
  title: { type: 'string' },
  subtitle: { type: 'string' },
  slug: { type: 'string' },
  project: { type: 'string' },
  'font-display': { type: 'string' },
  'font-body': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.title !== undefined) {
    if (positionals.length > 0) {
      throw new UsageError(`--title renders one card without a manifest; give the output directory with --out (unexpected argument: ${positionals[0]})`);
    }
    return { values, manifest: undefined, outDir: values.out ?? 'og-cards' };
  }
  if (values.subtitle !== undefined || values.slug !== undefined) throw new UsageError('--subtitle and --slug need --title');
  if (positionals.length === 0) throw new UsageError('missing pages.json (or --title)');
  if (positionals.length > 2) throw new UsageError(`unexpected argument: ${positionals[2]}`);
  const [manifest, outArg] = positionals;
  if (outArg !== undefined && values.out !== undefined) throw new UsageError('give the output directory once (outDir or --out)');
  return { values, manifest, outDir: outArg ?? values.out ?? 'og-cards' };
}

function pagesFromManifest(path) {
  const manifest = readJsonFile(path);
  const pages = Array.isArray(manifest) ? manifest : manifest?.pages;
  if (!Array.isArray(pages)) {
    throw new Error(`${path}: expected {"pages": [{"slug", "title", "subtitle"}]} or an array of pages`);
  }
  return pages;
}

/**
 * Run the og-card-generator CLI.
 * @param {string[]} argv - Arguments after the script name.
 * @param {{ cwd?: string, stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {Promise<number>} exit code: 0 written, 2 usage or runtime error
 */
export async function runCli(argv, {
  cwd = process.cwd(),
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr(`og-card-generator: ${err.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (cli.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }
  try {
    const { values } = cli;
    const pages = cli.manifest !== undefined
      ? pagesFromManifest(resolve(cwd, cli.manifest))
      : [{ slug: values.slug, title: values.title, subtitle: values.subtitle }];
    const { loadBrand } = await import('../brand-memory/index.mjs');
    const brand = loadBrand(resolve(cwd, values.project ?? '.'));
    const fonts = {
      display: values['font-display'] === undefined ? undefined : resolve(cwd, values['font-display']),
      body: values['font-body'] === undefined ? undefined : resolve(cwd, values['font-body']),
    };
    const outDir = resolve(cwd, cli.outDir);
    const paths = await generateCards({
      brand,
      pages,
      outDir,
      fonts,
      onWarning: (message) => stderr(`atelier: warning: ${message}\n`),
    });
    stdout(`Generated ${paths.length} OG card(s):\n`);
    for (const p of paths) {
      const rel = relative(cwd, p);
      stdout(`  ${rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p}\n`);
    }
    return 0;
  } catch (err) {
    stderr(`${formatError(err)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}

/**
 * brand-asset-pipeline: one SVG mark in, a PNG asset pack out (favicons, app
 * icons, social covers, Steam capsules).
 *
 * Everything is rendered in memory first and written only after every input
 * has been validated and every image has rendered, so a bad argument or a
 * broken mark never leaves a half-written output directory.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { isMain } from '../../lib/cli.mjs';
import { decodeText } from '../../lib/io.mjs';
import { PreflightError, formatError } from '../../lib/preflight.mjs';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const deepFreeze = (obj) => {
  for (const value of Object.values(obj)) if (value && typeof value === 'object') deepFreeze(value);
  return Object.freeze(obj);
};

/**
 * Asset specs per target. Square icons have `size`; banners have `w` and `h`.
 * `opaque: true` icons are flattened onto the background color.
 */
export const PRESETS = deepFreeze({
  favicons: [
    { name: 'favicon-16.png', size: 16 },
    { name: 'favicon-32.png', size: 32 },
    { name: 'favicon-48.png', size: 48 },
    { name: 'favicon-64.png', size: 64 },
    { name: 'favicon-180.png', size: 180 },
  ],
  'app-icons': [
    // iOS does not support transparent home-screen icons, so this one is opaque.
    { name: 'apple-touch-icon.png', size: 180, opaque: true },
    { name: 'android-chrome-192.png', size: 192 },
    { name: 'android-chrome-512.png', size: 512 },
  ],
  social: [
    { name: 'og-cover.png', w: 1200, h: 630 },
    { name: 'twitter-cover.png', w: 1500, h: 500 },
    { name: 'linkedin-cover.png', w: 1584, h: 396 },
  ],
  steam: [
    { name: 'steam-header.png', w: 460, h: 215 },
    { name: 'steam-capsule-main.png', w: 616, h: 353 },
    { name: 'steam-capsule-small.png', w: 231, h: 87 },
  ],
});

const DEFAULT_TARGETS = Object.freeze(['favicons', 'app-icons', 'social']);
const DEFAULT_BACKGROUND = '#110f1b';
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
/** Share of the icon edge the mark fills on the opaque apple-touch-icon. */
const OPAQUE_ICON_MARK_RATIO = 0.8;
/** Share of the banner's short edge the mark fills. */
const BANNER_MARK_RATIO = 0.5;
/** Linked SVG images may nest this deep before we give up. */
const MAX_LINK_DEPTH = 4;
/**
 * Caps on what one mark may pull in through <image> links. Images count every
 * use, so a linked SVG used 30 times counts its own links 30 times: librsvg
 * renders every copy, and fan-out (A links B 30 times, B links C 30 times)
 * would otherwise grow as the product of the link counts.
 */
const MB = 2 ** 20;
const MAX_LINKED_IMAGES = 256;
const MAX_LINKED_FILE_BYTES = 16 * MB;
const MAX_INLINED_BYTES = 32 * MB;

// ---------------------------------------------------------------------------
// Dependency loading
// ---------------------------------------------------------------------------

let sharpPromise;

/** Load sharp lazily so `--help` works and a broken install gets one clear message. */
function loadSharp() {
  sharpPromise ??= import('sharp').then(
    (mod) => mod.default,
    (err) => {
      sharpPromise = undefined;
      const first = String(err?.message ?? err).split('\n')[0];
      throw new PreflightError(`sharp could not be loaded (${first}).`, {
        code: 'SHARP_MISSING',
        fix: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.',
        cause: err,
      });
    },
  );
  return sharpPromise;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const own = (obj, key) =>
  obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined;

/**
 * Parse #rgb, #rgba, #rrggbb or #rrggbbaa (leading # optional) into a sharp color.
 * @param {string} value
 * @param {string} [label] - Name used in the error message.
 * @returns {{ r: number, g: number, b: number, alpha: number }}
 */
function parseHexColor(value, label = 'backgroundColor') {
  const m = typeof value === 'string' ? /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim()) : null;
  if (!m) {
    throw new Error(`Invalid ${label} ${JSON.stringify(value)}: use a hex color #rgb, #rgba, #rrggbb or #rrggbbaa.`);
  }
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  const byte = (i) => parseInt(hex.slice(i, i + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), alpha: hex.length === 8 ? byte(6) / 255 : 1 };
}

/**
 * Validate a target list and drop duplicates. Throws before anything is written.
 * @param {unknown} targets
 * @returns {string[]}
 */
function resolveTargets(targets) {
  const valid = Object.keys(PRESETS).join(', ');
  if (!Array.isArray(targets)) {
    throw new TypeError(`targets must be an array of preset names (${valid}).`);
  }
  if (targets.length === 0) throw new Error(`targets is empty. Valid targets: ${valid}.`);
  const unknown = targets.filter((t) => typeof t !== 'string' || !Object.hasOwn(PRESETS, t));
  if (unknown.length > 0) {
    const list = unknown.map((t) => JSON.stringify(t) ?? String(t)).join(', ');
    throw new Error(`Unknown target${unknown.length > 1 ? 's' : ''} ${list}. Valid targets: ${valid}.`);
  }
  return [...new Set(targets)];
}

// ---------------------------------------------------------------------------
// Brand defaults (.atelier/brand.json)
// ---------------------------------------------------------------------------

async function loadBrandFile(projectRoot) {
  const { loadBrand } = await import('../brand-memory/index.mjs');
  return await loadBrand(projectRoot);
}

/** Default targets, plus `steam` when brand.deploy.stores lists it. */
function brandTargets(brand) {
  const stores = own(own(brand, 'deploy'), 'stores');
  return Array.isArray(stores) && stores.includes('steam') ? [...DEFAULT_TARGETS, 'steam'] : [...DEFAULT_TARGETS];
}

function brandBackground(brand) {
  const bg = own(own(brand, 'palette'), 'bg');
  return typeof bg === 'string' ? bg : undefined;
}

/**
 * \\host\share, //host/share and the \\?\ and \\.\ device namespaces. On
 * Windows, opening one of these (even a stat) connects over SMB and sends the
 * user's credentials to that host.
 */
const isNetworkPath = (p) => /^[\\/]{2}/.test(p);

/**
 * logos.mark from brand.json, resolved inside the project root. brand.json is
 * repository content, so an absolute, drive, network or ../ path is refused
 * before anything is opened. A mark elsewhere can still be passed explicitly.
 */
function brandMark(brand, base) {
  const mark = own(own(brand, 'logos'), 'mark');
  if (typeof mark !== 'string' || mark.trim() === '') return undefined;
  const root = resolve(base);
  const refuse = () =>
    new Error(
      `brand.json logos.mark ${JSON.stringify(mark)} must be a relative path to a file inside the project root ${root}. Pass the mark file explicitly to use one elsewhere.`,
    );
  // /^[a-z]:/ also catches the drive-relative "C:mark.svg", which isAbsolute misses.
  if (isAbsolute(mark) || /^[\\/]/.test(mark) || /^[a-z]:/i.test(mark)) throw refuse();
  const target = resolve(root, mark);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse();
  return target;
}

// ---------------------------------------------------------------------------
// Reading the mark
// ---------------------------------------------------------------------------

/** Raster formats sharp reads directly, by magic bytes. */
function rasterType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Decode SVG bytes to a string. Handles UTF-8 and UTF-16 with a BOM (via
 * lib/io decodeText), BOM-less UTF-16 (detected by the NUL byte pattern of
 * ASCII markup), and single-byte encodings declared in the XML prolog.
 */
function decodeSvgText(buf) {
  const hasBom = (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    || (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (!hasBom && buf.length >= 2) {
    const even = buf.subarray(0, buf.length - (buf.length % 2));
    if (buf[0] !== 0 && buf[1] === 0) return even.toString('utf16le');
    if (buf[0] === 0 && buf[1] !== 0) return Buffer.from(even).swap16().toString('utf16le');
    const decl = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(buf.toString('latin1', 0, 200));
    if (decl && /^(iso-8859-1|iso8859-1|latin-?1|windows-1252|cp1252)$/i.test(decl[1])) return buf.toString('latin1');
  }
  return decodeText(buf);
}

/** The text is re-encoded as UTF-8, so a declared encoding would now be wrong. */
const dropXmlEncoding = (text) => text.replace(/^(\s*<\?xml\b[^>]*?)\s+encoding\s*=\s*(["'])[^"']*\2/i, '$1');

const looksLikeSvg = (text) => /<svg[\s>]/i.test(text);

/** Identity of a file for link-cycle detection; case-insensitive where the filesystem usually is. */
const pathKey = (p) =>
  process.platform === 'win32' || process.platform === 'darwin' ? resolve(p).toLowerCase() : resolve(p);

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXmlEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ent) => {
    if (ent[0] !== '#') return XML_ENTITIES[ent.toLowerCase()];
    const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/**
 * <image> and <feImage> tags. Comments and CDATA sections come first, so an
 * <image> inside one is consumed by that match and left alone, as librsvg does.
 */
const IMAGE_TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[\w.-]+:)?(?:image|feImage)\b[^>]*>/gi;
const HREF_ATTR = /(\s(?:xlink:)?href\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
/** Data URI image types librsvg renders itself. Others (WebP, GIF, ...) render blank. */
const RSVG_DATA_TYPES = /^image\/(png|jpe?g|svg\+xml)$/i;

async function toPngDataUri(sharp, buf) {
  const type = rasterType(buf);
  const out = type === 'png' || type === 'jpeg' ? buf : await sharp(buf).png().toBuffer();
  return `data:image/${type === 'jpeg' ? 'jpeg' : 'png'};base64,${out.toString('base64')}`;
}

/**
 * Link state for one mark: a cache of embedded files by path, and running
 * totals of images and embedded bytes, checked against the caps above.
 * @param {string} mark
 */
const newLinkState = (mark) => ({ mark, cache: new Map(), images: 0, bytes: 0 });

/** Add one use of an embedded image to the totals, or throw past a cap. */
function charge(state, { uri, images }) {
  state.images += images;
  state.bytes += uri.length;
  if (state.images > MAX_LINKED_IMAGES) {
    throw new Error(
      `${state.mark} expands to more than ${MAX_LINKED_IMAGES} linked images (each repeat of a linked SVG counts its own links again). Flatten it into one SVG.`,
    );
  }
  if (state.bytes > MAX_INLINED_BYTES) {
    throw new Error(`${state.mark}: linked images add more than ${MAX_INLINED_BYTES / MB} MB to the mark. Flatten it or use smaller images.`);
  }
  return uri;
}

/**
 * The local file an <image> href points to. Remote, network and device links
 * are refused before any filesystem call: atelier makes no network calls, and
 * on Windows even a stat of \\host\share connects to that host.
 */
function linkTarget(href, fromFile) {
  const networkPath = () =>
    new Error(
      `${fromFile} links to a network or device path (${href}). atelier makes no network calls: copy the image next to the SVG and link it by a relative path.`,
    );
  if (isNetworkPath(href)) throw networkPath();
  if (/^[a-z]:[\\/]/i.test(href)) return href;

  let url;
  try {
    url = new URL(href, pathToFileURL(fromFile));
  } catch {
    throw new Error(`${fromFile}: cannot resolve image link ${JSON.stringify(href)}.`);
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    throw new Error(
      `${fromFile} links to a remote image (${href}). atelier makes no network calls: download the image and link it by a local path, or embed it in the SVG.`,
    );
  }
  if (url.protocol !== 'file:') throw new Error(`${fromFile}: unsupported image link ${JSON.stringify(href)}.`);
  // file://host/share/x.png, /\host\share and \/host become \\host\share\x.png on Windows.
  if (url.host !== '') throw networkPath();
  let target;
  try {
    target = fileURLToPath(url);
  } catch (err) {
    throw new Error(`${fromFile}: cannot resolve image link ${JSON.stringify(href)} (${err.message}).`, { cause: err });
  }
  if (isNetworkPath(target)) throw networkPath();
  return target;
}

/** Read a linked file, which must be a regular file no larger than MAX_LINKED_FILE_BYTES. */
function readLinkedFile(target, href, fromFile) {
  try {
    const st = statSync(target);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > MAX_LINKED_FILE_BYTES) throw new Error(`larger than ${MAX_LINKED_FILE_BYTES / MB} MB`);
    return readFileSync(target);
  } catch (err) {
    throw new Error(
      `${fromFile} links to ${JSON.stringify(href)}, which cannot be read (${err.code === 'ENOENT' ? 'file not found' : err.message}).`,
      { cause: err },
    );
  }
}

/**
 * Turn one <image> href into a self-contained data URI, or return null to
 * leave it unchanged. librsvg cannot resolve links from an in-memory SVG and
 * silently drops links outside the SVG's folder, so every local link is
 * embedded here. Remote, network and device links are refused.
 */
async function resolveImageHref(sharp, href, fromFile, chain, state) {
  if (href === '' || href.startsWith('#')) return null;

  if (/^data:/i.test(href)) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(href);
    if (!m || RSVG_DATA_TYPES.test(m[1]) || !/;base64/i.test(m[2])) return null;
    let uri;
    try {
      uri = await toPngDataUri(sharp, Buffer.from(m[3], 'base64'));
    } catch {
      return null;
    }
    return charge(state, { uri, images: 0 });
  }

  const target = linkTarget(href, fromFile);
  const key = pathKey(target);
  if (chain.includes(key)) throw new Error(`${fromFile}: SVG image links form a cycle through ${target}.`);
  const cached = state.cache.get(key);
  if (cached !== undefined) return charge(state, cached);

  const buf = readLinkedFile(target, href, fromFile);
  let entry;
  if (!rasterType(buf)) {
    const text = decodeSvgText(buf);
    if (looksLikeSvg(text)) {
      if (chain.length >= MAX_LINK_DEPTH) throw new Error(`${fromFile}: SVG image links nest deeper than ${MAX_LINK_DEPTH} levels.`);
      const before = { images: state.images, bytes: state.bytes };
      const inner = await inlineLinkedImages(sharp, dropXmlEncoding(text), target, [...chain, key], state);
      // The nested links were charged while inlining. Undo that and charge the
      // whole expanded SVG below, on this use and on every cached reuse.
      const nested = state.images - before.images;
      state.images = before.images;
      state.bytes = before.bytes;
      entry = { uri: `data:image/svg+xml;base64,${Buffer.from(inner, 'utf8').toString('base64')}`, images: 1 + nested };
    }
  }
  if (entry === undefined) {
    try {
      entry = { uri: await toPngDataUri(sharp, buf), images: 1 };
    } catch (err) {
      throw new Error(`${fromFile} links to ${JSON.stringify(href)}, which is not a supported image (${err.message}).`, { cause: err });
    }
  }
  state.cache.set(key, entry);
  return charge(state, entry);
}

/** Replace every local <image>/<feImage> link in `text` with an embedded data URI. */
async function inlineLinkedImages(sharp, text, fromFile, chain, state) {
  let out = '';
  let last = 0;
  for (const tag of text.matchAll(IMAGE_TAG)) {
    // A comment or CDATA section: librsvg ignores the tags inside, so keep it verbatim.
    if (tag[0].startsWith('<!')) continue;
    let rewritten = '';
    let tagLast = 0;
    for (const attr of tag[0].matchAll(HREF_ATTR)) {
      const raw = attr[2] ?? attr[3];
      const replacement = await resolveImageHref(sharp, decodeXmlEntities(raw.trim()), fromFile, chain, state);
      if (replacement === null) continue;
      rewritten += tag[0].slice(tagLast, attr.index) + `${attr[1]}"${replacement}"`;
      tagLast = attr.index + attr[0].length;
    }
    out += text.slice(last, tag.index) + rewritten + tag[0].slice(tagLast);
    last = tag.index + tag[0].length;
  }
  return out + text.slice(last);
}

/**
 * Read the mark into a self-contained, UTF-8 SVG buffer (or a raster buffer)
 * and measure its intrinsic size.
 * @returns {Promise<{ path: string, input: Buffer, isSvg: boolean, longSide: number }>}
 */
async function loadMark(sharp, markPath) {
  let buf;
  try {
    buf = readFileSync(markPath);
  } catch (err) {
    throw new Error(`Cannot read mark ${markPath}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`, { cause: err });
  }

  let input = buf;
  let isSvg = false;
  if (!rasterType(buf)) {
    const text = decodeSvgText(buf);
    if (looksLikeSvg(text)) {
      const key = pathKey(markPath);
      const inlined = await inlineLinkedImages(sharp, dropXmlEncoding(text), markPath, [key], newLinkState(markPath));
      input = Buffer.from(inlined, 'utf8');
      isSvg = true;
    }
  }

  let meta;
  try {
    // metadata() does not rasterize, so the pixel limit can be lifted for huge canvases.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch (err) {
    throw new Error(`${markPath} is not a valid SVG or supported image: ${err.message}`, { cause: err });
  }
  return { path: markPath, input, isSvg, longSide: Math.max(meta.width || 0, meta.height || 0, 1) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * SVG density that rasterizes the mark at about twice the box size. A fixed
 * high density pushes large canvases (3072 px and up) past sharp's pixel
 * limit; a fixed low one makes small viewBoxes blurry.
 */
function densityFor(mark, boxPx) {
  return Math.min(100_000, Math.max(1, (72 * 2 * boxPx) / mark.longSide));
}

/**
 * Fit the mark inside a transparent w x h box. A raster mark is turned upright
 * by its EXIF orientation first, as image viewers show it.
 */
async function renderMark(sharp, mark, w, h) {
  try {
    const img = mark.isSvg
      ? sharp(mark.input, { density: densityFor(mark, Math.max(w, h)) })
      : sharp(mark.input, { autoOrient: true });
    return await img.resize(w, h, { fit: 'contain', background: TRANSPARENT }).png().toBuffer();
  } catch (err) {
    throw new Error(`Cannot render ${mark.path} at ${w}x${h}: ${err.message}`, { cause: err });
  }
}

/** A mark that renders as nothing would produce blank icons; fail loudly instead. */
async function assertVisible(sharp, mark) {
  const { channels } = await sharp(await renderMark(sharp, mark, 256, 256)).stats();
  if (channels.length === 4 && channels[3].max === 0) {
    throw new Error(
      `${mark.path} renders as a fully transparent image. Check that it has visible fills or strokes and that any linked images exist.`,
    );
  }
}

async function makeSquareIcon(sharp, mark, size) {
  return renderMark(sharp, mark, size, size);
}

/** Mark centred at 80% on an opaque background, with no alpha channel. */
async function makeOpaqueIcon(sharp, mark, size, bg) {
  const inner = Math.round(size * OPAQUE_ICON_MARK_RATIO);
  const markBuf = await renderMark(sharp, mark, inner, inner);
  const solid = { r: bg.r, g: bg.g, b: bg.b };
  const composed = await sharp({ create: { width: size, height: size, channels: 4, background: { ...solid, alpha: 1 } } })
    .composite([{ input: markBuf, gravity: 'centre' }])
    .png()
    .toBuffer();
  return sharp(composed).flatten({ background: solid }).png().toBuffer();
}

/** Mark centred at 50% of the short edge on the background color. */
async function makeBanner(sharp, mark, w, h, bg) {
  const markSize = Math.round(Math.min(w, h) * BANNER_MARK_RATIO);
  const markBuf = await renderMark(sharp, mark, markSize, markSize);
  return sharp({ create: { width: w, height: h, channels: 4, background: bg } })
    .composite([{ input: markBuf, gravity: 'centre' }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate brand assets from a single SVG mark.
 *
 * Brand defaults: pass `brand` (as returned by loadBrand) or `projectRoot`
 * (reads <projectRoot>/.atelier/brand.json). Then `targets` defaults to
 * favicons, app-icons and social plus steam when deploy.stores lists steam,
 * `backgroundColor` defaults to palette.bg, and `markSvg` defaults to
 * logos.mark resolved against projectRoot (or the working directory). That
 * logos.mark must be a relative path inside the root; pass `markSvg` to use a
 * file elsewhere. Explicit options always win.
 *
 * @param {{
 *   markSvg?: string,
 *   outDir: string,
 *   targets?: string[],
 *   backgroundColor?: string,
 *   brand?: object,
 *   projectRoot?: string,
 * }} opts
 * @returns {Promise<{ files: string[], targets: string[], backgroundColor: string }>}
 */
export async function generateAssets({ markSvg, outDir, targets, backgroundColor, brand, projectRoot } = {}) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new TypeError('outDir is required: the directory to write the assets into.');
  }
  if (brand != null && (typeof brand !== 'object' || Array.isArray(brand))) {
    throw new TypeError('brand must be an object, as returned by loadBrand().');
  }
  if (projectRoot != null && typeof projectRoot !== 'string') {
    throw new TypeError('projectRoot must be a directory path.');
  }

  const cfg = brand ?? (projectRoot != null ? await loadBrandFile(projectRoot) : undefined);
  const selected = resolveTargets(targets ?? brandTargets(cfg));
  const bgFromBrand = backgroundColor == null ? brandBackground(cfg) : undefined;
  const bgString = backgroundColor ?? bgFromBrand ?? DEFAULT_BACKGROUND;
  const bg = parseHexColor(bgString, bgFromBrand !== undefined ? 'brand palette.bg' : 'backgroundColor');

  const markPath = markSvg ?? brandMark(cfg, projectRoot ?? process.cwd());
  if (typeof markPath !== 'string' || markPath.trim() === '') {
    throw new TypeError('markSvg is required: the path to the SVG mark (or set logos.mark in brand.json).');
  }

  const sharp = await loadSharp();
  const mark = await loadMark(sharp, markPath);
  await assertVisible(sharp, mark);

  const outputs = [];
  for (const target of selected) {
    for (const spec of PRESETS[target]) {
      let buf;
      if (spec.size === undefined) buf = await makeBanner(sharp, mark, spec.w, spec.h, bg);
      else if (spec.opaque) buf = await makeOpaqueIcon(sharp, mark, spec.size, bg);
      else buf = await makeSquareIcon(sharp, mark, spec.size);
      outputs.push({ path: join(outDir, spec.name), buf });
    }
  }

  mkdirSync(outDir, { recursive: true });
  for (const { path, buf } of outputs) writeFileSync(path, buf);
  return { files: outputs.map((o) => o.path), targets: selected, backgroundColor: bgString };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: atelier assets [<mark.svg>] --out <dir> [options]

Render one SVG mark into PNG favicons, app icons, social covers and Steam capsules.

Options:
  -o, --out <dir>        Output directory (required). Created if missing.
  -t, --targets <list>   Comma-separated presets: ${Object.keys(PRESETS).join(', ')}.
                         Default: favicons,app-icons,social, plus steam when
                         brand.json deploy.stores lists steam.
      --bg <hex>         Background of the banners and apple-touch-icon:
                         #rgb, #rgba, #rrggbb or #rrggbbaa (the # is optional).
                         Default: brand.json palette.bg, else ${DEFAULT_BACKGROUND}.
      --root <dir>       Project root. Reads <dir>/.atelier/brand.json for the
                         defaults above; its logos.mark (a relative path
                         inside <dir>) is used when <mark.svg> is omitted.
      --json             Print the result as JSON.
  -h, --help             Show this help.

Exit codes: 0 assets written, 2 usage error or failure.`;

/** Accept a plain path or a file: URL for the mark. */
function markArg(value) {
  if (/^file:/i.test(value)) return fileURLToPath(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error(`The mark must be a local file; atelier does not download ${value}.`);
  }
  return resolve(value);
}

/**
 * Run the CLI. Returns the exit code instead of exiting.
 * @param {string[]} [argv]
 * @param {{ stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {Promise<number>}
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const usageError = (message) => {
    stderr.write(`atelier: ${message}\n\n${USAGE}\n`);
    return 2;
  };

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string', short: 'o' },
        targets: { type: 'string', short: 't' },
        bg: { type: 'string' },
        root: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    return usageError(err.message);
  }

  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length > 1) return usageError(`expected one mark file, got ${positionals.length}: ${positionals.join(' ')}`);
  if (!values.out) return usageError('--out <dir> is required.');
  if (positionals.length === 0 && values.root === undefined) {
    return usageError('pass the mark SVG path, or --root <dir> with logos.mark set in brand.json.');
  }

  let targets;
  let markSvg;
  try {
    if (values.targets !== undefined) {
      targets = resolveTargets(values.targets.split(',').map((t) => t.trim()).filter(Boolean));
    }
    if (values.bg !== undefined) parseHexColor(values.bg, '--bg');
    if (positionals.length === 1) markSvg = markArg(positionals[0]);
  } catch (err) {
    return usageError(err.message);
  }

  try {
    const outDir = resolve(values.out);
    const result = await generateAssets({
      markSvg,
      outDir,
      targets,
      backgroundColor: values.bg,
      projectRoot: values.root !== undefined ? resolve(values.root) : undefined,
    });
    if (values.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const lines = result.files.map((f) => `  ${basename(f)}`).join('\n');
      stdout.write(
        `Wrote ${result.files.length} files to ${outDir} (targets: ${result.targets.join(', ')}; background ${result.backgroundColor})\n${lines}\n`,
      );
    }
    return 0;
  } catch (err) {
    stderr.write(`${formatError(err)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await runCli();
}

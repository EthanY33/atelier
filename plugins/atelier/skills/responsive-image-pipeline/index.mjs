/**
 * responsive-image-pipeline: turn a source image into AVIF/WebP variants at
 * several widths (never upscaled), a fallback raster for <img src>, and a tiny
 * LQIP placeholder, then build a <picture> snippet whose srcset matches the
 * files that were actually written.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isMain } from '../../lib/cli.mjs';
import { readJsonFile, readTextFile } from '../../lib/io.mjs';
import { PreflightError, formatError } from '../../lib/preflight.mjs';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Bump whenever a change here alters output bytes: it invalidates every cache. */
const PIPELINE_VERSION = 2;

const DEFAULT_WIDTHS = Object.freeze([480, 768, 1280, 1920]);
const DEFAULT_FORMATS = Object.freeze(['avif', 'webp']);
const DEFAULT_QUALITY = Object.freeze({ avif: 60, webp: 78, jpg: 80 });
const AVIF_EFFORT = 4;
const LQIP_QUALITY = 40;
const MAX_WIDTH = 16384;

const FORMATS = {
  avif: { mime: 'image/avif' },
  webp: { mime: 'image/webp' },
  jpg: { mime: 'image/jpeg' },
  png: { mime: 'image/png' },
};

/** Extensions picked up when a folder is passed to the CLI. */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tif', '.tiff']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sharpModule;

/** Load sharp on first use, turning a broken install into one actionable error. */
async function loadSharp() {
  if (!sharpModule) {
    try {
      const mod = await import('sharp');
      sharpModule = mod.default ?? mod;
    } catch (err) {
      throw new PreflightError(`sharp (the image library) failed to load: ${String(err?.message ?? err).split('\n')[0]}`, {
        code: 'SHARP_MISSING',
        fix: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.',
        cause: err,
      });
    }
  }
  return sharpModule;
}

/** Filename without its extension. */
function stem(filePath) {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Real path when it exists, so junctions and symlinks compare equal. */
function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Accept a path, a file: URL string, or a URL object. */
function toPath(p, label) {
  if (p instanceof URL) return fileURLToPath(p);
  if (typeof p !== 'string' || p === '') throw new TypeError(`${label} must be a file path`);
  return /^file:/i.test(p) ? fileURLToPath(p) : p;
}

/** HTML-escape a string for use in a double-quoted attribute value. */
function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Characters left as-is in URLs. File names lose `,` `?` `#` so a name can
// never split a srcset candidate or start a query or fragment.
const NAME_SAFE = /^[A-Za-z0-9\-._~!$&'()*+;=:@/]$/;
const BASE_SAFE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?#[\]]$/;

/** Percent-encode everything outside `keep` (whitespace, quotes, non-ASCII...). */
function encodeUrl(s, keep) {
  const str = String(s);
  let out = '';
  for (let i = 0; i < str.length;) {
    const ch = String.fromCodePoint(str.codePointAt(i));
    i += ch.length;
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(str.slice(i, i + 2))) out += ch;
    else if (keep.test(ch)) out += ch;
    else {
      try {
        out += encodeURIComponent(ch);
      } catch {
        out += '%EF%BF%BD'; // lone surrogate
      }
    }
  }
  return out;
}

/** Validate and normalize a width list: positive integers, deduped, ascending. */
function toWidths(value, label = 'widths') {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array of positive integers`);
  }
  const out = value.map((w) => {
    const n = typeof w === 'string' && w.trim() !== '' ? Number(w) : w;
    if (!Number.isInteger(n) || n < 1 || n > MAX_WIDTH) {
      throw new TypeError(`${label}: ${JSON.stringify(w)} is not a whole number of pixels between 1 and ${MAX_WIDTH}`);
    }
    return n;
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

const normFormat = (f) => {
  const s = String(f).trim().toLowerCase();
  return s === 'jpeg' ? 'jpg' : s;
};

/** Validate and normalize a format list, keeping the caller's order. */
function toFormats(value, label = 'formats') {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array, e.g. ['avif', 'webp']`);
  }
  const out = [];
  for (const f of value) {
    const n = normFormat(f);
    if (!Object.hasOwn(FORMATS, n)) throw new TypeError(`${label}: unsupported format ${JSON.stringify(f)} (use avif, webp, jpg or png)`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Normalize the fallback option to 'auto', a format, or false. */
function toFallback(value) {
  if (value === false || value === 'none') return false;
  if (value === true || value === undefined || value === null || value === 'auto') return 'auto';
  const n = normFormat(value);
  if (!Object.hasOwn(FORMATS, n)) throw new TypeError(`fallback: unsupported value ${JSON.stringify(value)} (use auto, jpg, png, webp, avif or none)`);
  return n;
}

function toQuality(value) {
  if (value == null) return { ...DEFAULT_QUALITY };
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('quality must be an object like { avif: 60, webp: 78, jpg: 80 }');
  const out = { ...DEFAULT_QUALITY };
  for (const [k, v] of Object.entries(value)) {
    const f = normFormat(k);
    if (!Object.hasOwn(DEFAULT_QUALITY, f)) throw new TypeError(`quality: unknown key ${JSON.stringify(k)} (use avif, webp or jpg)`);
    if (!Number.isInteger(v) || v < 1 || v > 100) throw new TypeError(`quality.${k} must be a whole number from 1 to 100`);
    out[f] = v;
  }
  return out;
}

function toPositiveInt(value, label) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > MAX_WIDTH) throw new TypeError(`${label} must be a whole number of pixels between 1 and ${MAX_WIDTH}`);
  return n;
}

/** Output names become file names inside outDir, so they cannot carry a path. */
function checkName(name) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) {
    throw new TypeError(`name must be a plain file name without path separators (got ${JSON.stringify(name)})`);
  }
  return name;
}

function readImageFile(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.code === 'EISDIR' ? 'it is a folder' : err.message;
    throw new Error(`Cannot read ${path}: ${why}`, { cause: err });
  }
}

/** The previous run's manifest, or null when missing, unreadable, or pre-1.0. */
function readCache(cachePath) {
  if (!existsSync(cachePath)) return null;
  try {
    const data = readJsonFile(cachePath);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function encode(pipeline, format, { quality, hasAlpha, background }) {
  switch (format) {
    case 'avif':
      return pipeline.avif({ quality: quality.avif, effort: AVIF_EFFORT });
    case 'webp':
      return pipeline.webp({ quality: quality.webp });
    case 'jpg':
      // JPEG has no alpha channel: flatten onto `background` rather than black.
      return (hasAlpha ? pipeline.flatten({ background }) : pipeline).jpeg({ quality: quality.jpg, mozjpeg: true });
    default:
      return pipeline.png();
  }
}

/** Shape the public result from a manifest (fresh or cached). */
function toResult({ cached, outDir, input, name, lqip, manifest }) {
  const at = (file) => join(outDir, file);
  return {
    cached,
    variants: manifest.images.filter((i) => i.role === 'variant').map((i) => at(i.file)),
    lqip,
    basename: name,
    widths: [...manifest.widths],
    skippedWidths: [...manifest.skippedWidths],
    formats: [...manifest.formats],
    fallback: manifest.fallbackFile ? at(manifest.fallbackFile) : null,
    fallbackFormat: manifest.fallbackFormat,
    lqipPath: at(`${name}-lqip.txt`),
    source: { path: input, ...manifest.source },
    images: manifest.images.map(({ file, format, width, height }) => ({ path: at(file), format, width, height })),
  };
}

const isPlainFile = (f) => typeof f === 'string' && f !== '' && !/[\\/]/.test(f);

function isValidManifest(m) {
  return (
    m &&
    Array.isArray(m.widths) &&
    Array.isArray(m.skippedWidths) &&
    Array.isArray(m.formats) &&
    Array.isArray(m.images) &&
    m.images.every((i) => i && isPlainFile(i.file)) &&
    (m.fallbackFile === null || isPlainFile(m.fallbackFile)) &&
    m.source &&
    typeof m.source === 'object'
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process a source image into responsive variants plus an LQIP placeholder.
 *
 * EXIF orientation is applied before resizing. Requested widths larger than
 * the (oriented) source are skipped, and the source width is added as the top
 * size instead, so every file is exactly as wide as its name says. Outputs are
 * cached: a rerun with the same input bytes and options, whose files all still
 * exist, does no work.
 *
 * @param {{
 *   input: string | URL,
 *   outDir: string,
 *   widths?: number[],
 *   lqipWidth?: number,
 *   formats?: Array<'avif'|'webp'|'jpg'|'png'>,
 *   fallback?: 'auto'|'jpg'|'png'|'webp'|'avif'|false,
 *   quality?: { avif?: number, webp?: number, jpg?: number },
 *   background?: string,
 *   name?: string,
 * }} opts
 *   formats: <source> formats, best first (default ['avif', 'webp']).
 *   fallback: format of the <img src> file at the largest width. 'auto' (default)
 *     picks png for transparent, PNG or GIF sources and jpg otherwise. false skips it.
 *   quality: encoder quality per format (defaults avif 60, webp 78, jpg 80).
 *   background: color that transparent pixels are flattened onto for JPEG output.
 *   name: output file stem (default: the input file name without extension).
 * @returns {Promise<{
 *   cached: boolean, variants: string[], lqip: string, basename: string,
 *   widths: number[], skippedWidths: number[], formats: string[],
 *   fallback: string|null, fallbackFormat: string|null, lqipPath: string,
 *   source: { path: string, format: string, width: number, height: number, transparent: boolean },
 *   images: Array<{ path: string, format: string, width: number, height: number }>,
 * }>}
 */
export async function processImage({
  input,
  outDir,
  widths = DEFAULT_WIDTHS,
  lqipWidth = 24,
  formats = DEFAULT_FORMATS,
  fallback = 'auto',
  quality,
  background = '#ffffff',
  name,
} = {}) {
  input = toPath(input, 'input');
  if (typeof outDir !== 'string' || outDir === '') throw new TypeError('outDir must be a folder path');
  const requested = toWidths(widths);
  const fmts = toFormats(formats);
  const fallbackOpt = toFallback(fallback);
  const q = toQuality(quality);
  const lqipW = toPositiveInt(lqipWidth, 'lqipWidth');
  name = checkName(name ?? stem(input));
  if (typeof background !== 'string') throw new TypeError('background must be a CSS color string');

  const sharp = await loadSharp();
  sharp().flatten({ background }); // throws "Unable to parse color" now, not mid-run

  const inputBuf = readImageFile(input);
  const img = sharp(inputBuf, { autoOrient: true });
  let meta;
  try {
    meta = await img.metadata(); // header only; cheap enough to run before the cache check
  } catch (err) {
    throw new Error(`Cannot decode ${input}: ${err.message}`, { cause: err });
  }
  const srcW = meta.autoOrient?.width ?? meta.width;
  const srcH = meta.autoOrient?.height ?? meta.height;
  if (!srcW || !srcH) throw new Error(`Cannot read the dimensions of ${input}`);

  mkdirSync(outDir, { recursive: true });
  const inputReal = real(input);
  const outReal = real(outDir);
  const sourceRel = relative(outReal, inputReal).split(sep).join('/');
  const cachePath = join(outDir, `${name}.cache`);
  const lqipFile = `${name}-lqip.txt`;
  const lqipPath = join(outDir, lqipFile);

  // Two different sources must not share one output name.
  const prev = readCache(cachePath);
  if (prev && typeof prev.source === 'string' && !samePath(prev.source, sourceRel)) {
    const other = resolve(outReal, prev.source);
    if (existsSync(other) && !samePath(real(other), inputReal)) {
      throw new Error(
        `Output name "${name}" in ${outDir} already belongs to ${other}; processing ${input} would overwrite its files. ` +
          'Pass a different name (CLI: --name) or output folder.',
      );
    }
  }

  const settings = {
    pipeline: PIPELINE_VERSION,
    sharp: sharp.versions?.sharp ?? null,
    vips: sharp.versions?.vips ?? null,
    name,
    widths: requested,
    formats: fmts,
    fallback: fallbackOpt,
    lqipWidth: lqipW,
    lqipQuality: LQIP_QUALITY,
    quality: q,
    avifEffort: AVIF_EFFORT,
    background,
  };
  const key = createHash('sha256').update(inputBuf).update('\0').update(JSON.stringify(settings)).digest('hex');

  if (
    prev &&
    prev.pipeline === PIPELINE_VERSION &&
    prev.key === key &&
    isValidManifest(prev.manifest) &&
    [...prev.manifest.images.map((i) => i.file), lqipFile].every((f) => existsSync(join(outDir, f)))
  ) {
    try {
      const lqip = readTextFile(lqipPath).trim();
      if (lqip.startsWith('data:image/')) {
        return toResult({ cached: true, outDir, input, name, lqip, manifest: prev.manifest });
      }
    } catch {
      // unreadable placeholder: regenerate below
    }
  }

  // Regenerate. Drop the old manifest first so a failed run is never a cache hit.
  rmSync(cachePath, { force: true });

  const hasAlpha = Boolean(meta.hasAlpha);
  const transparent = hasAlpha && !(await img.clone().stats()).isOpaque;

  // Never upscale: drop widths above the source and use the source width instead.
  const produce = requested.filter((w) => w <= srcW);
  const skippedWidths = requested.filter((w) => w > srcW);
  if (skippedWidths.length > 0 && !produce.includes(srcW)) produce.push(srcW);

  let fallbackFormat = null;
  let fallbackFile = null;
  const top = produce[produce.length - 1];
  if (fallbackOpt !== false) {
    fallbackFormat = fallbackOpt === 'auto'
      ? (transparent || meta.format === 'png' || meta.format === 'gif' ? 'png' : 'jpg')
      : fallbackOpt;
    fallbackFile = `${name}-${top}.${fallbackFormat}`;
  }

  const plan = [];
  for (const w of produce) for (const f of fmts) plan.push({ file: `${name}-${w}.${f}`, format: f, width: w, role: 'variant' });
  if (fallbackFile && !fmts.includes(fallbackFormat)) {
    plan.push({ file: fallbackFile, format: fallbackFormat, width: top, role: 'fallback' });
  }

  // Never overwrite the source itself (possible with a custom name).
  for (const p of [...plan.map((x) => x.file), lqipFile, `${name}.cache`]) {
    if (samePath(resolve(outReal, p), inputReal)) {
      throw new Error(`Output ${p} would overwrite the source image ${input}. Pass a different name or output folder.`);
    }
  }

  const enc = { quality: q, hasAlpha, background };
  const images = [];
  for (const w of produce) {
    const resized = img.clone().resize({ width: w, withoutEnlargement: true });
    const jobs = plan.filter((x) => x.width === w);
    const infos = await Promise.all(jobs.map((x) => encode(resized.clone(), x.format, enc).toFile(join(outDir, x.file))));
    jobs.forEach((x, i) => images.push({ file: x.file, format: x.format, width: infos[i].width, height: infos[i].height, role: x.role }));
  }

  // LQIP: keep alpha (WebP) for transparent sources, otherwise a tiny JPEG.
  const small = img.clone().resize({ width: Math.min(lqipW, srcW) });
  const lqipBuf = transparent
    ? await small.webp({ quality: LQIP_QUALITY }).toBuffer()
    : await (hasAlpha ? small.flatten({ background }) : small).jpeg({ quality: LQIP_QUALITY }).toBuffer();
  const lqip = `data:image/${transparent ? 'webp' : 'jpeg'};base64,${lqipBuf.toString('base64')}`;
  writeFileSync(lqipPath, lqip, 'utf8');

  const manifest = {
    widths: produce,
    skippedWidths,
    formats: fmts,
    fallbackFormat,
    fallbackFile,
    source: { format: meta.format, width: srcW, height: srcH, transparent },
    images,
  };
  writeFileSync(
    cachePath,
    `${JSON.stringify({ pipeline: PIPELINE_VERSION, key, source: sourceRel, manifest }, null, 2)}\n`,
    'utf8',
  );

  return toResult({ cached: false, outDir, input, name, lqip, manifest });
}

/**
 * Build a copy-pasteable `<picture>` HTML snippet.
 *
 * Pass the processImage result straight in (`{ ...result, alt }`) so the
 * srcset widths, formats and fallback file match what was written. File names
 * are URL-encoded and every attribute is HTML-escaped.
 *
 * @param {{
 *   basename: string,
 *   widths: number[],
 *   alt?: string,
 *   fallbackFormat?: string|null,
 *   sizes?: string,
 *   formats?: string[],
 *   baseUrl?: string,
 *   loading?: 'lazy'|'eager',
 * }} opts
 *   fallbackFormat: extension of the <img src> file (default: the last of `formats`).
 *   baseUrl: prefix for every URL, e.g. '/img/' (default: bare file names).
 * @returns {string}
 */
export function buildPictureSnippet({
  basename: name,
  widths,
  alt = '',
  fallbackFormat,
  sizes = '100vw',
  formats = DEFAULT_FORMATS,
  baseUrl = '',
  loading = 'lazy',
} = {}) {
  if (typeof name !== 'string' || name === '') throw new TypeError('buildPictureSnippet: basename is required');
  const sorted = toWidths(widths);
  const fmts = toFormats(formats);
  const fallbackExt = fallbackFormat == null ? fmts[fmts.length - 1] : String(fallbackFormat);
  if (!/^(png|jpe?g|webp|avif|gif)$/i.test(fallbackExt)) {
    throw new TypeError(`buildPictureSnippet: unsupported fallbackFormat ${JSON.stringify(fallbackFormat)} (use jpg, png, webp or avif)`);
  }
  if (loading !== 'lazy' && loading !== 'eager') throw new TypeError('buildPictureSnippet: loading must be "lazy" or "eager"');

  const prefix = encodeUrl(baseUrl ?? '', BASE_SAFE);
  const stemUrl = encodeUrl(name, NAME_SAFE);
  const url = (w, ext) => escapeHtmlAttr(`${prefix}${stemUrl}-${w}.${ext}`);
  const safeSizes = escapeHtmlAttr(sizes ?? '100vw');
  const largest = sorted[sorted.length - 1];

  return [
    '<picture>',
    ...fmts.map((f) => {
      const srcset = sorted.map((w) => `${url(w, f)} ${w}w`).join(', ');
      return `  <source type="${FORMATS[f].mime}" srcset="${srcset}" sizes="${safeSizes}">`;
    }),
    `  <img src="${url(largest, fallbackExt)}" alt="${escapeHtmlAttr(alt ?? '')}" loading="${loading}" decoding="async">`,
    '</picture>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: atelier images <input...> --out <dir> [options]

Resize images into AVIF and WebP variants (never upscaled), a fallback file for
<img src>, and a tiny LQIP placeholder, then print a <picture> snippet per image.
An input is an image file, a file:// URL, or a folder (its images, not recursive).

Options:
  -o, --out <dir>        output folder (required)
  -w, --widths <list>    target widths in px (default 480,768,1280,1920)
  -f, --formats <list>   <source> formats, best first: avif, webp, jpg, png
                         (default avif,webp)
      --fallback <fmt>   <img src> format: auto, jpg, png, webp, avif, none
                         (default auto: png for transparent, PNG or GIF sources,
                         jpg otherwise)
      --lqip-width <px>  placeholder width (default 24)
      --name <stem>      output file name stem, one input only (default: input stem)
      --alt <text>       alt text for the snippet (default: empty, decorative)
      --sizes <value>    sizes attribute (default 100vw)
      --base-url <url>   prefix for snippet URLs, e.g. /img/ (default: file names)
      --loading <mode>   lazy or eager; use eager for above-the-fold images
                         (default lazy)
      --json             print a JSON report instead of text
  -h, --help             show this help

Exit codes: 0 all images processed, 2 usage error or an image failed.`;

const CLI_OPTIONS = {
  out: { type: 'string', short: 'o' },
  widths: { type: 'string', short: 'w' },
  formats: { type: 'string', short: 'f' },
  fallback: { type: 'string' },
  'lqip-width': { type: 'string' },
  name: { type: 'string' },
  alt: { type: 'string' },
  sizes: { type: 'string' },
  'base-url': { type: 'string' },
  loading: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

class UsageError extends Error {}

const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Turn a TypeError from a validator into a usage error for the CLI. */
function asUsage(fn) {
  try {
    return fn();
  } catch (err) {
    throw new UsageError(err.message);
  }
}

/** Expand CLI inputs (files, file: URLs, folders) to a deduplicated file list. */
function expandInputs(positionals, outDir) {
  const files = [];
  const seen = new Set();
  const add = (p) => {
    const k = process.platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(k)) {
      seen.add(k);
      files.push(p);
    }
  };
  for (const raw of positionals) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^file:/i.test(raw)) {
      throw new UsageError(`${raw}: only local files are supported; download the image and pass its path`);
    }
    const p = resolve(asUsage(() => toPath(raw, 'input')));
    let st;
    try {
      st = statSync(p);
    } catch {
      add(p); // processImage reports the missing file for this input
      continue;
    }
    if (!st.isDirectory()) {
      add(p);
      continue;
    }
    if (samePath(real(p), real(outDir))) {
      throw new UsageError(`${raw} is also the --out folder; write outputs to a separate folder`);
    }
    const found = readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile() && IMAGE_EXTS.has(extname(d.name).toLowerCase()))
      .map((d) => join(p, d.name))
      .sort();
    if (found.length === 0) throw new UsageError(`${raw} contains no images (${[...IMAGE_EXTS].join(' ')})`);
    found.forEach(add);
  }
  return files;
}

/**
 * Give inputs that share a stem distinct output names: add the source
 * extension, and a short path hash when the extension matches too. Grouping
 * ignores case because Windows and macOS file systems do.
 */
function assignNames(files, outDir) {
  const groups = new Map();
  for (const f of files) {
    const k = stem(f).toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const names = new Map();
  for (const group of groups.values()) {
    if (group.length === 1) {
      names.set(group[0], stem(group[0]));
      continue;
    }
    const extCount = new Map();
    for (const f of group) {
      const e = extname(f).toLowerCase();
      extCount.set(e, (extCount.get(e) ?? 0) + 1);
    }
    for (const f of group) {
      const e = extname(f).toLowerCase();
      let n = e ? `${stem(f)}-${e.slice(1)}` : stem(f);
      if (!e || extCount.get(e) > 1) {
        let rel = relative(resolve(outDir), f).split(sep).join('/');
        if (process.platform === 'win32') rel = rel.toLowerCase();
        n += `-${createHash('sha256').update(rel).digest('hex').slice(0, 6)}`;
      }
      names.set(f, n);
    }
  }
  return names;
}

function display(p) {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r.split(sep).join('/') : p;
}

/**
 * Run the CLI.
 * @param {string[]} [argv] - Arguments after the script name.
 * @param {{ stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {Promise<number>} Exit code.
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);

  let opts;
  try {
    const { values: v, positionals } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true });
    if (v.help) {
      out(USAGE);
      return 0;
    }
    if (positionals.length === 0) throw new UsageError('no input images given');
    if (!v.out) throw new UsageError('--out <dir> is required');
    opts = {
      json: Boolean(v.json),
      outDir: v.out,
      widths: v.widths === undefined ? DEFAULT_WIDTHS : asUsage(() => toWidths(splitList(v.widths), '--widths')),
      formats: v.formats === undefined ? DEFAULT_FORMATS : asUsage(() => toFormats(splitList(v.formats), '--formats')),
      fallback: asUsage(() => toFallback(v.fallback)),
      lqipWidth: v['lqip-width'] === undefined ? 24 : asUsage(() => toPositiveInt(v['lqip-width'], '--lqip-width')),
      alt: v.alt,
      sizes: v.sizes ?? '100vw',
      baseUrl: v['base-url'] ?? '',
      loading: v.loading ?? 'lazy',
      name: v.name === undefined ? undefined : asUsage(() => checkName(v.name)),
    };
    if (opts.loading !== 'lazy' && opts.loading !== 'eager') throw new UsageError('--loading must be lazy or eager');
    opts.files = expandInputs(positionals, opts.outDir);
    if (opts.name !== undefined && opts.files.length !== 1) throw new UsageError('--name works with exactly one input image');
  } catch (e) {
    if (e instanceof UsageError || e?.code?.startsWith?.('ERR_PARSE_ARGS')) {
      err(`atelier images: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    err(formatError(e));
    return 2;
  }

  if (!opts.json && opts.alt === undefined) {
    err('note: no --alt given, so each snippet has alt="" (decorative). Pass --alt "..." for meaningful images.');
  }

  const names = opts.name !== undefined ? new Map([[opts.files[0], opts.name]]) : assignNames(opts.files, opts.outDir);
  const report = [];
  let failed = 0;
  for (const file of opts.files) {
    try {
      const result = await processImage({
        input: file,
        outDir: opts.outDir,
        widths: opts.widths,
        formats: opts.formats,
        fallback: opts.fallback,
        lqipWidth: opts.lqipWidth,
        name: names.get(file),
      });
      const snippet = buildPictureSnippet({
        ...result,
        alt: opts.alt ?? '',
        sizes: opts.sizes,
        baseUrl: opts.baseUrl,
        loading: opts.loading,
      });
      report.push({ input: file, ok: true, ...result, snippet });
      if (!opts.json) {
        const skipped = result.skippedWidths.length
          ? ` (${result.skippedWidths.join(', ')} skipped: larger than the ${result.source.width} px source)`
          : '';
        out(`${display(file)} -> ${display(resolve(opts.outDir))} (${result.cached ? 'cached' : 'processed'})`);
        out(`  widths ${result.widths.join(', ')} px${skipped}`);
        out(`  fallback ${result.fallback ? basename(result.fallback) : 'none'}, placeholder ${basename(result.lqipPath)}`);
        out(snippet);
        out('');
      }
    } catch (e) {
      failed += 1;
      report.push({ input: file, ok: false, error: e instanceof Error ? e.message : String(e) });
      err(formatError(e));
    }
  }
  if (opts.json) out(JSON.stringify(report, null, 2));
  return failed > 0 ? 2 : 0;
}

if (isMain(import.meta.url)) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${formatError(e)}\n`);
      process.exitCode = 2;
    },
  );
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive stem (filename without extension) from a full path. */
function stem(filePath) {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** Compute SHA-256 of input bytes + widths key. */
function cacheKey(inputBuf, widths) {
  return createHash('sha256')
    .update(inputBuf)
    .update(widths.join(','))
    .digest('hex');
}

/** HTML-escape a string for use in a double-quoted attribute value. */
function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process a source image into AVIF + WebP variants at multiple widths, plus a
 * base64-encoded LQIP placeholder. Results are SHA-cached so unchanged sources
 * produce no re-work on subsequent runs.
 *
 * @param {{
 *   input: string,
 *   outDir: string,
 *   widths?: number[],
 *   lqipWidth?: number
 * }} opts
 * @returns {Promise<{ cached: boolean, variants: string[], lqip: string }>}
 */
export async function processImage({
  input,
  outDir,
  widths = [480, 768, 1280, 1920],
  lqipWidth = 24,
} = {}) {
  mkdirSync(outDir, { recursive: true });

  const inputBuf = readFileSync(input);
  const name = stem(input);

  // Build expected output paths
  const variants = [];
  for (const w of widths) {
    variants.push(join(outDir, `${name}-${w}.avif`));
    variants.push(join(outDir, `${name}-${w}.webp`));
  }
  const lqipPath = join(outDir, `${name}-lqip.txt`);
  const cachePath = join(outDir, `${name}.cache`);

  // Check cache
  const key = cacheKey(inputBuf, widths);
  if (existsSync(cachePath) && readFileSync(cachePath, 'utf8').trim() === key) {
    const lqip = existsSync(lqipPath) ? readFileSync(lqipPath, 'utf8').trim() : '';
    return { cached: true, variants, lqip };
  }

  // Generate variants
  const src = sharp(inputBuf);

  for (const w of widths) {
    const resized = src.clone().resize(w, null, { withoutEnlargement: true });
    await resized.clone().avif({ quality: 60, effort: 4 }).toFile(join(outDir, `${name}-${w}.avif`));
    await resized.clone().webp({ quality: 78 }).toFile(join(outDir, `${name}-${w}.webp`));
  }

  // Generate LQIP (24px-wide JPEG → base64 data URL)
  const lqipBuf = await src
    .clone()
    .resize(lqipWidth, null, { withoutEnlargement: false })
    .jpeg({ quality: 40 })
    .toBuffer();
  const lqip = `data:image/jpeg;base64,${lqipBuf.toString('base64')}`;
  writeFileSync(lqipPath, lqip, 'utf8');

  // Write cache key
  writeFileSync(cachePath, key, 'utf8');

  return { cached: false, variants, lqip };
}

/**
 * Build a copy-pasteable `<picture>` HTML snippet for the given image.
 *
 * @param {{
 *   basename: string,
 *   widths: number[],
 *   alt: string,
 *   fallbackFormat?: string,
 *   sizes?: string
 * }} opts
 * @returns {string}
 */
export function buildPictureSnippet({
  basename: name,
  widths,
  alt,
  fallbackFormat = 'png',
  sizes = '100vw',
}) {
  const sorted = [...widths].sort((a, b) => a - b);
  const largest = sorted[sorted.length - 1];

  const safeName = escapeHtmlAttr(name);
  const safeAlt = escapeHtmlAttr(alt);
  const safeSizes = escapeHtmlAttr(sizes);

  const avifSrcset = sorted.map((w) => `${safeName}-${w}.avif ${w}w`).join(', ');
  const webpSrcset = sorted.map((w) => `${safeName}-${w}.webp ${w}w`).join(', ');

  return [
    '<picture>',
    `  <source type="image/avif" srcset="${avifSrcset}" sizes="${safeSizes}">`,
    `  <source type="image/webp" srcset="${webpSrcset}" sizes="${safeSizes}">`,
    `  <img src="${safeName}-${largest}.${fallbackFormat}" alt="${safeAlt}" loading="lazy" decoding="async">`,
    '</picture>',
  ].join('\n');
}

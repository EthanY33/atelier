import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

/**
 * Each preset is an array of asset specs:
 *   - Square icons: { name, size }
 *   - Banner/cover:  { name, w, h }
 */
const PRESETS = {
  favicons: [
    { name: 'favicon-16.png',  size: 16 },
    { name: 'favicon-32.png',  size: 32 },
    { name: 'favicon-48.png',  size: 48 },
    { name: 'favicon-64.png',  size: 64 },
    { name: 'favicon-180.png', size: 180 },
  ],
  'app-icons': [
    { name: 'apple-touch-icon.png',    size: 180 },
    { name: 'android-chrome-192.png',  size: 192 },
    { name: 'android-chrome-512.png',  size: 512 },
  ],
  social: [
    { name: 'og-cover.png',       w: 1200, h: 630 },
    { name: 'twitter-cover.png',  w: 1500, h: 500 },
    { name: 'linkedin-cover.png', w: 1584, h: 396 },
  ],
  steam: [
    { name: 'steam-header.png',        w: 460,  h: 215 },
    { name: 'steam-capsule-main.png',  w: 616,  h: 353 },
    { name: 'steam-capsule-small.png', w: 231,  h: 87  },
  ],
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a CSS hex colour (#rrggbb or #rrggbbaa) into a sharp background object.
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number, alpha: number }}
 */
function parseHex(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const alpha = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, alpha };
}

/**
 * Render the SVG source at a given pixel density and return a PNG buffer.
 * @param {Buffer} svgBuf
 * @param {number} density  - DPI hint for SVG rasterization
 * @returns {Promise<Buffer>}
 */
async function renderSvg(svgBuf, density = 384) {
  return sharp(svgBuf, { density }).png().toBuffer();
}

/**
 * Produce a square icon PNG by fitting the mark inside a transparent canvas.
 * @param {Buffer} svgBuf
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function makeSquareIcon(svgBuf, size) {
  const markBuf = await sharp(svgBuf, { density: 384 })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return markBuf;
}

/**
 * Produce a banner PNG by placing the mark centred on a solid colour background.
 * @param {Buffer} svgBuf
 * @param {number} w
 * @param {number} h
 * @param {string} backgroundColor  - CSS hex colour
 * @returns {Promise<Buffer>}
 */
async function makeBanner(svgBuf, w, h, backgroundColor) {
  const markSize = Math.round(Math.min(w, h) * 0.5);
  const markBuf = await sharp(svgBuf, { density: 384 })
    .resize(markSize, markSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const bg = parseHex(backgroundColor);

  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: bg,
    },
  })
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
 * @param {{
 *   markSvg: string,
 *   outDir: string,
 *   targets?: string[],
 *   backgroundColor?: string
 * }} opts
 * @returns {Promise<{ files: string[] }>}
 */
export async function generateAssets({
  markSvg,
  outDir,
  targets = ['favicons', 'app-icons', 'social'],
  backgroundColor = '#110f1b',
} = {}) {
  mkdirSync(outDir, { recursive: true });

  const svgBuf = readFileSync(markSvg);
  const files = [];

  for (const target of targets) {
    const specs = PRESETS[target];
    if (!specs) {
      throw new Error(`Unknown target "${target}". Valid targets: ${Object.keys(PRESETS).join(', ')}`);
    }

    for (const spec of specs) {
      const outPath = join(outDir, spec.name);

      let buf;
      if (spec.size !== undefined) {
        // Square icon
        buf = await makeSquareIcon(svgBuf, spec.size);
      } else {
        // Banner / cover
        buf = await makeBanner(svgBuf, spec.w, spec.h, backgroundColor);
      }

      writeFileSync(outPath, buf);
      files.push(outPath);
    }
  }

  return { files };
}

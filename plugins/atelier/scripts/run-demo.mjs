/**
 * run-demo.mjs: end-to-end atelier pipeline demo.
 *
 * Runs every skill against the fixtures bundled in ../examples/ and writes the
 * results to an output directory in the caller's working directory (never
 * inside the plugin, which may be a read-only install cache).
 *
 * Usage:
 *   node scripts/run-demo.mjs [--out <dir>]      (default: ./atelier-demo)
 *   atelier demo [--out <dir>]
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

import { loadBrand } from '../skills/brand-memory/index.mjs';
import { syncTokens } from '../skills/design-token-sync/index.mjs';
import { generateAssets } from '../skills/brand-asset-pipeline/index.mjs';
import { processImage } from '../skills/responsive-image-pipeline/index.mjs';
import { generateCard } from '../skills/og-card-generator/index.mjs';
import { auditPage } from '../skills/accessibility-design-audit/index.mjs';
import { recordHtml } from '../skills/html-to-video/index.mjs';
import { findOnPath, formatError } from '../lib/preflight.mjs';
import { isMain } from '../lib/cli.mjs';

const pluginRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const fixturesDir = join(pluginRoot, 'examples');
const brandSrc = join(fixturesDir, 'brand.json');
const markSrc = join(fixturesDir, 'mark.svg');
const pageSrc = join(fixturesDir, 'page.html');
const MARKER = '.atelier-demo-output';

// Everything the demo writes. Re-runs delete exactly these names and nothing else.
const OWNED = ['stage', 'tokens', 'brand', 'img', 'og', 'a11y', 'ux', 'video', 'photo.jpg'];

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
// Real path when it exists, so junctions and symlinks cannot disguise a target.
const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
// path.relative is case-insensitive on win32, which is what we want here.
const contains = (dir, p) => {
  const r = relative(real(dir), real(p));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const same = (a, b) => relative(real(a), real(b)) === '';

/**
 * Make `outDir` safe to write into. Refuses the working directory, any of its
 * ancestors, the home directory, a filesystem root and the plugin itself, and
 * refuses any non-empty directory that lacks the marker file a previous demo
 * run left. On a re-run it removes only the demo's own outputs (OWNED).
 * @param {string} outDir - Absolute path.
 */
export function prepareOutDir(outDir) {
  const refuse = (why) => {
    throw new Error(`Refusing to use ${outDir} as the demo output directory: ${why}. Pass --out <new-folder>.`);
  };
  if (same(outDir, parse(resolve(outDir)).root)) refuse('it is a filesystem root');
  if (same(outDir, homedir())) refuse('it is your home directory');
  if (contains(outDir, process.cwd())) refuse('it is the current directory or one of its parents');
  if (contains(outDir, pluginRoot) || contains(pluginRoot, outDir)) refuse('it overlaps the plugin install');

  const marker = join(outDir, MARKER);
  if (existsSync(outDir)) {
    if (readdirSync(outDir).length > 0 && !isFile(marker)) refuse('it is not empty and was not created by atelier demo');
    for (const name of OWNED) rmSync(join(outDir, name), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(marker, 'Created by `atelier demo`. Safe to delete this whole folder.\n');
}

const step = (name) => console.log(`\n> ${name}`);
const ok = (msg) => console.log(`  ok  ${msg}`);

/**
 * Run the demo pipeline.
 * @param {{ outDir?: string }} [opts]
 * @returns {Promise<{ outDir: string }>}
 */
export async function runDemo({ outDir = 'atelier-demo' } = {}) {
  outDir = resolve(outDir);
  const stageDir = join(outDir, 'stage');
  const photoPath = join(outDir, 'photo.jpg');
  const rel = (p) => p.slice(outDir.length + 1).replaceAll('\\', '/');

  console.log('atelier demo: end-to-end pipeline');
  console.log(`output: ${outDir}`);

  prepareOutDir(outDir);
  mkdirSync(join(stageDir, '.atelier'), { recursive: true });
  copyFileSync(brandSrc, join(stageDir, '.atelier', 'brand.json'));

  step('synthetic photo');
  await sharp({ create: { width: 1600, height: 1000, channels: 3, background: { r: 30, g: 40, b: 60 } } })
    .jpeg({ quality: 80 })
    .toFile(photoPath);
  ok(rel(photoPath));

  step('design-token-sync');
  const tokenFiles = await syncTokens({ projectRoot: stageDir, outDir: join('..', 'tokens') });
  ok(`${tokenFiles.length} token files -> tokens/`);

  step('brand-asset-pipeline');
  const { files: assetFiles } = await generateAssets({
    markSvg: markSrc,
    outDir: join(outDir, 'brand'),
    targets: ['favicons', 'app-icons', 'social'],
    backgroundColor: '#110f1b',
  });
  ok(`${assetFiles.length} brand assets -> brand/`);

  step('responsive-image-pipeline');
  const { variants, cached } = await processImage({ input: photoPath, outDir: join(outDir, 'img'), widths: [480, 1280] });
  ok(`${cached ? 'cache hit' : 'processed'}, ${variants.length} variants -> img/`);

  step('og-card-generator');
  const ogOut = join(outDir, 'og', 'home.png');
  await generateCard({
    brand: loadBrand(stageDir),
    page: { slug: 'home', title: 'atelier-demo', subtitle: 'Design automation for indie studios' },
    outPath: ogOut,
  });
  ok(rel(ogOut));

  step('accessibility-design-audit');
  const pageUrl = pathToFileURL(pageSrc).href;
  const { violations } = await auditPage({ url: pageUrl, outDir: join(outDir, 'a11y') });
  ok(`critical ${violations.critical.length}, serious ${violations.serious.length} -> a11y/`);

  step('html-to-video');
  if (findOnPath('ffmpeg')) {
    const videoOut = join(outDir, 'video', 'demo.mp4');
    mkdirSync(join(outDir, 'video'), { recursive: true });
    await recordHtml({ url: pageUrl, duration: 2, width: 1280, height: 720, fps: 30, outPath: videoOut });
    ok(rel(videoOut));
  } else {
    ok('skipped (ffmpeg not on PATH)');
  }

  console.log(`\nDemo complete. Output in: ${outDir}`);
  return { outDir };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'atelier-demo' } } });
  runDemo({ outDir: values.out }).catch((err) => {
    console.error(`\n${formatError(err)}`);
    process.exit(1);
  });
}

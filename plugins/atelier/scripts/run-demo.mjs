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

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { auditRuntimeUx } from '../skills/runtime-ux-audit/index.mjs';
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

// lstat, not stat: a symlink named like the marker must not pass for it.
const isPlainFile = (p) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
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
 * ancestors, the home directory and its ancestors, a filesystem root, the
 * plugin itself, and an existing file. Refuses any non-empty directory that
 * lacks the marker file a previous demo run left. On a re-run it removes only
 * the demo's own outputs (OWNED); links among them are removed, not followed.
 * @param {string} outDir - Absolute path.
 */
export function prepareOutDir(outDir) {
  const refuse = (why) => {
    throw new Error(`Refusing to use ${outDir} as the demo output directory: ${why}. Pass --out <new-folder>.`);
  };
  if (same(outDir, parse(resolve(outDir)).root)) refuse('it is a filesystem root');
  if (contains(outDir, homedir())) refuse('it is your home directory or one of its parents');
  if (contains(outDir, process.cwd())) refuse('it is the current directory or one of its parents');
  if (contains(outDir, pluginRoot) || contains(pluginRoot, outDir)) refuse('it overlaps the plugin install');

  const marker = join(outDir, MARKER);
  if (existsSync(outDir)) {
    if (!isDir(outDir)) refuse('it is a file, not a directory');
    if (readdirSync(outDir).length > 0 && !isPlainFile(marker)) refuse('it is not empty and was not created by atelier demo');
    for (const name of OWNED) rmSync(join(outDir, name), { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });
  // Create the marker once; never rewrite an existing one (it could be a hard link).
  if (!isPlainFile(marker)) writeFileSync(marker, 'Created by `atelier demo`. Safe to delete this whole folder.\n', { flag: 'wx' });
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

  step('runtime-ux-audit');
  const ux = await auditRuntimeUx({ url: pageSrc, outDir: join(outDir, 'ux') });
  ok(`critical ${ux.violations.critical.length}, serious ${ux.violations.serious.length} (static pass) -> ux/`);

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

const USAGE = `Usage: node run-demo.mjs [--out <dir>]

Runs every atelier skill on the bundled fixtures and writes the results to <dir>
(default ./atelier-demo). <dir> must be new, empty, or a previous demo output.

Exit codes: 0 success, 2 usage error or failure.`;

if (isMain(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({ options: { out: { type: 'string', short: 'o', default: 'atelier-demo' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (err) {
    console.error(`atelier: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
  } else {
    runDemo({ outDir: values.out }).catch((err) => {
      console.error(`\n${formatError(err)}`);
      // Exit now: a step that failed mid-run may have left a browser open.
      process.exit(2);
    });
  }
}

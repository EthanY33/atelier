/**
 * run-demo.mjs — end-to-end atelier pipeline demo.
 *
 * Exercises all skills (except html-to-video when ffmpeg is absent) against the
 * bundled fixtures under examples/fixtures/, writing output to
 * examples/fixtures/output/.
 *
 * Usage:
 *   node scripts/run-demo.mjs
 */

import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Resolve repo root from this file's location (scripts/ → repo root)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(__filename, '..', '..');

// ---------------------------------------------------------------------------
// Skill imports
// ---------------------------------------------------------------------------
import { syncTokens } from '../plugins/atelier/skills/design-token-sync/index.mjs';
import { generateAssets } from '../plugins/atelier/skills/brand-asset-pipeline/index.mjs';
import { processImage } from '../plugins/atelier/skills/responsive-image-pipeline/index.mjs';
import { generateCard } from '../plugins/atelier/skills/og-card-generator/index.mjs';
import { auditPage } from '../plugins/atelier/skills/accessibility-design-audit/index.mjs';
import { recordHtml } from '../plugins/atelier/skills/html-to-video/index.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const fixturesDir = join(repoRoot, 'examples', 'fixtures');
const outDir      = join(fixturesDir, 'output');
const stageDir    = join(outDir, 'stage');
const brandSrc    = join(fixturesDir, 'brand.json');
const markSrc     = join(fixturesDir, 'mark.svg');
const pageSrc     = join(fixturesDir, 'page.html');
const photoPath   = join(fixturesDir, 'photo.jpg');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(name) {
  console.log(`\n→ ${name}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function ffmpegAvailable() {
  const result = spawnSync('ffmpeg', ['-version'], {
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('atelier demo — end-to-end pipeline');
  console.log('====================================');

  // 1. Fresh output directory
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  // 2. Staging directory: copy brand.json into .atelier/brand.json
  const atelierDir = join(stageDir, '.atelier');
  mkdirSync(atelierDir, { recursive: true });
  copyFileSync(brandSrc, join(atelierDir, 'brand.json'));

  // 3. Synthetic photo — generate fresh each run
  step('generating synthetic photo');
  await sharp({
    create: {
      width: 1600,
      height: 1000,
      channels: 3,
      background: { r: 30, g: 40, b: 60 },
    },
  })
    .jpeg({ quality: 80 })
    .toFile(photoPath);
  ok(`${photoPath}`);

  // 4. design-token-sync
  step('design-token-sync');
  const tokenFiles = await syncTokens({
    projectRoot: stageDir,
    outDir: join('..', 'tokens'),
  });
  ok(`wrote ${tokenFiles.length} token files → output/tokens/`);

  // 5. brand-asset-pipeline
  step('brand-asset-pipeline');
  const { files: assetFiles } = await generateAssets({
    markSvg: markSrc,
    outDir: join(outDir, 'brand'),
    targets: ['favicons', 'app-icons', 'social'],
    backgroundColor: '#110f1b',
  });
  ok(`generated ${assetFiles.length} brand assets → output/brand/`);

  // 6. responsive-image-pipeline
  step('responsive-image-pipeline');
  const { variants, cached } = await processImage({
    input: photoPath,
    outDir: join(outDir, 'img'),
    widths: [480, 1280],
  });
  ok(`${cached ? 'cache hit' : 'processed'} → ${variants.length} variants → output/img/`);

  // 7. og-card-generator — brand from staging dir
  step('og-card-generator');
  const ogOut = join(outDir, 'og', 'home.png');
  await generateCard({
    brand: JSON.parse(
      (await import('node:fs')).readFileSync(join(atelierDir, 'brand.json'), 'utf8'),
    ),
    page: { slug: 'home', title: 'atelier-demo', subtitle: 'Design automation for indie studios' },
    outPath: ogOut,
  });
  ok(`OG card → output/og/home.png`);

  // 8. accessibility-design-audit
  step('accessibility-design-audit');
  const pageUrl = pathToFileURL(pageSrc).href;
  const { violations, reportPath } = await auditPage({
    url: pageUrl,
    outDir: join(outDir, 'a11y'),
  });
  ok(
    `audit complete — critical: ${violations.critical.length}, serious: ${violations.serious.length} → output/a11y/`,
  );

  // 9. html-to-video (optional — requires ffmpeg)
  step('html-to-video');
  if (ffmpegAvailable()) {
    const videoOut = join(outDir, 'video', 'demo.mp4');
    mkdirSync(join(outDir, 'video'), { recursive: true });
    await recordHtml({
      url: pageUrl,
      duration: 2,
      width: 1280,
      height: 720,
      fps: 30,
      outPath: videoOut,
    });
    ok(`video → output/video/demo.mp4`);
  } else {
    ok('skipped (ffmpeg not found)');
  }

  // Done
  console.log(`\nDemo complete. Output in: ${outDir}`);
}

main().catch((err) => {
  console.error('\nDemo failed:', err.message);
  process.exit(1);
});

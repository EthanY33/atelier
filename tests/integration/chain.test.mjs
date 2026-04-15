/**
 * Integration test — exercises the full skill chain:
 *   brand-memory → design-token-sync → brand-asset-pipeline →
 *   responsive-image-pipeline → og-card-generator → accessibility-design-audit
 *
 * Uses real implementations (no mocks). Each skill feeds the next.
 */

import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import sharp from 'sharp';

import {
  initBrand,
  loadBrand,
} from '../../plugins/atelier/skills/brand-memory/index.mjs';
import { syncTokens } from '../../plugins/atelier/skills/design-token-sync/index.mjs';
import { generateAssets } from '../../plugins/atelier/skills/brand-asset-pipeline/index.mjs';
import { processImage } from '../../plugins/atelier/skills/responsive-image-pipeline/index.mjs';
import { generateCard } from '../../plugins/atelier/skills/og-card-generator/index.mjs';
import { auditPage } from '../../plugins/atelier/skills/accessibility-design-audit/index.mjs';

// ---------------------------------------------------------------------------
// Minimal SVG mark
// ---------------------------------------------------------------------------
const MINIMAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <circle cx="32" cy="32" r="28" fill="#e07a5f"/>
  <path d="M20 32 Q32 20 44 32" stroke="#110f1b" stroke-width="3" fill="none"/>
</svg>`;

// ---------------------------------------------------------------------------
// Minimal accessible HTML page
// ---------------------------------------------------------------------------
const MINIMAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Chain Test</title>
  <style>body{background:#110f1b;color:#f2cc8f;font-family:sans-serif;}</style>
</head>
<body>
  <main>
    <h1>Chain Test</h1>
    <p>Integration test fixture page.</p>
    <button type="button">OK</button>
  </main>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('integration chain', () => {
  let stage;

  beforeEach(() => {
    stage = mkdtempSync(join(tmpdir(), 'atelier-chain-'));
  });

  afterEach(() => {
    if (stage) {
      rmSync(stage, { recursive: true, force: true });
      stage = null;
    }
  });

  it(
    'runs brand-memory → design-token-sync → brand-asset → responsive-image → og-card → a11y',
    async () => {
      // ------------------------------------------------------------------
      // Write fixtures into the stage directory
      // ------------------------------------------------------------------
      const markPath = join(stage, 'mark.svg');
      const photoPath = join(stage, 'photo.jpg');
      const pagePath = join(stage, 'page.html');

      writeFileSync(markPath, MINIMAL_SVG, 'utf8');
      writeFileSync(pagePath, MINIMAL_HTML, 'utf8');

      // Synthetic JPEG via sharp
      await sharp({
        create: { width: 1200, height: 800, channels: 3, background: { r: 17, g: 15, b: 27 } },
      })
        .jpeg({ quality: 80 })
        .toFile(photoPath);

      // ------------------------------------------------------------------
      // 1. brand-memory: init → load → assert
      // ------------------------------------------------------------------
      initBrand(stage, {
        studio: 'ChainTest',
        bodyFont: 'Inter',
        primaryColor: '#110f1b',
      });
      const cfg = loadBrand(stage);
      expect(cfg.brand.studio).toBe('ChainTest');

      // ------------------------------------------------------------------
      // 2. design-token-sync → assert tokens.css exists
      // ------------------------------------------------------------------
      await syncTokens({ projectRoot: stage, outDir: 'tokens' });
      expect(existsSync(join(stage, 'tokens', 'tokens.css'))).toBe(true);

      // ------------------------------------------------------------------
      // 3. brand-asset-pipeline (favicons only) → assert ≥ 5 files
      // ------------------------------------------------------------------
      const { files } = await generateAssets({
        markSvg: markPath,
        outDir: join(stage, 'brand'),
        targets: ['favicons'],
      });
      expect(files.length).toBeGreaterThanOrEqual(5);

      // ------------------------------------------------------------------
      // 4. responsive-image-pipeline (480px only) → assert 2 variants (avif + webp)
      // ------------------------------------------------------------------
      const { variants } = await processImage({
        input: photoPath,
        outDir: join(stage, 'img'),
        widths: [480],
      });
      expect(variants.length).toBe(2);

      // ------------------------------------------------------------------
      // 5. og-card-generator → assert file exists + 1200×630
      // ------------------------------------------------------------------
      const ogPath = join(stage, 'og', 'home.png');
      await generateCard({
        brand: cfg,
        page: { slug: 'home', title: 'Chain', subtitle: 'Test' },
        outPath: ogPath,
      });
      expect(existsSync(ogPath)).toBe(true);
      const meta = await sharp(ogPath).metadata();
      expect(meta.width).toBe(1200);
      expect(meta.height).toBe(630);

      // ------------------------------------------------------------------
      // 6. accessibility-design-audit → assert violations object defined
      // ------------------------------------------------------------------
      const { violations } = await auditPage({
        url: pathToFileURL(pagePath).href,
        outDir: join(stage, 'a11y'),
      });
      expect(violations).toBeDefined();
    },
    120_000,
  );
});

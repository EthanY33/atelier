import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { generateAssets } from '../plugins/atelier/skills/brand-asset-pipeline/index.mjs';

const MARK_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#e07a5f"/></svg>`;

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('brand-asset-pipeline', { timeout: 30_000 }, () => {
  it('favicons target generates all 5 sizes', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    const markSvg = join(tmp, 'mark.svg');
    writeFileSync(markSvg, MARK_SVG);
    const outDir = join(tmp, 'out');

    const { files } = await generateAssets({ markSvg, outDir, targets: ['favicons'] });

    const names = files.map((f) => basename(f));
    expect(names).toContain('favicon-16.png');
    expect(names).toContain('favicon-32.png');
    expect(names).toContain('favicon-48.png');
    expect(names).toContain('favicon-64.png');
    expect(names).toContain('favicon-180.png');
    expect(files).toHaveLength(5);
  });

  it('app-icons target generates android-chrome files', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    const markSvg = join(tmp, 'mark.svg');
    writeFileSync(markSvg, MARK_SVG);
    const outDir = join(tmp, 'out');

    const { files } = await generateAssets({ markSvg, outDir, targets: ['app-icons'] });

    const names = files.map((f) => basename(f));
    expect(names).toContain('android-chrome-192.png');
    expect(names).toContain('android-chrome-512.png');
  });

  it('android-chrome-192.png has correct dimensions', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    const markSvg = join(tmp, 'mark.svg');
    writeFileSync(markSvg, MARK_SVG);
    const outDir = join(tmp, 'out');

    const { files } = await generateAssets({ markSvg, outDir, targets: ['app-icons'] });

    const icon192 = files.find((f) => basename(f) === 'android-chrome-192.png');
    expect(icon192).toBeDefined();
    const meta = await sharp(icon192).metadata();
    expect(meta.width).toBe(192);
    expect(meta.height).toBe(192);
  });

  it('social target generates og-cover.png with correct dimensions', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    const markSvg = join(tmp, 'mark.svg');
    writeFileSync(markSvg, MARK_SVG);
    const outDir = join(tmp, 'out');

    const { files } = await generateAssets({ markSvg, outDir, targets: ['social'] });

    const ogCover = files.find((f) => basename(f) === 'og-cover.png');
    expect(ogCover).toBeDefined();
    const meta = await sharp(ogCover).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });
});

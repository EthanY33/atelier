import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import {
  processImage,
  buildPictureSnippet,
} from '../plugins/atelier/skills/responsive-image-pipeline/index.mjs';

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('responsive-image-pipeline', { timeout: 30_000 }, () => {
  it('produces AVIF + WebP variants at requested widths', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rip-test-'));
    const inputPath = join(tmp, 'photo.png');

    // generate a 2000x1500 synthetic PNG
    const buf = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .png()
      .toBuffer();
    writeFileSync(inputPath, buf);

    const outDir = join(tmp, 'out');
    const { cached, variants } = await processImage({
      input: inputPath,
      outDir,
      widths: [480, 1280],
    });

    expect(cached).toBe(false);

    // 4 files: photo-480.avif, photo-480.webp, photo-1280.avif, photo-1280.webp
    const expected = [
      'photo-480.avif',
      'photo-480.webp',
      'photo-1280.avif',
      'photo-1280.webp',
    ];
    for (const name of expected) {
      expect(existsSync(join(outDir, name)), `${name} should exist`).toBe(true);
    }
    expect(variants).toHaveLength(4);
  });

  it('writes a base64 LQIP placeholder file starting with data:image/', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rip-test-'));
    const inputPath = join(tmp, 'photo.png');

    const buf = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 80, g: 120, b: 180 } },
    })
      .png()
      .toBuffer();
    writeFileSync(inputPath, buf);

    const outDir = join(tmp, 'out');
    const { lqip } = await processImage({
      input: inputPath,
      outDir,
      widths: [480],
    });

    const lqipPath = join(outDir, 'photo-lqip.txt');
    expect(existsSync(lqipPath)).toBe(true);

    const content = readFileSync(lqipPath, 'utf8').trim();
    expect(content.startsWith('data:image/')).toBe(true);
    expect(lqip.startsWith('data:image/')).toBe(true);
  });

  it('buildPictureSnippet produces correct HTML', () => {
    const html = buildPictureSnippet({
      basename: 'photo',
      widths: [480, 1280],
      alt: 'A photo',
    });

    expect(html).toContain('<picture>');
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain('photo-480.avif 480w');
    expect(html).toContain('alt="A photo"');
  });

  it('buildPictureSnippet HTML-escapes alt, basename, and sizes', () => {
    const html = buildPictureSnippet({
      basename: 'photo',
      widths: [480],
      alt: 'Say "hi" <script>',
      sizes: '(max-width: 480px) 100vw, 50vw',
    });

    // Escaped entities must appear
    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;');
    // Raw unescaped quotes and angle brackets must not be in the alt attribute
    expect(html).not.toContain('alt="Say "hi"');
    expect(html).not.toContain('<script>');
  });

  it('skips unchanged sources on second run (caching)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rip-test-'));
    const inputPath = join(tmp, 'photo.png');

    const buf = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 60, g: 90, b: 130 } },
    })
      .png()
      .toBuffer();
    writeFileSync(inputPath, buf);

    const outDir = join(tmp, 'out');
    const opts = { input: inputPath, outDir, widths: [480] };

    const first = await processImage(opts);
    expect(first.cached).toBe(false);

    const second = await processImage(opts);
    expect(second.cached).toBe(true);
    // variants still point to the right paths
    expect(second.variants.some((v) => v.endsWith('photo-480.avif'))).toBe(true);
    expect(second.variants.some((v) => v.endsWith('photo-480.webp'))).toBe(true);
  });
});

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { generateCard } from '../plugins/atelier/skills/og-card-generator/index.mjs';

const brand = {
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b', fg: '#f2cc8f' },
  typography: { display: 'Silkscreen', body: 'Geist' },
};

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('og-card-generator', () => {
  it('produces a PNG file', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'og-card-test-'));
    const outPath = join(tmp, 'home.png');
    await generateCard({
      brand,
      page: { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' },
      outPath,
    });
    expect(existsSync(outPath)).toBe(true);
    const stat = readFileSync(outPath);
    expect(stat.length).toBeGreaterThan(5000);
  }, 60_000);

  it('starts with PNG magic bytes', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'og-card-test-'));
    const outPath = join(tmp, 'home.png');
    await generateCard({
      brand,
      page: { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' },
      outPath,
    });
    const buf = readFileSync(outPath);
    const hex = buf.subarray(0, 8).toString('hex');
    expect(hex).toBe('89504e470d0a1a0a');
  }, 60_000);

  it('outputs correct dimensions 1200x630', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'og-card-test-'));
    const outPath = join(tmp, 'home.png');
    await generateCard({
      brand,
      page: { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' },
      outPath,
    });
    const meta = await sharp(outPath).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  }, 60_000);
});

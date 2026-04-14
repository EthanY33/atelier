import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  brandFilePath,
  loadBrand,
  saveBrand,
  getPath,
  setPath,
  initBrand,
  auditBrand,
} from '../plugins/atelier/skills/brand-memory/index.mjs';

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------
describe('load/save', () => {
  it('saveBrand writes and loadBrand reads roundtrip', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-test-'));
    const cfg = {
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen, monospace' },
    };
    await saveBrand(tmp, cfg);
    const loaded = await loadBrand(tmp);
    expect(loaded).toEqual(cfg);
  });

  it('saveBrand rejects invalid config (missing brand.studio)', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-test-'));
    const bad = {
      brand: {},
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' },
    };
    await expect(saveBrand(tmp, bad)).rejects.toThrow('invalid brand config');
  });

  it('loadBrand throws helpful error when file is missing', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-test-'));
    await expect(loadBrand(tmp)).rejects.toThrow(/brand\.json not found.*run \/brand-init/);
  });
});

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------
describe('get/set', () => {
  it('getPath returns nested values (brand.studio, palette.bg)', () => {
    const cfg = {
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' },
    };
    expect(getPath(cfg, 'brand.studio')).toBe('goneIdle');
    expect(getPath(cfg, 'palette.bg')).toBe('#110f1b');
  });

  it('getPath returns undefined for missing paths', () => {
    const cfg = { brand: { studio: 'goneIdle' } };
    expect(getPath(cfg, 'logos.mark')).toBeUndefined();
    expect(getPath(cfg, 'deploy.target')).toBeUndefined();
  });

  it('setPath sets value without mutating input', () => {
    const original = {
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' },
    };
    const updated = setPath(original, 'brand.product', 'TideWane');
    expect(updated.brand.product).toBe('TideWane');
    expect(original.brand.product).toBeUndefined(); // original unchanged
  });

  it('setPath creates intermediate objects (social.twitter on config lacking social)', () => {
    const cfg = {
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' },
    };
    const updated = setPath(cfg, 'social.twitter', '@EthanY33');
    expect(updated.social).toBeDefined();
    expect(updated.social.twitter).toBe('@EthanY33');
    expect(cfg.social).toBeUndefined(); // original unchanged
  });
});

// ---------------------------------------------------------------------------
// init / audit
// ---------------------------------------------------------------------------
describe('init/audit', () => {
  it('initBrand creates a minimal valid file', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-test-'));
    const cfg = await initBrand(tmp, {
      studio: 'goneIdle',
      bodyFont: 'Silkscreen, monospace',
      primaryColor: '#110f1b',
    });
    expect(cfg.brand.studio).toBe('goneIdle');
    expect(cfg.palette.bg).toBe('#110f1b');
    expect(cfg.typography.body).toBe('Silkscreen, monospace');

    // File should be loadable
    const loaded = await loadBrand(tmp);
    expect(loaded).toEqual(cfg);
  });

  it('auditBrand flags missing recommended fields (logos.mark, typography.display)', () => {
    const cfg = {
      brand: { studio: 'goneIdle' }, // missing brand.product, brand.voice
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' }, // missing display
      // missing logos, social, deploy
    };
    const { missing } = auditBrand(cfg);
    expect(missing).toContain('logos.mark');
    expect(missing).toContain('typography.display');
    expect(missing).toContain('brand.product');
    expect(missing).toContain('brand.voice');
    expect(missing).toContain('social');
    expect(missing).toContain('deploy.target');
  });

  it('auditBrand returns empty missing for a fully populated config', () => {
    const cfg = {
      brand: {
        studio: 'goneIdle',
        product: 'TideWane',
        voice: ['atmospheric', 'mysterious'],
      },
      palette: { bg: '#110f1b' },
      typography: {
        body: 'Silkscreen, monospace',
        display: 'Space Grotesk, sans-serif',
      },
      logos: {
        mark: 'brand/mark.svg',
        wordmark: 'brand/wordmark.svg',
      },
      social: {
        twitter: '@EthanY33',
      },
      deploy: {
        target: 'netlify',
      },
    };
    const { missing } = auditBrand(cfg);
    expect(missing).toHaveLength(0);
  });
});

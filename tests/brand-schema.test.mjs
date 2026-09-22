import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Ajv2020 as Ajv, addFormats } from './helpers/plugin-deps.mjs';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'plugins', 'atelier', 'schemas', 'brand.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function check(data) {
  const valid = validate(data);
  return { valid, errors: validate.errors };
}

describe('brand.schema.json', () => {
  it('accepts a minimal valid config (studio, one palette color, body font)', () => {
    const { valid } = check({
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen, monospace' }
    });
    expect(valid).toBe(true);
  });

  it('accepts a full config (all fields)', () => {
    const { valid } = check({
      brand: {
        studio: 'goneIdle',
        product: 'TideWane',
        voice: ['atmospheric', 'mysterious', 'deep-sea']
      },
      palette: {
        bg: '#110f1b',
        bgS: '#16132a',
        terra: '#e07a5f',
        cyan: '#67e8f9'
      },
      typography: {
        body: 'Silkscreen, monospace',
        display: 'Space Grotesk, sans-serif',
        mono: 'Courier New, monospace'
      },
      logos: {
        mark: 'brand/mark.svg',
        wordmark: 'brand/wordmark.svg'
      },
      social: {
        twitter: '@EthanY33',
        github: 'EthanY33'
      },
      deploy: {
        target: 'netlify',
        project: 'tidewane',
        stores: ['steam', 'itch']
      }
    });
    expect(valid).toBe(true);
  });

  it('rejects missing brand.studio', () => {
    const { valid, errors } = check({
      brand: {},
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen' }
    });
    expect(valid).toBe(false);
    expect(errors).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid hex color', () => {
    const { valid, errors } = check({
      brand: { studio: 'goneIdle' },
      palette: { bg: 'not-a-hex' },
      typography: { body: 'Silkscreen' }
    });
    expect(valid).toBe(false);
    expect(errors).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown deploy.target', () => {
    const { valid, errors } = check({
      brand: { studio: 'goneIdle' },
      palette: { bg: '#fff' },
      typography: { body: 'Silkscreen' },
      deploy: { target: 'firebase' }
    });
    expect(valid).toBe(false);
    expect(errors).toBeDefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts the bundled example brand.json', () => {
    const example = JSON.parse(readFileSync(join(__dirname, '..', 'plugins', 'atelier', 'examples', 'brand.json'), 'utf8'));
    expect(check(example).valid).toBe(true);
  });

  it('accepts an optional $schema key and the motion, surfaces and targets sections', () => {
    const { valid, errors } = check({
      $schema: schema.$id,
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Inter' },
      motion: { duration: { fast: '120ms', slow: '0.4s', base: '200ms' }, easing: { out: 'cubic-bezier(0.2, 0, 0, 1)' } },
      surfaces: { radius: { sm: '4px', md: '0.5rem', lg: '1.25em', pill: '50%' }, elevation: { card: 2 }, zIndexMax: 1000 },
      targets: { minTapPx: 24, inpBudgetMs: 200, lcpBudgetMs: 2500, clsBudget: 0.1 }
    });
    expect(errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('rejects durations and radii that are not numbers with a unit', () => {
    const cfg = (motion, surfaces) => ({
      brand: { studio: 'S' }, palette: { bg: '#000' }, typography: { body: 'Inter' }, motion, surfaces
    });
    for (const d of ['fast', 'dms', '200', '1.s', '-5ms']) {
      expect(check(cfg({ duration: { fast: d } })).valid, d).toBe(false);
    }
    for (const r of ['dpx', 'small', '4', '4 px']) {
      expect(check(cfg(undefined, { radius: { sm: r } })).valid, r).toBe(false);
    }
  });

  describe('typography hardening', () => {
    const withFont = (key, value) => ({
      brand: { studio: 'S' },
      palette: { bg: '#000' },
      typography: key === 'body' ? { body: value } : { body: 'Inter', [key]: value }
    });

    it('accepts real font stacks, including quotes and a leading dash', () => {
      for (const key of ['body', 'display', 'mono']) {
        for (const stack of [
          'Inter',
          "Silkscreen, 'Courier New', monospace",
          '"Space Grotesk", system-ui, -apple-system, sans-serif',
          'Source Sans 3',
          'x'.repeat(300)
        ]) {
          expect(check(withFont(key, stack)).valid, `${key}: ${stack}`).toBe(true);
        }
      }
    });

    it('rejects < > { } ; backslash, control characters and more than 300 chars', () => {
      for (const key of ['body', 'display', 'mono']) {
        for (const bad of ['a<b', 'a>b', 'a{b', 'a}b', 'a;b', 'a\\b', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'x'.repeat(301)]) {
          expect(check(withFont(key, bad)).valid, `${key}: ${JSON.stringify(bad)}`).toBe(false);
        }
      }
    });
  });
});

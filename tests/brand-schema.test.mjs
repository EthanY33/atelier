import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'schemas', 'brand.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ strict: false });
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
});

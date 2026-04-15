/**
 * validate-schemas.mjs — lint all JSON manifests and the brand JSON Schema.
 *
 * Checks:
 *   1. Each JSON file parses without error.
 *   2. schemas/brand.schema.json compiles as a valid JSON Schema 2020-12.
 *
 * Usage: node scripts/validate-schemas.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const FILES = [
  '.claude-plugin/marketplace.json',
  'plugins/atelier/plugin.json',
  'schemas/brand.schema.json',
];

let allOk = true;

const parsed = {};
for (const rel of FILES) {
  try {
    parsed[rel] = JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
    console.log(`✓ ${rel.split('/').pop()}`);
  } catch (err) {
    console.error(`✗ ${rel}: ${err.message}`);
    allOk = false;
  }
}

// Compile brand.schema.json to verify it is a valid JSON Schema 2020-12
if (parsed['schemas/brand.schema.json']) {
  try {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    ajv.compile(parsed['schemas/brand.schema.json']);
    console.log('✓ brand.schema.json compiles as JSON Schema 2020-12');
  } catch (err) {
    console.error(`✗ brand.schema.json schema compile failed: ${err.message}`);
    allOk = false;
  }
}

if (!allOk) process.exit(1);

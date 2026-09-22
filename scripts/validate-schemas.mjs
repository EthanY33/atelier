/**
 * validate-schemas.mjs: lint the JSON manifests and JSON Schemas.
 *
 * Checks:
 *   1. Each JSON file parses.
 *   2. Every schema under plugins/atelier/schemas/ compiles as JSON Schema 2020-12.
 *   3. The bundled example brand.json validates against brand.schema.json.
 *
 * Usage: node scripts/validate-schemas.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// ajv is a plugin dependency; resolve it from the plugin's node_modules.
const require = createRequire(resolve(root, 'plugins/atelier/package.json'));
const ajvMod = require('ajv/dist/2020.js');
const Ajv = ajvMod.default ?? ajvMod;
const formatsMod = require('ajv-formats');
const addFormats = formatsMod.default ?? formatsMod;

const SCHEMA_DIR = 'plugins/atelier/schemas';
const FILES = [
  '.claude-plugin/marketplace.json',
  'plugins/atelier/.claude-plugin/plugin.json',
  'plugins/atelier/package.json',
  'plugins/atelier/examples/brand.json',
  ...readdirSync(resolve(root, SCHEMA_DIR)).filter((f) => f.endsWith('.json')).map((f) => `${SCHEMA_DIR}/${f}`),
];

let allOk = true;
const parsed = {};
for (const rel of FILES) {
  try {
    parsed[rel] = JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
    console.log(`ok    ${rel}`);
  } catch (err) {
    console.error(`FAIL  ${rel}: ${err.message}`);
    allOk = false;
  }
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const rel of FILES.filter((f) => f.startsWith(SCHEMA_DIR))) {
  if (!parsed[rel]) continue;
  try {
    ajv.compile(parsed[rel]);
    console.log(`ok    ${rel} compiles as JSON Schema 2020-12`);
  } catch (err) {
    console.error(`FAIL  ${rel} does not compile: ${err.message}`);
    allOk = false;
  }
}

const brandRel = `${SCHEMA_DIR}/brand.schema.json`;
if (parsed[brandRel] && parsed['plugins/atelier/examples/brand.json']) {
  const validate = new Ajv({ strict: false, allErrors: true });
  addFormats(validate);
  if (validate.validate(parsed[brandRel], parsed['plugins/atelier/examples/brand.json'])) {
    console.log('ok    examples/brand.json validates against brand.schema.json');
  } else {
    console.error(`FAIL  examples/brand.json: ${validate.errorsText()}`);
    allOk = false;
  }
}

if (!allOk) process.exit(1);

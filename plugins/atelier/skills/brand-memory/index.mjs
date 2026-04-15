import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', '..', '..', '..', 'schemas', 'brand.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the path to the brand.json file within a project root.
 * @param {string} projectRoot
 * @returns {string}
 */
export function brandFilePath(projectRoot) {
  return join(projectRoot, '.atelier', 'brand.json');
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Reads and parses brand.json from projectRoot/.atelier/brand.json.
 * Throws a helpful error if the file is missing.
 * @param {string} projectRoot
 * @returns {object}
 */
export function loadBrand(projectRoot) {
  const filePath = brandFilePath(projectRoot);
  if (!existsSync(filePath)) {
    throw new Error(
      `brand.json not found at ${filePath} — run /brand-init first`
    );
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Validates cfg against the brand schema and writes it to brand.json.
 * Throws if validation fails.
 * @param {string} projectRoot
 * @param {object} cfg
 * @returns {void}
 */
export function saveBrand(projectRoot, cfg) {
  const valid = validate(cfg);
  if (!valid) {
    const messages = validate.errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
      .join('; ');
    throw new Error(`invalid brand config: ${messages}`);
  }
  const filePath = brandFilePath(projectRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Dotted-path accessor / mutator
// ---------------------------------------------------------------------------

/**
 * Gets a value from obj using a dotted path string (e.g. 'brand.studio').
 * Returns undefined if any segment along the path is missing.
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => {
    if (cur === undefined || cur === null) return undefined;
    return cur[key];
  }, obj);
}

/**
 * Returns a deep clone of obj with the value at dotted path set to value.
 * Creates intermediate objects as needed. Does NOT mutate the original.
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 * @returns {object}
 */
export function setPath(obj, path, value) {
  const clone = structuredClone(obj);
  const keys = path.split('.');
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Creates a minimal valid brand.json, saves it, and returns the config.
 * @param {string} projectRoot
 * @param {{ studio: string, bodyFont: string, primaryColor: string }} opts
 * @returns {object}
 */
export function initBrand(projectRoot, { studio, bodyFont, primaryColor }) {
  const cfg = {
    brand: { studio },
    palette: { bg: primaryColor },
    typography: { body: bodyFont },
  };
  saveBrand(projectRoot, cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Recommended fields and how to check if each is "present".
 * A field is considered missing if it is absent, an empty string,
 * an empty array, or an empty object.
 */
const RECOMMENDED = [
  'brand.product',
  'brand.voice',
  'typography.display',
  'logos.mark',
  'logos.wordmark',
  'social',
  'deploy.target',
];

function isMissing(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return true;
  return false;
}

/**
 * Returns an object with a `missing` array of dotted paths for recommended
 * fields that are absent or empty in cfg.
 * @param {object} cfg
 * @returns {{ missing: string[] }}
 */
export function auditBrand(cfg) {
  const missing = RECOMMENDED.filter((field) => isMissing(getPath(cfg, field)));
  return { missing };
}

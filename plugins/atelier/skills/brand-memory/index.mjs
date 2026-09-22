/**
 * brand-memory: read, write, validate and audit the project's brand file,
 * .atelier/brand.json. The JSON API is synchronous. The CLI (runCli) is what
 * `atelier brand ...` runs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isMain } from '../../lib/cli.mjs';
import { readJsonFile } from '../../lib/io.mjs';
import { formatError } from '../../lib/preflight.mjs';

// ---------------------------------------------------------------------------
// Schema setup
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
// Resolved inside the plugin so it survives the marketplace install copy.
const SCHEMA_PATH = join(HERE, '..', '..', 'schemas', 'brand.schema.json');
const schema = readJsonFile(SCHEMA_PATH);

/** Public URL of brand.schema.json, written as "$schema" for editor autocomplete. */
export const BRAND_SCHEMA_URL =
  'https://raw.githubusercontent.com/EthanY33/atelier/main/plugins/atelier/schemas/brand.schema.json';

const ajv = new Ajv({ strict: false, allErrors: true, verbose: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

/** Recommended (not required) fields that auditBrand checks, with a hint and an example value. */
const RECOMMENDED = [
  ['brand.product', 'product or game name', '"TideWane"'],
  ['brand.voice', '2 to 4 tone adjectives (a comma list becomes an array)', 'calm,precise'],
  ['typography.display', 'headline font stack', '"Space Grotesk, sans-serif"'],
  ['logos.mark', 'path to the icon or symbol SVG', 'brand/mark.svg'],
  ['logos.wordmark', 'path to the text logo', 'brand/wordmark.svg'],
  ['social', 'handles by platform (set one key at a time: social.twitter)', null],
  ['deploy.target', 'cloudflare-pages, netlify, github-pages, vercel or custom', 'netlify'],
];

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const INDEX_RE = /^(0|[1-9]\d*)$/;
const BARE_HEX_RE = /^([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function brandError(code, message, { cause, errors } = {}) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  if (errors) err.errors = errors;
  return err;
}

// ---------------------------------------------------------------------------
// Validation messages
// ---------------------------------------------------------------------------

function dotted(instancePath) {
  if (!instancePath) return '(root)';
  return instancePath
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.');
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function preview(v) {
  if (v !== null && typeof v === 'object') return `a${Array.isArray(v) ? 'n array' : 'n object'}`;
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

const ARTICLE = { array: 'an array', object: 'an object', integer: 'an integer' };

function patternHint(instancePath, pattern) {
  if (instancePath.startsWith('/palette/')) return 'must be a hex color: #rgb, #rrggbb or #rrggbbaa';
  if (instancePath.startsWith('/typography/')) {
    return 'must be a CSS font stack without < > { } ; \\ or control characters';
  }
  if (instancePath.startsWith('/motion/duration/')) return 'must be a duration like 200ms or 0.25s';
  if (instancePath.startsWith('/surfaces/radius/')) return 'must be a length like 8px, 0.5rem, 1em or 50%';
  return `must match ${pattern}`;
}

function describeError(e) {
  const where = dotted(e.instancePath);
  const child = (key) => (where === '(root)' ? key : `${where}.${key}`);
  switch (e.keyword) {
    case 'additionalProperties': {
      const key = child(e.params.additionalProperty);
      const allowed = e.parentSchema?.properties ? Object.keys(e.parentSchema.properties) : [];
      if (allowed.length) return `${key}: unknown property (allowed in ${where}: ${allowed.join(', ')})`;
      if (e.parentSchema?.patternProperties) {
        return `${key}: invalid key (keys start with a letter and use only letters, digits, _ and -)`;
      }
      return `${key}: unknown property`;
    }
    case 'required':
      return `${child(e.params.missingProperty)}: required property is missing`;
    case 'enum':
      return `${where}: ${preview(e.data)} is not allowed (allowed: ${e.params.allowedValues.join(', ')})`;
    case 'type': {
      const want = ARTICLE[e.params.type] ?? `a ${e.params.type}`;
      return `${where}: must be ${want} (got ${kindOf(e.data)})`;
    }
    case 'pattern':
      return `${where}: ${patternHint(e.instancePath, e.params.pattern)} (got ${preview(e.data)})`;
    case 'minLength':
      return e.params.limit === 1
        ? `${where}: must not be empty`
        : `${where}: must be at least ${e.params.limit} characters`;
    case 'maxLength':
      return `${where}: must be at most ${e.params.limit} characters (got ${e.data.length})`;
    case 'minProperties':
      return `${where}: needs at least ${e.params.limit} entr${e.params.limit === 1 ? 'y' : 'ies'}`;
    default: {
      const got = e.data !== null && typeof e.data === 'object' ? '' : ` (got ${preview(e.data)})`;
      return `${where}: ${e.message}${got}`;
    }
  }
}

/**
 * Validates a config against brand.schema.json without touching disk.
 * @param {unknown} cfg
 * @returns {{ valid: boolean, errors: string[] }} Readable messages that name
 *   the property (dotted path) and, for enums, the allowed values.
 */
export function validateBrand(cfg) {
  if (validateSchema(cfg)) return { valid: true, errors: [] };
  return { valid: false, errors: [...new Set(validateSchema.errors.map(describeError))] };
}

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
 * Reads and parses brand.json without schema validation. BOM tolerant.
 * Every error names the file.
 */
function readBrandFile(filePath) {
  if (!existsSync(filePath)) {
    throw brandError(
      'BRAND_NOT_FOUND',
      `brand.json not found at ${filePath}; run /brand-init (or: atelier brand init) first`,
    );
  }
  let cfg;
  try {
    cfg = readJsonFile(filePath);
  } catch (err) {
    const cause = err.cause ?? err;
    if (cause instanceof SyntaxError) {
      const detail = `not valid JSON (${cause.message})`;
      throw brandError('BRAND_INVALID', `invalid brand.json at ${filePath}: ${detail}`, { cause: err, errors: [detail] });
    }
    const reason = cause.code === 'EISDIR' ? 'it is a directory, not a file' : cause.message;
    throw brandError('BRAND_UNREADABLE', `cannot read brand.json at ${filePath}: ${reason}`, { cause: err });
  }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    const detail = `(root): must be a JSON object (got ${kindOf(cfg)})`;
    throw brandError('BRAND_INVALID', `invalid brand.json at ${filePath}: ${detail}`, { errors: [detail] });
  }
  return cfg;
}

/**
 * Reads, parses and validates projectRoot/.atelier/brand.json. Synchronous.
 * Tolerates a UTF-8 or UTF-16 byte order mark.
 * Throws (err.code): BRAND_NOT_FOUND when the file is missing, BRAND_INVALID
 * on malformed JSON or a schema failure (err.errors lists the problems),
 * BRAND_UNREADABLE when the path cannot be read.
 * @param {string} projectRoot
 * @returns {object}
 */
export function loadBrand(projectRoot) {
  const filePath = brandFilePath(projectRoot);
  const cfg = readBrandFile(filePath);
  const { valid, errors } = validateBrand(cfg);
  if (!valid) {
    throw brandError('BRAND_INVALID', `invalid brand.json at ${filePath}: ${errors.join('; ')}`, { errors });
  }
  return cfg;
}

/**
 * Validates cfg against the brand schema and writes it to brand.json as
 * 2-space JSON with a trailing newline. Synchronous. Throws BRAND_INVALID
 * before writing anything when validation fails.
 * @param {string} projectRoot
 * @param {object} cfg
 * @returns {void}
 */
export function saveBrand(projectRoot, cfg) {
  const { valid, errors } = validateBrand(cfg);
  if (!valid) throw brandError('BRAND_INVALID', `invalid brand config: ${errors.join('; ')}`, { errors });
  const filePath = brandFilePath(projectRoot);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  } catch (err) {
    throw brandError('BRAND_UNWRITABLE', `cannot write brand.json at ${filePath}: ${err.message}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Dotted-path accessor / mutator
// ---------------------------------------------------------------------------

/**
 * Gets a value from obj using a dotted path string (e.g. 'brand.studio').
 * Follows own properties only, so inherited members such as 'constructor' or
 * 'brand.toString' resolve to undefined. Returns undefined if any segment
 * along the path is missing.
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce(
      (cur, key) => (cur !== null && typeof cur === 'object' && Object.hasOwn(cur, key) ? cur[key] : undefined),
      obj,
    );
}

function splitPath(path) {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError('path must be a non-empty dotted string, e.g. palette.accent');
  }
  const keys = path.split('.');
  for (const key of keys) {
    if (key === '') throw new Error(`invalid path "${path}": empty segment`);
    if (FORBIDDEN_SEGMENTS.has(key)) throw new Error(`invalid path "${path}": "${key}" is not allowed as a path segment`);
  }
  return keys;
}

/**
 * Returns a deep clone of obj with the value at dotted path set to value.
 * Creates intermediate objects as needed. Does NOT mutate the original.
 * Throws on an empty segment, on '__proto__', 'constructor' or 'prototype'
 * segments, and on a non-index key (or a gap) inside an array.
 * @param {object} obj
 * @param {string} path
 * @param {*} value
 * @returns {object}
 */
export function setPath(obj, path, value) {
  const keys = splitPath(path);
  const clone = structuredClone(obj);
  let cur = clone;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (Array.isArray(cur)) {
      const where = keys.slice(0, i).join('.') || '(root)';
      if (!INDEX_RE.test(key)) {
        throw new Error(`invalid path "${path}": ${where} is an array, so "${key}" must be a numeric index`);
      }
      if (Number(key) > cur.length) {
        throw new Error(`invalid path "${path}": index ${key} would leave a gap in ${where} (length ${cur.length})`);
      }
    }
    if (i === keys.length - 1) {
      cur[key] = value;
      break;
    }
    if (!Object.hasOwn(cur, key) || cur[key] === null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function clean(v) {
  return typeof v === 'string' ? v.trim() : v;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function toVoiceList(voice) {
  if (typeof voice === 'string') return voice.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(voice)) return voice.map(clean).filter((s) => s !== '');
  return voice;
}

/**
 * Builds a brand config from the given values, validates it, and saves it in
 * one write (a bad value leaves no half-written file). Synchronous.
 * Blank or omitted optional values are left out of the file.
 * @param {string} projectRoot
 * @param {{
 *   studio: string, bodyFont: string, primaryColor: string,
 *   product?: string, voice?: string|string[], accent?: string,
 *   displayFont?: string, monoFont?: string, deployTarget?: string,
 *   withSchema?: boolean, overwrite?: boolean
 * }} opts voice may be a comma-separated string. accent goes to palette.accent,
 *   deployTarget to deploy.target. withSchema adds a "$schema" key (default
 *   false). overwrite: false throws BRAND_EXISTS if brand.json exists (default true).
 * @returns {object} The saved config.
 */
export function initBrand(projectRoot, opts = {}) {
  const {
    studio, bodyFont, primaryColor, product, voice, accent,
    displayFont, monoFont, deployTarget, withSchema = false, overwrite = true,
  } = opts;
  const filePath = brandFilePath(projectRoot);
  if (!overwrite && existsSync(filePath)) {
    throw brandError('BRAND_EXISTS', `brand.json already exists at ${filePath}; pass --force to overwrite it`);
  }
  const cfg = {};
  if (withSchema) cfg.$schema = BRAND_SCHEMA_URL;
  cfg.brand = {};
  if (!isBlank(studio)) cfg.brand.studio = clean(studio);
  if (!isBlank(product)) cfg.brand.product = clean(product);
  const voiceList = toVoiceList(voice);
  if (voiceList !== undefined && voiceList !== null && !(Array.isArray(voiceList) && voiceList.length === 0)) {
    cfg.brand.voice = voiceList;
  }
  cfg.palette = {};
  if (!isBlank(primaryColor)) cfg.palette.bg = clean(primaryColor);
  if (!isBlank(accent)) cfg.palette.accent = clean(accent);
  cfg.typography = {};
  if (!isBlank(bodyFont)) cfg.typography.body = clean(bodyFont);
  if (!isBlank(displayFont)) cfg.typography.display = clean(displayFont);
  if (!isBlank(monoFont)) cfg.typography.mono = clean(monoFont);
  if (!isBlank(deployTarget)) cfg.deploy = { target: clean(deployTarget) };
  saveBrand(projectRoot, cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

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
  const missing = RECOMMENDED.map(([field]) => field).filter((field) => isMissing(getPath(cfg, field)));
  return { missing };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_BG = '#111111';
const DEFAULT_BODY_FONT = 'system-ui, sans-serif';

const USAGE = `Usage: atelier brand <command> [options]

Read and write the project's brand file, .atelier/brand.json.

Commands:
  init                    Create brand.json, then print the audit
  get <path>              Print the JSON value at a dotted path, e.g. palette.bg
  set <path> <value>      Set a value, validate the whole file, save it
  audit                   List recommended fields that are missing or empty
  validate                Check brand.json against the schema
  path                    Print the absolute path of brand.json

Options for every command:
  --root <dir>            Project root that holds .atelier/ (default: current directory)
  -h, --help              Show this help

init:
  --studio <name>         Studio or company (default: the root folder name)
  --product <name>        Product or game name
  --voice <a,b,c>         Brand voice adjectives, comma separated
  --bg <hex>              Background color, palette.bg (default: ${DEFAULT_BG})
  --accent <hex>          Accent color, palette.accent
  --body-font <stack>     Body font stack (default: ${DEFAULT_BODY_FONT})
  --display-font <stack>  Display (headline) font stack
  --mono-font <stack>     Monospace font stack
  --deploy <target>       cloudflare-pages, netlify, github-pages, vercel or custom
  --force                 Overwrite an existing brand.json
get:
  --raw                   Print a string value without JSON quotes
audit, validate:
  --json                  Print JSON instead of text

set parses <value> as JSON when it is valid JSON, otherwise keeps it as a
string. For string fields a number stays text; for array fields (brand.voice,
deploy.stores) a comma list becomes an array. Hex colors may omit the "#".
Words after <value> are joined with spaces. Quote "#hex" values in a shell.
A value that starts with "-" goes after "--" (set -- typography.body
"-apple-system, sans-serif") or uses "=" (--body-font=-apple-system).

Exit codes:
  0  success (audit always exits 0)
  1  validate found schema errors
  2  usage error, missing or unreadable brand.json, get on an unset path,
     or a rejected init/set

Examples:
  atelier brand init --studio goneIdle --bg "#110f1b" --body-font "Inter, sans-serif" --voice calm,precise
  atelier brand set palette.accent "#67e8f9"
  atelier brand get palette.bg --raw
  atelier brand validate --root ./site`;

const CLI_OPTIONS = {
  root: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  raw: { type: 'boolean' },
  force: { type: 'boolean' },
  studio: { type: 'string' },
  product: { type: 'string' },
  voice: { type: 'string' },
  bg: { type: 'string' },
  accent: { type: 'string' },
  'body-font': { type: 'string' },
  'display-font': { type: 'string' },
  'mono-font': { type: 'string' },
  deploy: { type: 'string' },
};

const COMMANDS = {
  init: { options: ['studio', 'product', 'voice', 'bg', 'accent', 'body-font', 'display-font', 'mono-font', 'deploy', 'force'], args: [0, 0] },
  get: { options: ['raw'], args: [1, 1] },
  set: { options: [], args: [2, Infinity] },
  audit: { options: ['json'], args: [0, 0] },
  validate: { options: ['json'], args: [0, 0] },
  path: { options: [], args: [0, 0] },
};

class UsageError extends Error {}

function normalizeHex(v) {
  return typeof v === 'string' && BARE_HEX_RE.test(v.trim()) ? `#${v.trim()}` : v;
}

/** The schema node that governs a dotted path, or undefined when none does. */
function schemaNodeAt(path) {
  let node = schema;
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    if (node.properties && Object.hasOwn(node.properties, key)) {
      node = node.properties[key];
    } else if (node.patternProperties) {
      const hit = Object.entries(node.patternProperties).find(([re]) => new RegExp(re, 'u').test(key));
      node = hit ? hit[1] : undefined;
    } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      node = node.additionalProperties;
    } else if (node.items && INDEX_RE.test(key)) {
      node = node.items;
    } else {
      return undefined;
    }
  }
  return node;
}

/** Turns a CLI value into the value to store at path. */
function parseCliValue(path, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  const type = schemaNodeAt(path)?.type;
  if (type === 'string' && typeof value !== 'string') value = raw;
  if (type === 'array' && typeof value === 'string') value = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (path.startsWith('palette.')) value = normalizeHex(value);
  return value;
}

function auditText(cfg, filePath) {
  const { missing } = auditBrand(cfg);
  const lines = [`brand.json: ${filePath}`];
  if (missing.length === 0) {
    lines.push('All recommended fields are set.');
  } else {
    lines.push(`Missing recommended fields (${missing.length} of ${RECOMMENDED.length}):`);
    const w = Math.max(...missing.map((m) => m.length));
    for (const [field, hint, example] of RECOMMENDED) {
      if (!missing.includes(field)) continue;
      const cmd = example === null ? 'atelier brand set social.twitter @studio' : `atelier brand set ${field} ${example}`;
      lines.push(`  ${field.padEnd(w)}  ${hint}`);
      lines.push(`  ${''.padEnd(w)}  ${cmd}`);
    }
  }
  const { valid, errors } = validateBrand(cfg);
  if (!valid) lines.push(`Note: brand.json has ${errors.length} schema error(s); run atelier brand validate.`);
  return lines.join('\n');
}

function commandInit(values, root, out) {
  const filePath = brandFilePath(root);
  const defaults = [];
  const pick = (flag, fallback, label) => {
    if (values[flag] !== undefined) return values[flag];
    defaults.push(`${label} ${fallback}`);
    return fallback;
  };
  const cfg = initBrand(root, {
    studio: pick('studio', basename(root) || 'studio', 'brand.studio'),
    product: values.product,
    voice: values.voice,
    primaryColor: normalizeHex(pick('bg', DEFAULT_BG, 'palette.bg')),
    accent: normalizeHex(values.accent),
    bodyFont: pick('body-font', DEFAULT_BODY_FONT, 'typography.body'),
    displayFont: values['display-font'],
    monoFont: values['mono-font'],
    deployTarget: values.deploy,
    withSchema: true,
    overwrite: Boolean(values.force),
  });
  out(`Wrote ${filePath}`);
  if (defaults.length) out(`Defaults used: ${defaults.join('; ')}. Change them with atelier brand set.`);
  out('');
  out(auditText(cfg, filePath));
  return 0;
}

function commandGet(values, root, [path], out, err) {
  const filePath = brandFilePath(root);
  const value = getPath(readBrandFile(filePath), path);
  if (value === undefined) {
    err(formatError(new Error(`${path} is not set in ${filePath}`)));
    return 2;
  }
  out(values.raw && typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return 0;
}

function commandSet(root, [path, ...parts], out) {
  // Read without validating so `set` can repair a file that is currently invalid.
  const cfg = readBrandFile(brandFilePath(root));
  const value = parseCliValue(path, parts.join(' '));
  saveBrand(root, setPath(cfg, path, value));
  out(`${path} = ${JSON.stringify(value)}`);
  return 0;
}

function commandValidate(values, root, out) {
  const filePath = brandFilePath(root);
  let result;
  try {
    result = validateBrand(readBrandFile(filePath));
  } catch (e) {
    if (e.code !== 'BRAND_INVALID') throw e;
    result = { valid: false, errors: e.errors };
  }
  if (values.json) {
    out(JSON.stringify({ path: filePath, ...result }, null, 2));
  } else if (result.valid) {
    out(`valid: ${filePath}`);
  } else {
    out(`invalid: ${filePath}`);
    for (const e of result.errors) out(`  - ${e}`);
  }
  return result.valid ? 0 : 1;
}

/**
 * Runs the brand CLI. Never calls process.exit.
 * @param {string[]} [argv] Arguments after the script name.
 * @param {{ cwd?: string, stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {number} Exit code: 0 ok, 1 validate found errors, 2 usage error or failure.
 */
export function runCli(argv = process.argv.slice(2), { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s) => stdout.write(`${s}\n`);
  const err = (s) => stderr.write(`${s}\n`);
  let command;
  let args;
  let values;
  try {
    const parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true });
    values = parsed.values;
    if (values.help) {
      out(USAGE);
      return 0;
    }
    [command, ...args] = parsed.positionals;
    if (!command) throw new UsageError('missing command');
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!spec) throw new UsageError(`unknown command "${command}"`);
    const allowed = new Set(['root', 'help', ...spec.options]);
    for (const name of Object.keys(values)) {
      if (!allowed.has(name)) throw new UsageError(`--${name} does not apply to "${command}"`);
    }
    const [min, max] = spec.args;
    if (args.length < min || args.length > max) {
      const want = command === 'get' ? '<path>' : command === 'set' ? '<path> <value>' : 'no arguments';
      throw new UsageError(`"${command}" takes ${want}, got ${args.length === 0 ? 'none' : args.map((a) => JSON.stringify(a)).join(' ')}`);
    }
  } catch (e) {
    err(`atelier brand: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  const root = resolve(cwd, values.root ?? '.');
  try {
    switch (command) {
      case 'init':
        return commandInit(values, root, out);
      case 'get':
        return commandGet(values, root, args, out, err);
      case 'set':
        return commandSet(root, args, out);
      case 'audit': {
        const filePath = brandFilePath(root);
        const cfg = readBrandFile(filePath);
        if (values.json) {
          const { missing } = auditBrand(cfg);
          const { valid, errors } = validateBrand(cfg);
          out(JSON.stringify({ path: filePath, complete: missing.length === 0, missing, valid, errors }, null, 2));
        } else {
          out(auditText(cfg, filePath));
        }
        return 0;
      }
      case 'validate':
        return commandValidate(values, root, out);
      default: // path
        out(brandFilePath(root));
        return 0;
    }
  } catch (e) {
    err(formatError(e));
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}

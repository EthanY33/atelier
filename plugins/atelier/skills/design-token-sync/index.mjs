/**
 * design-token-sync: generate design tokens from .atelier/brand.json.
 *
 * API:
 *   import { syncTokens } from '<skill dir>/index.mjs';
 *   const written = await syncTokens({ projectRoot, outDir: 'dist/tokens', targets: ['css', 'dts'] });
 *
 * CLI:
 *   node index.mjs [projectRoot] [--root <dir>] [--out <dir>] [--targets css,tailwind,dts,figma] [--check]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../../lib/cli.mjs';
import { PreflightError, formatError } from '../../lib/preflight.mjs';
import { emitCss } from './emitters/css.mjs';
import { emitDts } from './emitters/dts.mjs';
import { emitFigmaVariables } from './emitters/figma.mjs';
import { emitJs } from './emitters/js.mjs';
import { emitTailwind } from './emitters/tailwind.mjs';

export { emitCss, emitDts, emitFigmaVariables, emitJs, emitTailwind };

/** Output groups accepted by `targets` / `--targets`. */
export const TARGETS = Object.freeze(['css', 'tailwind', 'dts', 'figma']);

/** Every file syncTokens can write, in the order of the returned paths. */
const ARTIFACTS = [
  { target: 'css', name: 'tokens.css', emit: emitCss },
  { target: 'tailwind', name: 'tailwind.config.js', emit: emitTailwind },
  { target: 'dts', name: 'tokens.d.ts', emit: emitDts },
  { target: 'figma', name: 'figma-variables.json', emit: emitFigmaVariables },
  { target: 'dts', name: 'tokens.js', emit: emitJs },
];

/**
 * Normalize a targets option (array or comma-separated string) to a Set.
 * @param {string|string[]|undefined} targets
 * @returns {Set<string>}
 */
export function parseTargets(targets) {
  if (targets === undefined) return new Set(TARGETS);
  const list = (Array.isArray(targets) ? targets : String(targets).split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (list.length === 0) throw new TypeError(`targets is empty; choose from ${TARGETS.join(', ')}`);
  for (const t of list) {
    if (!TARGETS.includes(t)) throw new TypeError(`unknown target "${t}"; choose from ${TARGETS.join(', ')}`);
  }
  return new Set(list);
}

async function loadBrandMemory() {
  try {
    return await import('../brand-memory/index.mjs');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new PreflightError(`atelier dependencies are missing: ${err.message.split('\n')[0]}`, {
        code: 'DEPS_MISSING',
        fix: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.',
        cause: err,
      });
    }
    throw err;
  }
}

const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

/**
 * Load `<projectRoot>/.atelier/brand.json`, render the requested token files,
 * and write them to outDir. All files are rendered before any is written, so
 * a bad value leaves the previous output untouched.
 *
 * Files by target: css -> tokens.css, tailwind -> tailwind.config.js,
 * dts -> tokens.d.ts + tokens.js, figma -> figma-variables.json.
 *
 * With `check: true` nothing is written, not even outDir: the rendered files
 * are compared with the files on disk (CRLF and LF count as equal) and the
 * result is `{ stale, missing }`, two arrays of absolute paths.
 *
 * @param {{
 *   projectRoot?: string,
 *   outDir?: string,
 *   targets?: string[]|string,
 *   check?: boolean,
 * }} [options]
 *   projectRoot: directory holding .atelier/brand.json (default: cwd).
 *   outDir: output directory; absolute, or relative to projectRoot (default 'dist/tokens').
 *   targets: subset of TARGETS, as an array or comma-separated string (default: all).
 *   check: compare instead of write (default false).
 * @returns {Promise<string[]|{ stale: string[], missing: string[] }>} Absolute paths of the written files, or
 *   with `check: true` the paths that differ from, or are absent on, disk.
 */
export async function syncTokens({ projectRoot = process.cwd(), outDir = 'dist/tokens', targets, check = false } = {}) {
  const wanted = parseTargets(targets);
  const root = resolve(projectRoot);
  const { loadBrand } = await loadBrandMemory();
  const cfg = await loadBrand(root);

  const outPath = resolve(root, outDir);
  const files = ARTIFACTS
    .filter((a) => wanted.has(a.target))
    .map((a) => ({ path: join(outPath, a.name), content: a.emit(cfg) }));

  if (check) {
    const stale = [];
    const missing = [];
    for (const { path, content } of files) {
      let onDisk;
      try {
        onDisk = readFileSync(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') missing.push(path);
        else stale.push(path);
        continue;
      }
      if (normalizeEol(onDisk) !== normalizeEol(content)) stale.push(path);
    }
    return { stale, missing };
  }

  mkdirSync(outPath, { recursive: true });
  for (const { path, content } of files) writeFileSync(path, content, 'utf8');
  return files.map((f) => f.path);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `Usage: atelier tokens [projectRoot] [options]

Generate design tokens from <projectRoot>/.atelier/brand.json.

Options:
  --root <dir>       project root holding .atelier/brand.json (default: current directory)
  --out <dir>        output directory, absolute or relative to the project root
                     (default: dist/tokens)
  --targets <list>   comma-separated outputs: css,tailwind,dts,figma (default: all)
  --check            write nothing; exit 1 if any token file differs from brand.json
                     or is missing (use in CI to catch stale committed tokens)
  -h, --help         show this help

Targets:
  css        tokens.css               :root custom properties (--color-*, --font-*)
  tailwind   tailwind.config.js       theme.extend colors and fontFamily
  dts        tokens.js, tokens.d.ts   typed constants (colors, fonts, one const per color)
  figma      figma-variables.json     body for POST /v1/files/:file_key/variables

Prints each written file's absolute path on its own line.

Exit codes: 0 written (or, with --check, up to date), 1 --check found stale or missing
files, 2 usage error or failure.`;

const CLI_OPTIONS = {
  root: { type: 'string' },
  out: { type: 'string' },
  targets: { type: 'string' },
  check: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/**
 * Run the CLI.
 * @param {string[]} [argv] - Arguments after the script path.
 * @param {{ stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [io]
 * @returns {Promise<number>} Exit code.
 */
export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const usageError = (message) => {
    stderr.write(`atelier: ${message}\n\n${USAGE}\n`);
    return 2;
  };

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true }));
  } catch (err) {
    if (argv.includes('--help') || argv.includes('-h')) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    return usageError(err.message);
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length > 1) return usageError(`expected at most one project root, got ${positionals.length}`);
  if (positionals.length === 1 && values.root !== undefined) {
    return usageError('give the project root as an argument or with --root, not both');
  }
  for (const flag of ['root', 'out', 'targets']) {
    if (values[flag] !== undefined && values[flag].trim() === '') return usageError(`--${flag} needs a value`);
  }
  let targets;
  try {
    targets = values.targets === undefined ? undefined : [...parseTargets(values.targets)];
  } catch (err) {
    return usageError(err.message);
  }

  try {
    const written = await syncTokens({
      projectRoot: values.root ?? positionals[0] ?? process.cwd(),
      outDir: values.out,
      targets,
      check: values.check,
    });
    if (values.check) {
      for (const path of written.stale) stdout.write(`stale: ${path}\n`);
      for (const path of written.missing) stdout.write(`missing: ${path}\n`);
      return written.stale.length + written.missing.length > 0 ? 1 : 0;
    }
    for (const file of written) stdout.write(`${file}\n`);
    return 0;
  } catch (err) {
    stderr.write(`${formatError(err)}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await runCli();
}

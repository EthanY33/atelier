import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli, syncTokens, TARGETS, USAGE } from '../../plugins/atelier/skills/design-token-sync/index.mjs';
import { Ajv2020, addFormats } from '../helpers/plugin-deps.mjs';

const pluginRoot = fileURLToPath(new URL('../../plugins/atelier/', import.meta.url));
const skillEntry = join(pluginRoot, 'skills', 'design-token-sync', 'index.mjs');
const binEntry = join(pluginRoot, 'bin', 'atelier');
const schema = JSON.parse(readFileSync(join(pluginRoot, 'schemas', 'brand.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateBrand = ajv.compile(schema);
const { stripTypeScriptTypes } = nodeModule;

const ALL_FILES = ['tokens.css', 'tailwind.config.js', 'tokens.d.ts', 'figma-variables.json', 'tokens.js'];

const exampleBrand = JSON.parse(readFileSync(join(pluginRoot, 'examples', 'brand.json'), 'utf8'));

/** Schema-valid brand that exercises every emitter edge case. */
const edgeBrand = {
  brand: { studio: 'Edge' },
  palette: { bg: '#110f1b', 'brand-500': '#e07a5f', 'brand-primary': '#000', default: '#fff', class: '#123', a_1: '#11223380', Object: '#abcdef' },
  typography: { body: "Silkscreen, 'Courier New', monospace", display: 'Press Start 2P', mono: '"Geist Mono", ui-monospace' },
};

let scratch;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'atelier-dts-'));
});
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
function project(brand = exampleBrand) {
  const root = join(scratch, `p${++n}`);
  mkdirSync(join(root, '.atelier'), { recursive: true });
  if (brand) writeFileSync(join(root, '.atelier', 'brand.json'), JSON.stringify(brand, null, 2));
  return root;
}

function sink() {
  let text = '';
  return { write: (s) => { text += s; }, get text() { return text; } };
}

async function cli(args) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(args, { stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('syncTokens', () => {
  it('the edge brand used below is schema valid', () => {
    expect(validateBrand(edgeBrand)).toBe(true);
  });

  it('writes every file to <root>/dist/tokens by default and returns absolute paths', async () => {
    const root = project();
    const written = await syncTokens({ projectRoot: root });
    expect(written).toEqual(ALL_FILES.map((f) => join(root, 'dist', 'tokens', f)));
    for (const p of written) {
      expect(isAbsolute(p)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
    expect(TARGETS).toEqual(['css', 'tailwind', 'dts', 'figma']);
  });

  it('resolves a relative outDir against projectRoot', async () => {
    const root = project();
    const written = await syncTokens({ projectRoot: root, outDir: join('..', `rel-${n}`) });
    expect(written[0]).toBe(resolve(root, '..', `rel-${n}`, 'tokens.css'));
    expect(existsSync(written[0])).toBe(true);
  });

  it('honors an absolute outDir', async () => {
    const root = project();
    const abs = join(scratch, `abs-out-${n}`);
    const written = await syncTokens({ projectRoot: root, outDir: abs });
    expect(written).toHaveLength(ALL_FILES.length);
    for (const p of written) {
      expect(p.startsWith(abs)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
    // Nothing nested under the project root.
    expect(readdirSync(root)).toEqual(['.atelier']);
  });

  it('writes only the requested targets (array or comma list)', async () => {
    const root = project();
    const css = await syncTokens({ projectRoot: root, outDir: 'a', targets: ['css'] });
    expect(css).toEqual([join(root, 'a', 'tokens.css')]);
    const dts = await syncTokens({ projectRoot: root, outDir: 'b', targets: 'dts, figma' });
    expect(dts.map((p) => p.slice(join(root, 'b').length + 1))).toEqual(['tokens.d.ts', 'figma-variables.json', 'tokens.js']);
    expect(readdirSync(join(root, 'b')).sort()).toEqual(['figma-variables.json', 'tokens.d.ts', 'tokens.js']);
  });

  it('rejects unknown or empty targets before writing anything', async () => {
    const root = project();
    await expect(syncTokens({ projectRoot: root, targets: ['css', 'scss'] })).rejects.toThrow(/unknown target "scss"/);
    await expect(syncTokens({ projectRoot: root, targets: [] })).rejects.toThrow(/targets is empty/);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('rejects with the brand.json path when the brand is missing', async () => {
    const root = project(null);
    await expect(syncTokens({ projectRoot: root })).rejects.toThrow(/brand\.json/);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('reads a brand.json saved with a UTF-8 byte order mark', async () => {
    const root = project(null);
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    writeFileSync(join(root, '.atelier', 'brand.json'), Buffer.concat([bom, Buffer.from(JSON.stringify(exampleBrand))]));
    const [cssPath] = await syncTokens({ projectRoot: root, targets: ['css'] });
    expect(readFileSync(cssPath, 'utf8')).toContain('--color-bg: #110f1b;');
  });

  it('names the file when brand.json is not valid JSON', async () => {
    const root = project(null);
    writeFileSync(join(root, '.atelier', 'brand.json'), '{ "brand": ');
    await expect(syncTokens({ projectRoot: root })).rejects.toThrow(/brand\.json/);
  });

  it('produces files that load and parse for a schema-valid edge brand', async () => {
    const root = project(edgeBrand);
    const [cssPath, twPath, dtsPath, figmaPath, jsPath] = await syncTokens({ projectRoot: root });

    const tw = (await import(pathToFileURL(twPath).href)).default;
    expect(tw.theme.extend.colors).toEqual(edgeBrand.palette);
    expect(tw.theme.extend.fontFamily.display).toEqual(['"Press Start 2P"', 'sans-serif']);

    const js = await import(pathToFileURL(jsPath).href);
    expect(js.colors).toEqual(edgeBrand.palette);
    expect(js.brand500).toBe('#e07a5f');
    expect(js.default_).toBe('#fff');
    // A key named Object must not shadow the global the module calls (Object.freeze).
    expect(js.Object_).toBe('#abcdef');

    const dts = readFileSync(dtsPath, 'utf8');
    const declared = [...dts.matchAll(/^export declare const ([^:]+):/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(js).sort());
    if (typeof stripTypeScriptTypes === 'function') expect(() => stripTypeScriptTypes(dts)).not.toThrow();

    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('--color-brand-500: #e07a5f;');
    expect(css).toContain('--font-body: "Silkscreen", "Courier New", monospace;');
    expect(css).toContain('--font-mono: "Geist Mono", ui-monospace;');

    const figma = JSON.parse(readFileSync(figmaPath, 'utf8'));
    expect(figma.variables).toHaveLength(Object.keys(edgeBrand.palette).length + 3);
  });
});

describe('runCli', () => {
  it('--help and -h print usage to stdout and exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await cli([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`${USAGE}\n`);
      expect(r.stderr).toBe('');
    }
    // Help wins even next to an unknown flag.
    expect((await cli(['--help', '--bogus'])).code).toBe(0);
  });

  it('usage errors print usage to stderr and exit 2', async () => {
    const root = project();
    const cases = [
      ['--bogus'],
      ['--out'],
      ['a', 'b'],
      [root, '--root', root],
      ['--root', root, '--targets', 'css,scss'],
      ['--root', root, '--targets', ','],
      ['--root', root, '--out', ' '],
    ];
    for (const args of cases) {
      const r = await cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^atelier: /);
      expect(r.stderr).toContain('Usage: atelier tokens');
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(root, 'dist'))).toBe(false);
  });

  it('writes tokens with --root, --out and --targets and prints one path per line', async () => {
    const root = project();
    const out = join(scratch, `cli-out-${n}`);
    const r = await cli(['--root', root, '--out', out, '--targets', 'css,tailwind']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim().split('\n')).toEqual([join(out, 'tokens.css'), join(out, 'tailwind.config.js')]);
  });

  it('accepts the project root as a positional argument', async () => {
    const root = project();
    const r = await cli([root]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(ALL_FILES.length);
  });

  it('runtime failures print a formatted error and exit 2', async () => {
    const root = project(null);
    const r = await cli(['--root', root]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: .*brand\.json/);
    expect(r.stderr).not.toContain('Usage:');
  });

  it('a schema-invalid brand fails with exit 2', async () => {
    const root = project({ brand: { studio: 'X' }, palette: { bg: 'not-a-color' }, typography: { body: 'X' } });
    const r = await cli(['--root', root]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: /);
  });
});

describe('CLI process', () => {
  const run = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000, ...opts });

  it('atelier tokens --help exits 0 with usage', () => {
    const r = run([binEntry, 'tokens', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: atelier tokens');
  });

  it('exits 2 when brand.json is missing', () => {
    const r = run([skillEntry, '--root', project(null)]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^atelier: /);
  });

  it('runs when reached through a symlink or junction', (ctx) => {
    const link = join(scratch, 'skills-link');
    try {
      symlinkSync(join(pluginRoot, 'skills'), link, 'junction');
    } catch {
      ctx.skip();
    }
    const root = project();
    const r = run([join(link, 'design-token-sync', 'index.mjs'), '--root', root, '--targets', 'css']);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'dist', 'tokens', 'tokens.css'))).toBe(true);
  });

  it('does not run the CLI when node -e imports it with its own path as argv[1]', () => {
    // argv[1] then names this file, so isMain() alone would start the CLI and
    // write every token file into the cwd.
    const root = project();
    const esm = "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); console.log(typeof m.syncTokens);";
    // --print refuses ESM input, so -p runs CommonJS input with a dynamic import.
    const cjs = "import(require('node:url').pathToFileURL(process.argv[1]).href).then((m) => console.log(typeof m.syncTokens))";
    const runs = [
      ['--input-type=module', '-e', esm],
      ['--input-type=module', '--eval', esm],
      ['-p', cjs],
    ];
    for (const args of runs) {
      const r = run([...args, skillEntry], { cwd: root });
      const label = args.slice(0, -1).join(' ');
      expect(r.stderr, label).toBe('');
      expect(r.status, label).toBe(0);
      // -p also prints the returned Promise, in an order that is not fixed.
      expect(r.stdout.trim().split(/\r?\n/), label).toContain('function');
      expect(existsSync(join(root, 'dist')), label).toBe(false);
    }
  });

  it('can be imported from node --input-type=module -e without running the CLI', () => {
    const url = pathToFileURL(skillEntry).href;
    const r = run(['--input-type=module', '-e', `import { syncTokens } from ${JSON.stringify(url)}; console.log(typeof syncTokens);`]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('function');
  });
});

describe('SKILL.md', () => {
  const skillDir = join(pluginRoot, 'skills', 'design-token-sync');
  const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const API_PREFIX = "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href);";

  it('runs through the plugin CLI, is plain ASCII and has no repo-relative paths', () => {
    expect(md).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" tokens');
    expect(md).not.toMatch(/plugins\/atelier/);
    expect([...md].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  it('the JS API snippet runs as written with the skill directory substituted', () => {
    const snippet = /^node --input-type=module -e "([^"\n]*)" "\$\{CLAUDE_SKILL_DIR\}\/index\.mjs"$/m.exec(md);
    expect(snippet, 'API snippet not found in SKILL.md').not.toBeNull();
    const code = snippet[1];
    expect(code.startsWith(API_PREFIX)).toBe(true);
    // Inside bash double quotes these would be expanded; the snippet must not rely on them.
    expect(code).not.toMatch(/[$`\!]/);

    // What bash passes after Claude Code substitutes ${CLAUDE_SKILL_DIR}: an absolute
    // native path (backslashes on Windows), which only works through pathToFileURL.
    const root = project();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, join(skillDir, 'index.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = join(root, 'dist', 'tokens');
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([join(out, 'tokens.css'), join(out, 'tailwind.config.js')]);
    expect(readdirSync(out).sort()).toEqual(['tailwind.config.js', 'tokens.css']);
  });

  it('documents every CLI flag, and every documented flag exists in --help', () => {
    const flags = (text) => new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z-]*[a-z]\b(?!-)/g)].map((m) => m[0]));
    // Only the CLI parts of SKILL.md: the Run block and the Options table, not the curl example.
    const cliDocs = md.split('\n').filter((l) => l.includes('bin/atelier" tokens') || l.startsWith('| `')).join('\n');
    const documented = flags(cliDocs);
    const usage = flags(USAGE);
    expect([...usage].sort()).toEqual(['--help', '--out', '--root', '--targets']);
    expect([...documented].sort()).toEqual([...usage].sort());
    expect(USAGE).toMatch(/-h, --help/);
    expect(md).toContain('`-h`, `--help`');
  });
});

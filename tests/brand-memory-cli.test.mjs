import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRAND_SCHEMA_URL,
  brandFilePath,
  loadBrand,
  runCli,
  saveBrand,
} from '../plugins/atelier/skills/brand-memory/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', 'plugins', 'atelier');
const BIN = join(PLUGIN_ROOT, 'bin', 'atelier');
const ENTRY = join(PLUGIN_ROOT, 'skills', 'brand-memory', 'index.mjs');

let tmp;

afterEach(() => {
  delete Object.prototype.polluted;
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function newTmp() {
  tmp = mkdtempSync(join(tmpdir(), 'atelier-brand-cli-'));
  return tmp;
}

/** Runs the CLI in-process against `root` (unless --root is given) and captures output. */
function cli(args, { cwd = tmp } = {}) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, {
    cwd,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

const base = () => ({
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b' },
  typography: { body: 'Inter' },
});

describe('brand CLI: usage', () => {
  it('--help and -h print usage to stdout and exit 0', () => {
    newTmp();
    for (const args of [['--help'], ['-h'], ['init', '--help'], ['set', '-h']]) {
      const r = cli(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^Usage: atelier brand <command>/);
      expect(r.stderr).toBe('');
    }
  });

  it('usage errors print usage to stderr and exit 2', () => {
    newTmp();
    const cases = [
      [[], /missing command/],
      [['frobnicate'], /unknown command "frobnicate"/],
      [['audit', '--bogus'], /Unknown option '--bogus'/],
      [['get', 'palette.bg', '--force'], /--force does not apply to "get"/],
      [['audit', '--raw'], /--raw does not apply to "audit"/],
      [['get'], /"get" takes <path>, got none/],
      [['get', 'a', 'b'], /"get" takes <path>, got "a" "b"/],
      [['set', 'palette.bg'], /"set" takes <path> <value>/],
      [['path', 'extra'], /"path" takes no arguments/],
      [['init', '--studio'], /argument missing/],
    ];
    for (const [args, re] of cases) {
      const r = cli(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(re);
      expect(r.stderr).toContain('Usage: atelier brand');
      expect(r.stdout).toBe('');
    }
    expect(existsSync(join(tmp, '.atelier'))).toBe(false);
  });
});

describe('brand CLI: init', () => {
  it('writes all values plus $schema, prints the path and then the audit', () => {
    newTmp();
    const r = cli([
      'init', '--studio', 'goneIdle', '--product', 'TideWane', '--voice', 'atmospheric, mysterious',
      '--bg', '#110f1b', '--accent', '67e8f9', '--body-font', "Silkscreen, 'Courier New', monospace",
      '--display-font', 'Space Grotesk, sans-serif', '--mono-font', 'JetBrains Mono', '--deploy', 'cloudflare-pages',
    ]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const file = brandFilePath(tmp);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe(`Wrote ${file}`);
    expect(r.stdout).not.toContain('Defaults used');
    expect(r.stdout.indexOf('Missing recommended fields (3 of 7)')).toBeGreaterThan(r.stdout.indexOf(file));
    expect(r.stdout).toContain('atelier brand set logos.mark brand/mark.svg');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toEqual({
      $schema: BRAND_SCHEMA_URL,
      brand: { studio: 'goneIdle', product: 'TideWane', voice: ['atmospheric', 'mysterious'] },
      palette: { bg: '#110f1b', accent: '#67e8f9' },
      typography: {
        body: "Silkscreen, 'Courier New', monospace",
        display: 'Space Grotesk, sans-serif',
        mono: 'JetBrains Mono',
      },
      deploy: { target: 'cloudflare-pages' },
    });
    expect(loadBrand(tmp)).toEqual(saved);
  });

  it('fills studio, bg and body font with defaults and says so', () => {
    newTmp();
    const r = cli(['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Defaults used: brand.studio ${basename(tmp)}; palette.bg #111111; typography.body system-ui, sans-serif.`);
    expect(loadBrand(tmp)).toMatchObject({
      brand: { studio: basename(tmp) },
      palette: { bg: '#111111' },
      typography: { body: 'system-ui, sans-serif' },
    });
  });

  it('accepts a dash-leading font stack through --opt=value', () => {
    newTmp();
    const r = cli(['init', '--studio', 'S', '--body-font=-apple-system, sans-serif']);
    expect(r.code).toBe(0);
    expect(loadBrand(tmp).typography.body).toBe('-apple-system, sans-serif');
  });

  it('refuses to overwrite without --force and exits 2', () => {
    newTmp();
    expect(cli(['init', '--studio', 'First']).code).toBe(0);
    const r = cli(['init', '--studio', 'Second']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: brand\.json already exists at .*pass --force/);
    expect(loadBrand(tmp).brand.studio).toBe('First');
    expect(cli(['init', '--studio', 'Third', '--force']).code).toBe(0);
    expect(loadBrand(tmp).brand.studio).toBe('Third');
  });

  it('rejects an invalid deploy target with the allowed values and writes nothing', () => {
    newTmp();
    const r = cli(['init', '--deploy', 'firebase']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('deploy.target: "firebase" is not allowed (allowed: cloudflare-pages, netlify, github-pages, vercel, custom)');
    expect(existsSync(brandFilePath(tmp))).toBe(false);
  });

  it('rejects a font stack that would break out of CSS or HTML', () => {
    newTmp();
    const r = cli(['init', '--body-font', 'Inter}</style><script>alert(1)</script>']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/typography\.body: must be a CSS font stack/);
    expect(existsSync(brandFilePath(tmp))).toBe(false);
  });

  it('--root resolves against the working directory', () => {
    newTmp();
    const r = cli(['init', '--root', 'site', '--studio', 'S'], { cwd: tmp });
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, 'site', '.atelier', 'brand.json'))).toBe(true);
  });
});

describe('brand CLI: get', () => {
  it('prints JSON values, raw strings with --raw, and exits 2 on an unset path', () => {
    newTmp();
    saveBrand(tmp, { ...base(), brand: { studio: 'goneIdle', voice: ['calm'] } });
    expect(cli(['get', 'palette.bg'])).toEqual({ code: 0, stdout: '"#110f1b"\n', stderr: '' });
    expect(cli(['get', 'palette.bg', '--raw'])).toEqual({ code: 0, stdout: '#110f1b\n', stderr: '' });
    expect(cli(['get', 'brand.voice', '--raw']).stdout).toBe('[\n  "calm"\n]\n');
    expect(JSON.parse(cli(['get', 'palette']).stdout)).toEqual({ bg: '#110f1b' });
    for (const path of ['logos.mark', 'constructor', '__proto__', 'brand.toString']) {
      const r = cli(['get', path]);
      expect(r.code, path).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^atelier: ${path.replace(/\./g, '\\.')} is not set in `));
      expect(r.stdout).toBe('');
    }
  });

  it('exits 2 with the init hint when brand.json is missing', () => {
    newTmp();
    const r = cli(['get', 'palette.bg']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: brand\.json not found at .*run \/brand-init \(or: atelier brand init\) first/);
  });

  it('reads a BOM-prefixed file', () => {
    newTmp();
    mkdirSync(join(tmp, '.atelier'));
    writeFileSync(brandFilePath(tmp), '\uFEFF' + JSON.stringify(base()));
    expect(cli(['get', 'brand.studio', '--raw']).stdout).toBe('goneIdle\n');
  });
});

describe('brand CLI: set', () => {
  it('parses values by the schema type at the path', () => {
    newTmp();
    saveBrand(tmp, base());
    const cases = [
      [['palette.accent', '#67e8f9'], 'palette.accent', '#67e8f9'],
      [['palette.terra', 'e07a5f'], 'palette.terra', '#e07a5f'],
      [['palette.sand', '"#f2cc8f"'], 'palette.sand', '#f2cc8f'],
      [['brand.product', '1984'], 'brand.product', '1984'],
      [['logos.mark', 'true'], 'logos.mark', 'true'],
      [['brand.voice', 'calm, precise'], 'brand.voice', ['calm', 'precise']],
      [['deploy.stores', '["steam","itch"]'], 'deploy.stores', ['steam', 'itch']],
      [['targets.minTapPx', '44'], 'targets.minTapPx', 44],
      [['motion.duration.fast', '200ms'], 'motion.duration.fast', '200ms'],
      [['social.twitter', '@goneidle'], 'social.twitter', '@goneidle'],
      [['typography.body', 'Inter,', 'sans-serif'], 'typography.body', 'Inter, sans-serif'],
      [['brand.voice.1', 'bold'], 'brand.voice', ['calm', 'bold']],
    ];
    for (const [args, path, expected] of cases) {
      const r = cli(['set', ...args]);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.stdout).toBe(`${args[0]} = ${JSON.stringify(path === args[0] ? expected : expected[1])}\n`);
      const saved = loadBrand(tmp);
      expect(path.split('.').reduce((o, k) => o[k], saved)).toEqual(expected);
    }
    // Formatting is preserved: 2-space JSON and a trailing newline.
    const text = readFileSync(brandFilePath(tmp), 'utf8');
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
  });

  it('takes a dash-leading value after --', () => {
    newTmp();
    saveBrand(tmp, base());
    const r = cli(['set', '--', 'typography.body', '-apple-system, sans-serif']);
    expect(r.code).toBe(0);
    expect(loadBrand(tmp).typography.body).toBe('-apple-system, sans-serif');
  });

  it('rejects invalid values with a readable message and leaves the file unchanged', () => {
    newTmp();
    saveBrand(tmp, base());
    const before = readFileSync(brandFilePath(tmp), 'utf8');
    const cases = [
      [['deploy.target', 'cloudflare'], /deploy\.target: "cloudflare" is not allowed \(allowed: cloudflare-pages, netlify/],
      [['brand.tagline', 'hi'], /brand\.tagline: unknown property \(allowed in brand: studio, product, voice\)/],
      [['palette.2x', '#fff'], /palette\.2x: invalid key/],
      [['palette.bg', 'blue'], /palette\.bg: must be a hex color/],
      [['brand.voice.tone', 'calm'], /numeric index|must be an array/],
      [['__proto__.polluted', 'yes'], /"__proto__" is not allowed as a path segment/],
      [['palette.constructor.x', 'yes'], /"constructor" is not allowed/],
    ];
    for (const [args, re] of cases) {
      const r = cli(['set', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^atelier: /);
      expect(r.stderr).toMatch(re);
      expect(readFileSync(brandFilePath(tmp), 'utf8')).toBe(before);
    }
    expect({}.polluted).toBeUndefined();
  });

  it('can repair a file that currently fails validation', () => {
    newTmp();
    mkdirSync(join(tmp, '.atelier'));
    writeFileSync(brandFilePath(tmp), JSON.stringify({ ...base(), palette: { bg: 'blue' } }));
    expect(cli(['validate']).code).toBe(1);
    expect(cli(['set', 'palette.bg', '#000000']).code).toBe(0);
    expect(cli(['validate']).code).toBe(0);
  });

  it('exits 2 when there is no brand.json to update', () => {
    newTmp();
    const r = cli(['set', 'palette.bg', '#000']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/brand\.json not found/);
    expect(existsSync(brandFilePath(tmp))).toBe(false);
  });
});

describe('brand CLI: audit, validate, path', () => {
  it('audit lists missing fields in text and JSON and always exits 0', () => {
    newTmp();
    saveBrand(tmp, base());
    const text = cli(['audit']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Missing recommended fields (7 of 7):');
    expect(text.stdout).toContain('atelier brand set brand.voice calm,precise');
    expect(text.stdout).toContain('atelier brand set social.twitter @studio');
    const json = cli(['audit', '--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ path: brandFilePath(tmp), complete: false, valid: true, errors: [] });
    expect(report.missing).toHaveLength(7);
  });

  it('audit reports a complete config and notes schema errors without failing', () => {
    newTmp();
    const full = {
      brand: { studio: 'S', product: 'P', voice: ['calm'] },
      palette: { bg: '#000' },
      typography: { body: 'Inter', display: 'Inter' },
      logos: { mark: 'm.svg', wordmark: 'w.svg' },
      social: { twitter: '@s' },
      deploy: { target: 'netlify' },
    };
    saveBrand(tmp, full);
    expect(cli(['audit']).stdout).toContain('All recommended fields are set.');
    writeFileSync(brandFilePath(tmp), JSON.stringify({ ...full, palette: { bg: 'nope' } }));
    const r = cli(['audit']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Note: brand.json has 1 schema error(s); run atelier brand validate.');
    expect(JSON.parse(cli(['audit', '--json']).stdout).valid).toBe(false);
  });

  it('validate exits 0 when valid and 1 with readable messages when not', () => {
    newTmp();
    saveBrand(tmp, base());
    expect(cli(['validate'])).toEqual({ code: 0, stdout: `valid: ${brandFilePath(tmp)}\n`, stderr: '' });

    writeFileSync(
      brandFilePath(tmp),
      JSON.stringify({ ...base(), brand: { studio: 'S', tagline: 'x' }, deploy: { target: 'firebase' } }),
    );
    const r = cli(['validate']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`invalid: ${brandFilePath(tmp)}`);
    expect(r.stdout).toContain('  - brand.tagline: unknown property (allowed in brand: studio, product, voice)');
    expect(r.stdout).toContain('  - deploy.target: "firebase" is not allowed (allowed: cloudflare-pages, netlify, github-pages, vercel, custom)');

    const json = cli(['validate', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ path: brandFilePath(tmp), valid: false });
  });

  it('validate exits 1 on malformed JSON and 2 when the file is missing', () => {
    newTmp();
    expect(cli(['validate']).code).toBe(2);
    mkdirSync(join(tmp, '.atelier'));
    writeFileSync(brandFilePath(tmp), '{ "brand": ');
    const r = cli(['validate']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/- not valid JSON/);
  });

  it('path prints the absolute brand.json path without requiring the file', () => {
    newTmp();
    expect(cli(['path'])).toEqual({ code: 0, stdout: `${brandFilePath(tmp)}\n`, stderr: '' });
    expect(cli(['path', '--root', 'a/b']).stdout).toBe(`${brandFilePath(join(tmp, 'a', 'b'))}\n`);
  });
});

describe('brand CLI: real processes', () => {
  it('atelier brand --help is forwarded by bin/atelier and exits 0', () => {
    const r = spawnSync(process.execPath, [BIN, 'brand', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: atelier brand <command>/);
  });

  it('the isMain guard runs the CLI directly and propagates exit codes', () => {
    newTmp();
    saveBrand(tmp, base());
    writeFileSync(brandFilePath(tmp), JSON.stringify({ ...base(), palette: { bg: 'x' } }));
    const r = spawnSync(process.execPath, [ENTRY, 'validate', '--root', tmp], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('palette.bg: must be a hex color');
  });

  it('importing the module under node -e does not run the CLI, even with index.mjs as argv[1]', () => {
    const script =
      "const { pathToFileURL } = await import('node:url'); " +
      'const m = await import(pathToFileURL(process.argv[1]).href); ' +
      'console.log(typeof m.loadBrand, typeof m.runCli);';
    // argv[1] is index.mjs itself in the SKILL.md form; the eval flag spellings all count.
    for (const evalFlag of [['-e', script], ['--eval', script], [`--eval=${script}`]]) {
      const r = spawnSync(process.execPath, ['--input-type=module', ...evalFlag, ENTRY], { encoding: 'utf8' });
      expect(r.stderr, evalFlag[0]).toBe('');
      expect(r.status, evalFlag[0]).toBe(0);
      expect(r.stdout).toBe('function function\n');
    }
    // CommonJS eval (-p cannot take ESM input) with a dynamic import.
    const cjs = "import(require('node:url').pathToFileURL(process.argv[1]).href).then((m) => console.log(typeof m.runCli)) && 'printed'";
    const p = spawnSync(process.execPath, ['-p', cjs, ENTRY], { encoding: 'utf8' });
    expect(p.stderr).toBe('');
    expect(p.status).toBe(0);
    expect(p.stdout.split('\n').filter(Boolean).sort()).toEqual(['function', 'printed']);
  });
});

// ---------------------------------------------------------------------------
// SKILL.md: the JS API line and the flag list
// ---------------------------------------------------------------------------
const SKILL_DIR = dirname(ENTRY);
const SKILL_MD = () => readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const API_LINE_RE = /^node --input-type=module -e "([^"\r\n]*)" "\$\{CLAUDE_SKILL_DIR\}\/index\.mjs"$/m;

/** A POSIX shell to run the SKILL.md line through, or undefined when there is none. */
function posixShell() {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : undefined;
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
  return roots.map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p));
}

function expectApiLineEffect(r) {
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^\[[\s\S]*'brand\.product'[\s\S]*'deploy\.target'[\s\S]*\]\n$/);
  expect(loadBrand(tmp).palette.accent).toBe('#67e8f9');
}

describe('SKILL.md', () => {
  it('has the cross-platform JS API line, with nothing a shell expands inside the double quotes', () => {
    const m = SKILL_MD().match(API_LINE_RE);
    expect(m, 'JS API line not found in SKILL.md').not.toBeNull();
    expect(m[1]).toMatch(/^const \{ pathToFileURL \} = await import\('node:url'\); const m = await import\(pathToFileURL\(process\.argv\[1\]\)\.href\); /);
    expect(m[1]).not.toMatch(/["$`\\!]/);
  });

  it('the JS API line runs with the real absolute skill path and does not start the CLI', () => {
    newTmp();
    saveBrand(tmp, base());
    const code = SKILL_MD().match(API_LINE_RE)[1];
    expectApiLineEffect(spawnSync(process.execPath, ['--input-type=module', '-e', code, join(SKILL_DIR, 'index.mjs')], { cwd: tmp, encoding: 'utf8' }));
  });

  const sh = posixShell();
  it.skipIf(!sh)('the JS API line runs as written through a POSIX shell (Git Bash on Windows)', () => {
    newTmp();
    saveBrand(tmp, base());
    // Claude Code substitutes the placeholder with the native absolute path
    // (backslashes on Windows). Pin node to the one running the tests.
    const line = SKILL_MD()
      .match(API_LINE_RE)[0]
      .replace('${CLAUDE_SKILL_DIR}', SKILL_DIR)
      .replace(/^node /, `"${process.execPath}" `);
    expectApiLineEffect(spawnSync(sh, ['-c', line], { cwd: tmp, encoding: 'utf8' }));
  });

  it('every CLI flag SKILL.md mentions is in --help, and every --help flag is in SKILL.md', () => {
    newTmp();
    const help = cli(['--help']).stdout;
    const flags = (text) => new Set([...text.matchAll(/(?<![\w-])(--[a-z][a-z-]*|-h)\b/g)].map((x) => x[1]));
    const inDoc = flags(SKILL_MD());
    inDoc.delete('--input-type'); // a node flag in the JS API line
    const inHelp = flags(help);
    expect([...inDoc].filter((f) => !inHelp.has(f))).toEqual([]);
    expect([...inHelp].filter((f) => !inDoc.has(f))).toEqual([]);
    expect(inHelp.size).toBeGreaterThanOrEqual(15);
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import { runCli } from '../plugins/atelier/skills/brand-asset-pipeline/index.mjs';

const PLUGIN = fileURLToPath(new URL('../plugins/atelier/', import.meta.url));
const ENTRY = join(PLUGIN, 'skills', 'brand-asset-pipeline', 'index.mjs');
const BIN = join(PLUGIN, 'bin', 'atelier');
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#e07a5f"/></svg>`;

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function setup() {
  tmp = mkdtempSync(join(tmpdir(), 'bap-cli-'));
  const mark = join(tmp, 'mark.svg');
  writeFileSync(mark, MARK_SVG);
  return { mark, out: join(tmp, 'out') };
}

async function run(argv) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

describe('brand-asset-pipeline CLI', { timeout: 30_000 }, () => {
  it.each([['--help'], ['-h']])('%s prints usage to stdout and exits 0', async (flag) => {
    const r = await run([flag]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Usage: atelier assets/);
    expect(r.stdout).toContain('--targets');
    expect(r.stderr).toBe('');
  });

  it.each([
    [[], /--out <dir> is required/],
    [['mark.svg'], /--out <dir> is required/],
    [['--out', 'x'], /pass the mark SVG path, or --root/],
    [['a.svg', 'b.svg', '--out', 'x'], /expected one mark file, got 2/],
    [['--nope'], /Unknown option '--nope'/],
    [['--out'], /argument missing/],
    [['m.svg', '--out', 'x', '--targets', 'favicons,bogus'], /Unknown target "bogus"/],
    [['m.svg', '--out', 'x', '--targets', ' , '], /targets is empty/],
    [['m.svg', '--out', 'x', '--bg', 'navy'], /Invalid --bg "navy"/],
    [['https://example.com/mark.svg', '--out', 'x'], /does not download/],
  ])('usage error %j exits 2 with usage on stderr', async (argv, message) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toContain('Usage: atelier assets');
  });

  it('writes the requested targets and lists them', async () => {
    const { mark, out } = setup();
    const r = await run([mark, '--out', out, '--targets', 'favicons, steam', '--bg', 'fff']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Wrote 8 files to .*targets: favicons, steam; background fff/);
    expect(r.stdout).toContain('  steam-capsule-small.png');
    expect(readdirSync(out).sort()).toHaveLength(8);
  });

  it('--json prints the result object with absolute paths', async () => {
    const { mark, out } = setup();
    const r = await run([mark, '-o', out, '-t', 'app-icons', '--json']);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout);
    expect(result.targets).toEqual(['app-icons']);
    expect(result.backgroundColor).toBe('#110f1b');
    expect(result.files.map((f) => basename(f))).toEqual(['apple-touch-icon.png', 'android-chrome-192.png', 'android-chrome-512.png']);
    for (const f of result.files) expect(resolve(f)).toBe(f);
  });

  it('accepts a file: URL for the mark', async () => {
    const { mark, out } = setup();
    const r = await run([pathToFileURL(mark).href, '--out', out, '--targets', 'favicons']);
    expect(r.code).toBe(0);
    expect(readdirSync(out)).toHaveLength(5);
  });

  it('runtime failures print a formatted error without usage and exit 2', async () => {
    const { out } = setup();
    const r = await run([join(tmp, 'missing.svg'), '--out', out]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: Cannot read mark .*missing\.svg: file not found/);
    expect(r.stderr).not.toContain('Usage:');
    expect(existsSync(out)).toBe(false);
  });

  it('--root reads brand.json: logos.mark, palette.bg and steam from deploy.stores', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-cli-'));
    mkdirSync(join(tmp, '.atelier'));
    writeFileSync(join(tmp, 'logo.svg'), MARK_SVG);
    writeFileSync(
      join(tmp, '.atelier', 'brand.json'),
      JSON.stringify({
        brand: { studio: 'T' },
        palette: { bg: '#00f' },
        typography: { body: 'Inter' },
        logos: { mark: 'logo.svg' },
        deploy: { stores: ['steam'] },
      }),
    );
    const out = join(tmp, 'out');
    const r = await run(['--root', tmp, '--out', out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('targets: favicons, app-icons, social, steam; background #00f');
    const { data } = await sharp(join(out, 'steam-header.png')).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });
});

describe('brand-asset-pipeline CLI as a process', { timeout: 60_000 }, () => {
  const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', shell: false, timeout: 30_000 });

  it('atelier assets --help exits 0', () => {
    const r = node([BIN, 'assets', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: atelier assets/);
  });

  it('index.mjs runs as a script and sets the exit code', () => {
    const { mark, out } = setup();
    const bad = node([ENTRY, mark, '--out', out, '--targets', 'nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Unknown target "nope"/);
    const good = node([ENTRY, mark, '--out', out, '--targets', 'favicons']);
    expect(good.status).toBe(0);
    expect(readdirSync(out)).toHaveLength(5);
  });

  it('importing the module does not run the CLI', () => {
    const r = node(['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(ENTRY).href)}); console.log('imported');`]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('imported');
  });
});

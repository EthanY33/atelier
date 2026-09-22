import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import { runCli } from '../plugins/atelier/skills/og-card-generator/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..', 'plugins', 'atelier');
const skillDir = join(pluginRoot, 'skills', 'og-card-generator');
const entry = join(skillDir, 'index.mjs');
const bin = join(pluginRoot, 'bin', 'atelier');

const brandJson = {
  brand: { studio: 'CliTest' },
  palette: { bg: '#110f1b', fg: '#f2cc8f' },
  typography: { body: 'system-ui' },
};

let tmp;
let link;

afterEach(() => {
  if (link) {
    try { unlinkSync(link); } catch { /* already gone */ }
    link = null;
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** A project directory with a valid .atelier/brand.json. */
function project() {
  tmp = mkdtempSync(join(tmpdir(), 'og-cli-test-'));
  mkdirSync(join(tmp, '.atelier'));
  writeFileSync(join(tmp, '.atelier', 'brand.json'), JSON.stringify(brandJson));
  return tmp;
}

async function run(argv, cwd = tmp ?? process.cwd()) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, { cwd, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}

describe('og-card-generator CLI: usage', () => {
  it('prints help to stdout and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^Usage:\n {2}atelier og <pages\.json> \[outDir\]/);
      expect(r.stderr).toBe('');
    }
  });

  it('writes to the process streams by default', async () => {
    const { stdout, stderr } = process;
    const writes = { stdout: stdout.write, stderr: stderr.write };
    let out = '';
    let err = '';
    stdout.write = (chunk) => { out += chunk; return true; };
    stderr.write = (chunk) => { err += chunk; return true; };
    let codes;
    try {
      codes = [await runCli(['--help']), await runCli(['--nope'])];
    } finally {
      stdout.write = writes.stdout;
      stderr.write = writes.stderr;
    }
    expect(codes).toEqual([0, 2]);
    expect(out).toContain('Usage:');
    expect(err).toContain("Unknown option '--nope'");
  });

  it.each([
    [[], /missing pages\.json/],
    [['--nope'], /Unknown option '--nope'/],
    [['a.json', 'out', 'extra'], /unexpected argument: extra/],
    [['a.json', 'out', '--out', 'other'], /give the output directory once/],
    [['--title', 'T', 'out'], /give the output directory with --out/],
    [['--slug', 'a'], /--subtitle and --slug need --title/],
    [['a.json', '--subtitle', 'S'], /--subtitle and --slug need --title/],
    [['--title'], /argument missing/],
  ])('exits 2 with usage on stderr for %j', async (argv, message) => {
    const r = await run(argv);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toMatch(/Usage:/);
    expect(r.stdout).toBe('');
  });
});

describe('og-card-generator CLI: runs', () => {
  it('renders a manifest with a UTF-8 BOM that is a bare array', async () => {
    const dir = project();
    writeFileSync(join(dir, 'pages.json'), String.fromCharCode(0xfeff) + JSON.stringify([{ slug: 'home', title: 'Home' }, { slug: 'blog/post', title: 'Post' }]));
    const r = await run(['pages.json', 'public/og']);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Generated 2 OG card(s):');
    expect(r.stdout).toContain(join('public', 'og', 'home.png'));
    const meta = await sharp(join(dir, 'public', 'og', 'blog', 'post.png')).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 630]);
  });

  it('renders one card from flags into the default og-cards directory', async () => {
    const dir = project();
    const r = await run(['--title', 'Launch', '--subtitle', 'Now', '--slug', 'launch']);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'og-cards', 'launch.png'))).toBe(true);
  });

  it('reads the brand from --project and writes to --out', async () => {
    const dir = project();
    const elsewhere = mkdtempSync(join(dir, 'cwd-'));
    writeFileSync(join(dir, 'pages.json'), JSON.stringify({ pages: [{ title: 'Index' }] }));
    const r = await run([join(dir, 'pages.json'), '--project', dir, '--out', join(dir, 'cards')], elsewhere);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'cards', 'index.png'))).toBe(true);
  });

  it('passes font files through and reports missing ones as runtime errors', async () => {
    project();
    const r = await run(['--title', 'T', '--font-display', 'nope.woff2']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: Cannot read font file .*nope\.woff2: file not found/);
  });

  it.each([
    ['a missing manifest', null, /^atelier: Cannot read .*pages\.json: file not found/],
    ['invalid JSON', '{ nope', /^atelier: .*pages\.json is not valid JSON/],
    ['the wrong shape', '{"items": []}', /^atelier: .*pages\.json: expected \{"pages"/],
    ['an unsafe slug', '{"pages": [{"slug": "../../escaped"}]}', /^atelier: pages\[0\]\.slug "\.\.\/\.\.\/escaped" is not a safe file name/],
  ])('exits 2 on %s', async (_, content, message) => {
    const dir = project();
    if (content !== null) writeFileSync(join(dir, 'pages.json'), content);
    const r = await run(['pages.json', 'out']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    expect(existsSync(join(dir, 'out'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(content === null ? ['.atelier'] : ['.atelier', 'pages.json']);
  });

  it('exits 2 when brand.json is missing', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'og-cli-test-'));
    const r = await run(['--title', 'T']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^atelier: .*brand\.json/);
  });
});

describe('og-card-generator CLI: process', () => {
  const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60_000 });

  it('runs as a script and through bin/atelier', () => {
    const direct = node([entry, '--help']);
    expect(direct.status).toBe(0);
    expect(direct.stdout).toContain('Usage:');
    const viaBin = node([bin, 'og', '--help']);
    expect(viaBin.status).toBe(0);
    expect(viaBin.stdout).toContain('atelier og <pages.json>');
    const usage = node([entry]);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('missing pages.json');
  });

  it('runs when reached through a symlink or junction', () => {
    tmp = mkdtempSync(join(tmpdir(), 'og-cli-link-'));
    link = join(tmp, 'skill');
    symlinkSync(skillDir, link, 'junction');
    const r = node([join(link, 'index.mjs'), '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('writes cards end to end and exits 0', async () => {
    const dir = project();
    writeFileSync(join(dir, 'pages.json'), JSON.stringify({ pages: [{ slug: 'home', title: 'Home' }] }));
    const r = node([entry, 'pages.json', 'og'], dir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, 'og', 'home.png'))).toBe(true);
  });
});

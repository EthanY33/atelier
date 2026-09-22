import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareOutDir } from '../plugins/atelier/scripts/run-demo.mjs';

// Regression for a bug caught before 1.0 shipped: `atelier demo --out .` used
// to rmSync the working directory.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'atelier');
const demoScript = join(pluginRoot, 'scripts', 'run-demo.mjs');
const MARKER = '.atelier-demo-output';
let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'demo-guard-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('run-demo prepareOutDir', () => {
  it('refuses the current directory and its parents', () => {
    expect(() => prepareOutDir(process.cwd())).toThrow(/current directory/);
    expect(() => prepareOutDir(dirname(process.cwd()))).toThrow(/current directory|home directory/);
  });

  it('refuses the home directory, its parents, and a filesystem root', () => {
    expect(() => prepareOutDir(homedir())).toThrow(/home directory|current directory/);
    expect(() => prepareOutDir(dirname(homedir()))).toThrow(/home directory|current directory|root/);
    expect(() => prepareOutDir(parse(tmp).root)).toThrow(/root|current directory/);
  });

  it('refuses the plugin install or anything inside it', () => {
    expect(() => prepareOutDir(pluginRoot)).toThrow(/plugin/);
    expect(() => prepareOutDir(join(pluginRoot, 'skills'))).toThrow(/plugin/);
  });

  it('refuses a non-empty directory it did not create and leaves it untouched', () => {
    const out = join(tmp, 'project');
    mkdirSync(join(out, 'brand'), { recursive: true });
    writeFileSync(join(out, 'brand', 'keep.txt'), 'user data');
    // A same-named directory must not count as the marker file.
    mkdirSync(join(out, MARKER));
    expect(() => prepareOutDir(out)).toThrow(/not created by atelier demo/);
    expect(readFileSync(join(out, 'brand', 'keep.txt'), 'utf8')).toBe('user data');
  });

  it('refuses an existing file', () => {
    const out = join(tmp, 'file.txt');
    writeFileSync(out, 'data');
    expect(() => prepareOutDir(out)).toThrow(/is a file/);
    expect(readFileSync(out, 'utf8')).toBe('data');
  });

  it('refuses a junction that points at the current directory or the plugin', () => {
    const toCwd = join(tmp, 'to-cwd');
    const toPlugin = join(tmp, 'to-plugin');
    symlinkSync(process.cwd(), toCwd, 'junction');
    symlinkSync(pluginRoot, toPlugin, 'junction');
    try {
      expect(() => prepareOutDir(toCwd)).toThrow(/current directory/);
      expect(() => prepareOutDir(toPlugin)).toThrow(/plugin/);
    } finally {
      // Remove the links themselves before the recursive temp-dir cleanup.
      unlinkSync(toCwd);
      unlinkSync(toPlugin);
    }
  });

  it('accepts a new directory and writes the marker', () => {
    const out = join(tmp, 'fresh');
    prepareOutDir(out);
    expect(existsSync(join(out, MARKER))).toBe(true);
  });

  it('accepts an existing empty directory', () => {
    const out = join(tmp, 'empty');
    mkdirSync(out);
    prepareOutDir(out);
    expect(readdirSync(out)).toEqual([MARKER]);
  });

  it('accepts a relative path', () => {
    const out = join(tmp, 'rel');
    prepareOutDir(relative(process.cwd(), out));
    expect(existsSync(join(out, MARKER))).toBe(true);
  });

  it('on a re-run removes only its own outputs', () => {
    const out = join(tmp, 'rerun');
    prepareOutDir(out);
    mkdirSync(join(out, 'og'));
    writeFileSync(join(out, 'og', 'home.png'), 'old');
    writeFileSync(join(out, 'photo.jpg'), 'old');
    writeFileSync(join(out, 'notes.md'), 'mine');
    mkdirSync(join(out, 'mine'));
    prepareOutDir(out);
    expect(existsSync(join(out, 'og'))).toBe(false);
    expect(existsSync(join(out, 'photo.jpg'))).toBe(false);
    expect(readFileSync(join(out, 'notes.md'), 'utf8')).toBe('mine');
    expect(existsSync(join(out, 'mine'))).toBe(true);
  });

  it('on a re-run removes a junction among its outputs without touching the target', () => {
    const out = join(tmp, 'rerun');
    const victim = join(tmp, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'precious');
    prepareOutDir(out);
    symlinkSync(victim, join(out, 'stage'), 'junction');
    prepareOutDir(out);
    expect(existsSync(join(out, 'stage'))).toBe(false);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('does not rewrite an existing marker', () => {
    const out = join(tmp, 'rerun');
    prepareOutDir(out);
    writeFileSync(join(out, MARKER), 'custom');
    prepareOutDir(out);
    expect(readFileSync(join(out, MARKER), 'utf8')).toBe('custom');
  });

  it('does not accept a symlink as the marker, so it never writes through one', (ctx) => {
    const out = join(tmp, 'linked');
    const outside = join(tmp, 'outside.txt');
    mkdirSync(out);
    writeFileSync(join(out, 'data.txt'), 'user data');
    writeFileSync(outside, 'outside');
    try {
      symlinkSync(outside, join(out, MARKER), 'file');
    } catch {
      ctx.skip(); // File symlinks need admin rights or Developer Mode on Windows.
    }
    expect(() => prepareOutDir(out)).toThrow(/not created by atelier demo/);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });
});

describe('run-demo.mjs command line', () => {
  const run = (args) => spawnSync(process.execPath, [demoScript, ...args], { cwd: tmp, encoding: 'utf8', timeout: 60_000 });

  it('prints usage for --help and exits 0 without writing', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: /);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('exits 2 with usage on stderr for an unknown flag', () => {
    const r = run(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown option '--bogus'/);
    expect(r.stderr).toContain('Usage: ');
  });

  it('exits 2 with a formatted error when the output directory is refused', () => {
    writeFileSync(join(tmp, 'keep.txt'), 'user data');
    const r = run(['--out', '.']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/atelier: Refusing to use /);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(tmp, 'keep.txt'), 'utf8')).toBe('user data');
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareOutDir } from '../plugins/atelier/scripts/run-demo.mjs';

// Regression for a bug caught before 1.0 shipped: `atelier demo --out .` used
// to rmSync the working directory.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'atelier');
let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'demo-guard-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('run-demo prepareOutDir', () => {
  it('refuses the current directory and its parents', () => {
    expect(() => prepareOutDir(process.cwd())).toThrow(/current directory/);
    expect(() => prepareOutDir(dirname(process.cwd()))).toThrow(/current directory/);
  });

  it('refuses the home directory and a filesystem root', () => {
    expect(() => prepareOutDir(homedir())).toThrow(/home directory|current directory/);
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
    mkdirSync(join(out, '.atelier-demo-output'));
    expect(() => prepareOutDir(out)).toThrow(/not created by atelier demo/);
    expect(readFileSync(join(out, 'brand', 'keep.txt'), 'utf8')).toBe('user data');
  });

  it('accepts a new directory and writes the marker', () => {
    const out = join(tmp, 'fresh');
    prepareOutDir(out);
    expect(existsSync(join(out, '.atelier-demo-output'))).toBe(true);
  });

  it('on a re-run removes only its own outputs', () => {
    const out = join(tmp, 'rerun');
    prepareOutDir(out);
    mkdirSync(join(out, 'og'));
    writeFileSync(join(out, 'og', 'home.png'), 'old');
    writeFileSync(join(out, 'notes.md'), 'mine');
    prepareOutDir(out);
    expect(existsSync(join(out, 'og'))).toBe(false);
    expect(readFileSync(join(out, 'notes.md'), 'utf8')).toBe('mine');
  });
});

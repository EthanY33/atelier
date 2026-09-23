import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOnPath } from '../../plugins/atelier/lib/preflight.mjs';
import { isWin, makeTmp, touch } from './helpers.mjs';

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('findonpath')); });
afterEach(() => cleanup());

// The `platform` option picks the lookup rules; the filesystem is the host's,
// so the win32 rules can be exercised on every OS.
const win = (PATH) => ({ env: { PATH }, platform: 'win32' });
const posix = (PATH) => ({ env: { PATH }, platform: 'linux' });

describe('findOnPath with win32 rules', () => {
  it('finds name.exe in a PATH directory and returns its full path', () => {
    const exe = touch(join(tmp, 'bin', 'tool.exe'));
    expect(findOnPath('tool', win(join(tmp, 'bin')))).toBe(exe);
  });

  it('falls back to .com when there is no .exe', () => {
    const com = touch(join(tmp, 'bin', 'tool.com'));
    expect(findOnPath('tool', win(join(tmp, 'bin')))).toBe(com);
  });

  it('ignores .cmd and .bat shims, which cannot be spawned without a shell', () => {
    touch(join(tmp, 'a', 'tool.cmd'));
    touch(join(tmp, 'a', 'tool.bat'));
    touch(join(tmp, 'a', 'tool'));
    expect(findOnPath('tool', win(join(tmp, 'a')))).toBeNull();
    expect(findOnPath('tool.cmd', win(join(tmp, 'a')))).toBeNull();
    expect(findOnPath('tool.bat', win(join(tmp, 'a')))).toBeNull();

    const exe = touch(join(tmp, 'b', 'tool.exe'));
    expect(findOnPath('tool', win(`${join(tmp, 'a')};${join(tmp, 'b')}`))).toBe(exe);
  });

  it('accepts a name that already carries .exe, in any case', () => {
    const exe = touch(join(tmp, 'bin', 'tool.exe'));
    expect(findOnPath('tool.exe', win(join(tmp, 'bin')))).toBe(exe);
    // Only a case-insensitive filesystem (Windows, default macOS) can find tool.EXE.
    if (existsSync(join(tmp, 'bin', 'TOOL.EXE'))) {
      expect(findOnPath('tool.EXE', win(join(tmp, 'bin')))?.toLowerCase()).toBe(exe.toLowerCase());
    }
  });

  it('skips a directory named like the binary and keeps searching', () => {
    mkdirSync(join(tmp, 'a', 'tool.exe'), { recursive: true });
    mkdirSync(join(tmp, 'a', 'tool.com'), { recursive: true });
    const exe = touch(join(tmp, 'b', 'tool.exe'));
    expect(findOnPath('tool', win(`${join(tmp, 'a')};${join(tmp, 'b')}`))).toBe(exe);
    expect(findOnPath('tool', win(join(tmp, 'a')))).toBeNull();
  });

  it('strips double quotes from PATH entries, including partial quoting', () => {
    const spaced = join(tmp, 'Program Files', 'Tool');
    const exe = touch(join(spaced, 'tool.exe'));
    expect(findOnPath('tool', win(`"${spaced}"`))).toBe(exe);
    expect(findOnPath('tool', win(`  "${spaced}"  `))).toBe(exe);
    const partial = join(tmp, '"Program Files"', 'Tool');
    expect(findOnPath('tool', win(partial))).toBe(exe);
  });

  it('skips empty and blank entries', () => {
    const exe = touch(join(tmp, 'bin', 'tool.exe'));
    expect(findOnPath('tool', win(`;;   ;"";${join(tmp, 'bin')};`))).toBe(exe);
  });

  it('reads PATH under any casing from a plain env object', () => {
    const exe = touch(join(tmp, 'bin', 'tool.exe'));
    expect(findOnPath('tool', { env: { Path: join(tmp, 'bin') }, platform: 'win32' })).toBe(exe);
    expect(findOnPath('tool', { env: { pAtH: join(tmp, 'bin') }, platform: 'win32' })).toBe(exe);
  });

  it('prefers an exact PATH key over other casings', () => {
    touch(join(tmp, 'old', 'tool.exe'));
    const exe = touch(join(tmp, 'new', 'tool.exe'));
    expect(findOnPath('tool', { env: { Path: join(tmp, 'old'), PATH: join(tmp, 'new') }, platform: 'win32' })).toBe(exe);
  });

  it('checks an absolute path directly and adds .exe/.com when it has no extension', () => {
    const exe = touch(join(tmp, 'bin', 'tool.exe'));
    expect(findOnPath(exe, win(''))).toBe(exe);
    expect(findOnPath(join(tmp, 'bin', 'tool'), win(''))).toBe(exe);
    expect(findOnPath(join(tmp, 'bin', 'missing.exe'), win(''))).toBeNull();
  });

  it('rejects an absolute path to a shim or a directory', () => {
    const cmd = touch(join(tmp, 'bin', 'tool.cmd'));
    mkdirSync(join(tmp, 'dir.exe'));
    expect(findOnPath(cmd, win(''))).toBeNull();
    expect(findOnPath(join(tmp, 'dir.exe'), win(''))).toBeNull();
  });

  it('resolves a relative name with a separator against the cwd, never PATH', () => {
    const exe = touch(join(tmp, 'sub', 'tool.exe'));
    // Present on PATH as sub/tool.exe, but a name with a separator is not searched there.
    expect(findOnPath(join('sub', 'tool'), win(tmp))).toBeNull();
    const rel = relative(process.cwd(), exe);
    // On Windows a temp dir on another drive makes `relative` return an absolute path.
    const found = findOnPath(rel, win(''));
    expect(found?.toLowerCase()).toBe(exe.toLowerCase());
  });
});

describe('findOnPath with POSIX rules', () => {
  it('finds a bare name in a PATH directory', () => {
    const bin = touch(join(tmp, 'bin', 'tool'));
    expect(findOnPath('tool', posix(join(tmp, 'bin')))).toBe(bin);
  });

  it('searches PATH entries in order', () => {
    const first = touch(join(tmp, 'a', 'tool'));
    touch(join(tmp, 'b', 'tool'));
    expect(findOnPath('tool', posix([join(tmp, 'a'), join(tmp, 'b')].join(delimiter)))).toBe(first);
  });

  it('skips a directory named like the binary', () => {
    mkdirSync(join(tmp, 'a', 'tool'), { recursive: true });
    const bin = touch(join(tmp, 'b', 'tool'));
    expect(findOnPath('tool', posix([join(tmp, 'a'), join(tmp, 'b')].join(delimiter)))).toBe(bin);
  });

  it('strips surrounding quotes from an entry', () => {
    const bin = touch(join(tmp, 'my bin', 'tool'));
    expect(findOnPath('tool', posix(`"${join(tmp, 'my bin')}"`))).toBe(bin);
  });

  it.skipIf(isWin)('skips a file without the execute bit', () => {
    touch(join(tmp, 'a', 'tool'), '', { exec: false });
    const bin = touch(join(tmp, 'b', 'tool'));
    expect(findOnPath('tool', posix(`${join(tmp, 'a')}:${join(tmp, 'b')}`))).toBe(bin);
    expect(findOnPath(join(tmp, 'a', 'tool'), posix(''))).toBeNull();
  });

  it('checks an absolute path directly', () => {
    const bin = touch(join(tmp, 'bin', 'tool'));
    expect(findOnPath(bin, posix(''))).toBe(bin);
    expect(findOnPath(join(tmp, 'bin'), posix(''))).toBeNull();
    expect(findOnPath(join(tmp, 'bin', 'nope'), posix(''))).toBeNull();
  });
});

describe('findOnPath edge cases', () => {
  it('returns null for empty or non-string names', () => {
    for (const name of ['', '   ', undefined, null, 42, {}]) expect(findOnPath(name, win(tmp))).toBeNull();
  });

  it('returns null when PATH is unset or empty', () => {
    expect(findOnPath('node', { env: {} })).toBeNull();
    expect(findOnPath('node', { env: { PATH: '' } })).toBeNull();
  });

  it('finds the real node binary on the host PATH', () => {
    const node = findOnPath('node');
    expect(node).not.toBeNull();
    expect(isAbsolute(node)).toBe(true);
    if (isWin) expect(node).toMatch(/\.exe$/i);
  });
});

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBinary,
  checkNodeModule,
  findOnPath,
  PreflightError,
  runPreflight,
} from '../../plugins/atelier/lib/preflight.mjs';
import { isWin, makeTmp, touch } from './helpers.mjs';

const hasFfmpeg = findOnPath('ffmpeg') !== null;
const js = (code) => ['-e', code];

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('checkbin')); });
afterEach(() => cleanup());

describe('checkBinary', () => {
  it('runs node --version and reports the first line as the version', async () => {
    const r = await checkBinary('node', ['--version']);
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(isAbsolute(r.path)).toBe(true);
  });

  it('defaults to --version', async () => {
    const r = await checkBinary('node');
    expect(r).toMatchObject({ ok: true, version: `v${process.versions.node}` });
  });

  it.skipIf(!hasFfmpeg)('runs ffmpeg -version', async () => {
    const r = await checkBinary('ffmpeg', ['-version']);
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^ffmpeg version /);
    expect(r.path).toBe(findOnPath('ffmpeg'));
  });

  it('reports a missing binary without spawning anything', async () => {
    const r = await checkBinary('this-binary-does-not-exist-xyz-12345', ['--version']);
    expect(r).toEqual({ ok: false, error: 'this-binary-does-not-exist-xyz-12345 not found on PATH' });
  });

  it('resolves the command against the env option', async () => {
    const r = await checkBinary('node', ['--version'], { env: { PATH: '' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found on PATH/);
  });

  it('accepts an absolute path', async () => {
    const r = await checkBinary(process.execPath, ['--version']);
    expect(r).toMatchObject({ ok: true, path: process.execPath });
  });

  // Regression: arguments must reach the binary literally. With a shell, `&`
  // would start a second command and `>` would create a file.
  it('passes shell metacharacters literally and never executes them', async () => {
    const r = await checkBinary('node', js('console.log(process.argv.length)').concat(['&', 'echo', 'pwned']));
    expect(r.ok).toBe(true);
    // argv is [execPath, '&', 'echo', 'pwned']: one process, nothing echoed.
    expect(r.version).toBe('4');

    const pwned = join(tmp, 'pwned.txt');
    const literal = [
      '&', 'echo', 'pwned', '>', pwned,
      '|', 'more', ';', 'touch', join(tmp, 'touched'),
      '&&', 'calc', '$(whoami)', '`id`', '%PATH%', '"quoted arg"', 'a b',
    ];
    const r2 = await checkBinary('node', js('console.log(JSON.stringify(process.argv.slice(1)))').concat(literal));
    expect(r2.ok).toBe(true);
    expect(JSON.parse(r2.version)).toEqual(literal);
    expect(existsSync(pwned)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('prefers stdout for the version and falls back to stderr', async () => {
    const both = await checkBinary('node', js("console.error('warning: noise'); console.log('tool 1.2.3')"));
    expect(both.version).toBe('tool 1.2.3');
    const errOnly = await checkBinary('node', js("console.error('java version 21')"));
    expect(errOnly.version).toBe('java version 21');
  });

  it('reports the first stderr line when the binary fails', async () => {
    const r = await checkBinary('node', js("process.stderr.write('boom: bad flag\\nmore\\n'); process.exit(3)"));
    expect(r).toMatchObject({ ok: false, error: 'boom: bad flag' });
    expect(isAbsolute(r.path)).toBe(true);
  });

  it('reports the exit code when a failing binary prints nothing', async () => {
    const r = await checkBinary('node', js('process.exit(4)'));
    expect(r).toMatchObject({ ok: false, error: 'exited with code 4' });
  });

  it('reports a child that dies from a signal', async () => {
    const r = await checkBinary('node', js("process.kill(process.pid, 'SIGKILL')"));
    expect(r.ok).toBe(false);
    // POSIX reports the signal; Windows reports TerminateProcess's exit code.
    expect(r.error).toMatch(/killed by SIGKILL|exited with code/);
  });

  it('gives the child a closed stdin, so a binary that reads stdin cannot hang', async () => {
    const r = await checkBinary('node', js("process.stdin.on('data', () => {}).on('end', () => console.log('eof'))"), { timeoutMs: 20_000 });
    expect(r).toMatchObject({ ok: true, version: 'eof' });
  });

  it('kills a binary that hangs and reports the timeout', async () => {
    const started = Date.now();
    const r = await checkBinary('node', js('setTimeout(() => {}, 30000)'), { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, error: 'timed out after 300 ms' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('settles on the timeout even when a grandchild keeps the output pipes open', async () => {
    const started = Date.now();
    const r = await checkBinary('node', js(
      "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000)",
    ), { timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, error: 'timed out after 500 ms' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns ok:false instead of throwing when spawn rejects the arguments', async () => {
    const r = await checkBinary('node', ['--version\0']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/null bytes/);
  });

  it.skipIf(!isWin)('returns ok:false when the file is not a real executable', async () => {
    const fake = touch(join(tmp, 'fake.exe'), 'not a PE file');
    const r = await checkBinary(fake, ['-version']);
    expect(r).toMatchObject({ ok: false, path: fake });
    expect(r.error).toMatch(/spawn/);
  });

  it.skipIf(isWin)('returns ok:false when an executable script fails', async () => {
    const fake = touch(join(tmp, 'fake'), '#!/bin/sh\necho "fake: broken" >&2\nexit 5\n');
    const r = await checkBinary(fake, ['-version']);
    expect(r).toMatchObject({ ok: false, path: fake, error: 'fake: broken' });
  });
});

describe('checkNodeModule', () => {
  it('resolves a plugin dependency', async () => {
    expect(await checkNodeModule('sharp')).toEqual({ ok: true });
    expect(await checkNodeModule('playwright')).toEqual({ ok: true });
  });

  it('reports a missing module with the resolver message', async () => {
    const r = await checkNodeModule('this-module-does-not-exist-xyz-12345');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/this-module-does-not-exist-xyz-12345/);
  });
});

describe('runPreflight', () => {
  it('returns one merged result per check when everything is present', async () => {
    const results = await runPreflight([
      { kind: 'bin', cmd: 'node' },
      { kind: 'module', name: 'sharp' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ kind: 'bin', cmd: 'node', ok: true });
    expect(results[0].version).toMatch(/^v\d+/);
    expect(results[1]).toMatchObject({ kind: 'module', name: 'sharp', ok: true });
  });

  it('throws one PreflightError listing every failure with its install hint', async () => {
    const err = await runPreflight([
      { kind: 'bin', cmd: 'this-binary-does-not-exist-xyz-12345', install: 'brew install xyz' },
      { kind: 'module', name: 'this-module-does-not-exist-xyz-12345', install: 'npm install xyz' },
      { kind: 'module', name: 'sharp' },
      { kind: 'bin', cmd: 'another-missing-binary-xyz' },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.code).toBe('PREFLIGHT_FAILED');
    expect(err.message).toContain('Missing binary: this-binary-does-not-exist-xyz-12345\n  Install: brew install xyz');
    expect(err.message).toContain('Missing module: this-module-does-not-exist-xyz-12345\n  Install: npm install xyz');
    expect(err.message).toMatch(/Missing binary: another-missing-binary-xyz$/m);
    expect(err.message).not.toContain('sharp');
  });

  it('rejects an unknown check kind', async () => {
    await expect(runPreflight([{ kind: 'nope' }])).rejects.toThrow(/Unknown preflight check kind: nope/);
  });

  it('passes args through to the binary', async () => {
    const [r] = await runPreflight([{ kind: 'bin', cmd: 'node', args: ['-e', "console.log('custom args')"] }]);
    expect(r.version).toBe('custom args');
  });
});

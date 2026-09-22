/**
 * Shared helpers for the lib/ and bin/ tests. Not a test file itself.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const isWin = process.platform === 'win32';
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const pluginRoot = join(repoRoot, 'plugins', 'atelier');
export const libDir = join(pluginRoot, 'lib');
export const binPath = join(pluginRoot, 'bin', 'atelier');

/** file:// URL of a lib module, for `import` inside a child process. */
export const libUrl = (name) => pathToFileURL(join(libDir, name)).href;

/** A fresh temp directory; call the returned cleanup in afterEach. */
export function makeTmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `atelier-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write a file, creating parent directories; `exec` sets the execute bit on POSIX. */
export function touch(path, content = '', { exec = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (!isWin) chmodSync(path, exec ? 0o755 : 0o644);
  return path;
}

/**
 * process.env with every casing of PATH removed, then PATH set to `path`.
 * (A spread of process.env on Windows carries `Path`, which would otherwise
 * sit next to the new `PATH`.)
 */
export function envWithPath(path, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== 'PATH') env[k] = v;
  }
  return { ...env, PATH: path, ...extra };
}

/** Run `node <args>` synchronously, never through a shell. */
export function runNode(args, { cwd, env, timeout = 60_000 } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, env: env ?? process.env, encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** Run an ES module snippet in a child Node process. */
export function runModule(code, opts) {
  return runNode(['--input-type=module', '-e', code], opts);
}

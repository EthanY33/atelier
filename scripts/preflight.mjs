/**
 * Preflight helpers for atelier skills.
 * Checks that required binaries and Node modules are available before running.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Check whether a CLI binary is available and reachable.
 * @param {string} cmd - The command to test (e.g. 'node', 'ffmpeg').
 * @param {string[]} [args=['--version']] - Arguments to pass.
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export function checkBinary(cmd, args = ['--version']) {
  return new Promise((resolve) => {
    const opts = { shell: process.platform === 'win32' };
    const child = spawn(cmd, args, opts);

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    child.on('close', (code) => {
      if (code === 0) {
        const version = (stdout.trim() || stderr.trim()).split('\n')[0].trim();
        resolve({ ok: true, version });
      } else {
        resolve({ ok: false, error: stderr.trim() || `exited with code ${code}` });
      }
    });
  });
}

/**
 * Check whether a Node module can be resolved from the current project.
 * @param {string} name - Module name (e.g. 'vitest').
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function checkNodeModule(name) {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run a batch of preflight checks and throw an aggregated error if any fail.
 * @param {Array<{ kind: 'bin'|'module', cmd?: string, name?: string, args?: string[], install?: string }>} checks
 * @returns {Promise<Array<object>>} per-check results on success.
 */
export async function runPreflight(checks) {
  const results = [];
  const failures = [];

  for (const check of checks) {
    if (check.kind === 'bin') {
      const result = await checkBinary(check.cmd, check.args);
      results.push({ ...check, ...result });
      if (!result.ok) {
        const hint = check.install ? `  Install: ${check.install}` : '';
        failures.push(`Missing binary: ${check.cmd}${hint ? '\n' + hint : ''}`);
      }
    } else if (check.kind === 'module') {
      const result = await checkNodeModule(check.name);
      results.push({ ...check, ...result });
      if (!result.ok) {
        const hint = check.install ? `  Install: ${check.install}` : '';
        failures.push(`Missing module: ${check.name}${hint ? '\n' + hint : ''}`);
      }
    } else {
      failures.push(`Unknown preflight check kind: ${check.kind}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Preflight failed:\n${failures.join('\n')}`);
  }
  return results;
}

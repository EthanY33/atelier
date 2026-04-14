import { describe, it, expect } from 'vitest';
import { checkBinary, checkNodeModule, runPreflight } from '../scripts/preflight.mjs';

describe('preflight', () => {
  it('checkBinary("node", ["--version"]) returns ok:true and a version string starting with v', async () => {
    const result = await checkBinary('node', ['--version']);
    expect(result.ok).toBe(true);
    expect(result.version).toBeDefined();
    expect(result.version.startsWith('v')).toBe(true);
  });

  it('checkBinary with nonexistent binary returns ok:false', async () => {
    const result = await checkBinary('this-binary-does-not-exist-xyz-12345', ['--version']);
    expect(result.ok).toBe(false);
  });

  it('checkNodeModule("vitest") returns ok:true', () => {
    const result = checkNodeModule('vitest');
    expect(result.ok).toBe(true);
  });

  it('checkNodeModule with nonexistent module returns ok:false', () => {
    const result = checkNodeModule('this-module-does-not-exist-xyz-12345');
    expect(result.ok).toBe(false);
  });

  it('runPreflight rejects when a check fails', async () => {
    const checks = [
      { kind: 'bin', cmd: 'this-binary-does-not-exist-xyz-12345', install: 'brew install xyz' },
      { kind: 'module', name: 'this-module-does-not-exist-xyz-12345', install: 'npm install xyz' }
    ];
    await expect(runPreflight(checks)).rejects.toThrow();
  });
});

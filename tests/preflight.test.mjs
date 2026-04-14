import { describe, it, expect } from 'vitest';
import { checkBinary, checkNodeModule, runPreflight } from '../scripts/preflight.mjs';

describe('preflight', () => {
  it('checkBinary("node", ["--version"]) returns ok:true and a version matching /^v\\d+/', async () => {
    const result = await checkBinary('node', ['--version']);
    expect(result.ok).toBe(true);
    expect(result.version).toMatch(/^v\d+/);
  });

  it('checkBinary with nonexistent binary returns ok:false', async () => {
    const result = await checkBinary('this-binary-does-not-exist-xyz-12345', ['--version']);
    expect(result.ok).toBe(false);
  });

  it('checkNodeModule("vitest") returns ok:true', async () => {
    const result = await checkNodeModule('vitest');
    expect(result.ok).toBe(true);
  });

  it('checkNodeModule with nonexistent module returns ok:false', async () => {
    const result = await checkNodeModule('this-module-does-not-exist-xyz-12345');
    expect(result.ok).toBe(false);
  });

  it('runPreflight rejects when a check fails', async () => {
    const checks = [
      { kind: 'bin', cmd: 'this-binary-does-not-exist-xyz-12345', install: 'brew install xyz' },
      { kind: 'module', name: 'this-module-does-not-exist-xyz-12345', install: 'npm install xyz' }
    ];
    await expect(runPreflight(checks)).rejects.toThrow(/[Pp]reflight/);
  });
});

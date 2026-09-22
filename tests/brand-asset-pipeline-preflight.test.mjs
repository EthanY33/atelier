/**
 * A plugin install without a working sharp must fail with one actionable
 * message, not a raw ERR_MODULE_NOT_FOUND at import time. Kept in its own
 * file because it mocks sharp for the whole module graph.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { pluginRequire } from './helpers/plugin-deps.mjs';

const SKILL = '../plugins/atelier/skills/brand-asset-pipeline/index.mjs';
const SHARP_ESM = fileURLToPath(new URL('../dist/index.mjs', `file:///${pluginRequire.resolve('sharp').replaceAll('\\', '/')}`));

describe('brand-asset-pipeline without sharp', () => {
  it('loads, prints --help, and reports SHARP_MISSING with a fix', async () => {
    vi.resetModules();
    vi.doMock(SHARP_ESM, () => {
      throw new Error('Could not load the "sharp" module using the test runtime');
    });
    const { generateAssets, runCli } = await import(SKILL);

    let out = '';
    expect(await runCli(['--help'], { stdout: { write: (s) => { out += s; } } })).toBe(0);
    expect(out).toMatch(/^Usage: atelier assets/);

    const err = await generateAssets({ markSvg: 'mark.svg', outDir: 'out' }).catch((e) => e);
    expect(err.name).toBe('PreflightError');
    expect(err.code).toBe('SHARP_MISSING');
    // vitest rewrites a throwing mock factory's message, so only the prefix is stable.
    expect(err.message).toMatch(/^sharp could not be loaded \(.+\)\.$/);
    expect(err.fix).toMatch(/npm ci/);

    let errText = '';
    const code = await runCli(['mark.svg', '--out', 'out'], { stderr: { write: (s) => { errText += s; } } });
    expect(code).toBe(2);
    expect(errText).toMatch(/^atelier: sharp could not be loaded/);
    expect(errText).toMatch(/\n {2}Fix: .*npm ci/);

    vi.doUnmock(SHARP_ESM);
    vi.resetModules();
  });
});

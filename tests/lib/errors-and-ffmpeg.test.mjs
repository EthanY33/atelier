import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureFfmpeg,
  findOnPath,
  formatError,
  playwrightVersion,
  PreflightError,
} from '../../plugins/atelier/lib/preflight.mjs';
import { pluginRequire } from '../helpers/plugin-deps.mjs';
import { envWithPath, isWin, libUrl, makeTmp, runModule, touch } from './helpers.mjs';

const hasFfmpeg = findOnPath('ffmpeg') !== null;

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('errors')); });
afterEach(() => cleanup());

describe('PreflightError', () => {
  it('carries name, code, fix and cause', () => {
    const cause = new Error('root cause');
    const err = new PreflightError('thing missing', { code: 'THING_MISSING', fix: 'install thing', cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PreflightError');
    expect(err.message).toBe('thing missing');
    expect(err.code).toBe('THING_MISSING');
    expect(err.fix).toBe('install thing');
    expect(err.cause).toBe(cause);
  });

  it('works without options', () => {
    const err = new PreflightError('bare');
    expect(err.code).toBeUndefined();
    expect(err.fix).toBeUndefined();
    expect('cause' in err).toBe(false);
  });
});

describe('formatError', () => {
  it('appends the fix of a PreflightError on its own line', () => {
    const err = new PreflightError('ffmpeg was not found on PATH.', { code: 'FFMPEG_MISSING', fix: 'brew install ffmpeg' });
    expect(formatError(err)).toBe('atelier: ffmpeg was not found on PATH.\n  Fix: brew install ffmpeg');
  });

  it('prints a PreflightError without a fix as one line', () => {
    expect(formatError(new PreflightError('Preflight failed', { code: 'PREFLIGHT_FAILED' }))).toBe('atelier: Preflight failed');
  });

  it('keeps the message of an ordinary error and drops the stack', () => {
    const out = formatError(new TypeError('bad input'));
    expect(out).toBe('atelier: bad input');
    expect(out).not.toMatch(/\bat\s/);
  });

  it('treats any error with a string fix like a PreflightError', () => {
    const err = Object.assign(new Error('brand.json is invalid'), { fix: 'run /brand-audit' });
    expect(formatError(err)).toBe('atelier: brand.json is invalid\n  Fix: run /brand-audit');
    expect(formatError(Object.assign(new Error('x'), { fix: '' }))).toBe('atelier: x');
    expect(formatError(Object.assign(new Error('x'), { fix: 42 }))).toBe('atelier: x');
  });

  it('falls back to the error name when the message is empty', () => {
    expect(formatError(new RangeError())).toBe('atelier: RangeError');
  });

  it('renders non-Error values without throwing', () => {
    expect(formatError('plain string')).toBe('atelier: plain string');
    expect(formatError({ message: 'error-like object' })).toBe('atelier: error-like object');
    expect(formatError(42)).toBe('atelier: 42');
    expect(formatError(null)).toBe('atelier: null');
    expect(formatError(undefined)).toBe('atelier: undefined');
    expect(formatError(Object.create(null))).toBe('atelier: unknown error');
  });
});

describe('ensureFfmpeg', () => {
  it.skipIf(!hasFfmpeg)('returns the absolute path of ffmpeg on PATH', () => {
    expect(ensureFfmpeg()).toBe(findOnPath('ffmpeg'));
  });

  it('throws FFMPEG_MISSING when PATH is empty', () => {
    let err;
    try {
      ensureFfmpeg({ env: { PATH: '' } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PreflightError);
    expect(err.code).toBe('FFMPEG_MISSING');
    expect(err.message).toBe('ffmpeg was not found on PATH.');
    expect(err.fix).toBeTruthy();
  });

  it('gives a per-OS install hint', () => {
    const fixFor = (platform) => {
      try {
        ensureFfmpeg({ env: { PATH: '' }, platform });
      } catch (e) {
        return e.fix;
      }
      return null;
    };
    expect(fixFor('win32')).toMatch(/^winget install Gyan\.FFmpeg/);
    expect(fixFor('darwin')).toBe('brew install ffmpeg');
    expect(fixFor('linux')).toMatch(/^sudo apt install ffmpeg/);
  });

  it('finds ffmpeg in a directory given through the env option', () => {
    const name = isWin ? 'ffmpeg.exe' : 'ffmpeg';
    const fake = touch(join(tmp, 'bin', name));
    expect(ensureFfmpeg({ env: { PATH: join(tmp, 'bin') } })).toBe(fake);
  });

  it('throws FFMPEG_MISSING in a child process whose PATH is empty', () => {
    const r = runModule(
      `import { ensureFfmpeg, formatError } from ${JSON.stringify(libUrl('preflight.mjs'))};
       try { ensureFfmpeg(); console.log('found'); }
       catch (e) { console.log(JSON.stringify({ code: e.code, text: formatError(e) })); }`,
      { env: envWithPath('') },
    );
    expect(r.stderr).toBe('');
    const out = JSON.parse(r.stdout);
    expect(out.code).toBe('FFMPEG_MISSING');
    expect(out.text).toMatch(/^atelier: ffmpeg was not found on PATH\.\n {2}Fix: \S/);
  });
});

describe('playwrightVersion', () => {
  it('reports the installed Playwright version', () => {
    expect(playwrightVersion()).toBe(pluginRequire('playwright/package.json').version);
  });
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginRequire } from '../helpers/plugin-deps.mjs';
import { libUrl, makeTmp, pluginRoot, runModule } from './helpers.mjs';

const pwVersion = pluginRequire('playwright/package.json').version;
// The module lib/preflight.mjs gets from `import('playwright')`.
const playwrightEntry = join(pluginRoot, 'node_modules', 'playwright', 'index.mjs');

let chromiumInstalled = false;
try {
  const { chromium } = pluginRequire('playwright');
  chromiumInstalled = existsSync(chromium.executablePath());
} catch {
  chromiumInstalled = false;
}

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('chromium')); });
afterEach(() => {
  cleanup();
  vi.doUnmock(playwrightEntry);
  vi.resetModules();
});

/** Import a fresh preflight.mjs whose `playwright` is replaced by `launch`. */
async function withLaunch(launch) {
  vi.resetModules();
  vi.doMock(playwrightEntry, () => ({ chromium: { launch } }));
  return import('../../plugins/atelier/lib/preflight.mjs');
}

describe('launchChromium with a real Playwright', () => {
  it('turns a missing browser into PreflightError CHROMIUM_MISSING with the exact install command', () => {
    // An empty browsers directory is what a fresh install looks like.
    const r = runModule(
      `import { launchChromium, formatError } from ${JSON.stringify(libUrl('preflight.mjs'))};
       try { const b = await launchChromium(); await b.close(); console.log(JSON.stringify({ launched: true })); }
       catch (e) { console.log(JSON.stringify({ name: e.name, code: e.code, fix: e.fix, message: e.message, cause: String(e.cause?.message), text: formatError(e) })); }`,
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: tmp } },
    );
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      name: 'PreflightError',
      code: 'CHROMIUM_MISSING',
      fix: `npx playwright@${pwVersion} install chromium`,
      message: 'Playwright Chromium is not installed.',
    });
    expect(out.cause).toMatch(/Executable doesn't exist/);
    expect(out.text).toBe(`atelier: Playwright Chromium is not installed.\n  Fix: npx playwright@${pwVersion} install chromium`);
  });

  it.skipIf(!chromiumInstalled)('launches Chromium when it is installed', async () => {
    const { launchChromium } = await import('../../plugins/atelier/lib/preflight.mjs');
    const browser = await launchChromium();
    try {
      expect(browser.version()).toMatch(/^\d+\./);
    } finally {
      await browser.close();
    }
  });

  it('does not blame the Playwright install for a missing custom executablePath', async () => {
    const { launchChromium, PreflightError } = await import('../../plugins/atelier/lib/preflight.mjs');
    const err = await launchChromium({ executablePath: join(tmp, 'no-such-browser.exe') }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PreflightError);
    expect(err.message).toMatch(/executable doesn't exist/i);
  });
});

describe('launchChromium error classification', () => {
  it('passes launch options through and returns the browser', async () => {
    const browser = { version: () => '140.0' };
    const launch = vi.fn(async () => browser);
    const { launchChromium } = await withLaunch(launch);
    await expect(launchChromium({ headless: true, args: ['--x'] })).resolves.toBe(browser);
    expect(launch).toHaveBeenCalledWith({ headless: true, args: ['--x'] });
    await launchChromium();
    expect(launch).toHaveBeenLastCalledWith({});
  });

  it('maps the "download new browsers" banner to CHROMIUM_MISSING', async () => {
    const { launchChromium } = await withLaunch(async () => {
      throw new Error('browserType.launch: Looks like Playwright was just installed or updated.\nPlease run the following command to download new browsers:\n    npx playwright install');
    });
    const err = await launchChromium().catch((e) => e);
    expect(err.code).toBe('CHROMIUM_MISSING');
    expect(err.fix).toBe(`npx playwright@${pwVersion} install chromium`);
    expect(err.cause.message).toMatch(/download new browsers/);
  });

  it('names the channel to install when a branded channel is missing', async () => {
    const { launchChromium } = await withLaunch(async () => {
      throw new Error('Chromium distribution \'chrome\' is not found at /opt/google/chrome/chrome\nRun "npx playwright install chrome"');
    });
    const err = await launchChromium({ channel: 'chrome' }).catch((e) => e);
    expect(err.code).toBe('CHROMIUM_MISSING');
    expect(err.fix).toBe(`npx playwright@${pwVersion} install chrome`);
    expect(err.message).toBe('Playwright browser channel "chrome" is not installed.');

    const shell = await launchChromium({ channel: 'chromium-headless-shell' }).catch((e) => e);
    expect(shell.fix).toBe(`npx playwright@${pwVersion} install chromium`);
  });

  // Regression: "install-deps" contains "playwright install", so missing
  // Linux libraries used to be reported as a missing browser.
  it('maps missing Linux system libraries to CHROMIUM_DEPS_MISSING', async () => {
    const { launchChromium } = await withLaunch(async () => {
      throw new Error('browserType.launch:\nHost system is missing dependencies to run browsers.\nPlease install them with the following command:\n\n    sudo npx playwright install-deps');
    });
    const err = await launchChromium().catch((e) => e);
    expect(err.name).toBe('PreflightError');
    expect(err.code).toBe('CHROMIUM_DEPS_MISSING');
    expect(err.fix).toBe(`sudo npx playwright@${pwVersion} install-deps chromium`);
  });

  it('rethrows unrelated launch errors unchanged', async () => {
    const original = new Error('browserType.launch: Target page, context or browser has been closed');
    const { launchChromium, PreflightError } = await withLaunch(async () => { throw original; });
    const err = await launchChromium().catch((e) => e);
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(PreflightError);
  });

  it('handles a non-Error rejection', async () => {
    const { launchChromium } = await withLaunch(async () => { throw 'Executable doesn\'t exist at /x'; });
    const err = await launchChromium().catch((e) => e);
    expect(err.code).toBe('CHROMIUM_MISSING');
  });

  it('reports PLAYWRIGHT_MISSING when playwright cannot be imported', async () => {
    vi.resetModules();
    vi.doMock(playwrightEntry, () => { throw new Error('Cannot find package \'playwright\''); });
    const { launchChromium } = await import('../../plugins/atelier/lib/preflight.mjs');
    const err = await launchChromium().catch((e) => e);
    expect(err.name).toBe('PreflightError');
    expect(err.code).toBe('PLAYWRIGHT_MISSING');
    expect(err.fix).toMatch(/npm ci/);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

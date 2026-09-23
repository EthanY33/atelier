/**
 * Chromium preflight for --dynamic, on top of the shared lib/preflight.mjs.
 * Playwright is imported lazily, so the static pass never loads it.
 */
import { existsSync } from 'node:fs';
import { launchChromium, playwrightVersion } from '../../../lib/preflight.mjs';
import { UxAuditError, fromPreflight } from './errors.mjs';

function installHint() {
  const v = playwrightVersion();
  return `npx playwright${v ? `@${v}` : ''} install chromium (the static pass needs no browser; drop --dynamic)`;
}

/**
 * Check that Playwright and its Chromium build are installed.
 * @param {{ chromium?: { executablePath(): string } }} [opts] - test hook
 * @returns {Promise<string>} the Chromium executable path
 */
export async function ensureChromium({ chromium } = {}) {
  let browserType = chromium;
  if (!browserType) {
    try {
      ({ chromium: browserType } = await import('playwright'));
    } catch (err) {
      throw new UxAuditError('PLAYWRIGHT_MISSING', 'runtime-ux-audit --dynamic needs Playwright, which is not installed next to the plugin.', {
        hint: 'Reinstall the plugin (/plugin install atelier@atelier), or run `npm ci` in the plugin directory.',
        cause: err,
      });
    }
  }
  let path = null;
  try {
    path = browserType.executablePath();
  } catch {
    path = null;
  }
  if (!path || !existsSync(path)) {
    throw new UxAuditError('CHROMIUM_MISSING', "runtime-ux-audit --dynamic needs Playwright's Chromium.", { hint: installHint() });
  }
  return path;
}

/** Playwright's messages when Chromium's own sandbox cannot start (Linux). */
const SANDBOX_FAILED = /Chromium sandboxing failed|No usable sandbox|crbug\.com\/(?:357670|638180)/i;

/**
 * Launch Chromium through the shared helper; a missing browser or Playwright
 * becomes UxAuditError CHROMIUM_MISSING / PLAYWRIGHT_MISSING with the fix kept.
 *
 * The dynamic pass runs third-party page code, so Chromium starts with its OS
 * sandbox on (Playwright defaults to --no-sandbox). Where the sandbox cannot
 * start (Linux without unprivileged user namespaces, or running as root) the
 * launch is retried without it and a one-line warning goes to stderr. An
 * explicit launchOptions.chromiumSandbox is used as given, with no retry.
 * @param {import('playwright').LaunchOptions} [launchOptions]
 * @param {{ platform?: string, warn?: (message: string) => void, launch?: typeof launchChromium }} [hooks] - test hooks
 */
export async function launchUxChromium(launchOptions = {}, hooks = {}) {
  const platform = hooks.platform ?? process.platform;
  const warn = hooks.warn ?? ((m) => process.stderr.write(`${m}\n`));
  const launch = hooks.launch ?? launchChromium;
  const opts = { chromiumSandbox: true, ...launchOptions };
  try {
    try {
      return await launch(opts);
    } catch (err) {
      const message = `${err?.message ?? err} ${err?.cause?.message ?? ''}`;
      if (platform !== 'linux' || launchOptions.chromiumSandbox !== undefined || !SANDBOX_FAILED.test(message)) throw err;
      warn('atelier: the Chromium sandbox cannot start here, so the page runs without it. Only audit pages you trust with --dynamic.');
      return await launch({ ...opts, chromiumSandbox: false });
    }
  } catch (err) {
    throw fromPreflight(err);
  }
}

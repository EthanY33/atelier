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

/**
 * Launch Chromium through the shared helper; a missing browser or Playwright
 * becomes UxAuditError CHROMIUM_MISSING / PLAYWRIGHT_MISSING with the fix kept.
 * @param {import('playwright').LaunchOptions} [launchOptions]
 */
export async function launchUxChromium(launchOptions = {}) {
  try {
    return await launchChromium(launchOptions);
  } catch (err) {
    throw fromPreflight(err);
  }
}

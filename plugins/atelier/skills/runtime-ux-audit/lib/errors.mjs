/**
 * Errors raised by runtime-ux-audit.
 *
 * UxAuditError extends the shared PreflightError so the shared formatError()
 * prints its hint as a "Fix:" line. `hint` and `fix` are the same string.
 */
import { PreflightError } from '../../../lib/preflight.mjs';

export const ERROR_CODES = Object.freeze([
  'USAGE',
  'INPUT_NOT_FOUND',
  'SCHEME_NOT_ALLOWED',
  'COLLECT_FAILED',
  'BRAND_INVALID',
  'PLAYWRIGHT_MISSING',
  'CHROMIUM_MISSING',
  'DYNAMIC_FAILED',
]);

export class UxAuditError extends PreflightError {
  /**
   * @param {string} code - One of ERROR_CODES.
   * @param {string} message
   * @param {{ hint?: string, cause?: unknown, path?: string }} [extra]
   */
  constructor(code, message, { hint, cause, path } = {}) {
    super(message, { code, fix: hint, cause });
    this.name = 'UxAuditError';
    if (path !== undefined) this.path = path;
  }

  get hint() {
    return this.fix;
  }
}

/**
 * Map a shared PreflightError (CHROMIUM_MISSING, PLAYWRIGHT_MISSING) to a
 * UxAuditError with the same code and fix. Other errors pass through.
 * @param {unknown} err
 * @returns {unknown}
 */
export function fromPreflight(err) {
  if (err instanceof UxAuditError) return err;
  if (err instanceof PreflightError && (err.code === 'CHROMIUM_MISSING' || err.code === 'PLAYWRIGHT_MISSING')) {
    const message = err.code === 'CHROMIUM_MISSING'
      ? "runtime-ux-audit --dynamic needs Playwright's Chromium."
      : 'runtime-ux-audit --dynamic needs Playwright, which is not installed next to the plugin.';
    const hint = err.code === 'CHROMIUM_MISSING'
      ? `${err.fix} (the static pass needs no browser; drop --dynamic)`
      : err.fix;
    return new UxAuditError(err.code, message, { hint, cause: err });
  }
  return err;
}

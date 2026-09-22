/**
 * Dynamic pass for runtime-ux-audit (--dynamic). It collects facts only; the
 * rules in rules/<area>/ judge them.
 *
 * runDynamicPass({ page: { kind, url, filePath, root }, toDisplay, budgets,
 * limits, launch }) resolves to DynamicFacts:
 *   engine, profile, navigation, rendered, sweep, interactions, dialogs,
 *   bfcache (each null when its probe did not run or failed), errors[].
 *
 * Sequence (each step isolated; a failure becomes errors[] and later steps
 * still run; a global dynamicTimeoutMs deadline skips what is left):
 *   1. navigate   load the page (local inputs over a loopback server)
 *   2. sweep      rendered HTML and DOM facts (targets, repeated groups, view-transition names)
 *   3-5. interactions  4x CPU, settle, Tab presses and taps; Event Timing and LoAF
 *   6. dialogs    open each dialog trigger by keyboard, close it, check where focus went
 *   7. bfcache    about:blank and back; restored or notRestoredReasons
 * A launch failure (Chromium or Playwright missing) is thrown, not recorded.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DYNAMIC_LIMITS } from '../lib/options.mjs';
import { createPageUrls } from '../lib/url.mjs';
import { launchUxChromium } from '../lib/browser.mjs';
import { startServer } from './serve.mjs';
import {
  CPU_THROTTLE, DEVICE, LAUNCH_OPTIONS, cleanSweep, doubleRaf, errorMessage, probeBfcache, probeDialogs, runInteractions,
} from './probes.mjs';

export { summarizeInteractions } from './inp.mjs';

const OBSERVERS_JS = fileURLToPath(new URL('./browser/observers.js', import.meta.url));
const SWEEP_JS = fileURLToPath(new URL('./browser/sweep.js', import.meta.url));
const MAX_RENDERED_CHARS = 10 * 1024 * 1024;
const CLOSE_WAIT_MS = 15_000;
const TIMEOUT = Symbol('dynamic-timeout');

// Used only when Playwright's device list lacks the entry.
const PIXEL_7 = Object.freeze({
  viewport: { width: 412, height: 839 },
  screen: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
});

/** DynamicFacts with every probe null. */
export function emptyFacts() {
  return {
    engine: null,
    profile: null,
    navigation: null,
    rendered: null,
    sweep: null,
    interactions: null,
    dialogs: null,
    bfcache: null,
    errors: [],
  };
}

async function deviceDescriptor() {
  try {
    const { devices } = await import('playwright');
    if (devices && devices[DEVICE]) return devices[DEVICE];
  } catch {
    // launch() already reported a missing Playwright
  }
  return PIXEL_7;
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms).unref?.();
});

function defaultToDisplay(target, server, targetUrl) {
  const urls = server
    ? createPageUrls({ kind: 'file', docUrl: pathToFileURL(target.filePath).href, root: server.root })
    : createPageUrls({ kind: 'http', docUrl: targetUrl, origin: new URL(targetUrl).origin });
  return (absUrl) => urls.toDisplay(absUrl);
}

function lowercaseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[String(k).toLowerCase()] = String(v);
  return out;
}

/**
 * Run the dynamic pass.
 * @param {{
 *   page: { kind: 'file'|'http', url: string, filePath: string|null, root: string|null },
 *   toDisplay?: (absUrl: string) => string,
 *   budgets?: object,
 *   limits?: Partial<typeof DYNAMIC_LIMITS>,
 *   launch?: (launchOptions: object) => Promise<import('playwright').Browser>
 * }} input
 * @returns {Promise<object>} DynamicFacts
 */
export async function runDynamicPass(input = {}) {
  const target = input.page ?? {};
  const limits = { ...DYNAMIC_LIMITS, ...(input.limits ?? {}) };
  const launch = typeof input.launch === 'function' ? input.launch : launchUxChromium;
  const facts = emptyFacts();
  const { errors } = facts;

  let targetUrl;
  if (target.kind === 'file') {
    if (!target.filePath || !target.root) throw new TypeError('runDynamicPass: a file input needs page.filePath and page.root');
  } else {
    targetUrl = String(target.url ?? '');
    if (!/^https?:\/\//i.test(targetUrl)) throw new TypeError(`runDynamicPass: expected an http(s) URL, got ${targetUrl || 'nothing'}`);
  }

  const server = target.kind === 'file' ? await startServer(target.root) : null;
  if (server) targetUrl = server.urlFor(target.filePath);
  // Core passes ctx.page.toDisplay; direct callers get the same mapping by default.
  const toDisplay = typeof input.toDisplay === 'function' ? input.toDisplay : defaultToDisplay(target, server, targetUrl);
  // Served URLs never leak into facts: map them back to file URLs, then to display strings.
  const display = (u) => {
    const s = typeof u === 'string' ? u : '';
    if (!s) return '';
    try {
      return toDisplay((server && server.toFileUrl(s)) || s);
    } catch {
      return s;
    }
  };
  const scrub = (s) => (server ? String(s).split(`${server.origin}/`).join('').split(server.origin).join('') : String(s));

  let expired = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(TIMEOUT);
    }, limits.dynamicTimeoutMs);
  });
  deadline.catch(() => {});
  const guard = (promise) => {
    promise.catch(() => {});
    return Promise.race([promise, deadline]);
  };
  const noteTimeout = () => {
    if (!errors.some((e) => e.probe === 'timeout')) {
      errors.push({ probe: 'timeout', message: `the dynamic pass reached its ${limits.dynamicTimeoutMs} ms limit; the remaining probes did not run` });
    }
  };
  // A step returns its value only when it finished before the deadline. Its
  // errors are collected locally and merged the same way, so a step that is
  // still unwinding after the deadline can neither change the facts nor add
  // errors caused by the browser closing under it.
  const step = async (probe, fn) => {
    if (expired) {
      noteTimeout();
      return null;
    }
    const local = [];
    try {
      const value = await guard(Promise.resolve().then(() => fn(local)));
      errors.push(...local);
      return { value };
    } catch (err) {
      if (err === TIMEOUT || expired) {
        noteTimeout();
        return null;
      }
      errors.push(...local, { probe, message: errorMessage(err, scrub) });
      return null;
    }
  };

  let browser = null;
  let context = null;
  let launching = null;
  try {
    const setup = async () => {
      launching = Promise.resolve().then(() => launch({ ...LAUNCH_OPTIONS }));
      browser = await launching;
      const device = await deviceDescriptor();
      context = await browser.newContext({ ...device });
      const page = await context.newPage();
      // Popups would hold an opener and block the bfcache; dialogs would block the page.
      context.on('page', (p) => {
        if (p !== page) p.close().catch(() => {});
      });
      page.on('dialog', (d) => (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {}));
      page.setDefaultNavigationTimeout(limits.navigationTimeoutMs);
      page.setDefaultTimeout(Math.min(limits.navigationTimeoutMs, 10_000));
      await page.addInitScript({ path: OBSERVERS_JS });
      await page.addInitScript({ path: SWEEP_JS });
      return {
        page,
        engine: { name: 'chromium', version: String(browser.version()), headless: 'new' },
        profile: {
          device: DEVICE,
          viewport: { width: device.viewport.width, height: device.viewport.height },
          deviceScaleFactor: device.deviceScaleFactor,
          cpuThrottle: CPU_THROTTLE,
        },
      };
    };

    let session;
    try {
      session = await guard(Promise.resolve().then(setup));
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      noteTimeout();
      return facts;
    }
    const { page } = session;
    facts.engine = session.engine;
    facts.profile = session.profile;

    const nav = await step('navigate', async (errs) => {
      let status = null;
      let headers = null;
      try {
        const res = await page.goto(targetUrl, { waitUntil: 'load' });
        if (res) {
          status = res.status();
          if (target.kind === 'http') headers = lowercaseHeaders(res.headers());
        }
      } catch (err) {
        // A load event that never came still leaves a usable document; an error page does not.
        if (!/^https?:/i.test(page.url())) throw err;
        errs.push({ probe: 'navigate', message: errorMessage(err, scrub) });
      }
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await doubleRaf(page).catch(() => {});
      const finalUrl = display(page.url());
      return headers ? { status, finalUrl, headers } : { status, finalUrl };
    });

    if (nav) {
      facts.navigation = nav.value;
      const rendered = await step('sweep', async () => {
        const html = await page.content();
        if (html.length > MAX_RENDERED_CHARS) throw new Error(`the rendered DOM is over ${MAX_RENDERED_CHARS} characters, so it was not re-checked`);
        return { html: server ? html.split(server.origin).join('') : html };
      });
      if (rendered) facts.rendered = rendered.value;
      const sweep = await step('sweep', async () => {
        const raw = await page.evaluate((o) => window.__atelierSweep(o), { maxInteractive: limits.maxInteractive });
        return cleanSweep(raw, limits.maxInteractive);
      });
      if (sweep) facts.sweep = sweep.value;
      const interactions = await step('interactions', (errs) => runInteractions(page, context, { targetUrl, limits, errors: errs, display, scrub }));
      if (interactions) facts.interactions = interactions.value;
      const dialogs = await step('dialogs', (errs) => probeDialogs(page, targetUrl, { limits, errors: errs, scrub }));
      if (dialogs) facts.dialogs = dialogs.value;
      const bfcache = await step('bfcache', () => probeBfcache(page, targetUrl, { limits }));
      if (bfcache) facts.bfcache = bfcache.value;
    }
    if (expired) noteTimeout();
    return facts;
  } finally {
    clearTimeout(timer);
    if (!browser && launching) {
      // The deadline beat the launch: close the browser once it exists.
      browser = await Promise.race([launching.catch(() => null), sleep(CLOSE_WAIT_MS).then(() => null)]);
    }
    // Closing the context first keeps browser.close() fast (it otherwise waited
    // seconds on the page kept in the back/forward cache).
    if (context) await Promise.race([context.close().catch(() => {}), sleep(CLOSE_WAIT_MS)]);
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(CLOSE_WAIT_MS)]);
    if (server) await server.close();
  }
}

/**
 * Probes for the dynamic pass: interactions (INP and LoAF), dialog focus and
 * bfcache, plus the sanitizers that turn page-supplied data into DynamicFacts.
 *
 * Everything read back from the page is untrusted: page code runs in the same
 * realm as the init scripts, so every value is type-checked, capped and
 * rounded here before it reaches the rules.
 */
import { summarizeInteractions } from './inp.mjs';

export const DEVICE = 'Pixel 7';
export const CPU_THROTTLE = 4;
/**
 * Full Chromium (new headless) restores pages from the back/forward cache;
 * the headless shell and Playwright's default --disable-back-forward-cache
 * switch never do.
 */
export const LAUNCH_OPTIONS = Object.freeze({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });

const MAX_ENTRIES = 5000;
const MAX_LOAF = 2000;
const MAX_SCRIPTS = 50;
const MAX_GROUPS = 20;
const MAX_VT_NAMES = 100;
const TAP_TIMEOUT_MS = 1500;
const CLICK_TIMEOUT_MS = 750;
const DIALOG_OPEN_MS = 1000;
const DIALOG_CLOSE_WAIT_MS = 300;
const PAGESHOW_WAIT_MS = 5000;
const NAVIGATION_SWAP_MS = 5000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 1000) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : null);
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (fin(v) === null ? null : Math.round(v));
const dec2 = (v) => (fin(v) === null ? 0 : Math.round(v * 100) / 100);
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * One line of an error, whitespace-collapsed, ANSI-free and capped at 300 chars.
 * @param {unknown} err
 * @param {(s: string) => string} [scrub] - e.g. strip the loopback origin
 */
export function errorMessage(err, scrub = (s) => s) {
  const raw = err instanceof Error ? err.message : String(err);
  const first = String(raw).replace(ANSI, '').split('\n').map((s) => s.trim()).find(Boolean) ?? 'unknown error';
  const s = scrub(first).replace(/\s+/g, ' ').trim() || 'unknown error';
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

/** Validate the object window.__atelierSweep returned. */
export function cleanSweep(raw, maxInteractive = 500) {
  if (!isObj(raw)) throw new Error('the DOM sweep returned no data');
  const rect = (r) => ({ x: dec2(r?.x), y: dec2(r?.y), width: dec2(r?.width), height: dec2(r?.height) });
  const interactive = arr(raw.interactive).filter(isObj).slice(0, maxInteractive).map((e) => ({
    selector: str(e.selector) ?? '',
    tag: str(e.tag, 64) ?? '',
    role: str(e.role, 64),
    type: str(e.type, 64),
    text: str(e.text, 60) ?? '',
    rect: rect(e.rect),
    visible: e.visible === true,
    disabled: e.disabled === true,
    inlineInText: e.inlineInText === true,
  }));
  return {
    interactive,
    interactiveTruncated: raw.interactiveTruncated === true || arr(raw.interactive).length > maxInteractive,
    repeatedGroups: arr(raw.repeatedGroups).filter(isObj).slice(0, MAX_GROUPS).map((g) => ({
      parentSelector: str(g.parentSelector) ?? '',
      signature: str(g.signature, 300) ?? '',
      count: Math.max(0, int(g.count) ?? 0),
      belowFoldCount: Math.max(0, int(g.belowFoldCount) ?? 0),
      contentVisibility: g.contentVisibility === true,
    })),
    viewTransitionNames: arr(raw.viewTransitionNames).filter(isObj).slice(0, MAX_VT_NAMES).map((v) => ({
      name: str(v.name, 300) ?? '',
      selectors: arr(v.selectors).filter((s) => typeof s === 'string').slice(0, 5).map((s) => str(s)),
    })),
  };
}

/** Validated Event Timing entries (unrounded, for summarizeInteractions). */
export function cleanEntries(events, max = MAX_ENTRIES) {
  const out = [];
  for (const e of arr(events)) {
    if (out.length >= max) break;
    if (!isObj(e)) continue;
    const interactionId = fin(e.interactionId);
    const startTime = fin(e.startTime);
    const duration = fin(e.duration);
    if (!interactionId || startTime === null || duration === null) continue;
    out.push({
      interactionId,
      name: str(e.name, 64) ?? '',
      target: str(e.target),
      startTime,
      duration,
      processingStart: fin(e.processingStart) ?? startTime,
      processingEnd: fin(e.processingEnd) ?? startTime,
    });
  }
  return out;
}

const roundEntry = (e) => ({
  interactionId: Math.round(e.interactionId),
  name: e.name,
  target: e.target,
  startTime: Math.round(e.startTime),
  duration: Math.round(e.duration),
  processingStart: Math.round(e.processingStart),
  processingEnd: Math.round(e.processingEnd),
});

/**
 * Validated Long Animation Frames with display URLs.
 * @param {unknown} frames
 * @param {(url: string) => string} [display] - served or absolute URL -> display string
 * @param {(s: string) => string} [scrub] - applied to invokers that are not a bare URL
 */
export function cleanLoaf(frames, display = (u) => u, scrub = (s) => s, max = MAX_LOAF) {
  const out = [];
  const invoker = (v) => {
    const s = str(v) ?? '';
    return /^https?:\/\/\S+$/i.test(s) ? display(s) : scrub(s);
  };
  for (const f of arr(frames)) {
    if (out.length >= max) break;
    if (!isObj(f)) continue;
    const startTime = int(f.startTime);
    if (startTime === null) continue;
    out.push({
      startTime,
      durationMs: int(f.duration) ?? 0,
      blockingDurationMs: int(f.blockingDuration) ?? 0,
      scripts: arr(f.scripts).filter(isObj).slice(0, MAX_SCRIPTS).map((s) => ({
        invoker: invoker(s.invoker),
        invokerType: str(s.invokerType, 64) ?? '',
        sourceURL: str(s.sourceURL) ? display(str(s.sourceURL)) : '',
        sourceFunctionName: str(s.sourceFunctionName, 300) ?? '',
        sourceCharPosition: int(s.sourceCharPosition) ?? -1,
        durationMs: int(s.duration) ?? 0,
        forcedStyleAndLayoutDurationMs: int(s.forcedStyleAndLayoutDuration) ?? 0,
      })),
    });
  }
  return out;
}

/** Wait two animation frames (bounded, so a throttled page cannot hang the probe). */
export async function doubleRaf(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const t = setTimeout(resolve, 1000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    }));
  }));
}

/** Navigate to url, wait for load and two frames. */
export async function freshLoad(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await doubleRaf(page);
}

/** Event Timing and LoAF data since windowStart, or null when this is not the measured document. */
async function harvest(page) {
  try {
    return await page.evaluate(() => window.__atelierProbe.harvest());
  } catch {
    return null;
  }
}

/** Still on the document whose measurement window was opened. */
async function sameDocument(page) {
  try {
    return await page.evaluate(() => !!window.__atelierUx && window.__atelierUx.windowStart !== null);
  } catch {
    return false;
  }
}

/** After a main-frame navigation request, wait (bounded) until the old document is gone. */
async function waitForDocumentSwap(page) {
  await page
    .waitForFunction(() => !window.__atelierUx || window.__atelierUx.windowStart === null, null, { timeout: NAVIGATION_SWAP_MS })
    .catch(() => {});
}

async function activePath(page) {
  return str(await page.evaluate(() => window.__atelierProbe.activePath()));
}

async function tapOrClick(locator) {
  try {
    await locator.tap({ timeout: TAP_TIMEOUT_MS });
    return 'tap';
  } catch {
    // fall back to a mouse click
  }
  try {
    await locator.click({ timeout: CLICK_TIMEOUT_MS });
    return 'click';
  } catch {
    return null;
  }
}

async function resetAfterInteraction(page) {
  try {
    await doubleRaf(page);
    await page.keyboard.press('Escape');
    await doubleRaf(page);
  } catch {
    // a navigation interrupted the reset; sameDocument() reports it
  }
}

/**
 * Interaction probe under CPU throttling: Tab presses, then taps on up to
 * maxTaps safe candidates. Returns DynamicFacts.interactions.
 * @param {import('playwright').Page} page - already on the target
 * @param {import('playwright').BrowserContext} context
 * @param {{ targetUrl: string, limits: object, errors: object[], display?: (u: string) => string, scrub?: (s: string) => string }} opts
 */
export async function runInteractions(page, context, { targetUrl, limits, errors, display = (u) => u, scrub = (s) => s }) {
  const attempted = [];
  let snapshot = null;
  let cdp = null;
  // A tap can start a navigation that has not committed by the time the
  // reset finishes; a main-frame navigation request says to wait for it.
  let navRequested = false;
  const onRequest = (req) => {
    try {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navRequested = true;
    } catch {
      // detached frame
    }
  };
  page.on('request', onRequest);
  const leftPage = async (target) => {
    errors.push({ probe: 'interactions', message: errorMessage(`navigated-away: tapping ${target} left the page; tapping stopped`, scrub) });
    await page.waitForLoadState('load').catch(() => {});
    await freshLoad(page, targetUrl).catch(() => {});
  };
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    // Settle: the first interaction after a throttle change is otherwise
    // dominated by pending load work (measured 416 ms on a trivial page).
    await page.waitForTimeout(limits.settleMs);
    await doubleRaf(page);
    await page.evaluate(() => {
      window.__atelierUx.windowStart = performance.now();
    });

    let active = await activePath(page);
    for (let i = 0; i < limits.maxTabs; i++) {
      await page.keyboard.press('Tab');
      attempted.push({ kind: 'key', target: active ?? 'document' });
      await doubleRaf(page);
      active = await activePath(page);
    }

    const candidates = arr(await page.evaluate((max) => window.__atelierProbe.tapCandidates(max), limits.maxTaps))
      .filter((t) => typeof t === 'string' && t !== '')
      .slice(0, limits.maxTaps);
    let navigatedAway = false;
    let last = null;
    for (const target of candidates) {
      snapshot = (await harvest(page)) ?? snapshot;
      const locator = page.locator(target);
      if ((await locator.count().catch(() => 0)) !== 1) continue;
      navRequested = false;
      const kind = await tapOrClick(locator);
      if (kind) {
        attempted.push({ kind, target: str(target) });
        last = target;
      }
      await resetAfterInteraction(page);
      if (navRequested) await waitForDocumentSwap(page);
      if (!(await sameDocument(page))) {
        navigatedAway = true;
        await leftPage(target);
        break;
      }
    }
    if (!navigatedAway) {
      await page.waitForTimeout(500);
      if (await sameDocument(page)) snapshot = (await harvest(page)) ?? snapshot;
      else if (last) await leftPage(last);
    }
  } finally {
    page.off('request', onRequest);
    if (cdp) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }

  const entries = cleanEntries(snapshot?.events);
  const interactionCount = fin(snapshot?.interactionCount) === null ? null : Math.round(snapshot.interactionCount);
  return {
    attempted,
    entries: entries.map(roundEntry),
    interactionCount,
    // No harvest at all means nothing was measured, which is not "all under 16 ms".
    inp: summarizeInteractions(entries, interactionCount, { attempted: snapshot ? attempted.length : 0 }),
    loaf: snapshot && Array.isArray(snapshot.loaf) ? cleanLoaf(snapshot.loaf, display, scrub) : null,
  };
}

async function probeDialog(page, trigger) {
  const entry = { trigger, opened: false, closed: false, closeMethod: null, activeAfterClose: null, restoredToTrigger: false };
  const focused = await page.evaluate((p) => window.__atelierProbe.focusTrigger(p), trigger);
  if (focused !== true) return entry;
  await page.evaluate(() => window.__atelierProbe.snapshotOpen());
  await page.keyboard.press('Enter');
  entry.opened = await page
    .waitForFunction(() => window.__atelierProbe.newOpenSurface() !== null, null, { timeout: DIALOG_OPEN_MS, polling: 'raf' })
    .then(() => true, () => false);
  if (!entry.opened) return entry;

  await doubleRaf(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(DIALOG_CLOSE_WAIT_MS);
  let open = (await page.evaluate(() => window.__atelierProbe.currentOpen())) === true;
  let method = open ? null : 'escape';
  if (open) {
    const close = str(await page.evaluate(() => window.__atelierProbe.closeCandidate()));
    if (close) {
      await page.locator(close).first().click({ timeout: DIALOG_OPEN_MS }).catch(() => {});
      await page.waitForTimeout(DIALOG_CLOSE_WAIT_MS);
      open = (await page.evaluate(() => window.__atelierProbe.currentOpen())) === true;
      if (!open) method = 'close-button';
    }
  }
  entry.closed = !open;
  entry.closeMethod = method;
  if (entry.closed) {
    const state = await page.evaluate(() => window.__atelierProbe.focusState());
    entry.activeAfterClose = str(state?.active);
    entry.restoredToTrigger = state?.restored === true;
  }
  return entry;
}

/**
 * Dialog focus probe: for each trigger (fresh load each), focus it, press
 * Enter, close the surface that opened (Escape, else a close control) and
 * record where focus landed. Returns DynamicFacts.dialogs.
 * @param {import('playwright').Page} page
 * @param {string} targetUrl
 * @param {{ limits: object, errors: object[], scrub?: (s: string) => string }} opts
 */
export async function probeDialogs(page, targetUrl, { limits, errors, scrub = (s) => s }) {
  await freshLoad(page, targetUrl);
  const triggers = arr(await page.evaluate((max) => window.__atelierProbe.dialogTriggers(max), limits.maxDialogTriggers))
    .filter((t) => typeof t === 'string' && t !== '')
    .slice(0, limits.maxDialogTriggers)
    .map((t) => str(t));
  const out = [];
  for (let i = 0; i < triggers.length; i++) {
    try {
      if (i > 0) await freshLoad(page, targetUrl);
      out.push(await probeDialog(page, triggers[i]));
    } catch (err) {
      errors.push({ probe: 'dialogs', message: errorMessage(err, scrub) });
    }
  }
  return out;
}

/**
 * bfcache probe: load, navigate to about:blank, go back, and read whether the
 * page was restored (pageshow persisted) or why not (notRestoredReasons).
 * @param {import('playwright').Page} page
 * @param {string} targetUrl
 * @param {{ limits: object }} opts
 * @returns {Promise<{ supported: boolean, restored: boolean|null, reasons: string[] }>}
 */
export async function probeBfcache(page, targetUrl, { limits }) {
  await freshLoad(page, targetUrl);
  await page.goto('about:blank', { waitUntil: 'load' });
  // A restore fires no load event, so wait for the commit and then pageshow.
  await page.goBack({ waitUntil: 'commit' });
  const shown = () => !!window.__atelierUx && window.__atelierUx.pageshow.length > 0;
  try {
    await page.waitForFunction(shown, null, { timeout: PAGESHOW_WAIT_MS });
  } catch {
    // A slow page that was not restored is still loading: give it the navigation budget.
    await page.waitForLoadState('load', { timeout: limits.navigationTimeoutMs });
    await page.waitForFunction(shown, null, { timeout: 2000 });
  }
  const r = await page.evaluate(() => window.__atelierProbe.bfcacheState());
  const reasons = [...new Set(arr(r?.reasons).filter((x) => typeof x === 'string').map((x) => str(x, 200)))].sort();
  return {
    supported: r?.supported === true,
    restored: typeof r?.restored === 'boolean' ? r.restored : null,
    reasons: reasons.slice(0, 50),
  };
}

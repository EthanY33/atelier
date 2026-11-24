/**
 * Dynamic pass for runtime-ux-audit (--dynamic). It collects facts only; the
 * rules in rules/<area>/ judge them.
 *
 * runDynamicPass({ page: { kind, url, filePath, root }, toDisplay, budgets,
 * limits, launch, allowOrigins }) resolves to DynamicFacts:
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
 * For local inputs Chromium runs behind a deny-by-default proxy that forwards
 * only to the loopback server and the allowOrigins origins, with no WebRTC
 * UDP and no DNS of its own; blocked requests Playwright sees are listed in
 * errors[].
 */
import http from 'node:http';
import net from 'node:net';
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

const MAX_BLOCKED_SHOWN = 5;

/** Chromium switches for local inputs, next to the proxy (startEgressProxy). */
const LOCAL_EGRESS_ARGS = Object.freeze([
  // WebRTC gets no UDP socket (STUN, TURN over UDP, peer traffic), and its TCP goes through the proxy.
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  // Chromium resolves no host names itself, so a lookup (WebRTC resolves ICE
  // server names on its own) cannot carry data out. The proxy resolves the
  // hosts it forwards to.
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
]);

/**
 * Deny-by-default forward proxy for local inputs. Chromium is launched with
 * it as the proxy for every scheme and host, loopback included, so each
 * http(s) and ws(s) connection passes through it whoever opens it: the page,
 * a dedicated or shared worker, a prefetch, a redirect, WebRTC over TCP. Only
 * the allowed origins get an upstream connection; the rest is answered 403.
 * @param {Set<string>} allowed - http(s) origins
 * @returns {Promise<{ url: string, close(): Promise<void> }>}
 */
async function startEgressProxy(allowed) {
  const authority = (u) => `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  const bare = (hostname) => hostname.replace(/^\[|\]$/g, '');
  // CONNECT names no scheme, so tunnels (https, wss, and ws to an http origin) are matched on host:port.
  const tunnels = new Set();
  for (const origin of allowed) {
    try {
      tunnels.add(authority(new URL(origin)));
    } catch {
      // not an origin: nothing to allow
    }
  }
  const sockets = new Set();

  const proxy = http.createServer((req, res) => {
    let url = null;
    try {
      url = new URL(req.url);
    } catch {
      // origin-form target: not a proxy request
    }
    req.on('error', () => {});
    res.on('error', () => {});
    if (!url || url.protocol !== 'http:' || !allowed.has(url.origin)) {
      req.resume();
      res.writeHead(403, { 'Content-Length': 0 });
      res.end();
      return;
    }
    const headers = { ...req.headers, connection: 'close' };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request({
      host: bare(url.hostname), port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, agent: false,
    }, (up) => {
      const out = { ...up.headers };
      delete out.connection;
      delete out['keep-alive'];
      up.on('error', () => res.destroy());
      res.writeHead(up.statusCode, up.statusMessage, out);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { 'Content-Length': 0 });
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  proxy.on('connect', (req, client, head) => {
    client.on('error', () => {});
    let target = null;
    try {
      target = new URL(`https://${req.url}`);
    } catch {
      // malformed authority
    }
    if (!target || !tunnels.has(authority(target))) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let open = false;
    const upstream = net.connect(Number(target.port || 443), bare(target.hostname), () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (open) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  // A tunnelled socket leaves the HTTP server, so closeAllConnections() would miss it.
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((ok, fail) => {
    proxy.once('error', fail);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', fail);
      ok();
    });
  });
  return {
    url: `http://127.0.0.1:${proxy.address().port}`,
    close() {
      return new Promise((ok) => {
        for (const socket of sockets) socket.destroy();
        proxy.close(() => ok());
      });
    },
  };
}

/**
 * Local inputs: page scripts run against the loopback server, so they could
 * read files under the root and send them anywhere. The proxy above is what
 * stops them: only the server's origin and --allow-origin origins are
 * reachable. This routing aborts the requests Playwright can intercept before
 * they leave the page and collects the origins that were refused, for the
 * report; it does not see shared worker requests or WebRTC. Returns the set
 * of blocked origins.
 */
async function restrictEgress(context, allowed) {
  const blocked = new Set();
  const originOf = (u) => {
    try {
      const url = new URL(u);
      if (url.protocol === 'ws:') url.protocol = 'http:';
      else if (url.protocol === 'wss:') url.protocol = 'https:';
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  };
  const permitted = (u) => {
    const origin = originOf(u);
    if (origin === null || allowed.has(origin)) return true; // data:, blob: and the like never leave the machine
    blocked.add(origin);
    return false;
  };
  await context.route('**/*', (route) => (permitted(route.request().url()) ? route.continue() : route.abort('blockedbyclient')).catch(() => {}));
  // Routing skips redirect hops, prefetches and some worker requests. The
  // proxy refuses those; the request event still names them.
  context.on('request', (request) => {
    permitted(request.url());
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, (ws) => {
      if (permitted(ws.url())) ws.connectToServer();
      else ws.close().catch(() => {});
    });
  }
  return blocked;
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
 *   launch?: (launchOptions: object) => Promise<import('playwright').Browser>,
 *   allowOrigins?: string[]   // local inputs: origins page requests may reach besides the loopback server
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
  let proxy = null;
  let blockedOrigins = null;
  const noteBlocked = () => {
    if (!blockedOrigins?.size) return;
    const list = [...blockedOrigins].sort();
    const shown = list.slice(0, MAX_BLOCKED_SHOWN).join(', ') + (list.length > MAX_BLOCKED_SHOWN ? ` and ${list.length - MAX_BLOCKED_SHOWN} more` : '');
    errors.push({ probe: 'network', message: `blocked requests to ${shown}; a local page only reaches the loopback server and --allow-origin origins` });
  };
  try {
    const allowed = server ? new Set([server.origin, ...(input.allowOrigins ?? [])]) : null;
    if (server) proxy = await startEgressProxy(allowed);
    const setup = async () => {
      launching = Promise.resolve().then(() => launch(proxy
        // <-loopback> drops Chromium's built-in proxy bypass for localhost and 127.0.0.1.
        ? { ...LAUNCH_OPTIONS, proxy: { server: proxy.url, bypass: '<-loopback>' }, args: [...LOCAL_EGRESS_ARGS] }
        : { ...LAUNCH_OPTIONS }));
      browser = await launching;
      const device = await deviceDescriptor();
      // Service worker fetches would bypass the request routing below.
      context = await browser.newContext(server ? { ...device, serviceWorkers: 'block' } : { ...device });
      if (server) blockedOrigins = await restrictEgress(context, allowed);
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
    noteBlocked();
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
    if (proxy) await proxy.close();
    if (server) await server.close();
  }
}

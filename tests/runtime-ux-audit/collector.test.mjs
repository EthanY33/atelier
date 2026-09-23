import { readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { contextFor, tempDir, writeFiles, withServer, SKILL_DIR } from './helpers.mjs';
import { collect } from '../../plugins/atelier/skills/runtime-ux-audit/lib/collect.mjs';
import { classifyInput, createPageUrls, isInside, normalizeOrigin } from '../../plugins/atelier/skills/runtime-ux-audit/lib/url.mjs';
import { fetchBounded } from '../../plugins/atelier/skills/runtime-ux-audit/lib/fetch.mjs';
import { auditRuntimeUx } from '../../plugins/atelier/skills/runtime-ux-audit/index.mjs';

const summary = (resources) => resources.map((r) => [r.kind, r.displayPath, r.status, r.reason ?? null]);

async function collectFiles(files, opts = {}) {
  const { dir, cleanup } = tempDir('ux-col-');
  try {
    writeFiles(dir, files);
    return await collect(join(dir, opts.entry ?? 'index.html'), { root: dir, ...opts });
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Input classification and local inputs
// ---------------------------------------------------------------------------

describe('input classification', () => {
  it('accepts paths, file URLs and http(s) URLs and rejects other schemes', () => {
    expect(classifyInput('https://example.com/a#x')).toEqual({ kind: 'http', url: 'https://example.com/a' });
    expect(classifyInput('HTTP://example.com')).toEqual({ kind: 'http', url: 'http://example.com/' });
    expect(classifyInput('site/index.html', '/tmp').kind).toBe('file');
    expect(classifyInput(pathToFileURL(join(SKILL_DIR, 'SKILL.md')).href).filePath).toBe(join(SKILL_DIR, 'SKILL.md'));
    for (const bad of ['data:text/html,hi', 'javascript:alert(1)', 'ftp://x/y', 'blob:x']) {
      expect(() => classifyInput(bad), bad).toThrow(expect.objectContaining({ code: 'SCHEME_NOT_ALLOWED' }));
    }
    expect(() => classifyInput('')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(() => classifyInput('http://')).toThrow(expect.objectContaining({ code: 'USAGE' }));
    expect(normalizeOrigin('https://a.example.com/path?q')).toBe('https://a.example.com');
    expect(() => normalizeOrigin('nope')).toThrow(expect.objectContaining({ code: 'USAGE' }));
  });

  it.runIf(process.platform === 'win32')('reads a Windows drive path before any scheme test', () => {
    const p = join(SKILL_DIR, 'SKILL.md');
    expect(classifyInput(p)).toEqual({ kind: 'file', filePath: p });
    expect(classifyInput(p.replace(/\\/g, '/'))).toEqual({ kind: 'file', filePath: p });
    const lower = p[0].toLowerCase() + p.slice(1);
    expect(classifyInput(lower).kind).toBe('file');
    expect(isInside('C:\\Site', 'c:\\site\\a.css')).toBe(true);
  });

  it('checks root containment lexically', () => {
    const root = join(SKILL_DIR, 'lib');
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, `${root}x`)).toBe(false);
    expect(isInside(root, join(root, '..', 'x'))).toBe(false);
  });

  it('audits a local path, a file:// URL and a relative path with cwd', async () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFiles(dir, { 'site/index.html': '<!doctype html><title>x</title>' });
      const a = await collect(join(dir, 'site', 'index.html'));
      const b = await collect(pathToFileURL(join(dir, 'site', 'index.html')).href);
      const c = await collect('site/index.html', { cwd: dir });
      for (const r of [a, b, c]) expect(r.page).toMatchObject({ kind: 'file', displayUrl: 'index.html', origin: null, status: null });
      const res = await auditRuntimeUx({ url: 'site/index.html', cwd: dir, outDir: 'out', timestamp: '2026-01-01T00:00:00Z' });
      expect(res.reportPath).toBe(join(dir, 'out', 'ux-report.md'));
    } finally {
      cleanup();
    }
  });

  it('fails clearly on missing inputs, directories, oversized documents and documents outside the root', async () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFiles(dir, { 'site/index.html': 'x'.repeat(2000), 'other/page.html': '<p>' });
      await expect(collect(join(dir, 'nope.html'))).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
      await expect(collect(join(dir, 'site'))).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
      await expect(collect(join(dir, 'site', 'index.html'), { limits: { maxBytes: 1000 } })).rejects.toMatchObject({ code: 'COLLECT_FAILED' });
      await expect(collect(join(dir, 'other', 'page.html'), { root: join(dir, 'site') })).rejects.toMatchObject({ code: 'USAGE' });
      await expect(collect(join(dir, 'site', 'index.html'), { root: join(dir, 'missing') })).rejects.toMatchObject({ code: 'INPUT_NOT_FOUND' });
    } finally {
      cleanup();
    }
  });
});

describe('local resource graph', () => {
  it('maps root-absolute hrefs to the root and honors <base href>', async () => {
    const c = await collectFiles({
      'pages/index.html': '<base href="../assets/"><link rel="stylesheet" href="/css/a.css"><link rel="stylesheet" href="b.css?v=2#x"><script src="c.js"></script>',
      'css/a.css': '.a{}', 'assets/b.css': '.b{}', 'assets/c.js': 'x()',
    }, { entry: 'pages/index.html' });
    expect(c.page.displayUrl).toBe('pages/index.html');
    expect(summary(c.resources)).toEqual([
      ['document', 'pages/index.html', 'parsed', null],
      ['stylesheet', 'css/a.css', 'parsed', null],
      ['stylesheet', 'assets/b.css', 'parsed', null],
      ['script', 'assets/c.js', 'parsed', null],
    ]);
  });

  it('blocks ../ traversal and symlink escapes with outside-root', async () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFiles(dir, {
        'site/index.html': '<link rel="stylesheet" href="../secret.css"><link rel="stylesheet" href="link/evil.css"><link rel="stylesheet" href="gone.css">',
        'secret.css': '.s{}', 'outside/evil.css': '.e{}',
      });
      let linked = true;
      try {
        symlinkSync(join(dir, 'outside'), join(dir, 'site', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        linked = false;
      }
      const c = await collect(join(dir, 'site', 'index.html'));
      const rows = summary(c.resources);
      expect(rows[1]).toEqual(['stylesheet', '../secret.css', 'skipped', 'outside-root']);
      if (linked) expect(rows[2]).toEqual(['stylesheet', 'link/evil.css', 'skipped', 'outside-root']);
      expect(rows[3]).toEqual(['stylesheet', 'gone.css', 'failed', 'not-found']);
      expect(c.cssComplete).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('follows @import to maxImportDepth and keeps cascade order', async () => {
    const c = await collectFiles({
      'index.html': '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css"><style>@import "b.css" print; @import url(d.css) screen; .s{}</style>',
      'a.css': '@import url("b.css");\n.a{}', 'b.css': '@import "c.css" layer(x);\n.b{}', 'c.css': '@import "d.css";\n.c{}', 'd.css': '@import "e.css";\n.d{}', 'e.css': '.e{}',
    });
    expect(summary(c.resources)).toEqual([
      ['document', 'index.html', 'parsed', null],
      ['stylesheet', 'a.css', 'parsed', null],
      ['stylesheet', 'b.css', 'parsed', null],
      ['stylesheet', 'c.css', 'parsed', null],
      ['stylesheet', 'd.css', 'parsed', null],
      ['stylesheet', 'e.css', 'skipped', 'depth'],
      ['stylesheet', 'a.css', 'skipped', 'duplicate'],
      ['stylesheet', 'style:inline(1)', 'parsed', null],
      ['stylesheet', 'b.css', 'skipped', 'print-media'],
      ['stylesheet', 'd.css', 'skipped', 'duplicate'],
    ]);
    const ctx = await contextFor({
      'index.html': '<link rel="stylesheet" href="a.css"><style>@import url(d.css) screen; .s{}</style>',
      'a.css': '@import url("b.css");\n.a{}', 'b.css': '.b{}', 'd.css': '.d{}',
    });
    expect(ctx.css.rules.map((r) => [r.selectorText, r.context.media])).toEqual([['.b', []], ['.a', []], ['.d', ['screen']], ['.s', []]]);
  });

  it('follows the ES module graph, skips bare specifiers and caps depth', async () => {
    const c = await collectFiles({
      'index.html': '<script type="module">import "./m1.js"; import "lit";</script><script>import("./dyn.js")</script><script type="application/json">{}</script><script type="importmap">{}</script>',
      'm1.js': 'export * from "./m2.js";', 'm2.js': 'export { a } from "./m3.js";', 'm3.js': 'import "./m4.js"; export const a = 1;',
      'm4.js': 'import "./m5.js";', 'm5.js': 'import "./m6.js";', 'm6.js': 'import "./m7.js";', 'm7.js': '', 'dyn.js': 'import "./m1.js";',
    });
    expect(summary(c.resources)).toEqual([
      ['document', 'index.html', 'parsed', null],
      ['script', 'script:inline(1)', 'parsed', null],
      ['module', 'm1.js', 'parsed', null],
      ['module', 'm2.js', 'parsed', null],
      ['module', 'm3.js', 'parsed', null],
      ['module', 'm4.js', 'parsed', null],
      ['module', 'm5.js', 'parsed', null],
      ['module', 'm6.js', 'skipped', 'depth'],
      ['module', 'lit', 'skipped', 'bare-specifier'],
      ['script', 'script:inline(2)', 'parsed', null],
      ['module', 'dyn.js', 'parsed', null],
    ]);
    expect(c.jsComplete).toBe(false);
    const selectors = c.scripts.map((s) => s.selector);
    expect(selectors).toContain('import("m1.js")');
    expect(selectors).toContain('script:inline(2)');
  });

  it('gives identical line/column for CRLF + BOM and LF sources', async () => {
    const body = '<!doctype html>\n<html>\n<head>\n<style>\n.a { height: 100vh }\n</style>\n</head>\n<body onclick="go()">\n<script src="a.js"></script>\n</body>\n</html>\n';
    const js = 'var x = 1;\n\nwindow.addEventListener("unload", f);\n';
    const lf = await contextFor({ 'index.html': body, 'a.js': js });
    const crlf = await contextFor({ 'index.html': `\uFEFF${body.replace(/\n/g, '\r\n')}`, 'a.js': `\uFEFF${js.replace(/\n/g, '\r\n')}` });
    const refs = (ctx) => [
      ctx.ref.css(ctx.css.declsByProp('height')[0]),
      ctx.ref.js(ctx.js.listenersByEvent('unload')[0]),
      ctx.ref.js(ctx.js.listenersByEvent('click')[0]),
      ctx.ref.html(ctx.html.byTag('body')[0], 'onclick'),
    ];
    expect(refs(crlf)).toEqual(refs(lf));
    expect(refs(lf).map((r) => r.location)).toEqual(['index.html:5:6', 'a.js:3:1', 'index.html:8:16', 'index.html:8:7']);
    const raw = crlf.js.scripts.find((s) => s.kind === 'external').rawText;
    expect(raw).toContain('\r\n');
    expect(crlf.js.locate('a.js', raw.indexOf('window'))).toEqual({ line: 3, column: 1 });
  });

  it('reads manifests, touch icon PNG sizes and marks parse errors', async () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png, 0);
    png.writeUInt32BE(120, 16);
    png.writeUInt32BE(96, 20);
    const ctx = await contextFor({
      'index.html': '<link rel="manifest" href="app.webmanifest"><link rel="apple-touch-icon" href="icon.png"><link rel="apple-touch-icon-precomposed" href="bad.png"><link rel="apple-touch-icon" href="sized.png" sizes="180x180"><link rel="stylesheet" href="broken.css"><script src="broken.js"></script>',
      'app.webmanifest': '\uFEFF{"icons":[{"src":"a.png","sizes":"512x512"}]}',
      'icon.png': png, 'bad.png': 'not a png', 'broken.css': '.a {', 'broken.js': 'let = ;',
    });
    expect(ctx.manifest).toEqual({ displayPath: 'app.webmanifest', json: { icons: [{ src: 'a.png', sizes: '512x512' }] }, error: null });
    expect(ctx.html.links.map((l) => l.imageSize)).toEqual([null, { width: 120, height: 96 }, null, null, null]);
    expect(summary(ctx.resources)).toEqual([
      ['document', 'index.html', 'parsed', null],
      ['stylesheet', 'broken.css', 'parse-error', 'Unclosed block at 1:1'],
      ['script', 'broken.js', 'parse-error', 'Unexpected token at 1:7'],
      ['manifest', 'app.webmanifest', 'parsed', null],
      ['image', 'icon.png', 'parsed', null],
      ['image', 'bad.png', 'parsed', 'not-png'],
    ]);
    expect(ctx.css.complete).toBe(false);
    expect(ctx.js.complete).toBe(false);
    expect(ctx.css.sheets[0].error).toEqual({ reason: 'Unclosed block', line: 1, column: 1 });
    const bad = await contextFor({ 'index.html': '<link rel="manifest" href="m.json"><link rel="manifest" href="second.json">', 'm.json': '{nope' });
    expect(bad.manifest).toEqual({ displayPath: 'm.json', json: null, error: 'invalid-json' });
    const missing = await contextFor({ 'index.html': '<link rel="manifest" href="gone.json">' });
    expect(missing.manifest).toEqual({ displayPath: 'gone.json', json: null, error: 'not-found' });
    expect((await contextFor({ 'index.html': '<p>' })).manifest).toBeNull();
  });

  it('caps the number of fetched resources', async () => {
    const c = await collectFiles({
      'index.html': ['a', 'b', 'c', 'd', 'e'].map((n) => `<link rel="stylesheet" href="${n}.css">`).join(''),
      'a.css': '', 'b.css': '', 'c.css': '', 'd.css': '', 'e.css': '',
    }, { limits: { maxResources: 3 } });
    expect(summary(c.resources).map((r) => r[2] + (r[3] ? `:${r[3]}` : ''))).toEqual(['parsed', 'parsed', 'parsed', 'skipped:limit', 'skipped:limit', 'skipped:limit']);
  });

  it('skips cross-origin subresources in file mode unless allow-listed', async () => {
    let hits = 0;
    await withServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/css' }); res.end('.remote{}'); }, async (base) => {
      const files = { 'index.html': `<link rel="stylesheet" href="${base}/r.css"><link rel="stylesheet" href="//cdn.example.invalid/x.css">` };
      const skipped = await collectFiles(files);
      expect(summary(skipped.resources).slice(1)).toEqual([
        ['stylesheet', `${base}/r.css`, 'skipped', 'cross-origin'],
        ['stylesheet', 'https://cdn.example.invalid/x.css', 'skipped', 'cross-origin'],
      ]);
      expect(skipped.cssComplete).toBe(true);
      expect(hits).toBe(0);
      const allowed = await collectFiles(files, { allowOrigins: [base] });
      expect(summary(allowed.resources)[1]).toEqual(['stylesheet', `${base}/r.css`, 'parsed', null]);
      expect(hits).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// http(s) inputs
// ---------------------------------------------------------------------------

describe('http inputs', () => {
  it('keeps response headers, follows redirects and never contacts another origin', async () => {
    let otherHits = 0;
    await withServer((req, res) => { otherHits++; res.end('.x{}'); }, async (other) => {
      await withServer((req, res) => {
        if (req.url === '/') { res.writeHead(301, { location: '/final/' }); res.end(); return; }
        if (req.url === '/final/') {
          res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "script-src 'self'", 'content-security-policy-report-only': "default-src 'none'" });
          res.end(`<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="${other}/b.css"><link rel="stylesheet" href="/hop.css"><link rel="stylesheet" href="file:///etc/passwd">`);
          return;
        }
        if (req.url === '/final/a.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('.a { color: red }'); return; }
        if (req.url === '/hop.css') { res.writeHead(302, { location: `${other}/stolen.css` }); res.end(); return; }
        res.writeHead(404); res.end();
      }, async (base) => {
        const ctx = await contextFor({ 'index.html': '<p>' }); // warm-up: helpers work alongside servers
        expect(ctx.page.kind).toBe('file');
        const c = await collect(`${base}/`);
        expect(c.page).toMatchObject({ kind: 'http', displayUrl: `${base}/final/`, origin: base, status: 200 });
        expect(c.page.headers['cache-control']).toBe('no-store');
        expect(summary(c.resources)).toEqual([
          ['document', `${base}/final/`, 'parsed', null],
          ['stylesheet', '/final/a.css', 'parsed', null],
          ['stylesheet', `${other}/b.css`, 'skipped', 'cross-origin'],
          ['stylesheet', '/hop.css', 'skipped', 'redirect-cross-origin'],
          ['stylesheet', 'file:///etc/passwd', 'skipped', 'scheme-not-allowed'],
        ]);
        const res = await auditRuntimeUx({ url: `${base}/`, write: false, timestamp: '2026-01-01T00:00:00Z', rules: [] });
        expect(res.raw.url).toBe(`${base}/final/`);
      });
    });
    expect(otherHits).toBe(0);
  });

  it('exposes header CSP (not report-only) and http-only page helpers', async () => {
    await withServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'self', default-src 'none'", 'content-security-policy-report-only': "img-src 'none'" });
      res.end('<meta http-equiv="content-security-policy" content="style-src \'self\'"><a href="/x?q=1#h">x</a>');
    }, async (base) => {
      const rules = [{
        id: 'atelier/runtime-ux/probe', area: 'transitions', severity: 'minor', confidence: 'high', methods: ['headers'], phase: 'static', requires: ['http'],
        description: 'probe', helpUrl: 'https://example.com',
        check: (ctx) => [{ node: ctx.ref.page('Content-Security-Policy', 'csp'), data: { policies: ctx.page.csp.length, display: ctx.page.toDisplay(ctx.page.resolve('/x?q=1#h')), same: ctx.page.isSameOrigin(`${base}/y`), other: ctx.page.isSameOrigin('https://example.com/') } }],
      }];
      const res = await auditRuntimeUx({ url: base, write: false, rules, timestamp: '2026-01-01T00:00:00Z' });
      expect(res.raw.violations[0].nodes[0]).toEqual({ selector: 'document', snippet: 'csp', location: '(response headers)', data: { display: '/x?q=1', other: false, policies: 3, same: true } });
    });
  });

  it('fails the audit when the document cannot be loaded', async () => {
    await withServer((req, res) => {
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); return; }
      if (req.url === '/stall') return; // never answers
      if (req.url === '/big') { res.writeHead(200, { 'content-length': '5000' }); res.end('x'.repeat(5000)); return; }
      res.writeHead(404); res.end();
    }, async (base) => {
      await expect(collect(`${base}/missing`)).rejects.toMatchObject({ code: 'COLLECT_FAILED', message: expect.stringContaining('http-404') });
      await expect(collect(`${base}/loop`, { limits: { maxRedirects: 2 } })).rejects.toMatchObject({ code: 'COLLECT_FAILED', message: expect.stringContaining('too-many-redirects') });
      await expect(collect(`${base}/stall`, { limits: { timeoutMs: 200 } })).rejects.toMatchObject({ code: 'COLLECT_FAILED', message: expect.stringContaining('timeout') });
      await expect(collect(`${base}/big`, { limits: { maxBytes: 1000 } })).rejects.toMatchObject({ code: 'COLLECT_FAILED', message: expect.stringContaining('too-large') });
    });
  });

  it('times out stalled subresources and never parses oversized ones', async () => {
    await withServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<link rel="stylesheet" href="/slow.css"><link rel="stylesheet" href="/declared.css"><link rel="stylesheet" href="/chunked.css"><link rel="stylesheet" href="/ok.css">');
        return;
      }
      if (req.url === '/slow.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.write('.a{'); return; }
      if (req.url === '/declared.css') { res.writeHead(200, { 'content-length': '3000' }); res.end('a'.repeat(3000)); return; }
      if (req.url === '/chunked.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        let n = 0;
        const t = setInterval(() => { res.write(`.c${n} { height: 100vh }\n`.repeat(20)); if (++n > 20) { clearInterval(t); res.end(); } }, 1);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/css' }); res.end('.ok { color: red }');
    }, async (base) => {
      const c = await collect(`${base}/`, { limits: { timeoutMs: 300, maxBytes: 1000 } });
      expect(summary(c.resources)).toEqual([
        ['document', `${base}/`, 'parsed', null],
        ['stylesheet', '/slow.css', 'failed', 'timeout'],
        ['stylesheet', '/declared.css', 'too-large', 'too-large'],
        ['stylesheet', '/chunked.css', 'too-large', 'too-large'],
        ['stylesheet', '/ok.css', 'parsed', null],
      ]);
      expect(c.sheets.map((s) => s.displayPath)).toEqual(['/ok.css']);
      expect(c.cssComplete).toBe(false);
    });
  });

  it('uses an injected fetchImpl and a bounded fetch helper', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push([url, init.redirect, init.credentials, init.headers['user-agent']]);
      return new Response('<p>hi</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const c = await collect('https://example.test/page', { fetchImpl });
    expect(c.page.displayUrl).toBe('https://example.test/page');
    expect(calls).toEqual([['https://example.test/page', 'manual', 'omit', 'atelier-runtime-ux-audit/1.0']]);
    const r = await fetchBounded('ftp://x', { timeoutMs: 10, maxBytes: 10, maxRedirects: 0, fetchImpl });
    expect(r).toMatchObject({ ok: false, status: 'skipped', reason: 'scheme-not-allowed' });
    const err = await fetchBounded('https://x.test/', { timeoutMs: 10, maxBytes: 10, maxRedirects: 0, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(err).toMatchObject({ ok: false, status: 'failed', reason: 'network-error' });
    const noLoc = await fetchBounded('https://x.test/', { timeoutMs: 10, maxBytes: 10, maxRedirects: 1, fetchImpl: async () => new Response(null, { status: 302 }) });
    expect(noLoc).toMatchObject({ ok: false, reason: 'redirect-without-location' });
  });

  it('never executes page code', async () => {
    let beacons = 0;
    const payload = 'globalThis.__atelierPwned = true; fetch("/beacon"); navigator.sendBeacon && navigator.sendBeacon("/beacon");';
    await withServer((req, res) => {
      if (req.url === '/beacon') { beacons++; res.end(); return; }
      if (req.url === '/evil.js' || req.url === '/evil-module.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(payload); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<body onload='${payload}'><script>${payload}</script><script src="/evil.js"></script><script type="module">import "/evil-module.js"; ${payload}</script><img src=x onerror='${payload}'></body>`);
    }, async (base) => {
      const res = await auditRuntimeUx({ url: base, write: false, timestamp: '2026-01-01T00:00:00Z' });
      expect(res.raw.resources.filter((r) => r.status === 'parsed').length).toBe(5);
    });
    expect(globalThis.__atelierPwned).toBeUndefined();
    expect(beacons).toBe(0);
  });
});

describe('page URL helpers', () => {
  it('resolves, compares origins and displays paths in file mode', () => {
    const root = join(SKILL_DIR, 'lib');
    const urls = createPageUrls({ kind: 'file', docUrl: pathToFileURL(join(root, 'sub', 'index.html')).href, root, allowOrigins: ['https://cdn.example.com'] });
    expect(urls.toDisplay(urls.resolve('/x.css?v=1#h'))).toBe('x.css');
    expect(urls.toDisplay(urls.resolve('../y.css'))).toBe('y.css');
    expect(urls.toDisplay(urls.resolve('../../z.css'))).toBe('../z.css');
    expect(urls.resolve('//cdn.example.com/a.css')).toBe('https://cdn.example.com/a.css');
    expect(urls.isSameOrigin('https://cdn.example.com/a.css')).toBe(true);
    expect(urls.isSameOrigin('https://other.example.com/a.css')).toBe(false);
    expect(urls.isSameOrigin(urls.resolve('a.css'))).toBe(true);
    expect(urls.isSameOrigin('not a url')).toBe(false);
    expect(urls.resolve('')).toBeNull();
    expect(urls.resolve('http://[bad')).toBeNull();
    expect(urls.toDisplay('https://a.example.com/x#y')).toBe('https://a.example.com/x');
  });

  it('displays same-origin http URLs as /path?query', () => {
    const urls = createPageUrls({ kind: 'http', docUrl: 'https://site.example/a/b.html', origin: 'https://site.example' });
    expect(urls.toDisplay(urls.resolve('c.css?v=1#x'))).toBe('/a/c.css?v=1');
    expect(urls.toDisplay('https://cdn.example/x.js')).toBe('https://cdn.example/x.js');
    expect(urls.isSameOrigin('file:///etc/passwd')).toBe(false);
    urls.setBase('/root/');
    expect(urls.resolve('d.css')).toBe('https://site.example/root/d.css');
  });
});

describe('static path hygiene', () => {
  it('lib/ and rules/ never import playwright, eval, new Function or node:vm', () => {
    const files = [];
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.mjs') || p.endsWith('.js')) files.push(p);
      }
    };
    walk(join(SKILL_DIR, 'lib'));
    walk(join(SKILL_DIR, 'rules'));
    const scanned = files.filter((f) => !f.endsWith(join('lib', 'browser.mjs')));
    expect(scanned.length).toBeGreaterThan(10);
    for (const f of scanned) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(SKILL_DIR, f);
      expect(src, rel).not.toMatch(/from\s+['"]playwright|import\(\s*['"]playwright|require\(\s*['"]playwright/);
      expect(src, rel).not.toMatch(/\beval\s*\(/);
      expect(src, rel).not.toMatch(/new\s+Function\s*\(/);
      expect(src, rel).not.toMatch(/node:vm|from\s+['"]vm['"]/);
    }
  });
});

/**
 * Static collector: loads the document and its same-origin (or allow-listed)
 * stylesheets, scripts, ES modules, manifest and touch icons, and parses them.
 * Page code is parsed, never executed. Discovery is sequential and in document
 * order, so the resource graph is deterministic.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeText } from '../../../lib/io.mjs';
import { UxAuditError } from './errors.mjs';
import { classifyInput, createPageUrls, isInside, isInternalHost, safeRealpath } from './url.mjs';
import { fetchBounded } from './fetch.mjs';
import { buildHtmlModel } from './html-model.mjs';
import { parseCss, isPrintOnlyMedia } from './css-model.mjs';
import { parseJs, traverse } from './js-model.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBytes: 2 * 1024 * 1024,
  maxResources: 64,
  maxImportDepth: 3,
  maxModuleDepth: 5,
  maxRedirects: 5,
});

const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/ecmascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript',
  'text/x-javascript']);

/**
 * Skip reasons that never affect completeness: third-party resources, and
 * print-only stylesheets (listed in Coverage, but they never apply on screen).
 */
export const COMPLETE_SKIP_REASONS = Object.freeze(new Set(['cross-origin', 'scheme-not-allowed', 'redirect-cross-origin', 'bare-specifier', 'print-media']));

/** Strip a leading BOM and convert CRLF / CR to LF. */
export function normalizeText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

function pngSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
  const u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  return { width: u32(16), height: u32(20) };
}

const isCssSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Parse @import params into { href, media }, or null. A linear scanner: the
 * regex it replaces had overlapping quantifiers and took minutes on
 * '@import url(' followed by a long run of spaces.
 * @param {string} params
 * @returns {{ href: string, media: string }|null}
 */
export function parseImport(params) {
  const s = String(params ?? '');
  const n = s.length;
  let i = 0;
  const skipSpace = () => { while (i < n && isCssSpace(s[i])) i++; };
  const quoted = () => {
    const end = s.indexOf(s[i], i + 1);
    if (end < 0) return null;
    const v = s.slice(i + 1, end);
    i = end + 1;
    return v;
  };
  skipSpace();
  let href;
  if (s.slice(i, i + 4).toLowerCase() === 'url(') {
    i += 4;
    skipSpace();
    if (s[i] === '"' || s[i] === "'") {
      href = quoted();
      if (href === null) return null;
      skipSpace();
      if (s[i] !== ')') return null;
      i++;
    } else {
      const end = s.indexOf(')', i);
      if (end < 0) return null;
      href = s.slice(i, end).trimEnd();
      i = end + 1;
    }
  } else if (s[i] === '"' || s[i] === "'") {
    href = quoted();
    if (href === null) return null;
  } else return null;
  return { href, media: stripImportConditions(s.slice(i)) };
}

/**
 * The media query list of @import params: the first layer / layer(...) and
 * supports(...) removed. Same result as
 * .replace(/layer(\([^)]*\))?/i, '').replace(/supports\([^)]*\)/i, ''), but
 * linear: those regexes rescan to the end for every 'supports(' with no ')'.
 */
function stripImportConditions(rest) {
  let s = rest;
  const layer = /layer/i.exec(s);
  if (layer) {
    let end = layer.index + 5;
    if (s[end] === '(') {
      const close = s.indexOf(')', end);
      if (close >= 0) end = close + 1;
    }
    s = s.slice(0, layer.index) + s.slice(end);
  }
  const supports = /supports\(/i.exec(s);
  if (supports) {
    const close = s.indexOf(')', supports.index + 9);
    if (close >= 0) s = s.slice(0, supports.index) + s.slice(close + 1);
  }
  return s.trim();
}

/**
 * The media a stylesheet link applies to once its onload handler has run, for
 * the async CSS patterns (loadCSS, Beasties, Angular CLI):
 *   <link rel="stylesheet" media="print" onload="this.media='all'">
 *   <link rel="preload" as="style" onload="this.rel='stylesheet'">
 * Returns undefined when there is no onload handler. Otherwise returns the
 * media the handler assigns, or null for 'all' or when it cannot be read,
 * since the swap almost always targets all media.
 */
function onloadMedia(onload) {
  if (onload === null || onload === undefined) return undefined;
  const m = /\bmedia\s*=\s*(["'`])([^"'`]{0,256})\1/i.exec(String(onload).slice(0, 4096));
  const media = m ? m[2].trim() : '';
  return media && media.toLowerCase() !== 'all' ? media : null;
}

/** Why a redirect of the document is refused, or null. Relative to where the audit started. */
function documentRedirectPolicy(startUrl) {
  const start = new URL(startUrl);
  const startInternal = isInternalHost(start.hostname);
  return (hop) => {
    if (!startInternal && isInternalHost(hop.hostname)) return 'redirect-private-address';
    if (start.protocol === 'https:' && hop.protocol === 'http:') return 'redirect-downgrade';
    return null;
  };
}

/**
 * @param {string} input - path | file:// URL | http(s) URL
 * @param {{ root?: string, allowOrigins?: string[], limits?: object, fetchImpl?: typeof fetch, cwd?: string }} [opts]
 */
export async function collect(input, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const cwd = opts.cwd ?? process.cwd();
  const allowOrigins = opts.allowOrigins ?? [];
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const target = classifyInput(input, cwd);
  const resources = [];
  const totalSignal = AbortSignal.timeout(limits.totalTimeoutMs);
  let fetchCount = 0;
  let nextOrder = 0;

  // ------------------------------------------------------------------
  // Document
  // ------------------------------------------------------------------
  let page;
  let rootDir = null;
  let rawDoc;
  if (target.kind === 'file') {
    let st;
    try {
      st = statSync(target.filePath);
    } catch {
      throw new UxAuditError('INPUT_NOT_FOUND', `Input not found: ${input}`, { hint: 'Pass an existing .html file, a file:// URL or an http(s) URL.' });
    }
    if (!st.isFile()) throw new UxAuditError('INPUT_NOT_FOUND', `Input is not a file: ${input}`, { hint: 'Point at the HTML file itself, e.g. site/index.html.' });
    if (st.size > limits.maxBytes) throw new UxAuditError('COLLECT_FAILED', `Document is larger than ${limits.maxBytes} bytes: ${input}`, { hint: 'Raise --max-bytes.' });
    const rootInput = opts.root ? resolve(cwd, opts.root) : dirname(target.filePath);
    rootDir = safeRealpath(rootInput);
    if (!rootDir) throw new UxAuditError('INPUT_NOT_FOUND', `Root directory not found: ${opts.root ?? rootInput}`);
    const realDoc = safeRealpath(target.filePath);
    if (!realDoc || !isInside(rootDir, realDoc)) {
      throw new UxAuditError('USAGE', `The document is outside the root directory: ${input}`, { hint: 'Pass a --root that contains the document.' });
    }
    rawDoc = decodeText(readFileSync(realDoc));
    fetchCount++;
    page = { kind: 'file', docUrl: pathToFileURL(realDoc).href, origin: null, status: null, headers: {}, root: rootDir };
  } else {
    fetchCount++;
    // A public page must not bounce the audit to a loopback, link-local or
    // private address (cloud metadata, local admin ports), or from https to
    // http. Hosts are checked as written: a DNS name that resolves to a
    // private address is not caught.
    const res = await fetchBounded(target.url, {
      kind: 'document', timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes, maxRedirects: limits.maxRedirects,
      signal: totalSignal, fetchImpl, policy: documentRedirectPolicy(target.url),
    });
    if (!res.ok) {
      const redirectRefused = res.reason === 'redirect-private-address' || res.reason === 'redirect-downgrade';
      let hint = 'Check that the URL is reachable.';
      if (res.reason === 'timeout') hint = 'Check the URL, or raise --timeout.';
      else if (res.reason === 'too-large') hint = 'Raise --max-bytes.';
      else if (redirectRefused) hint = `The page redirected to ${res.url}; audit that URL directly if that was intended.`;
      throw new UxAuditError('COLLECT_FAILED', `Could not load ${target.url}: ${res.reason}`, { hint });
    }
    rawDoc = decodeText(Buffer.from(res.bytes));
    page = { kind: 'http', docUrl: res.url, origin: new URL(res.url).origin, status: res.httpStatus, headers: res.headers, root: null };
  }

  const urls = createPageUrls({ kind: page.kind, docUrl: page.docUrl, root: rootDir, origin: page.origin, allowOrigins });
  const docDisplay = page.kind === 'file' ? urls.toDisplay(page.docUrl) : page.docUrl;
  resources.push({ order: nextOrder++, kind: 'document', displayPath: docDisplay, status: 'parsed', reason: null });

  const docText = normalizeText(rawDoc);
  const imageSizes = new Map();
  const html = buildHtmlModel(docText, {
    source: 'static', displayPath: docDisplay, resolve: (href) => urls.resolve(href), imageSizes,
    onBase: (href) => urls.setBase(href),
  });
  const locate = lineIndex(docText);

  // ------------------------------------------------------------------
  // Resource loading
  // ------------------------------------------------------------------
  const addResource = (r) => {
    resources.push(r);
    return r;
  };

  async function load(absUrl, kind) {
    let url;
    try {
      url = new URL(absUrl);
    } catch {
      return { ok: false, status: 'failed', reason: 'invalid-url', display: String(absUrl) };
    }
    const display = urls.toDisplay(url.href);
    if (url.protocol === 'file:') {
      if (page.kind === 'http') return { ok: false, status: 'skipped', reason: 'scheme-not-allowed', display };
      let p;
      try {
        p = fileURLToPath(url);
      } catch {
        return { ok: false, status: 'failed', reason: 'invalid-url', display };
      }
      if (!isInside(rootDir, p)) return { ok: false, status: 'skipped', reason: 'outside-root', display };
      if (fetchCount >= limits.maxResources) return { ok: false, status: 'skipped', reason: 'limit', display };
      const real = safeRealpath(p);
      if (!real) return { ok: false, status: 'failed', reason: 'not-found', display };
      if (!isInside(rootDir, real)) return { ok: false, status: 'skipped', reason: 'outside-root', display };
      let st;
      try {
        st = statSync(real);
      } catch {
        return { ok: false, status: 'failed', reason: 'not-found', display };
      }
      if (!st.isFile()) return { ok: false, status: 'failed', reason: 'not-a-file', display };
      if (st.size > limits.maxBytes) return { ok: false, status: 'too-large', reason: 'too-large', display };
      fetchCount++;
      const bytes = readFileSync(real);
      return { ok: true, bytes, finalUrl: pathToFileURL(real).href, display: urls.toDisplay(pathToFileURL(real).href) };
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (!urls.isSameOrigin(url.href)) return { ok: false, status: 'skipped', reason: 'cross-origin', display };
      if (fetchCount >= limits.maxResources) return { ok: false, status: 'skipped', reason: 'limit', display };
      fetchCount++;
      const res = await fetchBounded(url.href, {
        kind, timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes, maxRedirects: limits.maxRedirects,
        signal: totalSignal, fetchImpl,
        policy: (hop) => (urls.isSameOrigin(hop.href) ? null : 'redirect-cross-origin'),
      });
      if (!res.ok) return { ok: false, status: res.status, reason: res.reason, display };
      return { ok: true, bytes: Buffer.from(res.bytes), finalUrl: res.url, display: urls.toDisplay(res.url) };
    }
    return { ok: false, status: 'skipped', reason: 'scheme-not-allowed', display };
  }

  const contentStart = (el) => {
    const first = (el.childNodes ?? []).find((n) => n.nodeName === '#text');
    const loc = first?.sourceCodeLocation ?? null;
    if (!loc) return { lineOffset: 0, columnOffset: 0 };
    return { lineOffset: loc.startLine - 1, columnOffset: loc.startCol - 1 };
  };

  const attrValueStart = (el, name) => {
    const loc = el.sourceCodeLocation?.startTag?.attrs?.[name];
    if (!loc) return { lineOffset: 0, columnOffset: 0, line: 0, column: 0 };
    const src = docText.slice(loc.startOffset, loc.endOffset);
    const m = /^[^=]*=\s*(["']?)/.exec(src);
    const pos = locate(loc.startOffset + (m ? m[0].length : 0));
    return { lineOffset: pos.line - 1, columnOffset: pos.column - 1, line: loc.startLine, column: loc.startCol };
  };

  // ------------------------------------------------------------------
  // Stylesheets
  // ------------------------------------------------------------------
  const sheets = [];
  let inlineStyleCount = 0;
  const seenSheetUrls = new Set();

  async function addSheet({ origin, el, anchorEl, absUrl, inlineText, parentOrder = null, depth = 0, media = null }) {
    const order = nextOrder++;
    let text;
    let displayPath;
    let sheetUrl;
    let rawText;
    let inDocument = false;
    let offsets = { lineOffset: 0, columnOffset: 0 };
    if (inlineText !== undefined) {
      inlineStyleCount++;
      displayPath = docDisplay;
      sheetUrl = urls.baseUrl;
      rawText = inlineText;
      text = normalizeText(inlineText);
      inDocument = true;
      offsets = contentStart(el);
      const r = addResource({ order, kind: 'stylesheet', displayPath: `style:inline(${inlineStyleCount})`, status: 'parsed', reason: null });
      const { root, error } = parseCss(text);
      if (error) { r.status = 'parse-error'; r.reason = `${error.reason} at ${error.line ?? '?'}:${error.column ?? '?'}`; }
      const rec = { order, displayPath, origin, el, anchorEl: anchorEl ?? el, root, error, parentOrder, inDocument, media, url: sheetUrl, text, rawText, ...offsets };
      sheets.push(rec);
      if (root) await followImports(rec, depth);
      return;
    }
    if (seenSheetUrls.has(absUrl)) {
      addResource({ order, kind: 'stylesheet', displayPath: urls.toDisplay(absUrl), status: 'skipped', reason: 'duplicate' });
      return;
    }
    seenSheetUrls.add(absUrl);
    const res = await load(absUrl, 'stylesheet');
    if (!res.ok) {
      addResource({ order, kind: 'stylesheet', displayPath: res.display, status: res.status, reason: res.reason });
      return;
    }
    displayPath = res.display;
    sheetUrl = res.finalUrl;
    rawText = decodeText(res.bytes);
    text = normalizeText(rawText);
    const { root, error } = parseCss(text);
    addResource({ order, kind: 'stylesheet', displayPath, status: error ? 'parse-error' : 'parsed', reason: error ? `${error.reason} at ${error.line ?? '?'}:${error.column ?? '?'}` : null });
    const rec = { order, displayPath, origin, el, anchorEl: anchorEl ?? el, root, error, parentOrder, inDocument, media, url: sheetUrl, text, rawText, ...offsets };
    sheets.push(rec);
    if (root) await followImports(rec, depth);
  }

  async function followImports(sheet, depth) {
    for (const node of sheet.root.nodes ?? []) {
      if (node.type !== 'atrule' || String(node.name).toLowerCase() !== 'import') continue;
      const imp = parseImport(node.params);
      if (!imp || !imp.href) continue;
      const abs = urls.resolveFrom(imp.href, sheet.url);
      if (!abs) continue;
      if (imp.media && isPrintOnlyMedia(imp.media)) {
        addResource({ order: nextOrder++, kind: 'stylesheet', displayPath: urls.toDisplay(abs), status: 'skipped', reason: 'print-media' });
        continue;
      }
      if (depth + 1 > limits.maxImportDepth) {
        addResource({ order: nextOrder++, kind: 'stylesheet', displayPath: urls.toDisplay(abs), status: 'skipped', reason: 'depth' });
        continue;
      }
      await addSheet({ origin: 'import', el: sheet.el, anchorEl: sheet.anchorEl, absUrl: abs, parentOrder: sheet.order, depth: depth + 1, media: imp.media || null });
    }
  }

  // ------------------------------------------------------------------
  // Scripts
  // ------------------------------------------------------------------
  const scripts = [];
  let inlineScriptCount = 0;
  let specCount = 0;
  const seenScriptUrls = new Set();

  const importsOf = (ast) => {
    const out = [];
    traverse(ast, (node) => {
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
        out.push(String(node.source.value));
      } else if (node.type === 'ImportExpression') {
        const s = node.source;
        if (s?.type === 'Literal' && typeof s.value === 'string') out.push(s.value);
        else if (s?.type === 'TemplateLiteral' && s.expressions.length === 0) out.push(s.quasis[0].value.cooked);
      }
      return true;
    });
    return out;
  };

  async function followModules(script, depth) {
    if (!script.ast) return;
    for (const spec of importsOf(script.ast)) {
      const relative = /^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(spec);
      if (!relative) {
        addResource({ order: nextOrder++, kind: 'module', displayPath: spec, status: 'skipped', reason: 'bare-specifier' });
        continue;
      }
      const abs = urls.resolveFrom(spec, script.url);
      if (!abs || seenScriptUrls.has(abs)) continue;
      if (depth + 1 > limits.maxModuleDepth) {
        addResource({ order: nextOrder++, kind: 'module', displayPath: urls.toDisplay(abs), status: 'skipped', reason: 'depth' });
        continue;
      }
      await addScript({ kind: 'module-import', type: 'module', el: script.el, anchorEl: script.anchorEl, absUrl: abs, depth: depth + 1 });
    }
  }

  async function addScript({ kind, type, el, anchorEl, absUrl, inlineText, depth = 0 }) {
    const order = nextOrder++;
    const resourceKind = kind === 'module-import' ? 'module' : 'script';
    let rec;
    if (inlineText !== undefined) {
      inlineScriptCount++;
      const selector = `script:inline(${inlineScriptCount})`;
      const source = normalizeText(inlineText);
      const parsed = parseJs(source, { module: type === 'module' });
      addResource({ order, kind: 'script', displayPath: selector, status: parsed.error ? 'parse-error' : 'parsed', reason: parsed.error ? `${parsed.error.message} at ${parsed.error.line ?? '?'}:${parsed.error.column ?? '?'}` : null });
      rec = {
        order, displayPath: docDisplay, kind: 'inline', type, el, src: null, source, rawText: inlineText,
        ast: parsed.ast, error: parsed.error, comments: parsed.comments, selector, inDocument: true,
        anchorEl: el, url: urls.baseUrl, ...contentStart(el),
      };
    } else {
      if (seenScriptUrls.has(absUrl)) {
        addResource({ order, kind: resourceKind, displayPath: urls.toDisplay(absUrl), status: 'skipped', reason: 'duplicate' });
        return;
      }
      seenScriptUrls.add(absUrl);
      const res = await load(absUrl, resourceKind);
      if (!res.ok) {
        addResource({ order, kind: resourceKind, displayPath: res.display, status: res.status, reason: res.reason });
        return;
      }
      const rawText = decodeText(res.bytes);
      const source = normalizeText(rawText);
      const parsed = parseJs(source, { module: type === 'module' });
      addResource({ order, kind: resourceKind, displayPath: res.display, status: parsed.error ? 'parse-error' : 'parsed', reason: parsed.error ? `${parsed.error.message} at ${parsed.error.line ?? '?'}:${parsed.error.column ?? '?'}` : null });
      const srcAttr = kind === 'external' ? (el.attrs.find((a) => a.name === 'src')?.value ?? res.display) : null;
      rec = {
        order, displayPath: res.display, kind, type, el, src: kind === 'external' ? srcAttr : res.display, source, rawText,
        ast: parsed.ast, error: parsed.error, comments: parsed.comments,
        selector: kind === 'external' ? `script[src="${String(srcAttr).replace(/["\\]/g, '\\$&')}"]` : `import("${res.display.replace(/["\\]/g, '\\$&')}")`,
        inDocument: false, anchorEl: anchorEl ?? el, url: res.finalUrl, lineOffset: 0, columnOffset: 0,
      };
    }
    scripts.push(rec);
    await followModules(rec, depth);
  }

  // ------------------------------------------------------------------
  // Discovery in document order
  // ------------------------------------------------------------------
  const cspMetas = [];
  let manifestLink = null;
  const iconLinks = [];
  const styleAttrs = [];
  const eventAttrScripts = [];

  for (const el of html.elements) {
    const tag = html.tag(el);
    if (tag === 'link') {
      const rel = (html.attr(el, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const href = html.attr(el, 'href');
      if (href === null) continue;
      // <link rel="preload" as="style" onload="this.rel='stylesheet'"> turns
      // into a stylesheet once loaded (loadCSS pattern).
      const asyncStyle = rel.includes('preload') && (html.attr(el, 'as') ?? '').trim().toLowerCase() === 'style'
        && /stylesheet/i.test(html.attr(el, 'onload') ?? '');
      if ((rel.includes('stylesheet') || asyncStyle) && !rel.includes('alternate')) {
        const abs = urls.resolve(href);
        if (!abs) continue;
        let media = html.attr(el, 'media');
        if (media && isPrintOnlyMedia(media)) {
          // media="print" plus an onload swap is the async CSS pattern: the
          // sheet applies on screen once loaded. Without one it is print only.
          const swapped = onloadMedia(html.attr(el, 'onload'));
          if (swapped === undefined || (swapped && isPrintOnlyMedia(swapped))) {
            addResource({ order: nextOrder++, kind: 'stylesheet', displayPath: urls.toDisplay(abs), status: 'skipped', reason: 'print-media' });
            continue;
          }
          media = swapped;
        }
        await addSheet({ origin: 'link', el, absUrl: abs, media: media && media.trim().toLowerCase() !== 'all' ? media.trim() : null });
      } else if (rel.includes('manifest') && !manifestLink) {
        manifestLink = el;
      } else if ((rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) && !html.hasAttr(el, 'sizes')) {
        iconLinks.push(el);
      }
    } else if (tag === 'style') {
      const type = (html.attr(el, 'type') ?? '').trim().toLowerCase();
      if (type && type !== 'text/css') continue;
      const media = html.attr(el, 'media');
      if (media && isPrintOnlyMedia(media)) continue;
      await addSheet({ origin: 'style', el, inlineText: html.rawText(el), media: media && media.trim().toLowerCase() !== 'all' ? media.trim() : null });
    } else if (tag === 'script') {
      const type = (html.attr(el, 'type') ?? '').trim().toLowerCase();
      if (type === 'speculationrules') {
        specCount++;
        const entry = html.speculationRules.find((s) => s.el === el);
        addResource({ order: nextOrder++, kind: 'speculation-rules', displayPath: `script:speculationrules(${specCount})`, status: entry?.error ? 'parse-error' : 'parsed', reason: entry?.error ? 'invalid-json' : null });
      } else if (JS_TYPES.has(type) || type === 'module') {
        const scriptType = type === 'module' ? 'module' : 'classic';
        const src = html.attr(el, 'src');
        if (src !== null) {
          const abs = urls.resolve(src);
          if (abs) await addScript({ kind: 'external', type: scriptType, el, absUrl: abs });
        } else {
          await addScript({ kind: 'inline', type: scriptType, el, inlineText: html.rawText(el) });
        }
      }
    } else if (tag === 'meta') {
      if ((html.attr(el, 'http-equiv') ?? '').trim().toLowerCase() === 'content-security-policy') {
        const content = html.attr(el, 'content');
        if (content) cspMetas.push(content);
      }
    }
    if (html.hasAttr(el, 'style')) styleAttrs.push(el);
  }

  for (const { el, name, value } of html.eventAttrs) {
    const source = normalizeText(value);
    const parsed = parseJs(source, { eventAttr: true });
    const pos = attrValueStart(el, name);
    eventAttrScripts.push({
      order: 0, displayPath: docDisplay, kind: 'event-attr', type: 'classic', el, src: null, source, rawText: value,
      ast: parsed.ast, error: parsed.error, comments: parsed.comments, selector: `${html.cssPath(el)}[${name}]`,
      inDocument: true, anchorEl: el, url: urls.baseUrl, eventName: name, attrLine: pos.line, attrColumn: pos.column,
      lineOffset: pos.lineOffset, columnOffset: pos.columnOffset,
    });
  }

  for (const el of styleAttrs) {
    const value = html.attr(el, 'style') ?? '';
    const text = normalizeText(value);
    const { root, error } = parseCss(text);
    const pos = attrValueStart(el, 'style');
    sheets.push({
      order: 0, displayPath: docDisplay, origin: 'style-attr', el, anchorEl: el, root, error, parentOrder: null,
      inDocument: true, media: null, url: urls.baseUrl, text, rawText: value, styleAttrSelector: html.cssPath(el),
      attrLine: pos.line, attrColumn: pos.column, lineOffset: pos.lineOffset, columnOffset: pos.columnOffset,
    });
  }

  // Manifest
  let manifest = null;
  if (manifestLink) {
    const abs = urls.resolve(html.attr(manifestLink, 'href'));
    const order = nextOrder++;
    if (!abs) {
      manifest = { displayPath: String(html.attr(manifestLink, 'href')), json: null, error: 'invalid-url' };
      addResource({ order, kind: 'manifest', displayPath: manifest.displayPath, status: 'failed', reason: 'invalid-url' });
    } else {
      const res = await load(abs, 'manifest');
      if (!res.ok) {
        manifest = { displayPath: res.display, json: null, error: res.reason };
        addResource({ order, kind: 'manifest', displayPath: res.display, status: res.status, reason: res.reason });
      } else {
        let json = null;
        let error = null;
        try {
          json = JSON.parse(normalizeText(decodeText(res.bytes)));
        } catch {
          error = 'invalid-json';
        }
        manifest = { displayPath: res.display, json, error };
        addResource({ order, kind: 'manifest', displayPath: res.display, status: error ? 'parse-error' : 'parsed', reason: error });
      }
    }
    manifest = Object.freeze(manifest);
  }

  // Touch icons without sizes: read the PNG header.
  for (const el of iconLinks) {
    const abs = urls.resolve(html.attr(el, 'href'));
    if (!abs) continue;
    const order = nextOrder++;
    const res = await load(abs, 'image');
    if (!res.ok) {
      addResource({ order, kind: 'image', displayPath: res.display, status: res.status, reason: res.reason });
      continue;
    }
    const size = pngSize(res.bytes);
    if (size) imageSizes.set(el, size);
    addResource({ order, kind: 'image', displayPath: res.display, status: 'parsed', reason: size ? null : 'not-png' });
  }

  const firstParty = (kinds) => resources.filter((r) => kinds.includes(r.kind) && !(r.status === 'skipped' && COMPLETE_SKIP_REASONS.has(r.reason)) && r.reason !== 'duplicate');
  const cssComplete = firstParty(['stylesheet']).every((r) => r.status === 'parsed');
  const jsComplete = firstParty(['script', 'module']).every((r) => r.status === 'parsed');

  return {
    page: Object.freeze({
      kind: page.kind,
      displayUrl: docDisplay,
      origin: page.origin,
      status: page.status,
      headers: Object.freeze({ ...page.headers }),
      docUrl: page.docUrl,
      root: rootDir,
    }),
    urls,
    html,
    documentText: docText,
    sheets,
    scripts: [...scripts, ...eventAttrScripts],
    cssComplete,
    jsComplete,
    manifest,
    cspMetas,
    resources: resources.map((r) => Object.freeze({ ...r })),
    limits,
  };
}

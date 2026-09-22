/**
 * Input classification, root containment and page-relative URL helpers.
 */
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UxAuditError } from './errors.mjs';

/**
 * Classify the audit input.
 * - /^https?:\/\//i -> http
 * - /^file:/i -> file (fileURLToPath)
 * - a drive letter (C:\ or C:/) or no scheme -> file path resolved against cwd
 * - any other scheme -> SCHEME_NOT_ALLOWED
 * @param {string} input
 * @param {string} [cwd]
 * @returns {{ kind: 'http', url: string } | { kind: 'file', filePath: string }}
 */
export function classifyInput(input, cwd = process.cwd()) {
  const s = String(input ?? '').trim();
  if (!s) throw new UxAuditError('USAGE', 'No URL or file given.');
  if (/^https?:\/\//i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      throw new UxAuditError('USAGE', `Not a valid URL: ${s}`);
    }
    url.hash = '';
    return { kind: 'http', url: url.href };
  }
  if (/^file:/i.test(s)) {
    try {
      return { kind: 'file', filePath: fileURLToPath(s) };
    } catch {
      throw new UxAuditError('USAGE', `Not a valid file URL: ${s}`);
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(s)) return { kind: 'file', filePath: resolve(s) };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    throw new UxAuditError('SCHEME_NOT_ALLOWED', `Unsupported scheme in ${s.slice(0, s.indexOf(':') + 1)}. Use a local path, file://, http:// or https://.`);
  }
  return { kind: 'file', filePath: resolve(cwd, s) };
}

/** Normalize an origin allow-list entry ('https://cdn.example.com/x' -> 'https://cdn.example.com'). */
export function normalizeOrigin(value) {
  const s = String(value ?? '').trim();
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new UxAuditError('USAGE', `Not a valid origin: ${s}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UxAuditError('USAGE', `Origins must be http or https: ${s}`);
  return url.origin;
}

/** True when `p` equals `root` or sits inside it. Case-insensitive on win32. */
export function isInside(root, p) {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? p.toLowerCase() : p;
  if (a === b) return true;
  const withSep = a.endsWith(sep) ? a : a + sep;
  return b.startsWith(withSep);
}

/** realpath, or null when the file does not exist. */
export function safeRealpath(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    return null;
  }
}

/** Strip query and hash from a file: URL string. */
function stripFileSearch(u) {
  const url = new URL(u);
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Page-relative helpers shared by the collector and ctx.page.
 * @param {{ kind: 'file'|'http', docUrl: string, root?: string|null, origin?: string|null, allowOrigins?: string[] }} page
 */
export function createPageUrls(page) {
  const allow = new Set(page.allowOrigins ?? []);
  const rootDir = page.root ?? null;
  const rootUrl = rootDir ? pathToFileURL(rootDir.endsWith(sep) ? rootDir : rootDir + sep).href : null;
  let baseUrl = page.docUrl;

  const resolveAgainst = (href, againstUrl) => {
    const h = String(href ?? '').trim();
    if (!h) return null;
    try {
      if (page.kind === 'file') {
        if (h.startsWith('//')) return new URL(`https:${h}`).href;
        if (h.startsWith('/') && rootUrl) return stripFileSearch(new URL(h.slice(1), rootUrl).href);
        const abs = new URL(h, againstUrl);
        return abs.protocol === 'file:' ? stripFileSearch(abs.href) : withoutHash(abs.href);
      }
      return withoutHash(new URL(h, againstUrl).href);
    } catch {
      return null;
    }
  };

  const api = {
    /** Set the <base href> (resolved against the document URL). */
    setBase(href) {
      const r = resolveAgainst(href, page.docUrl);
      if (r) baseUrl = r;
    },
    get baseUrl() {
      return baseUrl;
    },
    resolve: (href) => resolveAgainst(href, baseUrl),
    resolveFrom: (href, fromUrl) => resolveAgainst(href, fromUrl),
    isSameOrigin(absUrl) {
      let url;
      try {
        url = new URL(absUrl);
      } catch {
        return false;
      }
      if (page.kind === 'http') {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return url.origin === page.origin || allow.has(url.origin);
      }
      if (url.protocol === 'file:') {
        try {
          return rootDir !== null && isInside(rootDir, fileURLToPath(url));
        } catch {
          return false;
        }
      }
      return (url.protocol === 'http:' || url.protocol === 'https:') && allow.has(url.origin);
    },
    toDisplay(absUrl) {
      let url;
      try {
        url = new URL(absUrl);
      } catch {
        return String(absUrl);
      }
      if (url.protocol === 'file:') {
        // An http page that links a file: URL: show the URL, never read it.
        if (!rootDir) return `file://${url.pathname}`;
        let p;
        try {
          p = fileURLToPath(url);
        } catch {
          return url.pathname;
        }
        const rel = relative(rootDir, p);
        if (!rel) return '.';
        if (isAbsolute(rel)) return `(outside root)/${basename(p)}`;
        return rel.split(sep).join('/');
      }
      url.hash = '';
      if (page.kind === 'http' && url.origin === page.origin) return `${url.pathname}${url.search}`;
      return url.href;
    },
  };
  return api;
}

function withoutHash(href) {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
}

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

/**
 * True for a URL hostname that names this machine or a private network:
 * localhost and *.localhost, 0/8, 10/8, 100.64/10, 127/8, 169.254/16
 * (link-local, cloud metadata), 172.16/12, 192.168/16, ::, ::1, fc00::/7,
 * fe80::/10 and IPv4-mapped IPv6 forms of those. The check is literal (as
 * the WHATWG URL parser normalizes the host); DNS is not resolved.
 * @param {string} hostname - URL.hostname (IPv6 in brackets)
 * @returns {boolean}
 */
export function isInternalHost(hostname) {
  let h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    h = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return false;
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

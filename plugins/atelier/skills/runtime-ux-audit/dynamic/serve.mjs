/**
 * Loopback static server for local inputs under --dynamic.
 *
 * Chromium only puts http(s) pages in the back/forward cache, and module
 * scripts and same-origin fetches behave like production only over http, so
 * a local file is served from http://127.0.0.1:<port>/ rooted at the audit
 * root. GET and HEAD only; no directory listing; no cache headers. Every
 * path is resolved and realpath'd, and anything outside the root is a 404.
 */
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isInside, safeRealpath } from '../lib/url.mjs';

const TEXT = (type) => `${type}; charset=utf-8`;

export const CONTENT_TYPES = Object.freeze({
  '.html': TEXT('text/html'),
  '.htm': TEXT('text/html'),
  '.xhtml': TEXT('application/xhtml+xml'),
  '.css': TEXT('text/css'),
  '.js': TEXT('text/javascript'),
  '.mjs': TEXT('text/javascript'),
  '.cjs': TEXT('text/javascript'),
  '.json': TEXT('application/json'),
  '.map': TEXT('application/json'),
  '.webmanifest': TEXT('application/manifest+json'),
  '.txt': TEXT('text/plain'),
  '.xml': TEXT('application/xml'),
  '.svg': TEXT('image/svg+xml'),
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
});

/** Content-Type for a file name, by extension. */
export function contentTypeFor(name) {
  return CONTENT_TYPES[extname(String(name)).toLowerCase()] ?? 'application/octet-stream';
}

function send(res, status, body = '') {
  res.writeHead(status, { 'Content-Type': TEXT('text/plain'), 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Start the server.
 * @param {string} root - directory to serve (realpath'd here)
 * @returns {Promise<{ origin: string, port: number, root: string,
 *   urlFor(filePath: string): string, toFileUrl(url: string): string|null, close(): Promise<void> }>}
 */
export async function startServer(root) {
  const rootDir = safeRealpath(resolve(String(root)));
  if (!rootDir) throw new Error(`Root directory not found: ${root}`);
  let host = null;

  const server = http.createServer((req, res) => {
    // Only this origin: a DNS-rebound page elsewhere must not read the root.
    if (req.headers.host !== host) return send(res, 403, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'Method Not Allowed');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      return send(res, 400, 'Bad Request');
    }
    if (pathname.includes('\0')) return send(res, 400, 'Bad Request');
    const abs = resolve(rootDir, `.${pathname}`);
    if (!isInside(rootDir, abs)) return send(res, 404, 'Not Found');
    const real = safeRealpath(abs);
    if (!real || !isInside(rootDir, real)) return send(res, 404, 'Not Found');
    let st;
    try {
      st = statSync(real);
    } catch {
      return send(res, 404, 'Not Found');
    }
    if (!st.isFile()) return send(res, 404, 'Not Found');
    res.writeHead(200, { 'Content-Type': contentTypeFor(real), 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return undefined;
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      ok();
    });
  });
  const { port } = server.address();
  host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;

  return {
    origin,
    port,
    root: rootDir,
    /** Served URL of a file inside the root. */
    urlFor(filePath) {
      const abs = resolve(String(filePath));
      const rel = relative(rootDir, safeRealpath(abs) ?? abs);
      return `${origin}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
    },
    /** Map a served URL back to the file:// URL it came from (query and hash dropped); null for other URLs. */
    toFileUrl(url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      if (u.origin !== origin) return null;
      let pathname;
      try {
        pathname = decodeURIComponent(u.pathname);
      } catch {
        return null;
      }
      const abs = resolve(rootDir, `.${pathname}`);
      if (!isInside(rootDir, abs)) return null;
      return pathToFileURL(safeRealpath(abs) ?? abs).href;
    },
    close() {
      return new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      });
    },
  };
}

/**
 * Bounded HTTP fetch: per-request timeout, collection-wide abort signal,
 * streaming byte cap, manual redirects re-checked on every hop.
 * Sends no cookies, credentials or auth headers.
 */

export const USER_AGENT = 'atelier-runtime-ux-audit/1.0';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const ACCEPT = {
  document: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  stylesheet: 'text/css,*/*;q=0.1',
  script: 'text/javascript,application/javascript,*/*;q=0.1',
  module: 'text/javascript,application/javascript,*/*;q=0.1',
  manifest: 'application/manifest+json,application/json,*/*;q=0.1',
  image: 'image/png,image/*;q=0.8,*/*;q=0.1',
};

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v);
  return out;
}

async function cancelBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} url - absolute http(s) URL
 * @param {{
 *   kind?: string, timeoutMs: number, maxBytes: number, maxRedirects: number,
 *   signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   policy?: (url: URL) => string|null   // reason to refuse a redirect hop, or null
 * }} opts
 * @returns {Promise<
 *   { ok: true, url: string, httpStatus: number, headers: Record<string,string>, bytes: Uint8Array } |
 *   { ok: false, url: string, status: 'failed'|'skipped'|'too-large', reason: string, httpStatus?: number }
 * >}
 */
export async function fetchBounded(url, opts) {
  const { kind = 'document', timeoutMs, maxBytes, maxRedirects, signal, policy } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return { ok: false, url: current, status: 'failed', reason: 'invalid-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, url: current, status: 'skipped', reason: 'scheme-not-allowed' };
    }
    if (hop > 0 && policy) {
      const refused = policy(parsed);
      if (refused) return { ok: false, url: current, status: 'skipped', reason: refused };
    }
    if (signal?.aborted) return { ok: false, url: current, status: 'failed', reason: 'timeout' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;
    try {
      const res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: ACCEPT[kind] ?? '*/*' },
        signal: combined,
      });
      if (REDIRECTS.has(res.status)) {
        const location = res.headers.get('location');
        await cancelBody(res);
        if (!location) return { ok: false, url: current, status: 'failed', reason: 'redirect-without-location', httpStatus: res.status };
        try {
          current = new URL(location, current).href;
        } catch {
          return { ok: false, url: current, status: 'failed', reason: 'invalid-redirect' };
        }
        continue;
      }
      if (res.status >= 400) {
        await cancelBody(res);
        return { ok: false, url: current, status: 'failed', reason: `http-${res.status}`, httpStatus: res.status };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await cancelBody(res);
        return { ok: false, url: current, status: 'too-large', reason: 'too-large', httpStatus: res.status };
      }
      const chunks = [];
      let total = 0;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return { ok: false, url: current, status: 'too-large', reason: 'too-large', httpStatus: res.status };
          }
          chunks.push(value);
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) return { ok: false, url: current, status: 'too-large', reason: 'too-large', httpStatus: res.status };
        chunks.push(buf);
        total = buf.byteLength;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
      return { ok: true, url: current, httpStatus: res.status, headers: headersToObject(res.headers), bytes };
    } catch (err) {
      const aborted = ctrl.signal.aborted || signal?.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError';
      return { ok: false, url: current, status: 'failed', reason: aborted ? 'timeout' : 'network-error' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, url: current, status: 'failed', reason: 'too-many-redirects' };
}

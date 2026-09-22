/**
 * Content-Security-Policy parsing. Report-only policies are never passed in.
 */

function parsePolicy(text) {
  const directives = {};
  for (const part of String(text).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    if (Object.hasOwn(directives, name)) continue; // first occurrence wins
    directives[name] = Object.freeze(tokens.slice(1));
  }
  return Object.freeze(directives);
}

/**
 * @param {string|null|undefined} header - Content-Security-Policy header value (multiple policies joined by ',')
 * @param {string[]} [metas] - content of each <meta http-equiv=Content-Security-Policy>
 * @returns {Array<{ source: 'header'|'meta', directives: Record<string, string[]> }>}
 */
export function parseCsp(header, metas = []) {
  const out = [];
  if (typeof header === 'string' && header.trim()) {
    for (const policy of header.split(',')) {
      const directives = parsePolicy(policy);
      if (Object.keys(directives).length) out.push(Object.freeze({ source: 'header', directives }));
    }
  }
  for (const content of metas) {
    if (typeof content !== 'string' || !content.trim()) continue;
    const directives = parsePolicy(content);
    if (Object.keys(directives).length) out.push(Object.freeze({ source: 'meta', directives }));
  }
  return Object.freeze(out);
}

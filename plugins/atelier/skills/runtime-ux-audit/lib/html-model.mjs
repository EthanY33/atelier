/**
 * HtmlModel: an indexed, read-only view of a parse5 document.
 *
 * Elements are parse5 element nodes. <template> contents are excluded (parse5
 * keeps them in template.content, which is never walked).
 */
import { parse, defaultTreeAdapter } from 'parse5';
import { matchesSelector, selectAll } from './selector-match.mjs';
import { UxAuditError } from './errors.mjs';

/**
 * Deepest element nesting the parser accepts. Chromium's HTML parser caps DOM
 * depth at 512 too. parse5 scans the whole stack of open elements for many
 * start tags, so parsing time grows with depth squared: 100,000 unclosed
 * <div>s (500 KB) took four minutes. Past this depth the audit stops with
 * COLLECT_FAILED (exit 2) instead of hanging.
 */
export const MAX_HTML_DEPTH = 512;

function depthGuardedAdapter(max, displayPath) {
  const depth = new WeakMap();
  const place = (parent, child) => {
    const d = (depth.get(parent) ?? 0) + 1;
    if (d > max) {
      throw new UxAuditError('COLLECT_FAILED', `${displayPath} nests elements more than ${max} deep.`, {
        hint: 'Close unclosed elements (browsers stop nesting past 512 levels), or audit a smaller page.',
      });
    }
    depth.set(child, d);
  };
  return {
    ...defaultTreeAdapter,
    appendChild(parent, child) {
      place(parent, child);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, ref) {
      place(parent, child);
      defaultTreeAdapter.insertBefore(parent, child, ref);
    },
  };
}

const TEXT_SKIP = new Set(['script', 'style', 'template', 'noscript']);

/** CSS.escape for identifiers (CSSOM serialize-an-identifier). */
export function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (code === 0) { out += String.fromCharCode(0xfffd); continue; }
    if ((code >= 0x1 && code <= 0x1f) || code === 0x7f
      || (i === 0 && code >= 0x30 && code <= 0x39)
      || (i === 1 && code >= 0x30 && code <= 0x39 && s.charCodeAt(0) === 0x2d)) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    if (i === 0 && code === 0x2d && s.length === 1) { out += `\\${ch}`; continue; }
    if (code >= 0x80 || code === 0x2d || code === 0x5f || /[0-9A-Za-z]/.test(ch)) { out += ch; continue; }
    out += `\\${ch}`;
  }
  return out;
}

/** Collapse whitespace and cap at `max` characters with a '...' suffix. */
export function collapseSnippet(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function isElement(node) {
  return node && typeof node.tagName === 'string';
}

/**
 * Build an HtmlModel.
 * @param {string} text - LF-normalized document source
 * @param {{ source?: 'static'|'rendered', displayPath?: string, resolve?: (href: string) => string|null, imageSizes?: Map<object, {width:number,height:number}> }} [meta]
 */
export function buildHtmlModel(text, meta = {}) {
  const source = meta.source ?? 'static';
  const displayPath = meta.displayPath ?? (source === 'rendered' ? '(rendered DOM)' : 'index.html');
  const resolveHref = typeof meta.resolve === 'function' ? meta.resolve : () => null;
  const document = parse(String(text ?? ''), { sourceCodeLocationInfo: true, treeAdapter: depthGuardedAdapter(MAX_HTML_DEPTH, displayPath) });

  const elements = [];
  const metas = new Map();
  const byTagIdx = new Map();
  const byRoleIdx = new Map();
  const byIdIdx = new Map();

  // Iterative pre-order DFS (deeply nested markup cannot overflow the stack).
  const childInfos = (parentNode, parentEl) => {
    const kids = (parentNode.childNodes ?? []).filter(isElement);
    const typeCounts = new Map();
    for (const k of kids) typeCounts.set(k.tagName.toLowerCase(), (typeCounts.get(k.tagName.toLowerCase()) ?? 0) + 1);
    const typeSeen = new Map();
    return kids.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const seen = (typeSeen.get(tag) ?? 0) + 1;
      typeSeen.set(tag, seen);
      return { el, tag, parentEl, prev: i > 0 ? kids[i - 1] : null, childIndex: i + 1, siblingCount: kids.length, typeIndex: seen, typeCount: typeCounts.get(tag) };
    });
  };
  const stack = childInfos(document, null).reverse();
  while (stack.length) {
    const info = stack.pop();
    const { el, tag } = info;
    const attrs = new Map();
    for (const a of el.attrs ?? []) {
      const name = a.name.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, a.value);
    }
    const id = attrs.has('id') && attrs.get('id') !== '' ? attrs.get('id') : null;
    const classes = new Set((attrs.get('class') ?? '').split(/\s+/).filter(Boolean));
    const hasContent = (el.childNodes ?? []).some((n) => isElement(n) || (n.nodeName === '#text' && n.value.length > 0));
    const m = {
      tag, id, classes, classList: [...classes], attrs,
      parent: info.parentEl, prev: info.prev, next: null, children: [],
      childIndex: info.childIndex, siblingCount: info.siblingCount,
      typeIndex: info.typeIndex, typeCount: info.typeCount,
      empty: !hasContent, order: elements.length, end: elements.length,
    };
    if (info.prev) metas.get(info.prev).next = el;
    metas.set(el, m);
    elements.push(el);
    if (info.parentEl) metas.get(info.parentEl).children.push(el);
    push(byTagIdx, tag, el);
    const role = (attrs.get('role') ?? '').trim().split(/\s+/)[0]?.toLowerCase();
    if (role) push(byRoleIdx, role, el);
    if (id !== null) push(byIdIdx, id, el);
    const kids = childInfos(el, el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  // Subtree end index: children follow their parent in pre-order.
  for (let i = elements.length - 1; i >= 0; i--) {
    const m = metas.get(elements[i]);
    const last = m.children[m.children.length - 1];
    m.end = last ? metas.get(last).end : m.order;
  }

  const adapter = (el) => {
    const m = metas.get(el);
    if (!m) throw new TypeError('element does not belong to this HtmlModel');
    return m;
  };
  const withAttrCache = new Map();

  const textOf = (el) => {
    const parts = [];
    const visit = (node) => {
      for (const n of node.childNodes ?? []) {
        if (n.nodeName === '#text') parts.push(n.value);
        else if (isElement(n) && !TEXT_SKIP.has(n.tagName.toLowerCase())) visit(n);
      }
    };
    visit(el);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  const rawTextOf = (el) => (el.childNodes ?? []).filter((n) => n.nodeName === '#text').map((n) => n.value).join('');

  const isUniqueId = (id) => (byIdIdx.get(id)?.length ?? 0) === 1;

  const cssPath = (el) => {
    const segs = [];
    for (let cur = el; cur; cur = metas.get(cur).parent) {
      const m = metas.get(cur);
      if (m.tag === 'html' || m.tag === 'body' || m.tag === 'head') { segs.unshift(m.tag); break; }
      if (m.id !== null && isUniqueId(m.id)) { segs.unshift(`#${cssEscape(m.id)}`); break; }
      let seg = m.tag + m.classList.slice(0, 2).map((c) => `.${cssEscape(c)}`).join('');
      if (m.typeCount > 1) seg += `:nth-of-type(${m.typeIndex})`;
      segs.unshift(seg);
    }
    return segs.join(' > ');
  };

  const startTagSource = (el) => {
    const loc = el.sourceCodeLocation?.startTag ?? null;
    if (loc && source === 'static') return text.slice(loc.startOffset, loc.endOffset);
    if (loc && source === 'rendered') return text.slice(loc.startOffset, loc.endOffset);
    const m = metas.get(el);
    const attrs = [...m.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${v.replace(/"/g, '&quot;')}"`)).join('');
    return `<${m.tag}${attrs}>`;
  };

  /** 1-based { line, column } of the start tag, or of one of its attributes. */
  const locationOf = (el, attrName) => {
    const loc = el.sourceCodeLocation;
    if (!loc) return null;
    if (attrName) {
      const a = loc.startTag?.attrs?.[attrName.toLowerCase()];
      if (a) return { line: a.startLine, column: a.startCol, offset: a.startOffset, endOffset: a.endOffset };
    }
    const st = loc.startTag ?? loc;
    return { line: st.startLine, column: st.startCol, offset: st.startOffset, endOffset: st.endOffset };
  };

  // viewport: the last <meta name=viewport> wins.
  let viewportEl = null;
  for (const el of byTagIdx.get('meta') ?? []) {
    if ((metas.get(el).attrs.get('name') ?? '').trim().toLowerCase() === 'viewport') viewportEl = el;
  }
  const viewportContent = viewportEl ? metas.get(viewportEl).attrs.get('content') ?? null : null;
  const viewportProps = {};
  if (viewportContent !== null) {
    for (const part of viewportContent.split(/[,;]/)) {
      const [k, ...rest] = part.split('=');
      const key = k.trim().toLowerCase();
      if (!key) continue;
      viewportProps[key] = rest.join('=').trim().toLowerCase();
    }
  }

  // The first <base href> sets the base URL before any link resolves.
  if (typeof meta.onBase === 'function') {
    const baseEl = (byTagIdx.get('base') ?? []).find((el) => metas.get(el).attrs.has('href'));
    if (baseEl) meta.onBase(metas.get(baseEl).attrs.get('href'));
  }
  const imageSizes = meta.imageSizes instanceof Map ? meta.imageSizes : new Map();
  const links = (byTagIdx.get('link') ?? []).map((el) => {
    const a = metas.get(el).attrs;
    const href = a.has('href') ? a.get('href') : null;
    return Object.freeze({
      el,
      rel: Object.freeze((a.get('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean)),
      href,
      url: href === null ? null : resolveHref(href),
      sizes: a.get('sizes') ?? null,
      as: a.get('as') ?? null,
      media: a.get('media') ?? null,
      // Filled by the collector after it reads the PNG header, hence a getter.
      get imageSize() { return imageSizes.get(el) ?? null; },
    });
  });

  const speculationRules = (byTagIdx.get('script') ?? [])
    .filter((el) => (metas.get(el).attrs.get('type') ?? '').trim().toLowerCase() === 'speculationrules')
    .map((el) => {
      const rawText = rawTextOf(el);
      let json = null;
      let error = null;
      try {
        json = JSON.parse(rawText);
      } catch {
        error = 'invalid JSON';
      }
      return Object.freeze({ el, rawText, json, error });
    });

  const eventAttrs = [];
  for (const el of elements) {
    for (const [name, value] of metas.get(el).attrs) {
      if (/^on[a-z]/.test(name)) eventAttrs.push(Object.freeze({ el, name, value }));
    }
  }

  const model = {
    source,
    displayPath,
    document,
    text,
    elements: Object.freeze(elements),
    byTag: (tag) => byTagIdx.get(String(tag).toLowerCase()) ?? [],
    byRole: (role) => byRoleIdx.get(String(role).toLowerCase()) ?? [],
    withAttr: (name) => {
      const key = String(name).toLowerCase();
      if (!withAttrCache.has(key)) withAttrCache.set(key, Object.freeze(elements.filter((el) => metas.get(el).attrs.has(key))));
      return withAttrCache.get(key);
    },
    byId: (id) => byIdIdx.get(String(id))?.[0] ?? null,
    querySelectorAll: (sel) => selectAll(adapter, elements, sel),
    matches: (el, sel) => matchesSelector(adapter, el, sel),
    attr: (el, name) => adapter(el).attrs.get(String(name).toLowerCase()) ?? null,
    hasAttr: (el, name) => adapter(el).attrs.has(String(name).toLowerCase()),
    tag: (el) => adapter(el).tag,
    parent: (el) => adapter(el).parent,
    prevSibling: (el) => adapter(el).prev,
    nextSibling: (el) => adapter(el).next,
    children: (el) => adapter(el).children,
    ancestors: (el) => {
      const out = [];
      for (let p = adapter(el).parent; p; p = metas.get(p).parent) out.push(p);
      return out;
    },
    descendants: (el, pred) => {
      const m = adapter(el);
      const list = elements.slice(m.order + 1, m.end + 1);
      return typeof pred === 'function' ? list.filter(pred) : list;
    },
    closest: (el, pred) => {
      for (let cur = el; cur; cur = metas.get(cur).parent) if (pred(cur)) return cur;
      return null;
    },
    text: (el) => textOf(el),
    viewport: Object.freeze({ el: viewportEl, content: viewportContent, props: Object.freeze(viewportProps) }),
    links: Object.freeze(links),
    speculationRules: Object.freeze(speculationRules),
    eventAttrs: Object.freeze(eventAttrs),
    // Extras (not in the minimal contract, stable):
    owns: (el) => metas.has(el),
    cssPath: (el) => { adapter(el); return cssPath(el); },
    classes: (el) => adapter(el).classList,
    indexOf: (el) => adapter(el).order,
    rawText: (el) => { adapter(el); return rawTextOf(el); },
    startTagSource: (el) => { adapter(el); return startTagSource(el); },
    locationOf: (el, attrName) => { adapter(el); return locationOf(el, attrName); },
  };
  return Object.freeze(model);
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

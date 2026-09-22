/**
 * buildContext(): the read-only ctx every rule receives, including the
 * ctx.ref.* NodeRef builders.
 */
import { buildCssModel } from './css-model.mjs';
import { buildJsModel } from './js-model.mjs';
import { collapseSnippet } from './html-model.mjs';
import { parseCsp } from './csp.mjs';

/** Sort buckets for NodeRef.order: page-level refs first, runtime last. */
export const ORDER_PAGE = -1;
export const ORDER_DOCUMENT = 0;
export const ORDER_RENDERED = 1e9;
export const ORDER_RUNTIME = 2e9;

/** Hidden marker: only refs built by ctx.ref carry it. */
export const REF_META = Symbol('atelier.runtime-ux.ref');

/** True when `node` was built by a ctx.ref builder. */
export function isNodeRef(node) {
  return Boolean(node && typeof node === 'object' && node[REF_META]);
}

/** Internal metadata of a NodeRef (anchorEl, model, cssNode, script, jsLine). */
export function refMeta(node) {
  return node?.[REF_META] ?? null;
}

function makeRef(selector, snippet, location, meta) {
  const ref = {
    selector: String(selector ?? ''),
    snippet: collapseSnippet(snippet ?? ''),
    location: String(location ?? ''),
  };
  Object.defineProperties(ref, {
    order: { value: meta.order, enumerable: false },
    line: { value: meta.line ?? 0, enumerable: false },
    column: { value: meta.column ?? 0, enumerable: false },
    anchorEl: { value: meta.anchorEl ?? null, enumerable: false },
    [REF_META]: { value: Object.freeze({ ...meta }), enumerable: false },
  });
  return Object.freeze(ref);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const v of Object.values(value)) deepFreeze(v, seen);
  return Object.freeze(value);
}

/**
 * @param {object} collected - collect() result
 * @param {{ options: { dynamic: boolean, areas: string[] }, budgets: object, brand: object|null, dynamic?: object|null, rendered?: object|null }} extra
 */
export function buildContext(collected, { options, budgets, brand = null, dynamic = null, rendered = null }) {
  const { html, urls } = collected;
  const css = buildCssModel(collected.sheets, { complete: collected.cssComplete });
  const js = buildJsModel(collected.scripts, { complete: collected.jsComplete });
  const docDisplay = collected.page.displayUrl;
  const headers = collected.page.headers ?? {};
  const csp = parseCsp(collected.page.kind === 'http' ? headers['content-security-policy'] : null, collected.cspMetas ?? []);

  const modelFor = (el) => {
    if (html.owns(el)) return html;
    if (rendered && rendered.owns(el)) return rendered;
    return null;
  };

  const ref = Object.freeze({
    /** Element ref. selector = cssPath, snippet = start tag, location = file:line:col or '(rendered DOM)'. */
    html(el, attrName) {
      const model = modelFor(el);
      if (!model) throw new TypeError('ctx.ref.html: the element is not from ctx.html or ctx.rendered');
      const loc = model.locationOf(el, attrName);
      const isRendered = model !== html;
      const location = isRendered ? '(rendered DOM)' : loc ? `${docDisplay}:${loc.line}:${loc.column}` : docDisplay;
      return makeRef(model.cssPath(el), model.startTagSource(el), location, {
        order: isRendered ? ORDER_RENDERED : ORDER_DOCUMENT, line: loc?.line ?? 0, column: loc?.column ?? 0,
        anchorEl: el, model, kind: 'html',
      });
    },

    /** CSS ref from a postcss node or a RuleInfo / DeclInfo / AtRuleInfo. */
    css(nodeOrInfo) {
      const node = nodeOrInfo && nodeOrInfo.node && !nodeOrInfo.type ? nodeOrInfo.node : nodeOrInfo;
      const found = css.infoOf(node);
      if (!found) throw new TypeError('ctx.ref.css: not a node from ctx.css');
      const { kind, info, sheet } = found;
      const isAttr = sheet.origin === 'style-attr';
      let selector;
      let snippet;
      if (kind === 'decl') {
        const decl = `${info.prop}: ${info.value}${info.important ? ' !important' : ''}`;
        if (info.rule) selector = info.rule.selectorText;
        else if (info.atRule) selector = `@${info.atRule.name} ${info.atRule.params}`.trim();
        else selector = '';
        snippet = isAttr ? `style="${decl}"` : `${selector} { ${decl} }`;
      } else if (kind === 'rule') {
        selector = info.selectorText;
        snippet = isAttr ? `style="${sheet.rawText}"` : `${selector} { ... }`;
      } else {
        selector = `@${info.name} ${info.params}`.trim();
        snippet = selector;
      }
      let line = 0;
      let column = 0;
      if (isAttr) {
        line = sheet.attrLine ?? 0;
        column = sheet.attrColumn ?? 0;
      } else {
        const start = node.source?.start;
        if (start) {
          line = start.line + (sheet.lineOffset ?? 0);
          column = start.line === 1 ? start.column + (sheet.columnOffset ?? 0) : start.column;
        }
      }
      const location = line ? `${sheet.displayPath}:${line}:${column}` : sheet.displayPath;
      return makeRef(selector, snippet, location, {
        order: sheet.inDocument ? ORDER_DOCUMENT : sheet.order, line, column,
        anchorEl: sheet.anchorEl ?? sheet.el ?? null, model: html, kind: 'css', cssNode: node,
      });
    },

    /** JS ref: ref.js(script, astNode) or ref.js(info) for CallInfo / ListenerInfo / AssignInfo / ImportInfo. */
    js(scriptOrInfo, astNode) {
      let script = scriptOrInfo;
      let node = astNode;
      if (astNode === undefined && scriptOrInfo && scriptOrInfo.script && scriptOrInfo.node) {
        script = scriptOrInfo.script;
        node = scriptOrInfo.node;
      }
      if (!script || typeof script.selector !== 'string' || !node) throw new TypeError('ctx.ref.js: expected (script, node) or an info object with .script and .node');
      const start = node.loc?.start;
      let line = 0;
      let column = 0;
      if (start) {
        line = start.line + (script.lineOffset ?? 0);
        column = (start.line === 1 ? start.column + (script.columnOffset ?? 0) : start.column) + 1;
      }
      const snippet = script.kind === 'event-attr' && node.type === 'Program' ? script.source : js.sourceOf(script, node);
      const location = line ? `${script.displayPath}:${line}:${column}` : script.displayPath;
      return makeRef(script.selector, snippet, location, {
        order: script.inDocument ? ORDER_DOCUMENT : script.order, line, column,
        anchorEl: script.anchorEl ?? script.el ?? null, model: html, kind: 'js', script, jsLine: start?.line ?? 0,
      });
    },

    /**
     * Page-level ref, selector 'document'. location defaults to
     * '(response headers)' when label names a response header present in
     * ctx.page.headers, else to the document path; pass a third argument to override.
     */
    page(label, snippet, location) {
      const isHeader = typeof label === 'string' && Object.hasOwn(headers, label.toLowerCase());
      const loc = location ?? (isHeader ? '(response headers)' : docDisplay);
      return makeRef('document', snippet ?? String(label ?? ''), loc, { order: ORDER_PAGE, line: 0, column: 0, anchorEl: null, kind: 'page' });
    },

    /** Runtime ref from dynamic facts. location defaults to '(runtime)'. */
    dynamic({ selector, snippet, location } = {}) {
      return makeRef(selector ?? 'document', snippet ?? '', location ?? '(runtime)', { order: ORDER_RUNTIME, line: 0, column: 0, anchorEl: null, kind: 'dynamic' });
    },
  });

  const page = Object.freeze({
    kind: collected.page.kind,
    displayUrl: docDisplay,
    origin: collected.page.origin,
    status: collected.page.status,
    headers: Object.freeze({ ...headers }),
    csp,
    resolve: (href) => urls.resolve(href),
    isSameOrigin: (absUrl) => urls.isSameOrigin(absUrl),
    toDisplay: (absUrl) => urls.toDisplay(absUrl),
  });

  const ctx = {
    page,
    options: Object.freeze({ dynamic: Boolean(options.dynamic), areas: Object.freeze([...options.areas]) }),
    budgets,
    brand: brand === null ? null : deepFreeze(structuredClone(brand)),
    html,
    rendered: rendered ?? null,
    css,
    js,
    manifest: collected.manifest ?? null,
    resources: Object.freeze(collected.resources.map((r) => Object.freeze({ order: r.order, kind: r.kind, displayPath: r.displayPath, status: r.status, reason: r.reason ?? null }))),
    dynamic: dynamic === null ? null : deepFreeze(structuredClone(dynamic)),
    ref,
  };
  return Object.freeze(ctx);
}

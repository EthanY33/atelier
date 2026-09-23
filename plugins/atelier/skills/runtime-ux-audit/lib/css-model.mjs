/**
 * CssModel on postcss: flattens nesting, tracks at-rule contexts and builds
 * lookup indices. Sheets come from the collector (see collect.mjs).
 */
import postcss from 'postcss';
import { normalizeSelector, splitSelectorList, stripCssComments } from './css-values.mjs';

const EMPTY_CONTEXT = Object.freeze({
  media: Object.freeze([]), supports: Object.freeze([]), layer: Object.freeze([]), container: Object.freeze([]),
  startingStyle: false, keyframes: null,
});

/** Lowercase, collapse whitespace, drop padding inside parentheses. */
export function normalizePrelude(params) {
  return stripCssComments(params)
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
    .toLowerCase();
}

/**
 * Parse CSS text without `from`, so errors never carry an absolute path.
 * @param {string} text
 * @returns {{ root: import('postcss').Root|null, error: { reason: string, line: number|null, column: number|null }|null }}
 */
export function parseCss(text) {
  try {
    return { root: postcss.parse(text), error: null };
  } catch (err) {
    return { root: null, error: { reason: String(err?.reason ?? err?.message ?? 'parse error'), line: err?.line ?? null, column: err?.column ?? null } };
  }
}

/** True when a @media prelude only targets print. */
export function isPrintOnlyMedia(params) {
  const list = normalizePrelude(params).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 && list.every((q) => /^(only\s+)?print(\s|$)/.test(q));
}

function extendContext(ctx, name, params) {
  const p = normalizePrelude(params);
  switch (name) {
    case 'media': return freezeCtx({ ...ctx, media: [...ctx.media, p] });
    case 'supports': return freezeCtx({ ...ctx, supports: [...ctx.supports, p] });
    case 'layer': return freezeCtx({ ...ctx, layer: [...ctx.layer, p] });
    case 'container': return freezeCtx({ ...ctx, container: [...ctx.container, p] });
    case 'starting-style': return freezeCtx({ ...ctx, startingStyle: true });
    case 'keyframes':
    case '-webkit-keyframes':
    case '-moz-keyframes':
      return freezeCtx({ ...ctx, keyframes: String(params ?? '').trim() });
    default: return ctx;
  }
}

function freezeCtx(c) {
  return Object.freeze({
    media: Object.freeze([...c.media]), supports: Object.freeze([...c.supports]), layer: Object.freeze([...c.layer]),
    container: Object.freeze([...c.container]), startingStyle: c.startingStyle, keyframes: c.keyframes,
  });
}

const MAX_SELECTORS = 256;
// '&' substitution multiplies selector length at every nesting level, and
// walk() recurses once per level, so page-controlled CSS could otherwise build
// selectors of millions of characters or overflow the stack. Rules past these
// bounds are not analyzed and the model reports truncated (complete: false).
export const MAX_SELECTOR_LENGTH = 4096;
export const MAX_NESTING_DEPTH = 64;
/** Total characters of resolved nested selectors per model. */
const MAX_RESOLVED_CHARS = 1024 * 1024;

const TOO_LONG = Symbol('too long');

/**
 * Replace each '&' outside strings and attribute brackets with parent.
 * Returns null when sel has no such '&', and TOO_LONG once the result passes
 * MAX_SELECTOR_LENGTH. One linear pass.
 */
function replaceNesting(sel, parent) {
  let out = '';
  let quote = null;
  let bracket = 0;
  let replaced = false;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '\\') { out += sel.slice(i, i + 2); i++; continue; }
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '[') bracket++;
    if (ch === ']') bracket--;
    if (ch === '&' && bracket === 0) { out += parent; replaced = true; } else out += ch;
    if (out.length > MAX_SELECTOR_LENGTH) return TOO_LONG;
  }
  return replaced ? out : null;
}

function resolveSelectors(selectorText, parentSelectors, budget) {
  if (parentSelectors && parentSelectors.length > 0 && budget.chars >= MAX_RESOLVED_CHARS) {
    budget.dropped = true;
    return [];
  }
  const items = splitSelectorList(selectorText);
  if (!parentSelectors || parentSelectors.length === 0) return items;
  const out = [];
  for (const p of parentSelectors) {
    for (const s of items) {
      if (budget.chars >= MAX_RESOLVED_CHARS) {
        budget.dropped = true;
        return [...new Set(out)];
      }
      // The resolved selector is never shorter than the nested one.
      const nested = s.length > MAX_SELECTOR_LENGTH ? TOO_LONG : replaceNesting(s, p);
      const joined = nested === null ? `${p} ${s}` : nested;
      if (joined === TOO_LONG || joined.length > MAX_SELECTOR_LENGTH || budget.chars + joined.length > MAX_RESOLVED_CHARS) {
        budget.dropped = true;
        continue;
      }
      budget.chars += joined.length;
      out.push(normalizeSelector(joined));
      if (out.length >= MAX_SELECTORS) return [...new Set(out)];
    }
  }
  return [...new Set(out)];
}

function makeGetter(decls) {
  return (prop) => {
    const key = normalizeProp(prop);
    let winner = null;
    for (const d of decls) {
      if (d.prop !== key) continue;
      if (winner && winner.important && !d.important) continue;
      winner = d;
    }
    return winner;
  };
}

function normalizeProp(prop) {
  const p = String(prop ?? '').trim();
  return p.startsWith('--') ? p : p.toLowerCase();
}

/**
 * Build a CssModel.
 * @param {Array<object>} sheets - collector sheet records in resource order:
 *   { order, displayPath, origin: 'style'|'link'|'import'|'style-attr', el, root, error,
 *     parentOrder?: number|null, styleAttrSelector?: string }
 * @param {{ complete?: boolean }} [opts]
 */
export function buildCssModel(sheetRecords, { complete = true } = {}) {
  const sheets = sheetRecords.map((s) => Object.freeze(s));
  const rules = [];
  const decls = [];
  const atRules = [];
  const infoByNode = new WeakMap();

  // Cascade order: an @import'ed sheet precedes its parent; style attributes last.
  const children = new Map();
  const topLevel = [];
  const attrSheets = [];
  for (const s of sheets) {
    if (s.origin === 'style-attr') attrSheets.push(s);
    else if (s.parentOrder !== undefined && s.parentOrder !== null) {
      if (!children.has(s.parentOrder)) children.set(s.parentOrder, []);
      children.get(s.parentOrder).push(s);
    } else topLevel.push(s);
  }
  const cascade = [];
  const addWithImports = (s, seen = new Set()) => {
    if (seen.has(s.order)) return;
    seen.add(s.order);
    for (const c of children.get(s.order) ?? []) addWithImports(c, seen);
    cascade.push(s);
  };
  for (const s of topLevel) addWithImports(s);
  // Orphans (parent missing) keep resource order. A Set, not cascade.includes():
  // a page can hold any number of <style> elements.
  const placed = new Set(cascade);
  for (const s of sheets) if (s.origin !== 'style-attr' && !placed.has(s)) cascade.push(s);
  cascade.push(...attrSheets);

  const addDecl = (node, sheet, context, rule, atRule) => {
    const info = Object.freeze({
      node, prop: normalizeProp(node.prop), value: String(node.value ?? '').trim(), important: Boolean(node.important),
      rule, atRule, sheet, context,
    });
    decls.push(info);
    infoByNode.set(node, { kind: 'decl', info, sheet });
    return info;
  };

  let truncated = false;
  const budget = { chars: 0, dropped: false };
  const walk = (container, sheet, context, parentRule, parentAt, depth = 0) => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'decl') {
        const d = addDecl(node, sheet, context, parentRule, parentAt);
        if (parentRule && container === parentRule.node) parentRule.decls.push(d);
      } else if (depth >= MAX_NESTING_DEPTH) {
        truncated = true;
      } else if (node.type === 'rule') {
        budget.dropped = false;
        const selectors = context.keyframes !== null
          ? splitSelectorList(node.selector)
          : resolveSelectors(node.selector, parentRule?.selectors, budget);
        if (budget.dropped) truncated = true;
        // Every selector over budget: skip the subtree, so its children are
        // not resolved as if they were top-level rules.
        if (budget.dropped && selectors.length === 0) continue;
        const ruleDecls = [];
        const info = {
          node, selectorText: selectors.join(', '), selectors: Object.freeze(selectors), sheet, context,
          decls: ruleDecls, get: makeGetter(ruleDecls), fromStyleAttr: null,
        };
        rules.push(info);
        infoByNode.set(node, { kind: 'rule', info, sheet });
        walk(node, sheet, context, info, null, depth + 1);
        Object.freeze(ruleDecls);
        Object.freeze(info);
      } else if (node.type === 'atrule') {
        const name = String(node.name).toLowerCase();
        const params = stripCssComments(node.params).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
        const at = Object.freeze({ node, name, params, sheet, context, rule: parentRule });
        atRules.push(at);
        infoByNode.set(node, { kind: 'atrule', info: at, sheet });
        if (name === 'media' && isPrintOnlyMedia(node.params)) continue;
        if (node.nodes) walk(node, sheet, extendContext(context, name, node.params), parentRule, at, depth + 1);
      }
    }
  };

  for (const sheet of cascade) {
    if (!sheet.root) continue;
    if (sheet.origin === 'style-attr') {
      const ruleDecls = [];
      const selector = sheet.styleAttrSelector ?? '*';
      const info = {
        node: sheet.root, selectorText: selector, selectors: Object.freeze([selector]), sheet, context: EMPTY_CONTEXT,
        decls: ruleDecls, get: makeGetter(ruleDecls), fromStyleAttr: sheet.el,
      };
      rules.push(info);
      infoByNode.set(sheet.root, { kind: 'rule', info, sheet });
      for (const node of sheet.root.nodes ?? []) {
        if (node.type === 'decl') ruleDecls.push(addDecl(node, sheet, EMPTY_CONTEXT, info, null));
      }
      Object.freeze(ruleDecls);
      Object.freeze(info);
      continue;
    }
    const start = sheet.media ? extendContext(EMPTY_CONTEXT, 'media', sheet.media) : EMPTY_CONTEXT;
    walk(sheet.root, sheet, start, null, null);
  }

  const byProp = new Map();
  for (const d of decls) push(byProp, d.prop, d);
  const bySelector = new Map();
  for (const r of rules) {
    if (r.context.keyframes !== null) continue;
    const keys = new Set([r.selectorText, ...r.selectors]);
    for (const k of keys) push(bySelector, k, r);
  }
  const byAtName = new Map();
  for (const a of atRules) push(byAtName, a.name, a);

  const customProps = (name) => byProp.get(String(name).trim()) ?? [];

  const valueMentions = (value, re, depth = 3, seen = new Set()) => {
    const v = String(value ?? '');
    re.lastIndex = 0;
    if (re.test(v)) return true;
    if (depth <= 0) return false;
    for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      for (const d of customProps(name)) if (valueMentions(d.value, re, depth - 1, seen)) return true;
    }
    return false;
  };

  return Object.freeze({
    complete: Boolean(complete) && !truncated,
    // Some nested rules were not analyzed (depth or selector-length bounds).
    truncated,
    sheets: Object.freeze(sheets),
    rules: Object.freeze(rules),
    decls: Object.freeze(decls),
    atRules: Object.freeze(atRules),
    declsByProp: (prop) => byProp.get(normalizeProp(prop)) ?? [],
    customProps,
    rulesBySelector: (sel) => bySelector.get(normalizeSelector(sel)) ?? [],
    atRulesByName: (name) => byAtName.get(String(name).toLowerCase()) ?? [],
    valueMentions: (value, re, depth = 3) => valueMentions(value, re, depth),
    // Extra: postcss node -> { kind: 'decl'|'rule'|'atrule', info, sheet }
    infoOf: (node) => infoByNode.get(node) ?? null,
  });
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

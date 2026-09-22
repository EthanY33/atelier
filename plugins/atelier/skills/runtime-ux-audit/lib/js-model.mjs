/**
 * JsModel on acorn + acorn-walk. Page code is parsed, never executed.
 *
 * Indexes calls, listeners, assignments and imports, and offers the guard and
 * conditional helpers the rules share.
 */
import * as acorn from 'acorn';
import { base as walkBase } from 'acorn-walk';
import { boolLiteral } from './css-values.mjs';

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const GLOBAL_PREFIX_RE = /^(?:(?:window|self|globalThis)\.)+/;
const JQUERY_NAMES = new Set(['$', 'jQuery']);
const JQUERY_ON = new Set(['on', 'one', 'bind']);
const JQUERY_SHORTHANDS = new Set(['blur', 'focus', 'focusin', 'focusout', 'resize', 'scroll', 'click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'change', 'select', 'submit', 'keydown', 'keypress', 'keyup', 'contextmenu', 'unload']);
// Body/frameset attributes that register on the window (HTML "window-reflecting" handlers).
const WINDOW_REFLECTING = new Set(['blur', 'error', 'focus', 'load', 'resize', 'scroll', 'afterprint', 'beforeprint', 'beforeunload', 'hashchange', 'languagechange', 'message', 'messageerror', 'offline', 'online', 'pageswap', 'pagehide', 'pagereveal', 'pageshow', 'popstate', 'rejectionhandled', 'storage', 'unhandledrejection', 'unload']);

export const isFunctionNode = (n) => Boolean(n) && FUNCTION_TYPES.has(n.type);

/**
 * Parse JS with acorn. Classic scripts that fail are retried as modules.
 * @param {string} source - LF-normalized
 * @param {{ module?: boolean, eventAttr?: boolean }} [opts]
 * @returns {{ ast: object|null, comments: object[], sourceType: 'script'|'module', error: { message: string, line: number|null, column: number|null }|null }}
 */
export function parseJs(source, { module = false, eventAttr = false } = {}) {
  const attempt = (sourceType) => {
    const comments = [];
    const ast = acorn.parse(source, {
      ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true, onComment: comments,
      allowReturnOutsideFunction: eventAttr,
    });
    return { ast, comments, sourceType, error: null };
  };
  try {
    return attempt(module ? 'module' : 'script');
  } catch (first) {
    if (!module && !eventAttr) {
      try { return attempt('module'); } catch { /* report the classic error */ }
    }
    return {
      ast: null, comments: [], sourceType: module ? 'module' : 'script',
      error: {
        message: String(first?.message ?? 'parse error').replace(/\s*\(\d+:\d+\)$/, ''),
        line: first?.loc?.line ?? null,
        column: typeof first?.loc?.column === 'number' ? first.loc.column + 1 : null,
      },
    };
  }
}

/** Direct child nodes in source order, via acorn-walk's base visitors. */
export function childNodes(node) {
  const out = [];
  const visitor = walkBase[node?.type];
  if (!visitor) return out;
  const cb = (child, st, override) => {
    if (!child) return;
    if (child === node) {
      const v = walkBase[override];
      if (v) v(child, st, cb);
      return;
    }
    out.push(child);
  };
  visitor(node, null, cb);
  return out;
}

/**
 * Iterative pre-order traversal. enter(node, ancestors) may return false to
 * skip the node's children. `ancestors` is live (root..parent); copy it to keep.
 */
export function traverse(root, enter) {
  const path = [];
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    path.length = depth;
    if (enter(node, path) === false) continue;
    path.push(node);
    const kids = childNodes(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
  }
}

/** Dotted path of an expression; '?' marks a computed or call segment. */
export function pathOf(n) {
  if (!n) return '?';
  switch (n.type) {
    case 'Identifier': return n.name;
    case 'ThisExpression': return 'this';
    case 'Super': return 'super';
    case 'ChainExpression': return pathOf(n.expression);
    case 'MetaProperty': return `${n.meta.name}.${n.property.name}`;
    case 'MemberExpression': {
      let prop = '?';
      if (!n.computed) prop = n.property.type === 'PrivateIdentifier' ? `#${n.property.name}` : n.property.name;
      else if (n.property.type === 'Literal' && typeof n.property.value === 'string') prop = n.property.value;
      else if (n.property.type === 'TemplateLiteral' && n.property.expressions.length === 0) prop = n.property.quasis[0].value.cooked;
      return `${pathOf(n.object)}.${prop}`;
    }
    default: return '?';
  }
}

const stripGlobal = (p) => String(p).replace(GLOBAL_PREFIX_RE, '');

/** Value of a string Literal or an expression-free template literal, else null. */
export function stringValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function unwrapChain(n) {
  return n?.type === 'ChainExpression' ? n.expression : n;
}

function markIife(fn, parent, grand) {
  let iife = false;
  if (parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && unwrapChain(parent.callee) === fn) iife = true;
  if (!iife && parent?.type === 'MemberExpression' && parent.object === fn && !parent.computed
    && ['call', 'apply'].includes(parent.property.name) && grand?.type === 'CallExpression' && grand.callee === parent) iife = true;
  Object.defineProperty(fn, '__iife', { value: iife, enumerable: false, configurable: true });
}

function hasEnclosingNonArrowFn(ancestors) {
  return ancestors.some((a) => a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression');
}

function computeTopLevel(ancestors) {
  return ancestors.every((a) => !FUNCTION_TYPES.has(a.type) || a.__iife === true);
}

function computeInLoop(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (FUNCTION_TYPES.has(a.type)) return false;
    if (LOOP_TYPES.has(a.type)) return true;
  }
  return false;
}

function classifyTarget(receiver, ancestors) {
  if (!receiver) return 'window';
  const node = unwrapChain(receiver);
  if (node.type === 'ThisExpression') return hasEnclosingNonArrowFn(ancestors) ? 'unknown' : 'window';
  const raw = pathOf(node);
  if (raw === 'window' || raw === 'self' || raw === 'globalThis') return 'window';
  const p = stripGlobal(raw);
  if (p === 'document') return 'document';
  if (p === 'document.body' || p === 'document.documentElement' || p === 'document.scrollingElement') return 'root-element';
  return 'element';
}

function classifyJqueryTarget(arg, ancestors) {
  if (!arg) return 'unknown';
  const s = stringValue(arg);
  if (s !== null) return /^\s*(body|html)\s*$/i.test(s) ? 'root-element' : 'element';
  return classifyTarget(arg, ancestors);
}

function parseListenerOptions(node) {
  if (!node) return Object.freeze({ kind: 'none', passive: undefined, capture: false, once: false, signal: false });
  const b = boolLiteral(node);
  if (b !== null) return Object.freeze({ kind: 'boolean', passive: undefined, capture: b, once: false, signal: false });
  if (node.type === 'ObjectExpression') {
    const get = (name) => node.properties.find((p) => p.type === 'Property' && !p.computed
      && ((p.key.type === 'Identifier' && p.key.name === name) || (p.key.type === 'Literal' && p.key.value === name)));
    const passiveProp = get('passive');
    const passive = passiveProp ? boolLiteral(passiveProp.value) ?? undefined : undefined;
    return Object.freeze({
      kind: 'object',
      passive,
      capture: get('capture') ? boolLiteral(get('capture').value) === true : false,
      once: get('once') ? boolLiteral(get('once').value) === true : false,
      signal: Boolean(get('signal')),
    });
  }
  return Object.freeze({ kind: 'unknown', passive: undefined, capture: false, once: false, signal: false });
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Build a JsModel from collector script records.
 * @param {Array<object>} scripts - ScriptInfo records (ast may be null)
 * @param {{ complete?: boolean }} [opts]
 */
export function buildJsModel(scripts, { complete = true } = {}) {
  const calls = [];
  const listeners = [];
  const assignments = [];
  const imports = [];
  const literalIndex = new Map();
  const fnIndex = new Map(); // script -> Map(name -> fn node)
  const initIndex = new Map(); // script -> Map(name -> init node)
  const listenerByFn = new Map();

  const sourceOf = (script, node) => (node && script?.source ? script.source.slice(node.start, node.end) : '');

  const resolveFunctionIn = (script, node, depth = 0) => {
    const n = unwrapChain(node);
    if (!n || depth > 3) return null;
    if (FUNCTION_TYPES.has(n.type)) return n;
    if (n.type === 'Identifier') return fnIndex.get(script)?.get(n.name) ?? null;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'bind') {
      return resolveFunctionIn(script, n.callee.object, depth + 1);
    }
    return null;
  };

  const pushListener = (info) => {
    const frozen = Object.freeze(info);
    listeners.push(frozen);
    if (frozen.handler && !listenerByFn.has(frozen.handler)) listenerByFn.set(frozen.handler, frozen);
  };

  for (const script of scripts) {
    if (!script.ast) continue;
    const fns = new Map();
    const inits = new Map();
    fnIndex.set(script, fns);
    initIndex.set(script, inits);
    // Pass 1: function names and initializers, so handlers resolve regardless of order.
    traverse(script.ast, (node, ancestors) => {
      if (FUNCTION_TYPES.has(node.type)) markIife(node, ancestors[ancestors.length - 1], ancestors[ancestors.length - 2]);
      if (node.type === 'FunctionDeclaration' && node.id) {
        if (!fns.has(node.id.name)) fns.set(node.id.name, node);
        if (!inits.has(node.id.name)) inits.set(node.id.name, node);
      }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        if (!inits.has(node.id.name)) inits.set(node.id.name, node.init);
        if (FUNCTION_TYPES.has(node.init.type) && !fns.has(node.id.name)) fns.set(node.id.name, node.init);
      }
      if (node.type === 'Literal' && typeof node.value === 'string') push(literalIndex, node.value, { script, node });
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) push(literalIndex, node.quasis[0].value.cooked, { script, node });
    });

    // Pass 2: calls, listeners, assignments, imports.
    traverse(script.ast, (node, live) => {
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const ancestors = Object.freeze(live.slice());
        const calleeNode = unwrapChain(node.callee);
        const callee = stripGlobal(pathOf(calleeNode));
        const method = callee.includes('.') ? callee.slice(callee.lastIndexOf('.') + 1) : callee;
        const info = Object.freeze({
          script, node, ancestors, callee, method, args: node.arguments, isNew: node.type === 'NewExpression',
          optional: node.optional === true, topLevel: computeTopLevel(ancestors), inLoop: computeInLoop(ancestors),
        });
        calls.push(info);
        collectListenerFromCall(script, node, calleeNode, info);
        if (node.type === 'CallExpression' && calleeNode.type === 'Identifier') {
          const src = stringValue(node.arguments[0]);
          if (src !== null && calleeNode.name === 'require') imports.push(Object.freeze({ script, node, source: src, kind: 'require', specifiers: Object.freeze([]) }));
          if (calleeNode.name === 'importScripts') {
            for (const a of node.arguments) {
              const s = stringValue(a);
              if (s !== null) imports.push(Object.freeze({ script, node, source: s, kind: 'importScripts', specifiers: Object.freeze([]) }));
            }
          }
        }
      } else if (node.type === 'AssignmentExpression') {
        const ancestors = Object.freeze(live.slice());
        const target = pathOf(node.left);
        const property = node.left.type === 'MemberExpression' ? target.slice(target.lastIndexOf('.') + 1) : (node.left.type === 'Identifier' ? node.left.name : '?');
        const info = Object.freeze({
          script, node, ancestors, target, normalizedTarget: stripGlobal(target), property, operator: node.operator, valueNode: node.right,
        });
        assignments.push(info);
        collectListenerFromAssignment(script, node, info);
      } else if (node.type === 'ImportDeclaration') {
        imports.push(Object.freeze({
          script, node, source: String(node.source.value), kind: 'static',
          specifiers: Object.freeze(node.specifiers.map((s) => Object.freeze({
            imported: s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported.name ?? s.imported.value),
            local: s.local.name,
          }))),
        }));
      } else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
        imports.push(Object.freeze({ script, node, source: String(node.source.value), kind: 'static', specifiers: Object.freeze([]) }));
      } else if (node.type === 'ImportExpression') {
        const s = stringValue(node.source);
        if (s !== null) imports.push(Object.freeze({ script, node, source: s, kind: 'dynamic', specifiers: Object.freeze([]) }));
      }
      return true;
    });

    if (script.kind === 'event-attr' && script.eventName) {
      const el = script.el;
      const tag = String(el?.tagName ?? '').toLowerCase();
      const event = script.eventName.replace(/^on/, '');
      let target = 'element';
      if ((tag === 'body' || tag === 'frameset') && WINDOW_REFLECTING.has(event)) target = 'window';
      else if (tag === 'body' || tag === 'html') target = 'root-element';
      pushListener({
        script, node: script.ast, ancestors: Object.freeze([]), via: 'attribute', event, target,
        targetText: script.selector.replace(/\[on[a-z-]+\]$/, ''), handler: script.ast, handlerText: script.source,
        options: parseListenerOptions(null), topLevel: true,
      });
    }
  }

  function collectListenerFromCall(script, node, calleeNode, info) {
    const { ancestors } = info;
    // addEventListener(type, handler, options)
    if (info.method === 'addEventListener' && node.type === 'CallExpression') {
      const type = stringValue(node.arguments[0]);
      if (type === null) return;
      const receiver = calleeNode.type === 'MemberExpression' ? calleeNode.object : null;
      const handlerArg = node.arguments[1] ?? null;
      const handler = resolveFunctionIn(script, handlerArg);
      pushListener({
        script, node, ancestors, via: 'addEventListener', event: type.toLowerCase(),
        target: classifyTarget(receiver, ancestors),
        targetText: receiver ? collapse(sourceOf(script, receiver)) : 'window',
        handler, handlerText: handler ? sourceOf(script, handler) : sourceOf(script, handlerArg),
        options: parseListenerOptions(node.arguments[2] ?? null), topLevel: info.topLevel,
      });
      return;
    }
    if (node.type !== 'CallExpression') return;
    // $(fn) / jQuery(fn): document ready.
    if (calleeNode.type === 'Identifier' && JQUERY_NAMES.has(calleeNode.name) && node.arguments.length === 1) {
      const handler = resolveFunctionIn(script, node.arguments[0]);
      if (handler) {
        pushListener({
          script, node, ancestors, via: 'jquery', event: 'domcontentloaded', target: 'document', targetText: 'document',
          handler, handlerText: sourceOf(script, handler), options: parseListenerOptions(null), topLevel: info.topLevel,
        });
      }
      return;
    }
    // $(target).on('a b.ns', [sel], [data], handler) / .ready(fn) / .scroll(fn)
    if (calleeNode.type === 'MemberExpression' && !calleeNode.computed) {
      const obj = unwrapChain(calleeNode.object);
      if (obj?.type !== 'CallExpression' || unwrapChain(obj.callee)?.type !== 'Identifier' || !JQUERY_NAMES.has(unwrapChain(obj.callee).name)) return;
      const name = calleeNode.property.name;
      const targetArg = obj.arguments[0] ?? null;
      const target = classifyJqueryTarget(targetArg, ancestors);
      const targetText = collapse(sourceOf(script, obj));
      let events = [];
      let handlerArg = null;
      if (JQUERY_ON.has(name)) {
        const type = stringValue(node.arguments[0]);
        if (type === null || node.arguments.length < 2) return;
        events = type.split(/\s+/).map((e) => e.split('.')[0].toLowerCase()).filter(Boolean);
        handlerArg = node.arguments[node.arguments.length - 1];
      } else if (name === 'ready') {
        events = ['domcontentloaded'];
        handlerArg = node.arguments[0] ?? null;
      } else if (JQUERY_SHORTHANDS.has(name) && node.arguments.length >= 1) {
        events = [name];
        handlerArg = node.arguments[node.arguments.length - 1];
      } else return;
      const handler = resolveFunctionIn(script, handlerArg);
      if (name !== 'ready' && JQUERY_SHORTHANDS.has(name) && !handler && handlerArg?.type !== 'Identifier') return;
      for (const event of events) {
        pushListener({
          script, node, ancestors, via: 'jquery', event, target: name === 'ready' ? 'document' : target, targetText,
          handler, handlerText: handler ? sourceOf(script, handler) : sourceOf(script, handlerArg),
          options: parseListenerOptions(null), topLevel: info.topLevel,
        });
      }
    }
  }

  function collectListenerFromAssignment(script, node, info) {
    if (node.operator !== '=') return;
    const left = node.left;
    let receiver = null;
    let prop = null;
    if (left.type === 'MemberExpression') {
      prop = left.computed ? stringValue(left.property) : left.property.name;
      receiver = left.object;
    } else if (left.type === 'Identifier') {
      prop = left.name;
    }
    if (!prop || !/^on[a-z]+$/.test(prop)) return;
    const right = node.right;
    if ((right.type === 'Literal' && right.value === null) || (right.type === 'Identifier' && right.name === 'undefined')) return;
    const handler = resolveFunctionIn(script, right);
    pushListener({
      script, node, ancestors: info.ancestors, via: 'property', event: prop.slice(2),
      target: receiver ? classifyTarget(receiver, info.ancestors) : 'window',
      targetText: receiver ? collapse(sourceOf(script, receiver)) : 'window',
      handler, handlerText: handler ? sourceOf(script, handler) : sourceOf(script, right),
      options: parseListenerOptions(null), topLevel: computeTopLevel(info.ancestors),
    });
  }

  const byCallee = new Map();
  const byMethod = new Map();
  for (const c of calls) { push(byCallee, c.callee, c); push(byMethod, c.method, c); }
  const byEvent = new Map();
  for (const l of listeners) push(byEvent, l.event, l);

  // ------------------------------------------------------------------
  // Structural helpers
  // ------------------------------------------------------------------

  const walkFunction = (fnNode, visit, { nested = false } = {}) => {
    if (!fnNode) return;
    const bodyRoots = fnNode.type === 'Program' ? fnNode.body : [fnNode.body];
    for (const rootNode of bodyRoots) {
      traverse(rootNode, (node, live) => {
        const ancestorsInFn = Object.freeze([fnNode, ...live]);
        const res = visit(node, ancestorsInFn);
        if (res === false) return false;
        if (!nested && FUNCTION_TYPES.has(node.type)) return false;
        return true;
      });
    }
  };

  const enclosingFunctions = (ancestors) => ancestors.filter((a) => FUNCTION_TYPES.has(a.type)).reverse();

  const isConditional = (arg, stopAt, nodeArg) => {
    const ancestors = Array.isArray(arg) ? arg : arg?.ancestors ?? [];
    const node = Array.isArray(arg) ? nodeArg : arg?.node;
    let start = 0;
    if (stopAt) {
      const idx = ancestors.lastIndexOf(stopAt);
      if (idx >= 0) start = idx + 1;
    }
    for (let i = ancestors.length - 1; i >= start; i--) {
      const a = ancestors[i];
      const child = ancestors[i + 1] ?? node;
      switch (a.type) {
        case 'IfStatement':
        case 'ConditionalExpression':
          if (child === undefined || child !== a.test) return true;
          break;
        case 'LogicalExpression':
          if (child === undefined || child === a.right) return true;
          break;
        case 'SwitchCase':
          if (child === undefined || child !== a.test) return true;
          break;
        case 'CatchClause':
          return true;
        default:
          break;
      }
    }
    return false;
  };

  const testMatches = (script, test, re) => {
    if (!test) return false;
    re.lastIndex = 0;
    if (re.test(sourceOf(script, test))) return true;
    // (e) one hop through a same-script initializer.
    const inits = initIndex.get(script);
    if (!inits) return false;
    let hit = false;
    traverse(test, (n) => {
      if (hit) return false;
      if (n.type === 'Identifier' && inits.has(n.name)) {
        re.lastIndex = 0;
        if (re.test(sourceOf(script, inits.get(n.name)))) hit = true;
      }
      return !FUNCTION_TYPES.has(n.type);
    });
    return hit;
  };

  const exits = (stmt) => {
    if (!stmt) return false;
    if (stmt.type === 'ReturnStatement' || stmt.type === 'ThrowStatement') return true;
    if (stmt.type === 'BlockStatement') return stmt.body.some((s) => s.type === 'ReturnStatement' || s.type === 'ThrowStatement');
    return false;
  };

  const isGuarded = (info, re, { tryCounts = false } = {}) => {
    const script = info.script;
    const node = info.node;
    const ancestors = info.ancestors ?? [];
    // (c) optional call on the matching callee.
    if (node?.type === 'CallExpression' && node.optional === true) {
      re.lastIndex = 0;
      if (re.test(info.callee ?? sourceOf(script, node.callee))) return true;
    }
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i];
      const child = ancestors[i + 1] ?? node;
      // (a) guarded branch
      if ((a.type === 'IfStatement' || a.type === 'ConditionalExpression') && child !== a.test && testMatches(script, a.test, re)) return true;
      if (a.type === 'LogicalExpression' && child === a.right && testMatches(script, a.left, re)) return true;
      if (a.type === 'SwitchCase' && child !== a.test) {
        const sw = ancestors[i - 1];
        if (testMatches(script, a.test, re) || (sw?.type === 'SwitchStatement' && testMatches(script, sw.discriminant, re))) return true;
      }
      // (d) try block
      if (tryCounts && a.type === 'TryStatement' && child === a.block) return true;
      // (b) earlier early-exit if in an enclosing block
      const list = a.type === 'BlockStatement' || a.type === 'Program' || a.type === 'StaticBlock' ? a.body
        : a.type === 'SwitchCase' ? a.consequent : null;
      if (list) {
        const idx = list.indexOf(child);
        for (let j = 0; j < idx; j++) {
          const s = list[j];
          if (s.type === 'IfStatement' && exits(s.consequent) && testMatches(script, s.test, re)) return true;
        }
      }
    }
    return false;
  };

  const locate = (displayPath, rawCharOffset) => {
    const script = scripts.find((s) => s.displayPath === displayPath && (s.kind === 'external' || s.kind === 'module-import'));
    if (!script || typeof rawCharOffset !== 'number' || rawCharOffset < 0) return null;
    const raw = script.rawText ?? script.source;
    if (rawCharOffset > raw.length) return null;
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < rawCharOffset; i++) {
      const ch = raw[i];
      if (ch === '\n' || (ch === '\r' && raw[i + 1] !== '\n')) { line++; lineStart = i + 1; }
    }
    return { line, column: rawCharOffset - lineStart + 1 };
  };

  return Object.freeze({
    complete: Boolean(complete),
    scripts: Object.freeze(scripts),
    calls: Object.freeze(calls),
    listeners: Object.freeze(listeners),
    assignments: Object.freeze(assignments),
    imports: Object.freeze(imports),
    callsByCallee: (p) => byCallee.get(stripGlobal(p)) ?? [],
    callsByMethod: (name) => byMethod.get(String(name)) ?? [],
    listenersByEvent: (event) => byEvent.get(String(event).toLowerCase()) ?? [],
    stringLiterals: (value) => literalIndex.get(String(value)) ?? [],
    mentions: (re) => scripts.some((s) => { re.lastIndex = 0; return re.test(s.source ?? ''); }),
    sourceOf,
    walkFunction,
    resolveFunction: (script, node) => resolveFunctionIn(script, node),
    /** Same-script initializer of a name: the var/let/const init node, or the FunctionDeclaration. First wins. */
    initializerOf: (script, name) => initIndex.get(script)?.get(String(name)) ?? null,
    listenerForFunction: (fn) => listenerByFn.get(fn) ?? null,
    enclosingFunctions,
    isConditional,
    isGuarded,
    locate,
  });
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

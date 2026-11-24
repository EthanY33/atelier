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

// Syntax nested deeper than this is not indexed, and the model then reports
// complete: false. One very long call chain or run of operators nests one
// level per link, and work on a node grows with its depth.
export const MAX_JS_DEPTH = 2000;

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

/**
 * Dotted path of an expression; '?' marks a computed or call segment.
 * Walks the member chain in a loop: one chain can be tens of thousands of
 * segments long, which would overflow the stack if each segment recursed.
 */
export function pathOf(n) {
  const props = [];
  let node = n;
  for (;;) {
    if (node?.type === 'ChainExpression') {
      node = node.expression;
    } else if (node?.type === 'MemberExpression') {
      let prop = '?';
      if (!node.computed) prop = node.property.type === 'PrivateIdentifier' ? `#${node.property.name}` : node.property.name;
      else if (node.property.type === 'Literal' && typeof node.property.value === 'string') prop = node.property.value;
      else if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) prop = node.property.quasis[0].value.cooked;
      props.push(prop);
      node = node.object;
    } else break;
  }
  let path = '?';
  if (node?.type === 'Identifier') path = node.name;
  else if (node?.type === 'ThisExpression') path = 'this';
  else if (node?.type === 'Super') path = 'super';
  else if (node?.type === 'MetaProperty') path = `${node.meta.name}.${node.property.name}`;
  for (let i = props.length - 1; i >= 0; i--) path += `.${props[i]}`;
  return path;
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

/** `inFunction`: the receiver sits in a non-arrow function, where `this` is not the window. */
function classifyTarget(receiver, inFunction) {
  if (!receiver) return 'window';
  const node = unwrapChain(receiver);
  if (node.type === 'ThisExpression') return inFunction ? 'unknown' : 'window';
  const raw = pathOf(node);
  if (raw === 'window' || raw === 'self' || raw === 'globalThis') return 'window';
  const p = stripGlobal(raw);
  if (p === 'document') return 'document';
  if (p === 'document.body' || p === 'document.documentElement' || p === 'document.scrollingElement') return 'root-element';
  return 'element';
}

function classifyJqueryTarget(arg, inFunction) {
  if (!arg) return 'unknown';
  const s = stringValue(arg);
  if (s !== null) return /^\s*(body|html)\s*$/i.test(s) ? 'root-element' : 'element';
  return classifyTarget(arg, inFunction);
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

// Scopes for name lookup: var scopes hold var, function and parameter
// bindings; block scopes also hold let, const, class and catch bindings.
const BLOCK_SCOPE_TYPES = new Set(['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'CatchClause']);
const isVarScope = (n) => n.type === 'Program' || n.type === 'StaticBlock' || FUNCTION_TYPES.has(n.type);

/** Names a binding pattern declares: identifiers, destructuring, defaults and rest. */
function bindingNames(pattern) {
  const out = [];
  const stack = [pattern];
  while (stack.length) {
    const p = stack.pop();
    if (!p) continue;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties) stack.push(prop.type === 'RestElement' ? prop.argument : prop.value);
    else if (p.type === 'ArrayPattern') for (const el of p.elements) stack.push(el);
    else if (p.type === 'AssignmentPattern') stack.push(p.left);
    else if (p.type === 'RestElement') stack.push(p.argument);
  }
  return out;
}

/**
 * Record a binding in a scope: `fn` is the function it names, or null for any
 * other binding. The first function a scope gives a name wins; other bindings
 * only hide same-named functions of outer scopes.
 */
function declare(scope, name, fn) {
  if (!scope) return;
  if (!scope.names) scope.names = new Map();
  if (fn ? !scope.names.get(name) : !scope.names.has(name)) scope.names.set(name, fn);
}

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
  const scopeIndex = new Map(); // script -> scope records in source order; the first is the Program
  const initIndex = new Map(); // script -> Map(name -> init node)
  const listenerByFn = new Map();
  // Programs of event attributes. Their code is the body of the attribute's
  // handler: it runs when the event fires, not when the page loads.
  const handlerPrograms = new Set();
  let truncated = false;

  // A record's ancestors are listed on demand from parent links that records
  // share, and only the latest list is kept. A copy of the path on every
  // record costs time and memory quadratic in nesting depth.
  const NO_ANCESTORS = Object.freeze([]);
  let listedChain = null;
  let listed = NO_ANCESTORS;
  const ancestorsOf = (chain) => {
    if (chain !== listedChain) {
      const list = new Array(chain ? chain.depth : 0);
      for (let link = chain; link; link = link.up) list[link.depth - 1] = link.node;
      listedChain = chain;
      listed = Object.freeze(list);
    }
    return listed;
  };

  const sourceOf = (script, node) => (node && script?.source ? script.source.slice(node.start, node.end) : '');

  /**
   * The function `name` refers to at source offset `pos`: the nearest scope
   * around `pos` that declares the name decides, and the result is null when
   * that binding is not a function (a parameter, say) or no scope declares
   * it. Without an offset the lookup starts at the top of the script.
   */
  const resolveName = (script, name, pos) => {
    const scopes = scopeIndex.get(script);
    if (!scopes?.length) return null;
    let scope = scopes[0];
    if (typeof pos === 'number') {
      // Last scope that starts at or before pos: the innermost scope around
      // pos, or a scope nested in it that has already ended.
      let lo = 0;
      let hi = scopes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (scopes[mid].start <= pos) lo = mid;
        else hi = mid - 1;
      }
      scope = scopes[lo];
      while (scope.parent && !(scope.start <= pos && pos < scope.end)) scope = scope.parent;
    }
    for (; scope; scope = scope.parent) {
      if (scope.names?.has(name)) return scope.names.get(name);
    }
    return null;
  };

  const resolveFunctionIn = (script, node, depth = 0) => {
    const n = unwrapChain(node);
    if (!n || depth > 3) return null;
    if (FUNCTION_TYPES.has(n.type)) return n;
    if (n.type === 'Identifier') return resolveName(script, n.name, n.start);
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
    const inHandler = script.kind === 'event-attr';
    if (inHandler) handlerPrograms.add(script.ast);
    const inits = new Map();
    initIndex.set(script, inits);
    const scopes = [];
    scopeIndex.set(script, scopes);
    // Innermost scope and innermost var scope around the children of the node at each depth.
    const scopeAt = [];
    const varScopeAt = [];
    // Pass 1: scopes, function names and initializers, so handlers resolve regardless of order.
    traverse(script.ast, (node, ancestors) => {
      const depth = ancestors.length;
      if (depth > MAX_JS_DEPTH) {
        truncated = true;
        return false;
      }
      const parent = ancestors[depth - 1];
      let scope = depth ? scopeAt[depth - 1] : null;
      let varScope = depth ? varScopeAt[depth - 1] : null;
      if (FUNCTION_TYPES.has(node.type)) markIife(node, parent, ancestors[depth - 2]);
      if (node.type === 'FunctionDeclaration' && node.id) {
        // Hoisted to the enclosing function, also from inside a block.
        declare(varScope, node.id.name, node);
        if (!inits.has(node.id.name)) inits.set(node.id.name, node);
      } else if (node.type === 'VariableDeclarator') {
        const fn = node.id.type === 'Identifier' && node.init && FUNCTION_TYPES.has(node.init.type) ? node.init : null;
        for (const name of bindingNames(node.id)) declare(parent?.kind === 'var' ? varScope : scope, name, fn);
        if (node.id.type === 'Identifier' && node.init && !inits.has(node.id.name)) inits.set(node.id.name, node.init);
      } else if (node.type === 'ClassDeclaration' && node.id) {
        declare(scope, node.id.name, null);
      }
      if (isVarScope(node) || BLOCK_SCOPE_TYPES.has(node.type)) {
        scope = { start: node.start, end: node.end, parent: scope, names: null };
        scopes.push(scope);
        if (isVarScope(node)) varScope = scope;
        if (FUNCTION_TYPES.has(node.type)) {
          for (const param of node.params) for (const name of bindingNames(param)) declare(scope, name, null);
          // A named function expression can refer to itself.
          if (node.type === 'FunctionExpression' && node.id && !scope.names?.has(node.id.name)) declare(scope, node.id.name, node);
        } else if (node.type === 'CatchClause') {
          for (const name of bindingNames(node.param)) declare(scope, name, null);
        }
      }
      scopeAt[depth] = scope;
      varScopeAt[depth] = varScope;
      if (node.type === 'Literal' && typeof node.value === 'string') push(literalIndex, node.value, { script, node });
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) push(literalIndex, node.quasis[0].value.cooked, { script, node });
      return true;
    });
    scopes.sort((a, b) => a.start - b.start);

    // Pass 2: calls, listeners, assignments, imports. The flags are kept per
    // depth, for a node with that many ancestors: it runs at script start
    // (every function around it is an IIFE), it is in a loop of its function,
    // it is in a non-arrow function.
    const top = [];
    const inLoop = [];
    const inFunction = [];
    // links[i]: parent link of live[i], made when a record first needs it.
    const links = [];
    const chainFor = (live) => {
      for (let i = links.length; i < live.length; i++) links[i] = { node: live[i], up: i ? links[i - 1] : null, depth: i + 1 };
      return live.length ? links[live.length - 1] : null;
    };
    traverse(script.ast, (node, live) => {
      const depth = live.length;
      if (depth > MAX_JS_DEPTH) return false;
      if (links.length > depth) links.length = depth;
      const parent = live[depth - 1];
      if (!parent) {
        top[0] = !inHandler;
        inLoop[0] = false;
        inFunction[0] = false;
      } else if (FUNCTION_TYPES.has(parent.type)) {
        top[depth] = top[depth - 1] && parent.__iife === true;
        inLoop[depth] = false;
        inFunction[depth] = inFunction[depth - 1] || parent.type !== 'ArrowFunctionExpression';
      } else {
        top[depth] = top[depth - 1];
        inLoop[depth] = inLoop[depth - 1] || LOOP_TYPES.has(parent.type);
        inFunction[depth] = inFunction[depth - 1];
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const chain = chainFor(live);
        const calleeNode = unwrapChain(node.callee);
        const callee = stripGlobal(pathOf(calleeNode));
        const method = callee.includes('.') ? callee.slice(callee.lastIndexOf('.') + 1) : callee;
        const info = Object.freeze({
          script, node, get ancestors() { return ancestorsOf(chain); }, callee, method, args: node.arguments, isNew: node.type === 'NewExpression',
          optional: node.optional === true, topLevel: top[depth], inLoop: inLoop[depth],
        });
        calls.push(info);
        collectListenerFromCall(script, node, calleeNode, info, chain, inFunction[depth]);
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
        const chain = chainFor(live);
        const target = pathOf(node.left);
        const property = node.left.type === 'MemberExpression' ? target.slice(target.lastIndexOf('.') + 1) : (node.left.type === 'Identifier' ? node.left.name : '?');
        const info = Object.freeze({
          script, node, get ancestors() { return ancestorsOf(chain); }, target, normalizedTarget: stripGlobal(target), property, operator: node.operator, valueNode: node.right,
        });
        assignments.push(info);
        collectListenerFromAssignment(script, node, chain, top[depth], inFunction[depth]);
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
        script, node: script.ast, ancestors: NO_ANCESTORS, via: 'attribute', event, target,
        targetText: script.selector.replace(/\[on[a-z-]+\]$/, ''), handler: script.ast, handlerText: script.source,
        options: parseListenerOptions(null), topLevel: true,
      });
    }
  }

  function collectListenerFromCall(script, node, calleeNode, info, chain, inFunction) {
    // addEventListener(type, handler, options)
    if (info.method === 'addEventListener' && node.type === 'CallExpression') {
      const type = stringValue(node.arguments[0]);
      if (type === null) return;
      const receiver = calleeNode.type === 'MemberExpression' ? calleeNode.object : null;
      const handlerArg = node.arguments[1] ?? null;
      const handler = resolveFunctionIn(script, handlerArg);
      pushListener({
        script, node, get ancestors() { return ancestorsOf(chain); }, via: 'addEventListener', event: type.toLowerCase(),
        target: classifyTarget(receiver, inFunction),
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
          script, node, get ancestors() { return ancestorsOf(chain); }, via: 'jquery', event: 'domcontentloaded', target: 'document', targetText: 'document',
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
      const target = classifyJqueryTarget(targetArg, inFunction);
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
          script, node, get ancestors() { return ancestorsOf(chain); }, via: 'jquery', event, target: name === 'ready' ? 'document' : target, targetText,
          handler, handlerText: handler ? sourceOf(script, handler) : sourceOf(script, handlerArg),
          options: parseListenerOptions(null), topLevel: info.topLevel,
        });
      }
    }
  }

  function collectListenerFromAssignment(script, node, chain, topLevel, inFunction) {
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
    // a.onx = b.ony = value assigns the last value to both.
    let right = node.right;
    while (right.type === 'AssignmentExpression' && right.operator === '=') right = right.right;
    // null, undefined and void 0 (the minified undefined) clear the handler.
    if ((right.type === 'Literal' && right.value === null) || (right.type === 'Identifier' && right.name === 'undefined')
      || (right.type === 'UnaryExpression' && right.operator === 'void')) return;
    const handler = resolveFunctionIn(script, right);
    pushListener({
      script, node, get ancestors() { return ancestorsOf(chain); }, via: 'property', event: prop.slice(2),
      target: receiver ? classifyTarget(receiver, inFunction) : 'window',
      targetText: receiver ? collapse(sourceOf(script, receiver)) : 'window',
      handler, handlerText: handler ? sourceOf(script, handler) : sourceOf(script, right),
      options: parseListenerOptions(null), topLevel,
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

  /** Functions around a node, innermost first. For code in an event attribute the last one is the attribute's Program. */
  const enclosingFunctions = (ancestors) => ancestors.filter((a) => FUNCTION_TYPES.has(a.type) || (a.type === 'Program' && handlerPrograms.has(a))).reverse();

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
    complete: Boolean(complete) && !truncated,
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
    /** The function a handler expression is: a function node, f.bind(...), or a name looked up in the scopes around the node. */
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

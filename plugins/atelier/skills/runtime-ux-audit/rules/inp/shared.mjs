/**
 * Helpers shared by the inp rules. Pure: AST inspection only, no I/O.
 */
import { boolLiteral } from '../../lib/css-values.mjs';
import { isFunctionNode, pathOf, traverse } from '../../lib/js-model.mjs';
import { RULE_PREFIX } from '../../lib/options.mjs';

export { boolLiteral, isFunctionNode, pathOf, traverse };

/** Freeze a rule definition with the inp defaults (area inp, static phase). */
export function defineRule(def) {
  return Object.freeze({ area: 'inp', phase: 'static', ...def, id: `${RULE_PREFIX}${def.id}` });
}

export const ROOT_TARGETS = new Set(['window', 'document', 'root-element']);
export const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const GLOBAL_PREFIX_RE = /^(?:(?:window|self|globalThis)\.)+/;

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const unwrap = (n) => (n?.type === 'ChainExpression' ? n.expression : n);
export const stripGlobal = (p) => String(p).replace(GLOBAL_PREFIX_RE, '');

/** Clip a label for messages: whitespace collapsed, at most `max` characters. */
export function clip(text, max = 48) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** Value of a string literal or an expression-free template literal, else null. */
export function stringValue(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}

/** Property name of a member expression (non-computed, or a computed string literal), else null. */
export function propName(member) {
  const m = unwrap(member);
  if (m?.type !== 'MemberExpression') return null;
  if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : null;
  return stringValue(m.property);
}

/**
 * Callee path of a call, like CallInfo.callee, but also seeing through the
 * minifier form (0, x.fn)(...).
 */
export function calleePath(callee) {
  let c = unwrap(callee);
  if (c?.type === 'SequenceExpression') c = unwrap(c.expressions[c.expressions.length - 1]);
  return stripGlobal(pathOf(c));
}

/** The value node of a non-computed key in an object literal: { found, value, spread }. */
export function objectProp(obj, name) {
  let spread = false;
  for (const p of obj?.properties ?? []) {
    if (p.type === 'SpreadElement') { spread = true; continue; }
    if (p.type !== 'Property' || p.computed) continue;
    const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
    if (key === name) return { found: true, value: p.value, spread };
  }
  return { found: false, value: null, spread };
}

/**
 * A value that cannot depend on runtime state: a literal, an expression-free
 * template, a negated number, or a conditional between two such values.
 */
export function isStaticValue(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (n.type === 'Literal') return true;
  if (n.type === 'TemplateLiteral') return n.expressions.length === 0;
  if (n.type === 'UnaryExpression' && (n.operator === '-' || n.operator === '+')) return n.argument.type === 'Literal';
  if (n.type === 'ConditionalExpression') return isStaticValue(n.consequent) && isStaticValue(n.alternate);
  return false;
}

/** script.source with every comment blanked out (offsets preserved). */
export function sourceWithoutComments(script) {
  const src = String(script?.source ?? '');
  const comments = script?.comments ?? [];
  if (!comments.length) return src;
  let out = '';
  let pos = 0;
  for (const c of [...comments].sort((a, b) => a.start - b.start)) {
    if (c.start < pos) continue;
    out += src.slice(pos, c.start) + src.slice(c.start, c.end).replace(/[^\n]/g, ' ');
    pos = c.end;
  }
  return out + src.slice(pos);
}

const cachePerModel = new WeakMap();

/** Map from AST node to its AssignInfo / CallInfo (full ancestors from Program). */
export function infoIndex(js) {
  let idx = cachePerModel.get(js);
  if (!idx) {
    const assign = new Map();
    const call = new Map();
    for (const a of js.assignments) assign.set(a.node, a);
    for (const c of js.calls) call.set(c.node, c);
    idx = { assign, call };
    cachePerModel.set(js, idx);
  }
  return idx;
}

/** Nearest enclosing function (by identity) of a node's ancestors, else null. */
export function nearestFunction(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) if (isFunctionNode(ancestors[i])) return ancestors[i];
  return null;
}

// ---------------------------------------------------------------------------
// Event-cancel analysis for listener handlers
// ---------------------------------------------------------------------------

/** Identifier names that refer to the event object inside a handler. */
function eventNames(handler) {
  const names = new Set(['arguments']);
  if (handler.type === 'Program') {
    names.add('event');
    return names;
  }
  const p = handler.params?.[0];
  if (!p) names.add('event');
  else if (p.type === 'Identifier') names.add(p.name);
  else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') names.add(p.left.name);
  return names;
}

/** True when an identifier reference hands its value to other code. */
function flowsOut(node, parent) {
  if (!parent) return false;
  switch (parent.type) {
    case 'CallExpression':
    case 'NewExpression':
      return parent.arguments.includes(node);
    case 'AssignmentExpression':
      return parent.right === node;
    case 'VariableDeclarator':
      return parent.init === node;
    case 'Property':
      return parent.value === node;
    case 'ArrowFunctionExpression':
      return parent.body === node;
    case 'ConditionalExpression':
      return parent.test !== node;
    case 'LogicalExpression':
      return parent.right === node;
    case 'ReturnStatement':
    case 'ArrayExpression':
    case 'SpreadElement':
    case 'YieldExpression':
    case 'SequenceExpression':
      return true;
    default:
      return false;
  }
}

/**
 * How a listener's handler cancels its event.
 * - any: preventDefault(), returnValue = false, or (attribute, property and
 *   jQuery handlers) return false, anywhere in the handler including nested functions
 * - unconditional: such a cancel in the handler's own body, outside any if,
 *   ternary, logical or switch
 * - escapes: the event object is handed to other code, so a helper could cancel it
 * @param {object} js - JsModel
 * @param {object} listener - ListenerInfo with a resolved handler
 */
export function analyzeCancel(js, listener) {
  const handler = listener.handler;
  const names = eventNames(handler);
  const returnFalseCancels = listener.via !== 'addEventListener';
  const out = { any: false, unconditional: false, escapes: false };
  js.walkFunction(handler, (node, anc) => {
    const nested = anc.slice(1).some(isFunctionNode);
    let cancel = false;
    if (node.type === 'CallExpression') {
      cancel = propName(node.callee) === 'preventDefault';
    } else if (node.type === 'AssignmentExpression') {
      cancel = propName(node.left) === 'returnValue' && boolLiteral(node.right) === false;
    } else if (node.type === 'ReturnStatement') {
      cancel = returnFalseCancels && !nested && boolLiteral(node.argument) === false;
    } else if (node.type === 'Identifier' && names.has(node.name)) {
      if (flowsOut(node, anc[anc.length - 1])) out.escapes = true;
    }
    if (cancel) {
      out.any = true;
      if (!nested && !js.isConditional(anc, handler, node)) out.unconditional = true;
    }
  }, { nested: true });
  return out;
}

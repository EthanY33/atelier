/**
 * inp rules about main-thread scheduling: setTimeout(0) as a yield,
 * requestIdleCallback without a timeout, and synchronous XMLHttpRequest.
 */
import {
  LOOP_TYPES, boolLiteral, defineRule, isFunctionNode, objectProp, pathOf, stringValue, stripGlobal, unwrap,
} from './shared.mjs';

// ---------------------------------------------------------------------------
// settimeout-zero-as-yield
// ---------------------------------------------------------------------------

const SCHEDULER_RE = /\bscheduler\b/;

const isZeroDelay = (args) => args.length === 1 || (args[1]?.type === 'Literal' && args[1].value === 0);

/**
 * For a setTimeout call inside `await new Promise(executor)`, the index of the
 * enclosing function that holds the await inside a loop, else -1.
 * Returns { awaitIdx, hostIdx } or null.
 */
function awaitedYieldInLoop(call) {
  const anc = call.ancestors;
  let execIdx = -1;
  for (let i = anc.length - 1; i >= 0; i--) {
    if (isFunctionNode(anc[i])) { execIdx = i; break; }
  }
  if (execIdx < 2) return null;
  const exec = anc[execIdx];
  const newExpr = anc[execIdx - 1];
  if (newExpr.type !== 'NewExpression' || stripGlobal(pathOf(newExpr.callee)) !== 'Promise' || newExpr.arguments[0] !== exec) return null;
  const awaitNode = anc[execIdx - 2];
  if (awaitNode.type !== 'AwaitExpression' || awaitNode.argument !== newExpr) return null;
  for (let j = execIdx - 3; j >= 0; j--) {
    if (isFunctionNode(anc[j])) return null;
    if (LOOP_TYPES.has(anc[j].type)) return { awaitIdx: execIdx - 2, loopIdx: j };
  }
  return null;
}

const EXIT_TYPES = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement']);

/**
 * The call leaves its innermost loop right after it runs: it sits in a
 * return or throw, or a later statement of an enclosing block (inside the
 * loop) returns, throws or breaks. `for (;;) { if (x) { t = setTimeout(f, 0); return; } }`
 * schedules one task, not one per iteration. A break inside a switch only
 * leaves the switch, so it does not count there.
 */
function exitsLoopAfter(call) {
  const anc = call.ancestors;
  let loopIdx = -1;
  for (let i = anc.length - 1; i >= 0; i--) {
    if (isFunctionNode(anc[i])) return false;
    if (LOOP_TYPES.has(anc[i].type)) { loopIdx = i; break; }
  }
  if (loopIdx < 0) return false;
  const chain = [...anc.slice(loopIdx + 1), call.node];
  let inSwitch = false;
  for (let i = 0; i < chain.length - 1; i++) {
    const n = chain[i];
    if (n.type === 'SwitchStatement') inSwitch = true;
    if (n.type === 'ReturnStatement' || n.type === 'ThrowStatement') return true;
    const list = n.type === 'BlockStatement' ? n.body : n.type === 'SwitchCase' ? n.consequent : null;
    if (!list) continue;
    const idx = list.indexOf(chain[i + 1]);
    if (idx >= 0 && list.slice(idx + 1).some((s) => EXIT_TYPES.has(s.type) && !(inSwitch && s.type === 'BreakStatement'))) return true;
  }
  return false;
}

export const setTimeoutZeroAsYield = defineRule({
  id: 'settimeout-zero-as-yield',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js'],
  description: 'setTimeout(fn, 0) is used to yield inside a loop; the continuation queues behind every other task instead of resuming first.',
  helpUrl: 'https://developer.chrome.com/blog/use-scheduler-yield',
  check(ctx) {
    const { js } = ctx;
    const out = [];
    for (const call of js.callsByCallee('setTimeout')) {
      if (call.isNew || call.args.length === 0 || !isZeroDelay(call.args)) continue;
      let kind = null;
      let hostIdx = -1;
      if (call.inLoop) {
        if (exitsLoopAfter(call)) continue;
        kind = 'loop';
        for (let i = call.ancestors.length - 1; i >= 0; i--) {
          if (isFunctionNode(call.ancestors[i])) { hostIdx = i; break; }
          if (LOOP_TYPES.has(call.ancestors[i].type)) hostIdx = i;
        }
      } else {
        const found = awaitedYieldInLoop(call);
        if (!found) continue;
        kind = 'await';
        hostIdx = found.loopIdx;
        for (let i = found.awaitIdx; i >= 0; i--) {
          if (isFunctionNode(call.ancestors[i])) { hostIdx = i; break; }
        }
      }
      // A scheduler.yield() path next to the fallback: the recommended pattern.
      const scopes = call.ancestors.slice(Math.max(hostIdx, 0)).filter((a, i) => i === 0 || isFunctionNode(a));
      if (scopes.some((n) => SCHEDULER_RE.test(js.sourceOf(call.script, n))) || js.isGuarded(call, SCHEDULER_RE)) continue;
      out.push({
        node: ctx.ref.js(call),
        message: kind === 'loop'
          ? 'setTimeout(fn, 0) inside a loop queues one task per iteration behind all other work; await scheduler.yield() (with a setTimeout fallback) between chunks instead.'
          : 'Awaiting a setTimeout(0) promise inside a loop yields without priority, so the loop resumes behind other tasks; prefer scheduler.yield() and keep this as the fallback.',
        data: { pattern: kind },
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// requestidlecallback-no-timeout
// ---------------------------------------------------------------------------

export const requestIdleCallbackNoTimeout = defineRule({
  id: 'requestidlecallback-no-timeout',
  severity: 'minor',
  confidence: 'high',
  methods: ['js'],
  description: 'requestIdleCallback is called without a timeout, so on a busy page the callback can be delayed indefinitely.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback',
  check(ctx) {
    const out = [];
    for (const call of ctx.js.callsByCallee('requestIdleCallback')) {
      if (call.isNew || call.args.length === 0) continue;
      if (call.args.length >= 2) {
        const opts = unwrap(call.args[1]);
        if (opts?.type !== 'ObjectExpression') continue;
        const t = objectProp(opts, 'timeout');
        if (t.found || t.spread) continue;
      }
      out.push({
        node: ctx.ref.js(call),
        message: 'requestIdleCallback without { timeout } may never run while the page is busy; add { timeout } if the work is user-visible.',
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// no-sync-xhr
// ---------------------------------------------------------------------------

const HTTP_METHOD_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;

const isFalseArg = (node) => {
  const n = unwrap(node);
  return boolLiteral(n) === false || (n?.type === 'Literal' && n.value === 0);
};

function receiverIsXhr(js, call) {
  const callee = unwrap(call.node.callee);
  const recv = callee?.type === 'MemberExpression' ? unwrap(callee.object) : null;
  if (recv?.type !== 'Identifier') return false;
  const init = unwrap(js.initializerOf(call.script, recv.name));
  return init?.type === 'NewExpression' && stripGlobal(pathOf(init.callee)) === 'XMLHttpRequest';
}

export const noSyncXhr = defineRule({
  id: 'no-sync-xhr',
  severity: 'serious',
  confidence: 'high',
  methods: ['js'],
  description: 'A synchronous XMLHttpRequest blocks the main thread, and every pending input, for the whole network round trip.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open',
  check(ctx) {
    const { js } = ctx;
    const out = [];
    for (const call of js.callsByMethod('open')) {
      if (call.isNew || call.args.length < 3 || !isFalseArg(call.args[2])) continue;
      const method = stringValue(call.args[0]);
      if (!(method !== null && HTTP_METHOD_RE.test(method)) && !receiverIsXhr(js, call)) continue;
      out.push({
        node: ctx.ref.js(call),
        message: `XMLHttpRequest.open(${method !== null ? `'${method.toUpperCase()}', ` : ''}..., false) is synchronous; use fetch() or an async XMLHttpRequest.`,
      });
    }
    return out;
  },
});

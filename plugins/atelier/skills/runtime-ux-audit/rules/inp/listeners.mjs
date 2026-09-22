/**
 * inp rules about event listeners: passive scroll-blocking listeners, forced
 * layout in input handlers, JS scroll-linked animation and mouse/touch pairs.
 */
import {
  ROOT_TARGETS, LOOP_TYPES, analyzeCancel, calleePath, clip, cmp, defineRule, infoIndex,
  isStaticValue, nearestFunction, pathOf, propName, stringValue, unwrap,
} from './shared.mjs';

// ---------------------------------------------------------------------------
// non-passive-scroll-listener
// ---------------------------------------------------------------------------

const SCROLL_BLOCKING = ['touchstart', 'touchmove', 'wheel', 'mousewheel'];
const WHEEL = new Set(['wheel', 'mousewheel']);

export const nonPassiveScrollListener = defineRule({
  id: 'non-passive-scroll-listener',
  severity: 'moderate',
  confidence: 'high',
  methods: ['js'],
  description: 'A touch or wheel listener that never cancels its event is registered without { passive: true }, so scrolling waits for it on the main thread.',
  helpUrl: 'https://developer.chrome.com/docs/lighthouse/best-practices/uses-passive-event-listeners',
  check(ctx) {
    const { js } = ctx;
    const out = [];
    for (const l of js.listeners) {
      if (!SCROLL_BLOCKING.includes(l.event) || !l.handler) continue;
      const target = clip(l.targetText, 40);
      if (!ROOT_TARGETS.has(l.target)) {
        // Case A: an element listener that could be passive.
        if (l.options.passive === true || l.options.kind === 'unknown') continue;
        const c = analyzeCancel(js, l);
        if (c.any || c.escapes) continue;
        out.push({
          node: ctx.ref.js(l),
          message: `${l.event} listener on ${target} never calls preventDefault(), so it can be passive; add { passive: true } to keep scrolling off the main thread.`,
          data: { event: l.event, target: l.target, via: l.via },
        });
      } else if (WHEEL.has(l.event) && l.options.passive === false) {
        // Case B: a root wheel listener that opts out of the passive default.
        // An unconditional preventDefault() is mobile/scroll-hijack.
        const c = analyzeCancel(js, l);
        if (c.unconditional || c.escapes) continue;
        out.push({
          node: ctx.ref.js(l),
          message: c.any
            ? `${l.event} listener on ${target} sets { passive: false } but only cancels conditionally; every wheel scroll now waits for it. Attach it to the element that needs it.`
            : `${l.event} listener on ${target} sets { passive: false } but never calls preventDefault(); drop the option so wheel scrolling stays passive.`,
          confidence: c.any ? 'medium' : 'high',
          data: { event: l.event, target: l.target, via: l.via },
        });
      }
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// click-handler-forced-layout
// ---------------------------------------------------------------------------

const INPUT_EVENTS = new Set(['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'input', 'change', 'scroll', 'resize', 'wheel', 'touchstart', 'touchmove', 'pointermove', 'mousemove']);
const LAYOUT_PROPS = new Set(['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'clientTop', 'clientLeft', 'clientWidth', 'clientHeight', 'scrollTop', 'scrollLeft', 'scrollWidth', 'scrollHeight']);
const LAYOUT_CALLS = new Set(['getBoundingClientRect', 'getClientRects']);
const STYLE_PATH_RE = /(?:^|\.)style\.[^.]+$/;
const STYLE_CALL_RE = /(?:^|\.)style\.(?:setProperty|removeProperty)$/;
const CLASSLIST_CALL_RE = /(?:^|\.)classList\.(?:add|remove|toggle|replace)$/;

/** Label of a style or class write, else null. */
function writeLabel(node) {
  if (node.type === 'AssignmentExpression' && unwrap(node.left)?.type === 'MemberExpression') {
    const path = pathOf(unwrap(node.left));
    if (STYLE_PATH_RE.test(path) || propName(node.left) === 'className') return clip(path);
    return null;
  }
  if (node.type === 'CallExpression') {
    const path = calleePath(node.callee);
    if (STYLE_CALL_RE.test(path) || CLASSLIST_CALL_RE.test(path)) return `${clip(path)}()`;
    if (propName(node.callee) === 'setAttribute') {
      const name = stringValue(node.arguments[0]);
      if (name !== null && /^(?:style|class)$/i.test(name)) return `setAttribute('${name.toLowerCase()}')`;
    }
  }
  return null;
}

/** Label of a layout read, else null. */
function readLabel(node, parent) {
  if (node.type === 'MemberExpression') {
    const name = propName(node);
    if (!LAYOUT_PROPS.has(name)) return null;
    if (parent?.type === 'AssignmentExpression' && parent.operator === '=' && unwrap(parent.left) === node) return null;
    // jQuery-style setter: $(w).scrollTop(0)
    if (parent?.type === 'CallExpression' && unwrap(parent.callee) === node && parent.arguments.length > 0) return null;
    return name;
  }
  if (node.type === 'CallExpression') {
    const name = propName(node.callee);
    if (LAYOUT_CALLS.has(name)) return `${name}()`;
    if (/(?:^|\.)getComputedStyle$/.test(calleePath(node.callee))) return 'getComputedStyle()';
  }
  return null;
}

const BLOCK_LIST = (n) => (n.type === 'BlockStatement' || n.type === 'Program' || n.type === 'StaticBlock' ? n.body : n.type === 'SwitchCase' ? n.consequent : null);

/** A return or throw follows `path`'s node in any block below index `from`. */
function exitsAfter(path, from) {
  for (let j = path.length - 2; j >= from; j--) {
    const list = BLOCK_LIST(path[j]);
    if (!list) continue;
    const i = list.indexOf(path[j + 1]);
    if (i >= 0 && list.slice(i + 1).some((s) => s.type === 'ReturnStatement' || s.type === 'ThrowStatement')) return true;
  }
  return false;
}

/**
 * True when `first` and `second` cannot both run, in that order, in one pass:
 * opposite if/else or ternary branches, different switch cases, or an early
 * return after `first`.
 */
function exclusive(first, second) {
  const pa = [...first.anc, first.node];
  const pb = [...second.anc, second.node];
  let k = 0;
  while (k < pa.length && k < pb.length && pa[k] === pb[k]) k++;
  const lca = pa[k - 1];
  const ca = pa[k];
  const cb = pb[k];
  if (!lca || !ca || !cb) return false;
  if ((lca.type === 'IfStatement' || lca.type === 'ConditionalExpression') && ca !== lca.test && cb !== lca.test) return true;
  if (lca.type === 'SwitchStatement' && ca.type === 'SwitchCase' && cb.type === 'SwitchCase') return true;
  return exitsAfter(pa, k);
}

/**
 * Loops between the handler and a node whose repeating part holds the node:
 * the body, a for test or update, or a while test. A for-of iterable or a for
 * initializer runs once and does not count.
 */
function loopsOf(entry) {
  const path = [...entry.anc, entry.node];
  const out = [];
  for (let i = 1; i < path.length - 1; i++) {
    const loop = path[i];
    if (!LOOP_TYPES.has(loop.type)) continue;
    const child = path[i + 1];
    if (child === loop.body || child === loop.test || child === loop.update) out.push(loop);
  }
  return out;
}

function forcedLayout(js, handler) {
  const writes = [];
  const reads = [];
  js.walkFunction(handler, (node, anc) => {
    const w = writeLabel(node);
    if (w) writes.push({ node, anc, label: w });
    const r = readLabel(node, anc[anc.length - 1]);
    if (r) reads.push({ node, anc, label: r });
  }, { nested: false });
  if (!writes.length || !reads.length) return null;
  reads.sort((a, b) => a.node.start - b.node.start);
  for (const r of reads) {
    for (const w of writes) {
      if (w.node.end <= r.node.start && !exclusive(w, r)) return { read: r, write: w, loop: false };
    }
    const rLoops = loopsOf(r);
    if (!rLoops.length) continue;
    for (const w of writes) {
      if (w.node.end <= r.node.start) continue;
      if (loopsOf(w).some((l) => rLoops.includes(l)) && !exclusive(r, w)) return { read: r, write: w, loop: true };
    }
  }
  return null;
}

export const clickHandlerForcedLayout = defineRule({
  id: 'click-handler-forced-layout',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js'],
  description: 'An input handler writes styles or classes and then reads layout in the same task, forcing a synchronous style and layout pass.',
  helpUrl: 'https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing',
  check(ctx) {
    const { js } = ctx;
    const seen = new Set();
    const out = [];
    for (const l of js.listeners) {
      if (!INPUT_EVENTS.has(l.event) || !l.handler || seen.has(l.handler)) continue;
      seen.add(l.handler);
      const hit = forcedLayout(js, l.handler);
      if (!hit) continue;
      out.push({
        node: ctx.ref.js(l.script, hit.read.node),
        message: hit.loop
          ? `${l.event} handler reads ${hit.read.label} and writes ${hit.write.label} in the same loop, forcing a layout on every iteration; do all reads first, then all writes.`
          : `${l.event} handler writes ${hit.write.label} and then reads ${hit.read.label}, forcing a synchronous layout; read before writing, or move the read into requestAnimationFrame.`,
        data: { event: l.event, read: hit.read.label, write: hit.write.label, loop: hit.loop },
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// scroll-listener-animates-transform
// ---------------------------------------------------------------------------

const ANIMATED_PROPS = new Set(['transform', 'webkitTransform', 'opacity', 'translate', 'scale', 'rotate']);
const ANIMATED_CSS = new Set(['transform', '-webkit-transform', 'opacity', 'translate', 'scale', 'rotate']);
const TIMELINE_GUARD_RE = /animation-timeline|scroll-timeline|view-timeline|CSS\.supports/;

/** { node, label } when `node` writes a compositor property with a runtime value. */
function animatedWrite(node) {
  if (node.type === 'AssignmentExpression') {
    const left = unwrap(node.left);
    if (left?.type !== 'MemberExpression' || propName(left.object) !== 'style') return null;
    if (!ANIMATED_PROPS.has(propName(left)) || isStaticValue(node.right)) return null;
    return { node, label: clip(pathOf(left)) };
  }
  if (node.type === 'CallExpression' && propName(node.callee) === 'setProperty' && propName(unwrap(node.callee).object) === 'style') {
    const prop = stringValue(node.arguments[0]);
    if (prop === null || !ANIMATED_CSS.has(prop.toLowerCase()) || isStaticValue(node.arguments[1])) return null;
    return { node, label: `style.setProperty('${prop.toLowerCase()}')` };
  }
  return null;
}

/**
 * First unguarded compositor write reachable from `fn`: nested functions
 * count (rAF callbacks), and so do same-script functions it names in a call
 * or passes as an argument (requestAnimationFrame(update)), two hops deep.
 */
function findAnimatedWrite(js, script, fn, idx, visited, depth) {
  if (visited.has(fn)) return null;
  visited.add(fn);
  const hops = [];
  let hit = null;
  js.walkFunction(fn, (node) => {
    if (hit) return false;
    const w = animatedWrite(node);
    if (w) {
      const info = idx.assign.get(node) ?? idx.call.get(node);
      if (!info || !js.isGuarded(info, TIMELINE_GUARD_RE)) { hit = w; return false; }
    }
    if (depth < 2 && (node.type === 'CallExpression' || node.type === 'NewExpression')) {
      for (const cand of [node.callee, ...node.arguments]) {
        if (unwrap(cand)?.type !== 'Identifier') continue;
        const target = js.resolveFunction(script, cand);
        if (target && !visited.has(target)) hops.push(target);
      }
    }
    return true;
  }, { nested: true });
  if (hit) return hit;
  for (const next of hops) {
    const found = findAnimatedWrite(js, script, next, idx, visited, depth + 1);
    if (found) return found;
  }
  return null;
}

export const scrollListenerAnimatesTransform = defineRule({
  id: 'scroll-listener-animates-transform',
  severity: 'moderate',
  confidence: 'high',
  methods: ['js'],
  description: 'A scroll listener drives transform or opacity from JavaScript where a CSS scroll-driven animation could run off the main thread.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline',
  check(ctx) {
    const { js } = ctx;
    const idx = infoIndex(js);
    const out = [];
    for (const l of js.listenersByEvent('scroll')) {
      if (!l.handler || js.isGuarded(l, TIMELINE_GUARD_RE)) continue;
      const hit = findAnimatedWrite(js, l.script, l.handler, idx, new Set(), 0);
      if (!hit) continue;
      out.push({
        node: ctx.ref.js(l),
        message: `Scroll listener on ${clip(l.targetText, 40)} sets ${hit.label} on scroll; use animation-timeline: scroll() or view() and keep this code as a fallback behind CSS.supports().`,
        data: { write: hit.label, target: l.target },
      });
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// mouse-and-touch-pair
// ---------------------------------------------------------------------------

const MOUSE = new Set(['mousedown', 'mouseup', 'click']);
const TOUCH = new Set(['touchstart', 'touchend']);
const PAIR_VIA = new Set(['addEventListener', 'jquery', 'property']);
const JQUERY_ON = new Set(['on', 'one', 'bind']);

const normalizeTarget = (text) => String(text).replace(/\s+/g, '').replace(/["`]/g, "'").replace(/^(?:(?:window|self|globalThis)\.)+(?=.)/, '');

/** jQuery delegated selector: $(x).on('click', '.sel', fn). */
function delegateOf(l) {
  if (l.via !== 'jquery' || l.node.type !== 'CallExpression') return '';
  if (!JQUERY_ON.has(propName(l.node.callee)) || l.node.arguments.length < 3) return '';
  return stringValue(l.node.arguments[1]) ?? '';
}

const sameHandler = (a, b) => (a.handler && a.handler === b.handler) || (!a.handler && !b.handler && a.handlerText === b.handlerText);

export const mouseAndTouchPair = defineRule({
  id: 'mouse-and-touch-pair',
  severity: 'minor',
  confidence: 'medium',
  methods: ['js', 'html'],
  description: 'The same target listens to both mouse and touch events for one gesture; a single pointer event listener handles every input type once.',
  helpUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events',
  check(ctx) {
    const { js, html } = ctx;
    const out = [];
    // JS: group by (script, target text, delegate selector, scope).
    const fnIds = new Map();
    const groups = new Map();
    for (const l of js.listeners) {
      if (!PAIR_VIA.has(l.via) || !(MOUSE.has(l.event) || TOUCH.has(l.event))) continue;
      const root = ROOT_TARGETS.has(l.target);
      let scope = '';
      if (!root) {
        const fn = nearestFunction(l.ancestors);
        if (fn) {
          if (!fnIds.has(fn)) fnIds.set(fn, fnIds.size + 1);
          scope = String(fnIds.get(fn));
        }
      }
      let byScript = groups.get(l.script);
      if (!byScript) { byScript = new Map(); groups.set(l.script, byScript); }
      const key = `${normalizeTarget(l.targetText)}\u0000${delegateOf(l)}\u0000${scope}`;
      if (!byScript.has(key)) byScript.set(key, { root, list: [] });
      byScript.get(key).list.push(l);
    }
    for (const byScript of groups.values()) {
      for (const { root, list } of byScript.values()) {
        const touches = list.filter((l) => TOUCH.has(l.event));
        for (const t of touches) {
          // Root targets serve many widgets: pair only listeners sharing a handler.
          const partners = list.filter((m) => MOUSE.has(m.event) && (!root || sameHandler(m, t)));
          if (!partners.length) continue;
          const mouseEvents = [...new Set(partners.map((m) => m.event))].sort(cmp);
          out.push({
            node: ctx.ref.js(t),
            message: `${clip(t.targetText, 40)} listens to ${t.event} and ${mouseEvents.join(', ')}; use one pointerdown or pointerup listener (or click) instead.`,
            data: { mouse: mouseEvents, touch: t.event },
          });
          break;
        }
      }
    }
    // HTML: on* attribute pairs on one element.
    const byEl = new Map();
    for (const a of html.eventAttrs) {
      if (!byEl.has(a.el)) byEl.set(a.el, []);
      byEl.get(a.el).push(a.name);
    }
    for (const [el, names] of byEl) {
      const mouse = names.filter((n) => MOUSE.has(n.slice(2))).sort(cmp);
      const touch = names.filter((n) => TOUCH.has(n.slice(2)));
      if (!mouse.length || !touch.length) continue;
      out.push({
        node: ctx.ref.html(el, touch[0]),
        message: `Element has ${touch[0]} and ${mouse.join(', ')} attributes; use one onpointerdown or onpointerup handler (or onclick) instead.`,
        data: { mouse: mouse.map((n) => n.slice(2)), touch: touch[0].slice(2) },
      });
    }
    return out;
  },
});

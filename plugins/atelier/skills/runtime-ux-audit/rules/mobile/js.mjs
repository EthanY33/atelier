/**
 * Mobile rules read from JavaScript: touch and wheel listeners, double-tap
 * overrides and web push permission prompts.
 */
import { ROOT_TARGETS, isPreventDefaultCall, isUnconditional, preventDefaultCalls } from './shared.mjs';

/** The first preventDefault() call that runs on every invocation of the handler, or null. */
function unconditionalPreventDefault(ctx, fn) {
  return preventDefaultCalls(ctx, fn).find((c) => isUnconditional(ctx, fn, c)) ?? null;
}

const GESTURE_START = new Set(['touchstart', 'pointerdown', 'mousedown', 'dragstart']);

/**
 * The listener is added from inside a touchstart/pointerdown/mousedown
 * handler: the drag pattern, where a non-passive root touchmove exists only
 * while the gesture lasts.
 */
function attachedDuringGesture(ctx, l) {
  return ctx.js.enclosingFunctions(l.ancestors).some((fn) => GESTURE_START.has(ctx.js.listenerForFunction(fn)?.event));
}

const rootNonPassive = (ctx, l) => ROOT_TARGETS.has(l.target) && l.options.passive === false && !attachedDuringGesture(ctx, l);

export const nonPassiveTouchListener = {
  id: 'atelier/runtime-ux/non-passive-touch-listener',
  area: 'mobile',
  severity: 'critical',
  confidence: 'high',
  methods: ['js'],
  phase: 'static',
  description: 'A touchstart or touchmove listener on window, document or body opts out of passive mode, so every scroll gesture waits for the handler to run.',
  helpUrl: 'https://web.dev/articles/uses-passive-event-listeners',
  check(ctx) {
    const out = [];
    for (const event of ['touchstart', 'touchmove']) {
      for (const l of ctx.js.listenersByEvent(event)) {
        if (!rootNonPassive(ctx, l)) continue;
        // An unconditional preventDefault() is scroll-hijack's finding.
        if (l.handler && unconditionalPreventDefault(ctx, l.handler)) continue;
        out.push({
          node: ctx.ref.js(l),
          message: `${event} on ${l.targetText} with passive: false blocks scrolling until the handler returns; use passive: true, or touch-action in CSS.`,
          data: { event, target: l.target },
        });
      }
    }
    return out;
  },
};

export const scrollHijack = {
  id: 'atelier/runtime-ux/scroll-hijack',
  area: 'mobile',
  severity: 'critical',
  confidence: 'high',
  methods: ['js'],
  phase: 'static',
  description: 'A non-passive touch or wheel listener on window, document or body calls preventDefault() on every event, which disables native scrolling.',
  helpUrl: 'https://web.dev/articles/uses-passive-event-listeners',
  check(ctx) {
    const out = [];
    for (const event of ['touchstart', 'touchmove', 'wheel', 'mousewheel', 'dommousescroll']) {
      for (const l of ctx.js.listenersByEvent(event)) {
        if (!rootNonPassive(ctx, l) || !l.handler) continue;
        const call = unconditionalPreventDefault(ctx, l.handler);
        if (!call) continue;
        const at = ctx.ref.js(l.script, call.node).location;
        out.push({
          node: ctx.ref.js(l),
          message: `The ${event} handler on ${l.targetText} calls preventDefault() unconditionally (${at}) with passive: false, so the page cannot scroll natively.`,
          data: { event, target: l.target },
        });
      }
    }
    return out;
  },
};

const GUARD_RE = /display-mode|standalone/;

export const pushPermissionNoDisplayModeGuard = {
  id: 'atelier/runtime-ux/push-permission-no-display-mode-guard',
  area: 'mobile',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js'],
  phase: 'static',
  description: 'Notification permission or a push subscription is requested without a display-mode: standalone check, but iOS offers web push only to Home Screen web apps.',
  helpUrl: 'https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/',
  check(ctx) {
    const calls = [
      ...ctx.js.callsByCallee('Notification.requestPermission'),
      ...ctx.js.callsByMethod('subscribe').filter((c) => c.callee === 'pushManager.subscribe' || c.callee.endsWith('.pushManager.subscribe')),
    ];
    return calls
      .filter((c) => !c.isNew && !ctx.js.isGuarded(c, GUARD_RE))
      .map((c) => ({
        node: ctx.ref.js(c),
        message: `${c.callee}() is not gated on matchMedia('(display-mode: standalone)') or navigator.standalone; on iOS, ask only inside the installed app.`,
      }));
  },
};

const TIME_OPERAND_RE = /now\(\)|timeStamp|getTime\(\)|last/i;
const COMPARE_OPS = new Set(['<', '<=', '>', '>=']);
const isWindowLiteral = (n) => n?.type === 'Literal' && typeof n.value === 'number' && n.value >= 200 && n.value <= 600;

/** The handler compares a timestamp difference against a 200 to 600 ms double-tap window. */
function doubleTapWindow(ctx, script, fn) {
  let found = null;
  ctx.js.walkFunction(fn, (node) => {
    if (found || node.type !== 'BinaryExpression' || !COMPARE_OPS.has(node.operator)) return;
    for (const [lit, other] of [[node.right, node.left], [node.left, node.right]]) {
      if (isWindowLiteral(lit) && TIME_OPERAND_RE.test(ctx.js.sourceOf(script, other))) { found = lit.value; return; }
    }
  });
  return found;
}

function callsPreventDefault(ctx, fn) {
  let hit = false;
  ctx.js.walkFunction(fn, (node) => {
    if (!hit && isPreventDefaultCall(node)) hit = true;
  });
  return hit;
}

const FASTCLICK_RE = /fastclick/i;

export const doubleTapJsOverride = {
  id: 'atelier/runtime-ux/double-tap-js-override',
  area: 'mobile',
  severity: 'moderate',
  confidence: 'medium',
  methods: ['js', 'html'],
  phase: 'static',
  description: 'Script fights the browser tap handling (a touchend double-tap timer with preventDefault, or FastClick) where touch-action: manipulation or a device-width viewport is enough.',
  helpUrl: 'https://web.dev/articles/mobile-touch',
  check(ctx) {
    const out = [];
    for (const l of ctx.js.listenersByEvent('touchend')) {
      if (!l.handler || !callsPreventDefault(ctx, l.handler)) continue;
      const ms = doubleTapWindow(ctx, l.script, l.handler);
      if (ms === null) continue;
      out.push({
        node: ctx.ref.js(l),
        message: `touchend handler cancels a second tap within ${ms} ms; use touch-action: manipulation instead of a script timer.`,
        data: { windowMs: ms },
      });
    }
    const fastclick = 'FastClick removes a 300 ms delay that no current browser has with width=device-width, and breaks native taps; remove it.';
    for (const el of ctx.html.byTag('script')) {
      if (FASTCLICK_RE.test(ctx.html.attr(el, 'src') ?? '')) out.push({ node: ctx.ref.html(el, 'src'), message: fastclick });
    }
    for (const imp of ctx.js.imports) {
      if (FASTCLICK_RE.test(imp.source)) out.push({ node: ctx.ref.js(imp), message: fastclick });
    }
    for (const c of ctx.js.callsByCallee('FastClick.attach')) out.push({ node: ctx.ref.js(c), message: fastclick });
    return out;
  },
};

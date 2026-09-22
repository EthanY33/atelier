/**
 * Back/forward cache blockers: unload and always-on beforeunload handlers,
 * Cache-Control: no-store on the document, and the dynamic restore probe.
 */
import { HELP, isWindowListener, listenerRef } from './shared.mjs';

// Ready-style events: a handler for one of these runs on every page load.
const READY_EVENTS = new Set(['domcontentloaded', 'load', 'readystatechange', 'pageshow']);

export const noUnloadHandler = {
  id: 'atelier/runtime-ux/no-unload-handler',
  area: 'transitions',
  severity: 'critical',
  confidence: 'high',
  methods: ['js', 'html'],
  phase: 'static',
  description: 'An unload handler on the window keeps the page out of the back/forward cache.',
  helpUrl: HELP.bfcache,
  check(ctx) {
    const out = [];
    for (const l of ctx.js.listenersByEvent('unload')) {
      if (!isWindowListener(l)) continue;
      out.push({
        node: listenerRef(ctx, l),
        message: 'unload handlers keep the page out of the back/forward cache in Firefox and desktop Chromium, and Chromium is deprecating them; listen for pagehide instead.',
        data: { via: l.via },
      });
    }
    return out;
  },
};

/**
 * True when the listener is registered on every page load: at the top level
 * (IIFEs count) or inside handlers of ready-style events, with no condition
 * on the way.
 */
function attachedUnconditionally(js, l) {
  if (js.isConditional(l)) return false;
  if (l.topLevel) return true;
  return js.enclosingFunctions(l.ancestors).every((fn) => fn.__iife === true || READY_EVENTS.has(js.listenerForFunction(fn)?.event));
}

export const noBeforeunloadAlwaysAttached = {
  id: 'atelier/runtime-ux/no-beforeunload-always-attached',
  area: 'transitions',
  severity: 'serious',
  confidence: 'medium',
  methods: ['js', 'html'],
  phase: 'static',
  description: 'A beforeunload handler is attached on every page load instead of only while there are unsaved changes.',
  helpUrl: HELP.bfcache,
  check(ctx) {
    const { js } = ctx;
    const out = [];
    for (const l of js.listenersByEvent('beforeunload')) {
      if (!isWindowListener(l)) continue;
      if (l.via !== 'attribute' && !attachedUnconditionally(js, l)) continue;
      out.push({
        node: listenerRef(ctx, l),
        message: 'beforeunload is attached unconditionally; add it only while there are unsaved changes and remove it after saving, since it can keep the page out of the back/forward cache.',
        data: { via: l.via },
      });
    }
    return out;
  },
};

export const cacheControlNoStoreOnHtml = {
  id: 'atelier/runtime-ux/cache-control-no-store-on-html',
  area: 'transitions',
  severity: 'moderate',
  confidence: 'high',
  methods: ['headers'],
  phase: 'static',
  requires: ['http'],
  description: 'The HTML response sends Cache-Control: no-store, which keeps the page out of the back/forward cache in WebKit and Gecko.',
  helpUrl: HELP.bfcacheCcns,
  check(ctx) {
    const value = ctx.page.headers['cache-control'];
    if (typeof value !== 'string') return [];
    const tokens = value.split(',').map((t) => t.trim().toLowerCase());
    if (!tokens.includes('no-store')) return [];
    return [{
      node: ctx.ref.page('Cache-Control', `Cache-Control: ${value.trim()}`),
      message: 'Chromium now bfcaches no-store pages (verified on Chromium 153); WebKit and Gecko still evict them. Use no-cache or private, max-age=0 unless the page must never be stored.',
    }];
  },
};

export const bfcacheNotRestored = {
  id: 'atelier/runtime-ux/bfcache-not-restored',
  area: 'transitions',
  severity: 'serious',
  confidence: 'high',
  methods: ['trace'],
  phase: 'dynamic',
  description: 'Going back to the page reloaded it instead of restoring it from the back/forward cache.',
  helpUrl: HELP.bfcacheReasons,
  check(ctx) {
    const bf = ctx.dynamic?.bfcache ?? null;
    if (!bf || bf.supported !== true) return { notApplicable: 'bfcache probe unavailable' };
    if (bf.restored === null || bf.restored === undefined) return { notApplicable: 'bfcache probe did not finish' };
    if (bf.restored !== false) return [];
    const reasons = Array.isArray(bf.reasons) ? bf.reasons.map(String) : [];
    const masked = reasons.length === 1 && reasons[0] === 'masked';
    const message = masked
      ? 'Chromium masked the blocking reason; check the no-unload-handler and no-beforeunload-always-attached findings and any third-party frames.'
      : reasons.length
        ? 'The back navigation reloaded the page; fix the reported notRestoredReasons.'
        : 'The back navigation reloaded the page and Chromium reported no reason.';
    return [{
      node: ctx.ref.dynamic({ selector: 'document', snippet: `notRestoredReasons: ${reasons.length ? reasons.join(', ') : '(none reported)'}` }),
      message,
      data: { reasons },
    }];
  },
};

export const rules = [noUnloadHandler, noBeforeunloadAlwaysAttached, cacheControlNoStoreOnHtml, bfcacheNotRestored];

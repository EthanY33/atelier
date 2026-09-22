/*
 * atelier runtime-ux-audit init script. Runs in the page before any page
 * script (page.addInitScript) and only collects data:
 *
 *   window.__atelierUx = { events, loaf, loafSupported, pageshow, windowStart }
 *     events:   Event Timing entries with an interactionId (durationThreshold 16)
 *     loaf:     Long Animation Frames, when the engine supports them
 *     pageshow: e.persisted of every pageshow event (a bfcache restore pushes true)
 *
 *   window.__atelierCssPath(el): the same selector core's HtmlModel.cssPath builds
 *
 * It must never add unload, beforeunload or pagehide listeners: they would
 * change the back/forward cache result the audit measures.
 */
(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(window, '__atelierUx')) return;

  const MAX_EVENTS = 5000;
  const MAX_LOAF = 2000;
  const MAX_SCRIPTS = 50;

  // Captured before page code runs, so later monkey-patching cannot skew them.
  const docQsa = Document.prototype.querySelectorAll;
  const getAttr = Element.prototype.getAttribute;
  const escapeIdent = CSS.escape;

  const state = { events: [], loaf: [], loafSupported: false, pageshow: [], windowStart: null };
  const hidden = (name, value) => Object.defineProperty(window, name, { value, enumerable: false, writable: false, configurable: false });

  const idCount = (id) => {
    try {
      return docQsa.call(document, '[id="' + escapeIdent(id) + '"]').length;
    } catch (e) {
      return 0;
    }
  };

  // Core algorithm (lib/html-model.mjs cssPath), walked from el upward:
  // html/body/head stop the walk; a unique non-empty id stops it as #id;
  // otherwise tag + first 2 classes + :nth-of-type(n) when the parent has
  // more than one child with that tag. Segments are joined with ' > '.
  const cssPath = (el) => {
    const segs = [];
    let cur = el;
    for (let guard = 0; cur && cur.nodeType === 1 && guard < 1000; guard++) {
      const tag = String(cur.localName || cur.tagName || '').toLowerCase();
      if (tag === 'html' || tag === 'body' || tag === 'head') {
        segs.unshift(tag);
        break;
      }
      const id = getAttr.call(cur, 'id');
      if (id && idCount(id) === 1) {
        segs.unshift('#' + escapeIdent(id));
        break;
      }
      const seen = new Set();
      const classes = [];
      for (const c of String(getAttr.call(cur, 'class') || '').split(/\s+/)) {
        if (c && !seen.has(c)) {
          seen.add(c);
          classes.push(c);
        }
      }
      let seg = tag + classes.slice(0, 2).map((c) => '.' + escapeIdent(c)).join('');
      const parent = cur.parentNode;
      if (parent && parent.children) {
        let count = 0;
        let index = 0;
        for (const sib of parent.children) {
          if (String(sib.localName || '').toLowerCase() === tag) {
            count++;
            if (sib === cur) index = count;
          }
        }
        if (count > 1) seg += ':nth-of-type(' + index + ')';
      }
      segs.unshift(seg);
      cur = cur.parentElement;
    }
    return segs.join(' > ');
  };

  const safePath = (node) => {
    try {
      return node && node.nodeType === 1 ? cssPath(node) : null;
    } catch (e) {
      return null;
    }
  };

  hidden('__atelierUx', state);
  hidden('__atelierCssPath', cssPath);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId || state.events.length >= MAX_EVENTS) continue;
        state.events.push({
          interactionId: e.interactionId,
          name: e.name,
          target: safePath(e.target),
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
        });
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (e) {
    // Event Timing unsupported: no entries, and the INP estimate stays null.
  }

  try {
    const types = PerformanceObserver.supportedEntryTypes || [];
    if (types.indexOf('long-animation-frame') !== -1) {
      state.loafSupported = true;
      new PerformanceObserver((list) => {
        for (const f of list.getEntries()) {
          if (state.loaf.length >= MAX_LOAF) break;
          const scripts = [];
          for (const s of f.scripts || []) {
            if (scripts.length >= MAX_SCRIPTS) break;
            scripts.push({
              invoker: s.invoker,
              invokerType: s.invokerType,
              sourceURL: s.sourceURL,
              sourceFunctionName: s.sourceFunctionName,
              sourceCharPosition: s.sourceCharPosition,
              duration: s.duration,
              forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
            });
          }
          state.loaf.push({ startTime: f.startTime, duration: f.duration, blockingDuration: f.blockingDuration, scripts });
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    }
  } catch (e) {
    state.loafSupported = false;
  }

  addEventListener('pageshow', (e) => {
    state.pageshow.push(e.persisted === true);
  });
})();

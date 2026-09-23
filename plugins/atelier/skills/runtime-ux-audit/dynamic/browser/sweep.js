/*
 * atelier runtime-ux-audit init script, added after observers.js (it uses
 * window.__atelierCssPath from there). It defines, without running them:
 *
 *   window.__atelierSweep({ maxInteractive }) -> DOM facts at load:
 *     interactive[], interactiveTruncated, repeatedGroups[], viewTransitionNames[]
 *     Rects are document coordinates (client rect plus scroll offset).
 *   window.__atelierProbe -> helpers the Node side calls while it drives the
 *     page (tap candidates, dialog triggers, open-surface tracking, focus,
 *     the Event Timing and LoAF harvest, and the bfcache state after a back
 *     navigation).
 *
 * Nothing here mutates the page. Both globals are non-enumerable.
 */
(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(window, '__atelierSweep')) return;

  const cssPath = window.__atelierCssPath;
  const gcs = window.getComputedStyle.bind(window);
  const rectOf = Element.prototype.getBoundingClientRect;
  const rectsOf = Element.prototype.getClientRects;
  const docQsa = Document.prototype.querySelectorAll;
  const elQsa = Element.prototype.querySelectorAll;
  const matchesSel = Element.prototype.matches;
  const closestSel = Element.prototype.closest;
  const getAttr = Element.prototype.getAttribute;
  const hasAttr = Element.prototype.hasAttribute;
  const checkVis = Element.prototype.checkVisibility;

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option']);
  const INTERACTIVE_QUERY = 'a[href], button, input, select, textarea, summary, [role], [onclick], [tabindex]';
  // Text inside these does not make a link "inline in text" (a nav of links is not a sentence).
  const OTHER_TARGETS = 'a[href], button, input, select, textarea, summary, [onclick], [role="button" i], [role="link" i], [role="tab" i], [role="menuitem" i]';
  const TEXT_SKIP = new Set(['script', 'style', 'noscript', 'template']);
  const GROUP_SKIP = new Set(['head', 'select', 'datalist', 'optgroup', 'script', 'style', 'template', 'noscript']);
  const VT_SKIP = new Set(['none', 'auto', 'match-element', '']);
  const WORDISH = /[\p{L}\p{N}]/u;

  const hidden = (name, value) => Object.defineProperty(window, name, { value, enumerable: false, writable: false, configurable: false });
  const r2 = (n) => Math.round(n * 100) / 100;
  const tagOf = (el) => String(el.localName || '').toLowerCase();
  const attr = (el, name) => getAttr.call(el, name);
  const has = (el, name) => hasAttr.call(el, name);
  const roleOf = (el) => {
    const r = String(attr(el, 'role') || '').trim().split(/\s+/)[0];
    return r ? r.toLowerCase() : null;
  };
  const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const cap = (s, max) => (s.length > max ? s.slice(0, max - 3) + '...' : s);
  const all = (root, sel) => (root === document ? docQsa.call(document, sel) : elQsa.call(root, sel));

  function isInteractive(el) {
    const tag = tagOf(el);
    if (tag === 'a' && has(el, 'href')) return true;
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    if (tag === 'input') return String(el.type || '').toLowerCase() !== 'hidden';
    const role = roleOf(el);
    if (role && ROLES.has(role)) return true;
    if (has(el, 'onclick')) return true;
    if (has(el, 'tabindex') && parseInt(attr(el, 'tabindex'), 10) >= 0) return true;
    return false;
  }

  // Non-empty rect, visibility visible, display not none, opacity > 0 (self
  // and ancestors), and no aria-hidden="true" or inert ancestor.
  function isVisible(el) {
    const r = rectOf.call(el);
    if (!(r.width > 0 && r.height > 0)) return false;
    if (typeof checkVis === 'function') {
      if (!checkVis.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    } else {
      const cs = gcs(el);
      if (cs.display === 'none' || cs.visibility !== 'visible' || parseFloat(cs.opacity) === 0) return false;
    }
    return !closestSel.call(el, '[aria-hidden="true" i], [inert]');
  }

  function isDisabled(el) {
    if (has(el, 'disabled')) return true;
    try {
      if (matchesSel.call(el, ':disabled')) return true;
    } catch (e) {
      // :disabled is always supported; keep the probe alive regardless.
    }
    return String(attr(el, 'aria-disabled') || '').trim().toLowerCase() === 'true';
  }

  // display inline, and the nearest non-inline ancestor holds other word text
  // that is not inside this or another target.
  function isInlineInText(el) {
    if (gcs(el).display !== 'inline') return false;
    let block = el.parentElement;
    while (block && block !== document.body && /^(inline|contents)$/.test(gcs(block).display)) block = block.parentElement;
    if (!block) return false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let n = walker.nextNode(); n && seen < 2000; n = walker.nextNode(), seen++) {
      if (!WORDISH.test(n.data)) continue;
      const parent = n.parentElement;
      if (!parent || el.contains(n)) continue;
      if (TEXT_SKIP.has(tagOf(parent))) continue;
      if (closestSel.call(parent, OTHER_TARGETS)) continue;
      return true;
    }
    return false;
  }

  function labelOf(el) {
    let text = collapse(el.textContent);
    if (!text) text = collapse(attr(el, 'aria-label'));
    if (!text) {
      const img = elQsa.call(el, 'img[alt]')[0];
      if (img) text = collapse(attr(img, 'alt'));
    }
    if (!text && tagOf(el) === 'input' && /^(button|submit|reset)$/.test(String(el.type))) text = collapse(el.value);
    if (!text) text = collapse(attr(el, 'title'));
    return cap(text, 60);
  }

  function docRect(el, sx, sy) {
    const r = rectOf.call(el);
    return { x: r2(r.left + sx), y: r2(r.top + sy), width: r2(r.width), height: r2(r.height) };
  }

  function interactiveFacts(max, sx, sy) {
    const out = [];
    let truncated = false;
    for (const el of all(document, INTERACTIVE_QUERY)) {
      if (!isInteractive(el)) continue;
      if (out.length >= max) {
        truncated = true;
        break;
      }
      const tag = tagOf(el);
      out.push({
        selector: cssPath(el),
        tag,
        role: roleOf(el),
        type: tag === 'input' || tag === 'button' ? String(el.type || '').toLowerCase() || null : null,
        text: labelOf(el),
        rect: docRect(el, sx, sy),
        visible: isVisible(el),
        disabled: isDisabled(el),
        inlineInText: isInlineInText(el),
      });
    }
    return { interactive: out, interactiveTruncated: truncated };
  }

  const cvHidden = (el) => /^(auto|hidden)$/.test(String(gcs(el).contentVisibility || ''));

  function shapeOf(el) {
    const classes = [...new Set(String(attr(el, 'class') || '').split(/\s+/).filter(Boolean))].sort();
    return tagOf(el) + classes.slice(0, 3).map((c) => '.' + c).join('');
  }

  function repeatedGroups(sy) {
    const fold = 2 * window.innerHeight;
    const found = [];
    let index = 0;
    for (const el of all(document, '*')) {
      index++;
      if (el.namespaceURI !== HTML_NS || GROUP_SKIP.has(tagOf(el)) || el.children.length < 20) continue;
      const counts = new Map();
      for (const child of el.children) {
        const sig = shapeOf(child);
        counts.set(sig, (counts.get(sig) || 0) + 1);
      }
      let signature = '';
      let count = 0;
      for (const [sig, n] of counts) {
        if (n > count) {
          signature = sig;
          count = n;
        }
      }
      let belowFoldCount = 0;
      let contentVisibility = cvHidden(el);
      for (const child of el.children) {
        if (!contentVisibility && cvHidden(child)) contentVisibility = true;
        if (shapeOf(child) === signature && rectOf.call(child).top + sy > fold) belowFoldCount++;
      }
      found.push({ index, entry: { parentSelector: cssPath(el), signature, count, belowFoldCount, contentVisibility } });
    }
    // Keep at most 20: groups big enough to matter first, then document order.
    found.sort((a, b) => (b.entry.count >= 20) - (a.entry.count >= 20) || a.index - b.index);
    return found.slice(0, 20).sort((a, b) => a.index - b.index).map((f) => f.entry);
  }

  function viewTransitionNames() {
    const byName = new Map();
    for (const el of all(document, '*')) {
      const name = String(gcs(el).viewTransitionName || '').trim();
      if (VT_SKIP.has(name) || rectsOf.call(el).length === 0) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(el);
    }
    const out = [];
    for (const [name, els] of byName) {
      if (els.length >= 2) out.push({ name, selectors: els.slice(0, 5).map((e) => cssPath(e)) });
    }
    return out;
  }

  hidden('__atelierSweep', (opts) => {
    const max = opts && Number.isInteger(opts.maxInteractive) && opts.maxInteractive > 0 ? opts.maxInteractive : 500;
    const sx = window.scrollX;
    const sy = window.scrollY;
    return { ...interactiveFacts(max, sx, sy), repeatedGroups: repeatedGroups(sy), viewTransitionNames: viewTransitionNames() };
  });

  // ---- helpers for the Node-driven probes ----

  const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
  const dialogLike = (el) => tagOf(el) === 'dialog' || DIALOG_ROLES.has(roleOf(el)) || String(attr(el, 'aria-modal') || '').toLowerCase() === 'true';

  function surfaceOpen(el) {
    if (!el || !el.isConnected) return false;
    if (tagOf(el) === 'dialog' && el.open) return true;
    if (has(el, 'popover')) {
      try {
        if (matchesSel.call(el, ':popover-open')) return true;
      } catch (e) {
        // no popover support
      }
    }
    return (DIALOG_ROLES.has(roleOf(el)) || String(attr(el, 'aria-modal') || '').toLowerCase() === 'true') && isVisible(el);
  }

  const openSurfaces = () => [...all(document, 'dialog, [popover], [role], [aria-modal]')].filter(surfaceOpen);

  const CLOSE_QUERY = 'button[aria-label*="close" i], [data-close], [data-bs-dismiss], .close, form[method="dialog" i] button';

  // True when activating el would submit its form: a submit button
  // (<button> with no type or type=submit, input submit/image) owned by a
  // form whose effective method is not "dialog". A missing action attribute
  // still submits, to the document URL.
  function submitsForm(el) {
    const tag = tagOf(el);
    const type = String(el.type || '').toLowerCase();
    const submit = (tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image'));
    if (!submit || !el.form) return false;
    const method = String((has(el, 'formmethod') && el.formMethod) || el.form.method || 'get').toLowerCase();
    return method !== 'dialog';
  }

  const probe = {
    before: new Set(),
    current: null,
    trigger: null,
    triggerPath: null,

    /** Up to max tap candidates in DOM order (never links, downloads or form submits). */
    tapCandidates(max) {
      const out = [];
      for (const el of all(document, 'button, summary, input, [role], [aria-expanded], [popovertarget]')) {
        if (out.length >= max) break;
        const tag = tagOf(el);
        const type = String(el.type || '').toLowerCase();
        const kind = tag === 'button' || roleOf(el) === 'button' || tag === 'summary' || has(el, 'aria-expanded') || has(el, 'popovertarget')
          || (tag === 'input' && (type === 'checkbox' || type === 'radio'));
        if (!kind) continue;
        if (closestSel.call(el, 'a[href]') || has(el, 'download') || has(el, 'target')) continue;
        if (submitsForm(el)) continue;
        if (isDisabled(el) || !isVisible(el)) continue;
        out.push(cssPath(el));
      }
      return out;
    },

    /** Up to max visible, enabled elements that open a dialog or popover. */
    dialogTriggers(max) {
      const out = [];
      for (const el of all(document, '[popovertarget], [commandfor], [aria-haspopup], [data-bs-toggle], [aria-controls]')) {
        if (out.length >= max) break;
        const command = String(attr(el, 'command') || '').toLowerCase();
        let ok = has(el, 'popovertarget')
          || (has(el, 'commandfor') && (command === 'show-modal' || command === 'show-popover' || command === 'toggle-popover'))
          || String(attr(el, 'aria-haspopup') || '').trim().toLowerCase() === 'dialog'
          || String(attr(el, 'data-bs-toggle') || '').trim().toLowerCase() === 'modal';
        if (!ok && has(el, 'aria-controls')) {
          ok = String(attr(el, 'aria-controls')).trim().split(/\s+/).some((id) => {
            const t = id ? document.getElementById(id) : null;
            return !!t && dialogLike(t);
          });
        }
        if (!ok || submitsForm(el) || isDisabled(el) || !isVisible(el)) continue;
        out.push(cssPath(el));
      }
      return out;
    },

    /** Selector of document.activeElement ('body', 'html', a path) or null. */
    activePath() {
      const a = document.activeElement;
      return a ? cssPath(a) : null;
    },

    /** Focus the element at path; true when it took focus. */
    focusTrigger(path) {
      const el = document.querySelector(path);
      this.trigger = el;
      this.triggerPath = path;
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    },

    snapshotOpen() {
      this.before = new Set(openSurfaces());
      this.current = null;
    },

    /** Selector of the first surface opened since snapshotOpen(), or null. */
    newOpenSurface() {
      for (const el of openSurfaces()) {
        if (!this.before.has(el)) {
          this.current = el;
          return cssPath(el);
        }
      }
      return null;
    },

    currentOpen() {
      return surfaceOpen(this.current);
    },

    /** Selector of the first visible close control inside the open surface, or null. */
    closeCandidate() {
      if (!this.current) return null;
      for (const el of elQsa.call(this.current, CLOSE_QUERY)) {
        if (isVisible(el)) return cssPath(el);
      }
      return null;
    },

    /** Event Timing and LoAF data since the measurement window opened; null on any other document. */
    harvest() {
      const ux = window.__atelierUx;
      if (!ux || ux.windowStart === null) return null;
      const w = ux.windowStart;
      return {
        events: ux.events.filter((e) => e.startTime >= w),
        loaf: ux.loafSupported ? ux.loaf.filter((f) => f.startTime >= w) : null,
        interactionCount: typeof performance.interactionCount === 'number' ? performance.interactionCount : null,
      };
    },

    /** After a back navigation: restored (last pageshow persisted) or the notRestoredReasons. */
    bfcacheState() {
      const shows = window.__atelierUx.pageshow;
      const restored = shows[shows.length - 1] === true;
      const nav = performance.getEntriesByType('navigation')[0];
      const supported = nav ? 'notRestoredReasons' in nav
        : typeof PerformanceNavigationTiming !== 'undefined' && 'notRestoredReasons' in PerformanceNavigationTiming.prototype;
      const reasons = [];
      const walk = (node, depth) => {
        if (!node || depth > 20) return;
        for (const item of node.reasons || []) {
          const reason = typeof item === 'string' ? item : item && item.reason;
          if (reason) reasons.push(String(reason));
        }
        for (const child of node.children || []) walk(child, depth + 1);
      };
      if (!restored && nav && nav.notRestoredReasons) walk(nav.notRestoredReasons, 0);
      return { supported, restored, reasons };
    },

    focusState() {
      const active = this.activePath();
      const restored = !!document.activeElement && (document.activeElement === this.trigger || (this.triggerPath !== null && active === this.triggerPath));
      return { active, restored };
    },
  };
  hidden('__atelierProbe', probe);
})();

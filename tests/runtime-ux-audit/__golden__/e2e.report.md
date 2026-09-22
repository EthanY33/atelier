# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static
Total violations: 7 rules, 7 instances (critical: 1, serious: 3, moderate: 3, minor: 0)
Pass: no (1 critical, 3 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| Transitions | 1 | 1 | 0 | 0 | bfcache blockers 1, view-transition gaps 1, speculation rules 0, prerender analytics 0 |
| INP | 0 | 0 | 1 | 0 | non-passive listeners 0, main-thread smells 1, long scripts 0, RUM gaps 0, INP est. n/a (static) |
| Panels | 0 | 0 | 2 | 0 | z-index smells 1, dialog semantics 1, popover/menu behavior 0, motion gaps 0, compositor costs 0 |
| Mobile | 0 | 2 | 0 | 0 | tap targets under 24px 0, vh without dvh 1, safe-area gaps 0, touch/scroll hijacks 0, viewport meta 0, PWA 0 |

## 1. Transitions

### Critical (1)

#### atelier/runtime-ux/no-unload-handler
- Description: An unload handler on the window keeps the page out of the back/forward cache.
- Confidence: high
- Help: https://web.dev/articles/bfcache
- Instances (1):
  - `script[src="js/analytics.js"]` at js/analytics.js:3:1: `window.addEventListener('unload', function () { navigator.sendBeacon('/collect', JSON.stringify({ type: 'exit' })); })`
    unload handlers keep the page out of the back/forward cache in Firefox and desktop Chromium, and Chromium is deprecating them; listen for pagehide instead.

### Serious (1)

#### atelier/runtime-ux/vta-no-feature-check
- Description: document.startViewTransition() is called without checking that the browser supports it.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:23:3: `document.startViewTransition(function () { const grid = document.getElementById('products'); const items = Array.from(grid.children).reverse(); items.forEach...`
    startViewTransition throws where the API is missing; guard it: if (!document.startViewTransition) { update(); return; }

## 2. INP

### Moderate (1)

#### atelier/runtime-ux/scroll-listener-animates-transform
- Description: A scroll listener drives transform or opacity from JavaScript where a CSS scroll-driven animation could run off the main thread.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:32:1: `window.addEventListener('scroll', function () { hero.style.transform = 'translateY(' + window.scrollY * 0.3 + 'px)'; }, { passive: true })`
    Scroll listener on window sets hero.style.transform on scroll; use animation-timeline: scroll() or view() and keep this code as a fallback behind CSS.supports().

## 3. Panels

### Moderate (2)

#### atelier/runtime-ux/div-role-dialog
- Description: A modal built from a non-dialog element with role="dialog"; a native <dialog> opened with showModal() handles focus, inertness and Escape.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog
- Instances (1):
  - `#menu-sheet` at index.html:51:36: `<div class="sheet" id="menu-sheet" role="dialog" aria-modal="true" aria-label="Menu" hidden>`
    <div role="dialog" aria-modal="true">: use <dialog> with showModal()

#### atelier/runtime-ux/z-index-literal-smell
- Description: A magic "always on top" z-index such as 9999 or 2147483647; the top layer (showModal, popover) replaces it.
- Confidence: high
- Help: https://drafts.csswg.org/css-position-4/#top-layer
- Instances (1):
  - `.sheet` at css/site.css:91:3: `.sheet { z-index: 9999 }`
    z-index 9999 is an "always on top" literal; use a small z-index scale, or the top layer for dialogs and popovers

## 4. Mobile

### Serious (2)

#### atelier/runtime-ux/hover-only-affordance
- Description: Content hidden by default is revealed only by :hover on an ancestor or sibling, with no :focus, :focus-within or click-state equivalent, so touch users cannot reach it.
- Confidence: medium
- Help: https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus
- Instances (1):
  - `.product:hover .quick-view` at css/site.css:74:3: `.product:hover .quick-view { opacity: 1 }`
    .product:hover .quick-view reveals it on hover only; add :focus-within (or a click toggle) to the same rule.

#### atelier/runtime-ux/uses-vh-without-dvh
- Description: A full-height box is sized with 100vh and no dvh or svh fallback, so on phones it is taller than the visible viewport while the URL bar shows.
- Confidence: high
- Help: https://web.dev/blog/viewport-units
- Instances (1):
  - `.hero` at css/site.css:40:3: `.hero { height: 100vh }`
    height uses 100vh with no later dvh or svh declaration; add height: 100dvh (or svh) after it.

## Needs review

None.

## Coverage

- Resources: 1 document, 1 stylesheet, 3 scripts, 1 manifest parsed; skipped: none; failed: none
- Rules: 65 total; 7 failed, 0 incomplete, 32 passed, 20 not applicable, 6 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 0

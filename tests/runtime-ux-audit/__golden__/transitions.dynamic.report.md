# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static + dynamic (Chromium 153, Pixel 7, 4x CPU)
Total violations: 10 rules, 14 instances (critical: 1, serious: 5, moderate: 4, minor: 0)
Pass: no (1 critical, 5 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| Transitions | 1 | 5 | 4 | 0 | bfcache blockers 4, view-transition gaps 7, speculation rules 2, prerender analytics 1 |

## 1. Transitions

### Critical (1)

#### atelier/runtime-ux/no-unload-handler
- Description: An unload handler on the window keeps the page out of the back/forward cache.
- Confidence: high
- Help: https://web.dev/articles/bfcache
- Instances (2):
  - `body` at index.html:19:7: `<body onunload="navigator.sendBeacon('/bye')">`
    unload handlers keep the page out of the back/forward cache in Firefox and desktop Chromium, and Chromium is deprecating them; listen for pagehide instead.
  - `script[src="js/app.js"]` at js/app.js:2:1: `window.addEventListener('unload', function () { navigator.sendBeacon('/analytics/exit'); })`
    unload handlers keep the page out of the back/forward cache in Firefox and desktop Chromium, and Chromium is deprecating them; listen for pagehide instead.

### Serious (5)

#### atelier/runtime-ux/bfcache-not-restored
- Description: Going back to the page reloaded it instead of restoring it from the back/forward cache.
- Confidence: high
- Help: https://developer.chrome.com/docs/web-platform/bfcache-notrestoredreasons
- Instances (1):
  - `document` at (runtime): `notRestoredReasons: masked`
    Chromium masked the blocking reason; check the no-unload-handler and no-beforeunload-always-attached findings and any third-party frames.

#### atelier/runtime-ux/no-beforeunload-always-attached
- Description: A beforeunload handler is attached on every page load instead of only while there are unsaved changes.
- Confidence: medium
- Help: https://web.dev/articles/bfcache
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:6:1: `window.addEventListener('beforeunload', function (event) { if (cart.dirty) event.preventDefault(); })`
    beforeunload is attached unconditionally; add it only while there are unsaved changes and remove it after saving, since it can keep the page out of the back/forward cache.

#### atelier/runtime-ux/speculation-rules-csp-gap
- Description: The page's Content-Security-Policy blocks its inline speculation rules.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API
- Instances (1):
  - `head > script:nth-of-type(1)` at index.html:9:1: `<script type="speculationrules">`
    Blocked by the meta CSP script-src: add 'inline-speculation-rules', a matching nonce or the sha256 hash to script-src.

#### atelier/runtime-ux/vta-duplicate-names
- Description: The same view-transition-name is set on more than one element, which makes the browser skip the transition.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name
- Instances (2):
  - `.hero` at css/site.css:13:9: `.hero { view-transition-name: hero }`
    view-transition-name "hero" is on 2 elements in the CSS, but not on 2 rendered boxes at runtime (Pixel 7).
    Confidence: low
  - `body > main > ul.products > li.card:nth-of-type(1)` at (runtime): `view-transition-name: product-card`
    view-transition-name "product-card" is on more than one rendered element, so the browser skips the transition.
    Confidence: high

#### atelier/runtime-ux/vta-no-feature-check
- Description: document.startViewTransition() is called without checking that the browser supports it.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:16:3: `document.startViewTransition(() => render(id))`
    startViewTransition throws where the API is missing; guard it: if (!document.startViewTransition) { update(); return; }

### Moderate (4)

#### atelier/runtime-ux/analytics-without-prerender-guard
- Description: Analytics send a page view at script start without checking document.prerendering, so prerendered pages that are never viewed are counted.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering
- Instances (1):
  - `script[src="js/analytics.js"]` at js/analytics.js:3:3: `ga('send', 'pageview')`
    ga("send", "pageview") runs at script start, so prerendered pages that are never viewed are counted; send it once document.prerendering is false (prerenderingchange).

#### atelier/runtime-ux/speculation-rules-immediate-abuse
- Description: An immediate speculation rule matches more URLs than Chromium will prerender or prefetch at once.
- Confidence: medium
- Help: https://developer.chrome.com/blog/speculation-rules-improvements
- Instances (1):
  - `head > script:nth-of-type(1)` at index.html:9:1: `<script type="speculationrules">`
    This immediate prerender rule matches 12 URLs, above Chromium's limit of 10; the extra requests waste bandwidth and memory. Use eagerness moderate or conservative.

#### atelier/runtime-ux/vta-no-reduced-motion-guard
- Description: View transitions with custom motion have no prefers-reduced-motion: reduce override.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
- Instances (3):
  - `@view-transition` at css/site.css:3:3: `@view-transition { navigation: auto }`
    Cross-document view transitions have no reduced-motion override; add @media (prefers-reduced-motion: reduce) { @view-transition { navigation: none } }.
  - `::view-transition-old(root)` at css/site.css:17:3: `::view-transition-old(root) { animation: 250ms ease-out both slide-out }`
    This view transition animation has no reduced-motion override; remove or shorten it under @media (prefers-reduced-motion: reduce).
  - `::view-transition-new(root)` at css/site.css:21:3: `::view-transition-new(root) { animation: 250ms ease-in both slide-in }`
    This view transition animation has no reduced-motion override; remove or shorten it under @media (prefers-reduced-motion: reduce).

#### atelier/runtime-ux/vta-root-transformed
- Description: The root element has a transform, filter, opacity below 1 or will-change: transform on a page that uses view transitions.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using
- Instances (1):
  - `html` at css/site.css:8:3: `html { will-change: transform }`
    will-change: transform on the root element can break the root view transition snapshot; apply it to an inner wrapper instead.

## Needs review

None.

## Coverage

- Resources: 1 document, 1 stylesheet, 2 scripts, 2 speculation rules blocks parsed; skipped: none; failed: none
- Rules: 11 total; 10 failed, 0 incomplete, 0 passed, 1 not applicable, 0 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 1
- Dynamic findings reflect Chromium-only APIs.
- Probe errors: none

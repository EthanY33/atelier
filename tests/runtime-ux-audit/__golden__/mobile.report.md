# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static
Total violations: 14 rules, 19 instances (critical: 2, serious: 4, moderate: 4, minor: 4)
Pass: no (2 critical, 4 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| Mobile | 2 | 4 | 4 | 4 | tap targets under 24px 0, vh without dvh 2, safe-area gaps 3, touch/scroll hijacks 5, viewport meta 1, PWA 3 |

## 1. Mobile

### Critical (2)

#### atelier/runtime-ux/non-passive-touch-listener
- Description: A touchstart or touchmove listener on window, document or body opts out of passive mode, so every scroll gesture waits for the handler to run.
- Confidence: high
- Help: https://web.dev/articles/uses-passive-event-listeners
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:6:1: `document.addEventListener('touchmove', function onTouchMove(e) { pinching = e.touches.length > 1; if (pinching) e.preventDefault(); }, { passive: false })`
    touchmove on document with passive: false blocks scrolling until the handler returns; use passive: true, or touch-action in CSS.

#### atelier/runtime-ux/scroll-hijack
- Description: A non-passive touch or wheel listener on window, document or body calls preventDefault() on every event, which disables native scrolling.
- Confidence: high
- Help: https://web.dev/articles/uses-passive-event-listeners
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:12:1: `window.addEventListener('wheel', (e) => { e.preventDefault(); customScrollBy(e.deltaY); }, { passive: false })`
    The wheel handler on window calls preventDefault() unconditionally (js/app.js:13:3) with passive: false, so the page cannot scroll natively.

### Serious (4)

#### atelier/runtime-ux/fixed-bottom-no-safe-area
- Description: A position: fixed element pinned to bottom 0 under viewport-fit=cover never pads for env(safe-area-inset-bottom), so the home indicator overlaps it.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/env
- Instances (2):
  - `.composer` at css/site.css:82:3: `.composer { position: fixed }`
    .composer is fixed at bottom 0 with no env(safe-area-inset-bottom) padding, margin or offset.
  - `.tabbar` at css/site.css:91:3: `.tabbar { position: fixed }`
    .tabbar is fixed at bottom 0 with no env(safe-area-inset-bottom) padding, margin or offset.

#### atelier/runtime-ux/hover-only-affordance
- Description: Content hidden by default is revealed only by :hover on an ancestor or sibling, with no :focus, :focus-within or click-state equivalent, so touch users cannot reach it.
- Confidence: medium
- Help: https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus
- Instances (1):
  - `.nav-item:hover .dropdown` at css/site.css:25:3: `.nav-item:hover .dropdown { display: block }`
    .nav-item:hover .dropdown reveals it on hover only; add :focus-within (or a click toggle) to the same rule.

#### atelier/runtime-ux/user-scalable-no
- Description: The viewport meta disables or caps pinch zoom (user-scalable=no or maximum-scale below 2), which fails WCAG 1.4.4 Resize Text.
- Confidence: high
- Help: https://www.w3.org/TR/WCAG22/#resize-text
- Instances (1):
  - `head > meta:nth-of-type(2)` at index.html:5:25: `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">`
    maximum-scale=1 blocks zooming to 200%; remove it.

#### atelier/runtime-ux/uses-vh-without-dvh
- Description: A full-height box is sized with 100vh and no dvh or svh fallback, so on phones it is taller than the visible viewport while the URL bar shows.
- Confidence: high
- Help: https://web.dev/blog/viewport-units
- Instances (1):
  - `.hero` at css/site.css:40:3: `.hero { min-height: 100vh }`
    min-height uses 100vh with no later dvh or svh declaration; add min-height: 100dvh (or svh) after it.

### Moderate (4)

#### atelier/runtime-ux/carousel-no-scroll-snap
- Description: A horizontal carousel scrolls freely without scroll-snap-type, or scroll-snap-align is set with no snap container, so swipes stop between slides.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_snap
- Instances (2):
  - `.product-carousel` at css/site.css:53:3: `.product-carousel { overflow-x: auto }`
    .product-carousel scrolls horizontally without scroll-snap-type; add scroll-snap-type: x mandatory and scroll-snap-align on the slides.
  - `.product-carousel .card` at css/site.css:59:3: `.product-carousel .card { scroll-snap-align: start }`
    scroll-snap-align is set but no rule sets scroll-snap-type, so nothing snaps.
    Confidence: high

#### atelier/runtime-ux/double-tap-js-override
- Description: Script fights the browser tap handling (a touchend double-tap timer with preventDefault, or FastClick) where touch-action: manipulation or a device-width viewport is enough.
- Confidence: medium
- Help: https://web.dev/articles/mobile-touch
- Instances (3):
  - `body > script:nth-of-type(1)` at index.html:69:11: `<script src="https://cdn.example.com/fastclick/1.0.6/fastclick.min.js">`
    FastClick removes a 300 ms delay that no current browser has with width=device-width, and breaks native taps; remove it.
  - `script[src="js/app.js"]` at js/app.js:22:1: `document.querySelector('.product-carousel').addEventListener('touchend', (e) => { const now = Date.now(); if (now - lastTap < 350) { e.preventDefault(); } la...`
    touchend handler cancels a second tap within 350 ms; use touch-action: manipulation instead of a script timer.
  - `script[src="js/app.js"]` at js/app.js:46:3: `FastClick.attach(document.body)`
    FastClick removes a 300 ms delay that no current browser has with width=device-width, and breaks native taps; remove it.

#### atelier/runtime-ux/modal-no-overscroll-behavior
- Description: A scrollable modal has no overscroll-behavior and the page has no body scroll lock, so scrolling past its end scrolls the page behind it.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior
- Instances (1):
  - `.modal` at css/site.css:77:3: `.modal { overflow-y: auto }`
    .modal scrolls but has no overscroll-behavior: contain and no body scroll lock was found.

#### atelier/runtime-ux/push-permission-no-display-mode-guard
- Description: Notification permission or a push subscription is requested without a display-mode: standalone check, but iOS offers web push only to Home Screen web apps.
- Confidence: medium
- Help: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Instances (2):
  - `script[src="js/app.js"]` at js/app.js:32:28: `Notification.requestPermission()`
    Notification.requestPermission() is not gated on matchMedia('(display-mode: standalone)') or navigator.standalone; on iOS, ask only inside the installed app.
  - `script[src="js/app.js"]` at js/app.js:35:11: `reg.pushManager.subscribe({ userVisibleOnly: true })`
    reg.pushManager.subscribe() is not gated on matchMedia('(display-mode: standalone)') or navigator.standalone; on iOS, ask only inside the installed app.

### Minor (4)

#### atelier/runtime-ux/fixed-header-vh-sized
- Description: A position: fixed or sticky element is sized in vh, which follows the large viewport on phones and overstates the visible area while browser toolbars show.
- Confidence: medium
- Help: https://web.dev/blog/viewport-units
- Instances (1):
  - `.site-header` at css/site.css:16:3: `.site-header { height: 8vh }`
    position: fixed element sized with height: 8vh; use svh or dvh.

#### atelier/runtime-ux/missing-interactive-widget
- Description: A fixed, bottom-anchored bar holds a text field but the viewport meta has no interactive-widget key, so the on-screen keyboard covers it in Chromium.
- Confidence: medium
- Help: https://developer.chrome.com/blog/viewport-resize-behavior
- Instances (1):
  - `.composer` at css/site.css:82:3: `.composer { position: fixed }`
    .composer is fixed at bottom 0 and holds body > form.composer > input; add interactive-widget=resizes-content to the viewport meta.

#### atelier/runtime-ux/pwa-no-apple-touch-icon
- Description: An installable page has no apple-touch-icon and no manifest icon of at least 180x180, so iOS adds it to the Home Screen with a blurry or screenshot icon.
- Confidence: medium
- Help: https://web.dev/articles/install-criteria
- Instances (1):
  - `head > link:nth-of-type(2)` at index.html:8:32: `<link rel="apple-touch-icon" href="icons/touch-120.png">`
    The largest apple-touch-icon is 120x120 and no manifest icon is 180x180 or larger; iOS needs 180x180.

#### atelier/runtime-ux/webkit-overflow-scrolling-touch
- Description: -webkit-overflow-scrolling: touch has been a no-op since iOS 13, where every overflow scroller already uses momentum scrolling.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-overflow-scrolling
- Instances (1):
  - `.product-carousel` at css/site.css:54:3: `.product-carousel { -webkit-overflow-scrolling: touch }`
    Remove it; iOS 13 and later ignore it.

## Needs review

None.

## Coverage

- Resources: 1 document, 1 stylesheet, 1 script, 1 manifest, 1 image parsed; skipped: https://cdn.example.com/fastclick/1.0.6/fastclick.min.js (cross-origin); failed: none
- Rules: 17 total; 14 failed, 0 incomplete, 2 passed, 0 not applicable, 1 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 1

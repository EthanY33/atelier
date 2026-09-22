# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static + dynamic (Chromium 153, Pixel 7, 4x CPU)
Total violations: 13 rules, 15 instances (critical: 0, serious: 3, moderate: 7, minor: 3)
Pass: no (0 critical, 3 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| INP | 0 | 3 | 7 | 3 | non-passive listeners 2, main-thread smells 6, long scripts 2, RUM gaps 2, INP est. 312 ms (budget 150 ms) |

## 1. INP

### Serious (3)

#### atelier/runtime-ux/inp-estimate-over-budget
- Description: The lab INP estimate (Event Timing, 4x CPU throttle, Pixel 7 profile) exceeds the INP budget from brand.json targets.inpBudgetMs or the 200 ms default.
- Confidence: medium
- Help: https://web.dev/articles/inp
- Instances (1):
  - `#feed > li.card:nth-of-type(1)` at (runtime): `pointerup 312 ms (input delay 18, processing 262, presentation 32)`
    INP estimate 312 ms exceeds the 150 ms budget (brand.json targets.inpBudgetMs). Most of it is handler time: split the work and yield.

#### atelier/runtime-ux/loaf-long-script
- Description: A script ran longer than 100 ms inside one long animation frame during the interaction probe, blocking input and rendering.
- Confidence: high
- Help: https://developer.chrome.com/docs/web-platform/long-animation-frames
- Instances (2):
  - `js/app.js` at js/app.js:16:36: `DOCUMENT.onclick 240 ms (forced style/layout 36 ms)`
    Script ran 240 ms in one frame during the interaction probe (limit 100 ms); split it and yield to the main thread.
  - `https://cdn.example.com/ads.js` at https://cdn.example.com/ads.js: `TimerHandler:setTimeout 118 ms (forced style/layout 0 ms)`
    tick() ran 118 ms in one frame during the interaction probe (limit 100 ms); split it and yield to the main thread.

#### atelier/runtime-ux/no-sync-xhr
- Description: A synchronous XMLHttpRequest blocks the main thread, and every pending input, for the whole network round trip.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:50:3: `xhr.open('GET', '/api/config.json', false)`
    XMLHttpRequest.open('GET', ..., false) is synchronous; use fetch() or an async XMLHttpRequest.

### Moderate (7)

#### atelier/runtime-ux/click-handler-forced-layout
- Description: An input handler writes styles or classes and then reads layout in the same task, forcing a synchronous style and layout pass.
- Confidence: medium
- Help: https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:20:16: `card.offsetHeight`
    click handler writes card.classList.add() and then reads offsetHeight, forcing a synchronous layout; read before writing, or move the read into requestAnimationFrame.

#### atelier/runtime-ux/framework-hydration-on-static-page
- Description: A framework hydration runtime ships with a page whose server-rendered body has no interactive elements, spending main-thread time for nothing.
- Confidence: low
- Help: https://qwik.dev/docs/concepts/resumable/
- Instances (1):
  - `#__NEXT_DATA__` at index.html:7:9: `<script id="__NEXT_DATA__" type="application/json">`
    Next.js hydration (script#__NEXT_DATA__) runs on a page with no interactive elements; ship static HTML, or hydrate only the widgets that need it.

#### atelier/runtime-ux/missing-content-visibility
- Description: A long list of repeated blocks sits mostly below the fold without content-visibility: auto, so every item pays style and layout cost up front.
- Confidence: medium
- Help: https://web.dev/articles/content-visibility
- Instances (1):
  - `#feed` at (runtime): `48 x li.card`
    40 of 48 li.card items start more than two viewports down; add content-visibility: auto with contain-intrinsic-size to skip their rendering.

#### atelier/runtime-ux/missing-webvitals-oninp
- Description: The page reports Core Web Vitals with web-vitals but never registers onINP, so field responsiveness is not measured.
- Confidence: high
- Help: https://www.npmjs.com/package/web-vitals
- Instances (1):
  - `script[src="js/vitals.js"]` at js/vitals.js:1:1: `import { onCLS, onLCP } from 'web-vitals';`
    web-vitals reports onCLS, onLCP but never onINP; add onINP (the attribution build also reports long animation frames).

#### atelier/runtime-ux/non-passive-scroll-listener
- Description: A touch or wheel listener that never cancels its event is registered without { passive: true }, so scrolling waits for it on the main thread.
- Confidence: high
- Help: https://developer.chrome.com/docs/lighthouse/best-practices/uses-passive-event-listeners
- Instances (2):
  - `script[src="js/app.js"]` at js/app.js:4:1: `carousel.addEventListener('touchmove', function (e) { carouselX = e.touches[0].clientX; })`
    touchmove listener on carousel never calls preventDefault(), so it can be passive; add { passive: true } to keep scrolling off the main thread.
  - `script[src="js/scroll.js"]` at js/scroll.js:29:1: `window.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false })`
    wheel listener on window sets { passive: false } but only cancels conditionally; every wheel scroll now waits for it. Attach it to the element that needs it.
    Confidence: medium

#### atelier/runtime-ux/scroll-listener-animates-transform
- Description: A scroll listener drives transform or opacity from JavaScript where a CSS scroll-driven animation could run off the main thread.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline
- Instances (1):
  - `script[src="js/scroll.js"]` at js/scroll.js:4:1: `window.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(updateHero); ticking = true; } }, { passive: true })`
    Scroll listener on window sets hero.style.transform on scroll; use animation-timeline: scroll() or view() and keep this code as a fallback behind CSS.supports().

#### atelier/runtime-ux/settimeout-zero-as-yield
- Description: setTimeout(fn, 0) is used to yield inside a loop; the continuation queues behind every other task instead of resuming first.
- Confidence: medium
- Help: https://developer.chrome.com/blog/use-scheduler-yield
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:35:36: `setTimeout(resolve, 0)`
    Awaiting a setTimeout(0) promise inside a loop yields without priority, so the loop resumes behind other tasks; prefer scheduler.yield() and keep this as the fallback.

### Minor (3)

#### atelier/runtime-ux/longtask-without-loaf
- Description: A PerformanceObserver watches longtask entries with no long-animation-frame observer, so slow frames are not attributed to scripts.
- Confidence: high
- Help: https://developer.chrome.com/docs/web-platform/long-animation-frames
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:62:1: `new PerformanceObserver(function (list) { report(list.getEntries()); }).observe({ type: 'longtask', buffered: true })`
    Observes 'longtask' only; also observe 'long-animation-frame' (LoAF), which names the scripts and forced layout behind slow frames.

#### atelier/runtime-ux/mouse-and-touch-pair
- Description: The same target listens to both mouse and touch events for one gesture; a single pointer event listener handles every input type once.
- Confidence: medium
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:8:1: `carousel.addEventListener('touchstart', onPress, { passive: true })`
    carousel listens to touchstart and mousedown; use one pointerdown or pointerup listener (or click) instead.

#### atelier/runtime-ux/requestidlecallback-no-timeout
- Description: requestIdleCallback is called without a timeout, so on a busy page the callback can be delayed indefinitely.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
- Instances (1):
  - `script:inline(1)` at index.html:25:3: `requestIdleCallback(sendLogs)`
    requestIdleCallback without { timeout } may never run while the page is busy; add { timeout } if the work is user-visible.

## Needs review

None.

## Coverage

- Resources: 1 document, 0 stylesheets, 4 scripts parsed; skipped: web-vitals (bare-specifier); failed: none
- Rules: 13 total; 13 failed, 0 incomplete, 0 passed, 0 not applicable, 0 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 0
- Dynamic findings reflect Chromium-only APIs.
- Probe errors: none

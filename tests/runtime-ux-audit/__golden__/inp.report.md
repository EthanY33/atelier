# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static
Total violations: 10 rules, 11 instances (critical: 0, serious: 1, moderate: 6, minor: 3)
Pass: no (0 critical, 1 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| INP | 0 | 1 | 6 | 3 | non-passive listeners 2, main-thread smells 6, long scripts 0, RUM gaps 2, INP est. n/a (static) |

## 1. INP

### Serious (1)

#### atelier/runtime-ux/no-sync-xhr
- Description: A synchronous XMLHttpRequest blocks the main thread, and every pending input, for the whole network round trip.
- Confidence: high
- Help: https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/open
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:50:3: `xhr.open('GET', '/api/config.json', false)`
    XMLHttpRequest.open('GET', ..., false) is synchronous; use fetch() or an async XMLHttpRequest.

### Moderate (6)

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
- Rules: 13 total; 10 failed, 0 incomplete, 0 passed, 0 not applicable, 3 skipped (dynamic only), 0 ignored, 0 errors
- Suppressed instances: 0

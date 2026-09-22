# Runtime-UX research — April 2026

**Context:** Atelier today (7 skills) addresses brand, asset, and WCAG-correctness
concerns. It does not address **runtime** UX quality: how transitions feel, how fast
input is acknowledged, how panels behave, and how the site reads on a phone. This
document is the research base for the next skill(s) to close that gap.

**Scope:** Four pain areas surfaced during goneidle.com build-out —

1. Seamless page / section transitions
2. Input latency (INP quality, not just TTI number)
3. Panel / surface design (popovers, dialogs, menus, tooltips)
4. Mobile-specific design

Each section is a 2026-current snapshot: state of the art, concrete techniques with
browser-support reality and graceful-degradation recipes, and anti-patterns an
automated auditor can detect. Sources cited inline.

---

## 1. Seamless page / section transitions

### State of the art

As of April 2026, the "seamless web navigation" stack has coalesced around three composable primitives: the **View Transitions API** for animated DOM/document swaps, the **Speculation Rules API** for prefetch/prerender of the next document, and **bfcache** for restoring prior documents instantly on back/forward. All three ship in Chromium (Chrome/Edge 126+). Safari 18.2 (Dec 2024) lit up both same- and cross-document view transitions [MDN: ViewTransition](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition). Firefox 144 (Oct 2025) shipped **same-document** (Level 1) only; cross-document is a 2026 Interop target, not yet implemented [Firefox 144 release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/144).

Speculation Rules remain a Chromium-only shipping feature; Safari 26.2 includes the implementation but disabled by default, Firefox has no signal [MDN: Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API). bfcache is universal (Chrome, Safari, Firefox), and Chrome 2025 rolled out bfcache for `Cache-Control: no-store` pages (3-minute retention, evicted on cookie change) closing the single biggest bfcache-miss source (~17% mobile, ~7% desktop navigations) [Chrome: bfcache CCNS](https://developer.chrome.com/docs/web-platform/bfcache-ccns).

Practically, the 2026 stance is: treat these as **progressive enhancement, cumulative**. Speculation-rules + bfcache together give sub-100ms back/forward and near-zero forward navigation in Chromium; View Transitions add the visual layer on top. Safari gets view transitions natively; Firefox still needs a same-document cross-fade fallback for MPA. Respecting `prefers-reduced-motion` is mandatory, not optional [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).

### Techniques

- **Same-document view transitions via `document.startViewTransition()`.** Wrap the DOM mutation: `document.startViewTransition(() => updateDOM())`. Browsers capture before/after snapshots and animate via `::view-transition-*` pseudo-elements [MDN: Using View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using). **Support floor:** Chrome 111+, Edge 111+, Safari 18+, Firefox 144+ [caniuse: View Transitions](https://caniuse.com/view-transitions). **Graceful degradation:** `if (!document.startViewTransition) { updateDOM(); return; }` — older browsers just swap instantly.

- **Cross-document view transitions via `@view-transition`.** Opt in on both pages: `@view-transition { navigation: auto; }` in CSS [MDN: @view-transition](https://developer.mozilla.org/en-US/docs/Web/CSS/@view-transition). Pair with `pageswap`/`pagereveal` events to customize. **Support floor:** Chrome 126+, Edge 126+, Safari 18.2+. **Unsupported as of 2026-04:** Firefox (Level 1 only). **Graceful degradation:** unsupported browsers do a plain navigation — no polyfill needed; the at-rule is ignored.

- **Per-element morphing with `view-transition-name`.** Assign a unique name to paired elements across states: `.hero { view-transition-name: hero; }`. Pairs matching names and animates position/size [MDN: view-transition-name](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name). Names must be globally unique per frame. **Dynamic pattern:** set `view-transition-name` inline via JS on the clicked card, clear it on `transition.finished`.

- **Nested view transition groups (fixes clipping).** As of Chrome shipping Mar 2025, `::view-transition-group-children(name)` lets children be clipped by their parent group; apply `overflow: clip` to contain bleed [Chrome Devs: nested groups](https://developer.chrome.com/docs/css-ui/view-transitions/nested-view-transition-groups). Without nesting, snapshots are flat siblings of `::view-transition` and ignore ancestor `overflow:hidden`.

- **Reduced-motion gate.** Wrap custom animations: `@media (prefers-reduced-motion: no-preference) { ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 250ms; } }`. The browser does **not** auto-disable view transitions on reduced-motion — you must scope the keyframes yourself [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion). **Fallback:** under reduced-motion, set `animation-duration: 0.001s` on the pseudos so the swap is effectively instant but still paired.

- **Speculation Rules: prerender with moderate eagerness.** Framework-agnostic:
  ```html
  <script type="speculationrules">
  { "prerender": [{ "where": { "href_matches": "/*" }, "eagerness": "moderate" }] }
  </script>
  ```
  `moderate` triggers on ~200ms hover/pointerdown; `conservative` waits for pointerdown only; `eager` fires on viewport intersection; `immediate` prerenders all matches [Chrome: speculation rules improvements](https://developer.chrome.com/blog/speculation-rules-improvements). **Support floor:** Chrome 109+ (prefetch), Chrome 121+ (prerender w/ eagerness). **Unsupported as of 2026-04:** Firefox (no signal), Safari (26.2 behind flag). **Graceful degradation:** non-supporting browsers ignore the script tag; no shim needed [MDN: speculationrules](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/speculationrules).

- **Same-site cross-origin prerender opt-in.** Default prerender is same-origin; same-site cross-origin requires the target to send `Supports-Loading-Mode: credentialed-prerender` HTTP header [Chrome: implementing speculation rules](https://developer.chrome.com/docs/web-platform/implementing-speculation-rules). Cross-**site** prerender is not permitted — only prefetch (and that requires no credentials).

- **Prerender-aware JS guard.** Use `document.prerendering` and `prerenderingchange` to defer analytics/ads until activation [MDN: Document.prerendering](https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering). Pattern:
  ```js
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', fireAnalytics, { once: true });
  } else { fireAnalytics(); }
  ```

- **bfcache-safe lifecycle events.** Use `pagehide`/`pageshow` (never `unload`): `addEventListener('pageshow', (e) => { if (e.persisted) /* restored from bfcache */ })`. On `pagehide`, close IndexedDB connections, release Web Locks, close BroadcastChannels [web.dev: bfcache](https://web.dev/articles/bfcache). **Support floor:** all evergreen browsers.

- **bfcache diagnostics via `notRestoredReasons`.** `performance.getEntriesByType('navigation')[0].notRestoredReasons` reports blocking reasons post-navigation [MDN: Monitoring bfcache](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Monitoring_bfcache_blocking_reasons). **Support floor:** Chrome 123+. DevTools: Application panel → Back/forward cache → "Test back/forward cache" button [Chrome: DevTools tips 29](https://developer.chrome.com/blog/devtools-tips-29).

- **`:active-view-transition` / `:active-view-transition-type()` gating.** CSS pseudo-classes to scope styles only during a transition, or by type passed to `startViewTransition({ update, types: ['slide-forward'] })` [CSS-Tricks: :active-view-transition-type()](https://css-tricks.com/almanac/pseudo-selectors/a/active-view-transition-type/). **Support floor:** Chrome 125+, Safari 18.2+; Firefox unsupported as of 2026-04.

- **React `<ViewTransition>` (framework-specific).** Only in React 19+ experimental/canary; wraps children and coordinates with React's scheduler [React: ViewTransition](https://react.dev/reference/react/ViewTransition). **Not** a polyfill — still requires browser support. Framework-agnostic fallback is `document.startViewTransition` directly.

### Anti-patterns to flag in an audit

- **Uses `window.onunload` or `window.addEventListener('unload', ...)`.** Blocks bfcache in all browsers; replace with `pagehide` [web.dev: bfcache](https://web.dev/articles/bfcache).
- **Sends `Cache-Control: no-store` without reviewing bfcache intent.** Still evicts from bfcache in Safari/Firefox and non-updated Chrome; if session privacy isn't the concern, prefer `no-cache` or `private, max-age=0` [Chrome: bfcache CCNS](https://developer.chrome.com/docs/web-platform/bfcache-ccns).
- **Leaves IndexedDB transactions, Web Locks, or `BroadcastChannel` open past `pagehide`.** Held locks are a documented bfcache eviction reason [web.dev: bfcache](https://web.dev/articles/bfcache).
- **Uses `beforeunload` non-conditionally (always attached).** Blocks bfcache in Firefox/Safari; should be attached only when dirty state exists and removed on save.
- **Applies `transform` / `filter` / `opacity < 1` / `will-change: transform` to `:root` or `html`.** Root creates a snapshot; promoted root breaks the implicit `::view-transition-group(root)` animation and causes visual glitches [MDN: Using View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using).
- **Duplicate `view-transition-name` values in the captured tree.** Spec error — transition is aborted and `updateCallback` still runs without animation [MDN: view-transition-name](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name).
- **`view-transition-name` set on a `display: contents` element.** No box generated, so no snapshot captured; name is ignored silently.
- **Relies on parent `overflow: hidden`/`clip` to mask a transitioning child without nested groups.** Snapshots are siblings of `::view-transition`, so the child escapes the clip; use `::view-transition-group-children` + `overflow: clip` [Chrome: nested groups](https://developer.chrome.com/docs/css-ui/view-transitions/nested-view-transition-groups).
- **Calls `startViewTransition()` without a feature check.** Throws in Firefox <144 and Safari <18; always guard `if ('startViewTransition' in document)`.
- **Defines `@view-transition { navigation: auto }` without a reduced-motion override.** View Transitions do not auto-disable on `prefers-reduced-motion`; audit for an accompanying `@media (prefers-reduced-motion: reduce)` block that shortens or no-ops `::view-transition-old/new` animations [MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).
- **Analytics/GA/ad pixels fire at top-level script evaluation without `document.prerendering` guard.** Double-counts page views on Chromium prerender [MDN: Document.prerendering](https://developer.mozilla.org/en-US/docs/Web/API/Document/prerendering).
- **Speculation rules use `"eagerness": "immediate"` on a list page with >10 candidate links.** Memory/bandwidth abuse; prerender cap is 10 same-origin + 2 cross-site in Chromium. Use `moderate` or `conservative` [Chrome: speculation rules improvements](https://developer.chrome.com/blog/speculation-rules-improvements).
- **CSP `script-src` without `'inline-speculation-rules'` source expression.** Inline `<script type="speculationrules">` is blocked under strict CSP unless `'inline-speculation-rules'` or a matching hash/nonce is present [MDN: Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API).
- **Cross-origin prerender target without `Supports-Loading-Mode: credentialed-prerender` header.** Silently downgrades to prefetch or no-op [Chrome: implementing speculation rules](https://developer.chrome.com/docs/web-platform/implementing-speculation-rules).
- **Uses `document.write`, `window.opener` links without `rel="noopener"`, or top-level `window.open` during page load.** All documented bfcache blockers in Chromium's `notRestoredReasons` taxonomy [Chrome: notRestoredReasons](https://developer.chrome.com/docs/web-platform/bfcache-notrestoredreasons/).
- **Assumes view-transition `z-index` inherits DOM order.** Each `view-transition-name` creates its own stacking context flat at the pseudo-tree root; siblings no longer stack by parent [Nic Chan: view transitions stacking context](https://www.nicchan.me/blog/view-transitions-and-stacking-context/). Audit should flag nested-card transitions without explicit `z-index` on pseudo groups.
- **No `:active-view-transition-type()` scoping when multiple transition flavors share a page.** Keyframes leak across navigations (back vs forward look identical) [CSS-Tricks: :active-view-transition-type()](https://css-tricks.com/almanac/pseudo-selectors/a/active-view-transition-type/).

---

## 2. Input latency (INP)

### State of the art

As of April 2026, **Interaction to Next Paint (INP)** is the Core Web Vitals responsiveness metric, having replaced First Input Delay in March 2024. The passing threshold is **p75 ≤ 200 ms** across the full page lifecycle — "needs improvement" is 200–500 ms, "poor" is >500 ms ([web.dev/inp](https://web.dev/articles/inp), [web.dev launch post](https://web.dev/blog/inp-cwv-launch)). INP measures the worst (roughly) interaction on a page and breaks end-to-end latency into three sub-parts: **input delay** (time until the event handler can run — dominated by other main-thread work), **processing time** (the handler itself plus any synchronous work it triggers), and **presentation delay** (style/layout/paint to show the next frame). The 2025 Web Almanac puts the global mobile pass rate around 77%, with mobile p75 (~131 ms) still ~2.8× worse than desktop (~48 ms), so the metric is gated by mid-tier Android.

The practical playbook has converged on three ideas: **yield the main thread on a 50 ms cadence** during any JS work triggered by an interaction; **defer non-urgent work** (telemetry, prefetch, analytics) via prioritized scheduling instead of `setTimeout(0)`; and **move as much animation off JS** as possible via CSS scroll-driven animations and `content-visibility`. Chromium 129+ ships `scheduler.yield()` which — unlike `setTimeout(0)` — resumes in a *prioritized continuation* ahead of other posted tasks, making chunked work safe to interleave with user input ([Chrome for Developers](https://developer.chrome.com/blog/use-scheduler-yield)). The **Long Animation Frames (LoAF) API** (Chrome 123+, still Chromium-only) replaces the older Long Tasks API for attribution — it reports scripts, style/layout, and render blocking time per frame ([MDN LoAF](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing), [chrome.com](https://developer.chrome.com/docs/web-platform/long-animation-frames)).

For static-first sites, the dominant 2026 stance is "ship no framework runtime unless you need one." **Islands** (Astro) and **resumability** (Qwik) both exist to avoid full-page hydration — but a vanilla-HTML site typically needs neither; lazy-loaded ES modules per interactive widget ship less code than either approach ([Qwik resumable](https://qwik.dev/docs/concepts/resumable/)). Measurement is standardized on **web-vitals v5** (`onINP` with LoAF attribution) in the field, **Chrome DevTools → Performance → Insights** ("LCP → INP → CLS" breakdown with sub-part timing) for labs, and **CrUX** for the 28-day p75 that Search uses ([web-vitals CHANGELOG](https://github.com/GoogleChrome/web-vitals/blob/main/CHANGELOG.md), [DevTools Performance](https://developer.chrome.com/docs/devtools/performance/reference)).

### Techniques

- **Yield on a 50 ms budget with `scheduler.yield()` fallback chain.** Wrap hot loops:
  ```js
  const yieldToMain = () =>
    'scheduler' in window && 'yield' in scheduler
      ? scheduler.yield()
      : new Promise(r => setTimeout(r, 0));
  let last = performance.now();
  for (const item of items) {
    process(item);
    if (performance.now() - last > 50) { await yieldToMain(); last = performance.now(); }
  }
  ```
  Use whenever a handler may exceed 50 ms. `scheduler.yield()` is Chromium 129+ (Sep 2024), not yet Baseline — fallback via `setTimeout` is correct but loses continuation priority ([chrome.com](https://developer.chrome.com/blog/use-scheduler-yield)). Cost: async rewrite, slightly higher total wall-clock.

- **Prioritize deferred work with `scheduler.postTask()`.** `scheduler.postTask(fn, { priority: 'user-blocking' | 'user-visible' | 'background' })`. Use `background` for analytics/logging, `user-visible` for non-critical UI updates, `user-blocking` only for input responses ([MDN postTask](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask)). Chromium-only (115+); polyfill or feature-detect. Cost: still Chromium-only, so Safari/Firefox fall through to `setTimeout`.

- **Check `navigator.scheduling.isInputPending()` before committing work.** `if (navigator.scheduling?.isInputPending()) await yieldToMain();` inside synchronous loops ([chrome.com](https://developer.chrome.com/docs/capabilities/web-apis/isinputpending)). Chromium 87+. Cost: Chromium-only; noisy — combine with a time budget.

- **`requestIdleCallback(cb, { timeout })` for truly idle work.** Cache warming, log flushing. Never for anything the user is waiting on — callbacks may be delayed minutes on a busy page ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)). Widely supported except Safari until 17.4; provide a timeout.

- **Diagnose with the LoAF API in production RUM.**
  ```js
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.duration > 150) reportLoAF(e);
  }).observe({ type: 'long-animation-frame', buffered: true });
  ```
  Each entry exposes `.scripts[]` with `invoker`, `sourceURL`, and `forcedStyleAndLayoutDuration` — enough to attribute INP regressions to a file ([chrome.com](https://developer.chrome.com/docs/web-platform/long-animation-frames)). Chromium 123+.

- **Passive listeners for any scroll-adjacent input.** `el.addEventListener('touchstart', fn, { passive: true })`. Required on `wheel`, `touchstart`, `touchmove`; Chrome/Safari/Edge already default these to passive on the root, so `preventDefault()` silently fails — explicitly pass `{ passive: false }` if you need it ([Lighthouse](https://developer.chrome.com/docs/lighthouse/best-practices/uses-passive-event-listeners)). Cost: can't cancel the gesture.

- **Prefer pointer events over mouse+touch pairs.** Single `pointerdown`/`pointerup` handler instead of both, eliminating double work and simulated-mouse latency after touch ([MDN Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)). Universal support.

- **rAF-batching for DOM writes; debounce for "wait till idle"; throttle for "bounded rate".** Inside a scroll handler: read layout, then `requestAnimationFrame(() => writeDom())` — coalesces N events into 1 paint. Debounce (`trailing`) for search-as-you-type. Throttle for progress indicators. Wrong pattern: debouncing a scroll handler that updates a sticky header (feels laggy) or rAF-batching a network request (no benefit).

- **`content-visibility: auto` on long offscreen lists.** `.card { content-visibility: auto; contain-intrinsic-size: auto 320px; }` skips render/layout for offscreen subtrees. Baseline Newly Available since Sept 2024 (Chrome 85, Safari 18, Firefox 125) ([web.dev](https://web.dev/blog/css-content-visibility-baseline), [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)). Cost: `contain-intrinsic-size` needed or CLS goes up; breaks in-page search for hidden content.

- **Scroll-driven animation via `animation-timeline`, not scroll handlers.**
  ```css
  @supports (animation-timeline: view()) {
    .reveal { animation: fade linear both; animation-timeline: view(); animation-range: entry 0% cover 30%; }
  }
  ```
  Runs on the compositor, zero main-thread cost. Chromium 115+, Safari 26+, Firefox behind flag — not yet Baseline, so gate with `@supports` and fall back to IntersectionObserver ([MDN scroll-timeline](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-timeline)).

- **Islands for interactive widgets on otherwise-static pages.** Astro-style: ship HTML for the whole page, hydrate only `<client-island>` boundaries on visibility or interaction. For vanilla sites, the DIY equivalent is a `<script type="module">` that imports a widget only after `IntersectionObserver` fires. Cost: SSR+hydration frameworks (Next/Nuxt/SvelteKit full-hydration) are *premature* for a mostly-static site — prefer lazy ESM.

- **Resumability (Qwik) for complex apps that must not replay on the client.** Serializes listener closures into HTML (`q:on=...`) and downloads handler code only on the interaction that triggers it ([Qwik docs](https://qwik.dev/docs/concepts/resumable/)). Cost: Qwik-specific authoring model; overkill for brochureware.

- **React-only note:** `startTransition`/`useDeferredValue` split renders into "urgent" and "transition" buckets in React 18+; `use()` + Suspense streams from RSC in 19+. Not applicable to vanilla/non-React sites — don't flag their absence outside a React codebase.

- **RUM via `PerformanceObserver('event')` + `interactionId`.**
  ```js
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) if (e.interactionId) report(e);
  }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
  ```
  Group by `interactionId` to reconstruct full interactions; web-vitals v5 `onINP` does this plus LoAF attribution out of the box ([MDN interactionId](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming/interactionId), [Event Timing spec](https://www.w3.org/TR/event-timing/)).

### Anti-patterns to flag in an audit

- **Non-passive `scroll`, `wheel`, `touchstart`, or `touchmove` listener on `window` or `document`** — block scrolling until JS runs. Detect: `addEventListener('touchstart', ...)` with no options object or `{ passive: false }`.
- **`setTimeout(fn, 0)` used as a "yielding" primitive in a hot loop.** Fires after all other queued tasks (including lower-priority ones); no continuation priority. Replace with `scheduler.yield()` + fallback ([chrome.com](https://developer.chrome.com/blog/use-scheduler-yield)).
- **Synchronous `JSON.parse` of >10 KB inside a click/input handler.** Parse cost is main-thread; move to a Worker or stream with `Response.json()` off an async boundary.
- **`document.addEventListener('click', bigHandler)` without a time budget.** If the handler does >50 ms of work, INP regresses even with a fast paint. Audit rule: any event handler whose static analysis call graph reaches a loop over `document.querySelectorAll('*')`, a sync `localStorage.setItem` of a serialized tree, or a sync DOMParser call.
- **Scroll handler that reads `offsetTop`/`getBoundingClientRect` then writes styles directly** — forced sync layout per event. Fix: cache reads, apply writes inside `requestAnimationFrame`.
- **`mousedown` + `touchstart` listeners side-by-side.** Use a single `pointerdown`.
- **Full-framework hydration (React/Vue/Svelte SSR) on a mostly-static marketing page.** Flag if >80% of routes have zero interactive components but the bundle includes a hydration runtime. Recommend islands or plain ESM.
- **`requestIdleCallback` without a `timeout` option for user-perceivable work** — may never fire under load.
- **Input handler that synchronously awaits `fetch()` before painting feedback.** The UI should paint an optimistic state first (e.g., spinner, disabled button) *inside the same task* as the input, then `await` in a continuation.
- **Long offscreen lists (>20 items, >2× viewport) without `content-visibility: auto` or virtualization.** Each item pays layout/paint on every scroll/resize.
- **Scroll-linked animation implemented with `scroll` listener + `transform` writes** when `animation-timeline: scroll()` or `view()` would do the same on the compositor ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-timeline)).
- **Debounced typeahead with >300 ms delay on desktop** — feels broken; 120–200 ms is the sweet spot. Conversely, throttled scroll handler firing >60 Hz — wasted work.
- **`for…of` loop over >1000 DOM nodes inside a handler with no yield.** Even a cheap per-item op (e.g., reading `dataset`) blows the 50 ms budget at ~5k items on mid-tier mobile.
- **Analytics beacons sent via synchronous `XMLHttpRequest` or blocking `fetch` in a `click` handler** — use `navigator.sendBeacon` or `fetch(url, { keepalive: true })` in `scheduler.postTask({ priority: 'background' })`.
- **No `onINP`/LoAF reporting in production.** If the site ships RUM for LCP/CLS but not INP, the audit cannot correlate regressions. Require `web-vitals` v5 `onINP` ([web-vitals v5](https://www.npmjs.com/package/web-vitals)).
- **Relying on `Long Tasks API` (`longtask`) alone for attribution** — superseded by LoAF, which also reports rendering sub-parts. Flag `PerformanceObserver({ type: 'longtask' })` without an accompanying `long-animation-frame` observer on Chromium.

---

## 3. Panel / surface design

### State of the art

As of April 2026, panel/surface design on the web has crossed a threshold: the stack of 2020-era workarounds (portal divs, z-index wars, custom focus traps, JS-driven positioning) is now replaceable by three interlocking platform primitives — the **Popover API**, the **`<dialog>` element**, and **CSS Anchor Positioning**. Chrome/Edge 125+ and Safari 26 (shipped autumn 2025) support all three; Firefox shipped Popover API and `<dialog>` in 125, and anchor positioning landed in Firefox 131 behind a default-on flag through 2025 before becoming unflagged in 134 (early 2026). The result is that a menu, tooltip, combobox popup, or non-modal panel can now be written with ~10 lines of HTML+CSS, with the browser handling top-layer promotion, light dismiss, focus return, and viewport-edge flipping.

The cultural shift: **"panel" is no longer a CSS problem, it's a semantics problem**. Pick the right primitive (`popover=auto` for menus/tooltips, `popover=manual` for toasts/teaching callouts, `<dialog>` + `showModal()` for blocking flows) and you inherit correct stacking, keyboard, and dismissal behavior. Floating UI ([floating-ui.com](https://floating-ui.com)) has repositioned itself as a **positioning-only** library and ships an [anchor-positioning polyfill](https://github.com/oddbird/css-anchor-positioning) (OddBird) that the team actively maintains — warranted when your support matrix includes Safari <26, Firefox <131, or WebViews older than ~12 months. For greenfield work targeting evergreen 2026 browsers, a library is no longer required; for design-system work spanning older enterprise browsers, Floating UI + the OddBird polyfill is still the pragmatic choice.

Motion and a11y are the remaining hand-authored layers. `@starting-style` + `transition-behavior: allow-discrete` ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@starting-style)) finally lets panels animate from `display: none` without JS, and Material 3's motion tokens ([m3.material.io/styles/motion](https://m3.material.io/styles/motion/overview)) plus iOS 17+ UIKit spring curves (`response`/`dampingFraction`) are the de facto reference for timing. ARIA 1.3 ([W3C](https://www.w3.org/TR/wai-aria-1.3/)) is CR as of Q1 2026 and tightens the combobox and menu patterns; the APG ([w3.org/WAI/ARIA/apg](https://www.w3.org/WAI/ARIA/apg/)) remains the canonical keyboard-contract source.

### Techniques

- **Native popover (menus, tooltips, non-blocking panels)** — `<button popovertarget="menu">Open</button><div id="menu" popover>…</div>`. `popover="auto"` (default) gives light-dismiss on outside click/Escape, auto-stacking via top layer, and one-at-a-time behavior per ancestor chain; `popover="manual"` disables light dismiss (use for toasts, teaching UI). Shipping: Chrome 114+, Safari 17+, Firefox 125+ ([MDN Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API)). **Degradation**: feature-detect with `HTMLElement.prototype.hasOwnProperty('popover')`; fall back to a focus-managed `<div>` with JS outside-click handler. No React hook needed — works in JSX as `popover="auto"` (React 19+; for React 18, spread via `{...{popover:'auto'}}`).

- **CSS Anchor Positioning** — pair a trigger and panel without JS:
  ```css
  .trigger { anchor-name: --t; }
  .panel {
    position: absolute;
    position-anchor: --t;
    position-area: block-end span-inline-end;
    position-try-fallbacks: flip-block, flip-inline, --shift;
  }
  @position-try --shift { position-area: block-end center; }
  ```
  Shipping: Chrome/Edge 125+, Safari 26 (Sep 2025), Firefox 134 (Jan 2026) — [CSS WG Anchor Positioning](https://drafts.csswg.org/css-anchor-position-1/), [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning). **Degradation**: `@supports (anchor-name: --x) { … }` else load OddBird [css-anchor-positioning polyfill](https://github.com/oddbird/css-anchor-positioning) (~12kB) or Floating UI's `computePosition` with `flip`/`shift` middleware. Note `position-area` replaced the earlier `inset-area` name in the spec and in shipped browsers as of late 2024 — older tutorials using `inset-area` are stale.

- **Modal `<dialog>`** — `dialog.showModal()` promotes to top layer, applies `inert` to everything else, traps focus, and enables Escape-to-close. `closedby="any|closerequest|none"` attribute ([WHATWG HTML PR](https://html.spec.whatwg.org/multipage/interactive-elements.html#attr-dialog-closedby)) shipped Chrome 134 (Feb 2025), Safari 26, Firefox 136 — lets you opt into light-dismiss on non-modal dialogs. **Focus restore**: the browser returns focus to the invoking element automatically *only if* you opened via `<button>` click in the same task; restore manually if opened programmatically by stashing `document.activeElement` before `showModal()` and calling `.focus()` on it in the `close` event.

- **Non-modal `<dialog>` vs `popover`** — both stay in flow (non-modal dialog) or promote to top layer (popover). Rule of thumb: use `<dialog>` when the surface is a discrete "view" the user accepts/dismisses with a clear outcome; use `popover` for transient surfaces anchored to a trigger (menus, combobox listboxes, tooltips).

- **Backdrop styling** — `dialog::backdrop { background: color-mix(in oklab, black 50%, transparent); }` and `[popover]::backdrop` work identically. Animate with `@starting-style`. ([MDN ::backdrop](https://developer.mozilla.org/en-US/docs/Web/CSS/::backdrop)).

- **Discrete-property transitions for enter/exit**:
  ```css
  [popover] {
    opacity: 0; translate: 0 -4px;
    transition: opacity .18s, translate .18s, overlay .18s allow-discrete, display .18s allow-discrete;
  }
  [popover]:popover-open { opacity: 1; translate: 0 0; }
  @starting-style { [popover]:popover-open { opacity: 0; translate: 0 -4px; } }
  ```
  `transition-behavior: allow-discrete` is required to animate `display` and `overlay`. Shipping: Chrome 117+, Safari 17.4+, Firefox 129+ ([web.dev: four new CSS features for smooth entry/exit animations](https://web.dev/articles/entry-exit-animations)). **Degradation**: without support, the panel snaps; acceptable.

- **Motion tokens** — Material 3 emphasized/standard easing (`cubic-bezier(0.2, 0, 0, 1)` standard, `cubic-bezier(0.3, 0, 0, 1)` emphasized) for panels; durations 200ms (small/tooltip) → 300ms (dialog) → 400ms (full-screen sheet). iOS spring: `linear(…)` easing generator or the [Linear() CSS function](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear) (shipping everywhere as of 2025) to approximate `spring(response: 0.35, damping: 0.8)`. **Enter/exit asymmetry**: exit ~0.7× enter duration; never cross-fade slower going out than coming in.

- **Reduced motion** — wrap all panel transitions in `@media (prefers-reduced-motion: no-preference)`; provide instantaneous state change otherwise. Do **not** merely shorten duration; kill translate/scale transforms entirely, keep opacity if needed.

- **`inert` for bespoke modality** — `inert` attribute ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/inert)) on the main-content sibling when you build a modal *without* `<dialog>` (e.g., a route-level modal in an SPA). Shipping everywhere 2022+. Redundant with `dialog.showModal()` — do not double up; `<dialog>` already inerts siblings.

- **Top layer over z-index** — any element in the top layer (via `popover`, `showModal()`, or fullscreen) paints above all stacking contexts in the normal tree regardless of z-index. Audit rule: if your design system has `--z-modal: 9999`, the system predates 2024. ([CSS WG top layer](https://drafts.csswg.org/css-position-4/#top-layer)).

- **ARIA patterns (APG 1.3)**:
  - **Tooltip** — `role="tooltip"` on panel; `aria-describedby` from trigger; *no focus*; Escape dismisses when trigger is focused. Prefer `popover="manual"` to avoid light-dismiss stealing pointer events. ([APG Tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/))
  - **Menu** — `role="menu"` + `role="menuitem"`; roving tabindex or `aria-activedescendant`; arrow keys navigate, Home/End jump, typeahead, Escape closes and returns focus to trigger. ([APG Menu](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/))
  - **Dialog** — `<dialog>` auto-supplies `role="dialog"` + `aria-modal="true"` for `showModal()`; you must supply `aria-labelledby` (pointing to the title) or `aria-label`. ([APG Modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/))
  - **Combobox (ARIA 1.2+)** — input has `role="combobox"`, `aria-expanded`, `aria-controls` → listbox id, `aria-activedescendant` → focused option id. Popup is `role="listbox"` with `role="option"` children. Do **not** move DOM focus into the listbox. ([APG Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/))

- **Focus restore (programmatic opens)** — stash `const opener = document.activeElement` before opening; on `close`/`toggle→closed` event, call `opener?.focus({ preventScroll: true })`. Framework-agnostic; in React, use a ref captured in a `useEffect` on open.

### Anti-patterns to flag in an audit

- **`z-index >= 1000` on any panel-like element** — very likely replaceable by `popover` or `dialog.showModal()`. Flag any declared z-index above the design-system modal token; flag literal `9999`, `99999`, `2147483647`.
- **`position: fixed` + JS viewport math on a dropdown/menu** — replace with `position-anchor` + `position-try-fallbacks`. Detect: element with `position: fixed`, `top`/`left` set via inline style that changes on scroll/resize listeners.
- **`<div role="dialog">` when a native `<dialog>` would do** — flag if the element is modal-like (has backdrop sibling) and is not `<dialog>`. Allow opt-out via data attribute for legacy.
- **`<dialog>` without `aria-labelledby` or `aria-label`** — AT will announce "dialog" with no name. Flag any `<dialog>` missing both.
- **Dialog/popover with focus-trap library loaded** — `focus-trap`, `react-focus-lock` on a native `<dialog open modal>` is redundant; flag the import.
- **Outside-click handlers on `popover="auto"` elements** — light dismiss is native; custom handler will double-fire or race. Flag document-level `click`/`pointerdown` listeners near a `[popover]` element.
- **Custom Escape-key handlers on `<dialog>` or `[popover]`** — native handling exists; custom listeners cause double-close or interfere with `closedby`.
- **Tooltip that receives DOM focus** — APG violation. Flag `role="tooltip"` elements with `tabindex="0"` or that are focused programmatically.
- **Menu using `<div>` + `onClick` with no arrow-key handling** — flag `role="menu"` without `keydown` handling for `ArrowUp`/`ArrowDown`/`Home`/`End`/`Escape`.
- **Combobox moving focus into listbox** — flag `role="combobox"` inputs whose associated listbox receives focus on open; should use `aria-activedescendant`.
- **No `@starting-style` on transitioned popover/dialog** — panel snaps in, animates out (or vice versa). Flag any `[popover]`/`dialog` with `transition` declared but no `@starting-style` rule.
- **`transition: all` on a popover** — layout thrash; top-layer promotion animates unpredictably. Flag.
- **Motion without `prefers-reduced-motion` guard** — any `transition` or `animation` on panel open/close not wrapped in `@media (prefers-reduced-motion: no-preference)`.
- **Enter/exit symmetric or inverted** — exit duration equal to or longer than enter. Flag computed exit > enter.
- **Backdrop as a sibling `<div>` instead of `::backdrop`** — duplicates top-layer behavior in the normal tree, causes stacking issues. Flag `.backdrop`/`.overlay` siblings of modal containers.
- **`inert` applied simultaneously with `dialog.showModal()`** — redundant; indicates misunderstanding. Flag `inert` on `<body>` or main landmarks while a modal dialog is open.
- **Focus lost on close** — opener not refocused. Auditable dynamically: record `document.activeElement` before open; after close, if it's `<body>`, flag.
- **`anchor-name` used without `@supports` or polyfill** — will silently fail in Safari <26 / Firefox <134. Flag `anchor-name`/`position-anchor` declarations not inside `@supports (anchor-name: --x)` when build target includes those versions.
- **Stale `inset-area` keyword** — renamed to `position-area`. Flag any `inset-area` declaration.
- **Fixed-pixel `max-height` on panels without `overflow: auto`** — content clipping on small viewports. Prefer `max-block-size: min(40rem, 80dvb)` with `overflow: auto`.
- **Dialog `closedby="any"` on destructive confirmations** — light-dismiss of a "Delete account?" dialog is a footgun. Flag destructive-intent dialogs with `closedby` other than `none` or `closerequest`.

---

## 4. Mobile-specific design

### State of the art

As of April 2026, mobile web design has consolidated around three platform-driven shifts: **dynamic viewport units are the default** (iOS Safari 15.4+, Chrome Android 108+ ship `dvh`/`svh`/`lvh`/`dvi`/`dvb`), **WCAG 2.2 Success Criterion 2.5.8 Target Size (Minimum)** is an enforceable Level AA requirement (W3C Recommendation, October 2023) that procurement and accessibility audits now flag, and **the iOS/Safari PWA gap has narrowed but not closed** — Web Push on iOS requires 16.4+ and only for home-screen-installed PWAs, and the EU-only third-party-browser-engine carve-out has stabilized without meaningfully changing authoring guidance. See [MDN: viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#viewport-dependent_lengths), [WCAG 2.2 SC 2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum), [Apple: Web Push on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

The practical baseline for a new mobile layout in 2026 is: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">`, layout heights in `dvh`/`svh` rather than `vh`, `env(safe-area-inset-*)` padding on any fixed/sticky chrome, every interactive element at least 24×24 CSS px (ideally 44×44 per [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility#Interaction) or 48×48 per [Material 3](https://m3.material.io/foundations/designing/structure)), `touch-action: manipulation` on tappables to kill the legacy 300 ms delay, and passive touch/wheel listeners by default. Scroll-hijacking and long-press/double-tap overrides are now actively penalized in Core Web Vitals' INP metric (became a Core Web Vital March 2024) and in Lighthouse audits.

The `interactive-widget` viewport key (Chrome 108+, Safari 16.4+ ships `resizes-content` semantics via `dvh`) finally gives authors a declarative way to choose between the old "resize the layout viewport when the soft keyboard opens" behavior and the new "overlay-only" behavior — critical for chat UIs and bottom-anchored CTAs. See [web.dev: The large, small, and dynamic viewport units](https://web.dev/blog/viewport-units) and [Chrome: interactive-widget](https://developer.chrome.com/blog/viewport-resize-behavior).

### Techniques

- **Viewport-fit=cover + safe-area insets.** Pattern: `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`, then `padding: max(12px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));` on fixed bottom nav / headers / modal sheets. Support: iOS Safari 11.2+, Chrome Android 69+, all current evergreens. Graceful degradation: the `env()` fallback value (second arg) is used where unsupported; on non-notched devices the insets resolve to `0`. [MDN: env()](https://developer.mozilla.org/en-US/docs/Web/CSS/env).

- **Dynamic viewport units (`dvh`/`svh`/`lvh`).** Pattern: hero section uses `min-height: 100svh` (won't jump when URL bar hides), fullscreen modal uses `height: 100dvh` (tracks the current viewport), splash uses `100lvh` only if you want the largest possible. Support: iOS Safari 15.4+ (March 2022), Chrome/Edge 108+, Firefox 101+. Graceful degradation: `height: 100vh; height: 100dvh;` — the second declaration is ignored in older browsers and `vh` remains as fallback. [MDN: viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#dvh).

- **Keyboard avoidance via `interactive-widget`.** Pattern: add `interactive-widget=resizes-content` to the viewport meta so the layout viewport shrinks when the virtual keyboard opens (best for chat/forms). Use `overlays-content` if you want the keyboard to float over your UI (best for full-bleed maps/video). Support: Chrome Android 108+; Safari 16.4+ gives equivalent behavior through `dvh` updating as the keyboard appears. Graceful degradation: pair with `100dvh` so Safari still reflows. [Chrome docs](https://developer.chrome.com/blog/viewport-resize-behavior), [MDN VirtualKeyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API).

- **WCAG 2.2 target-size minimum.** Pattern: every `<button>`, link-as-button, icon toggle is ≥ 24×24 CSS px with ≥ 24 px center-to-center spacing; prefer 44×44 (iOS) or 48×48 (Material) for primary actions. Use `min-block-size: 44px; min-inline-size: 44px;` with `padding` expanding the hit area beyond the visual glyph, or an invisible `::before` that extends the pointer area. Support: universal. Graceful degradation: N/A — this is a layout rule. [WCAG 2.2 SC 2.5.8](https://www.w3.org/TR/WCAG22/#target-size-minimum), [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Material 3 accessibility](https://m3.material.io/foundations/accessible-design/accessibility-basics).

- **Thumb-zone placement.** Pattern: primary actions live in the bottom third of the screen within a ~70 mm thumb arc from the bottom corners; avoid top-right icons for destructive/primary actions (Luke Wroblewski's thumb-map research, still the dominant heuristic). Bottom sheets with a drag handle (`touch-action: none` on the handle, `pan-y` on the content) outperform top-anchored modals on phones >6". Graceful degradation: on tablet/landscape, switch to a sidebar via `@media (min-width: 900px) and (orientation: landscape)`. [LukeW: Responsive Navigation](https://www.lukew.com/ff/entry.asp?1649).

- **`touch-action` for gesture intent.** Pattern: `touch-action: manipulation` on all buttons/links (kills double-tap-zoom delay), `touch-action: pan-y` on vertically-scrolling lists inside a horizontal carousel, `touch-action: none` only on drag handles / custom gesture surfaces. Support: iOS Safari 13+, Chrome Android 55+. Graceful degradation: without it, you lose the fast-tap hint but nothing breaks. [MDN: touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action).

- **Passive listeners.** Pattern: `el.addEventListener('touchstart', fn, { passive: true })` and `{ passive: true }` on `wheel`/`touchmove` unless you truly must `preventDefault()`. Chrome Android and Safari have defaulted `touchstart`/`touchmove` on `window`/`document`/`body` to passive since 2017/2018; explicit `passive: true` still matters on nested scrollers. Graceful degradation: older browsers ignore the options object; feature-detect via the standard `try { addEventListener('t', null, { get passive(){ passiveSupported = true; }}) } catch {}` probe. [web.dev: Improve scrolling performance with passive listeners](https://web.dev/articles/uses-passive-event-listeners).

- **`overscroll-behavior` to contain rubber-banding / pull-to-refresh.** Pattern: `overscroll-behavior: contain` on modals and infinite-scroll containers prevents scroll chaining to the document; `overscroll-behavior-y: none` on the `<html>` element disables Chrome's pull-to-refresh when you have a custom one. Support: iOS Safari 16+, Chrome Android 63+. Graceful degradation: ignored silently; only cost is occasional scroll chaining. [MDN: overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior).

- **Pointer Events for drag/swipe.** Pattern: use `pointerdown`/`pointermove`/`pointerup` + `element.setPointerCapture(e.pointerId)` instead of separate touch/mouse handlers; check `e.pointerType === 'touch'` when you need to branch. Support: universal since iOS Safari 13 (2019). Graceful degradation: pointer events are the only modern path — legacy fallback to mouse/touch pairs is no longer warranted in 2026. [MDN: Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events).

- **CSS Scroll Snap for carousels.** Pattern: container `scroll-snap-type: x mandatory; overflow-x: auto; scrollbar-width: none;` with children `scroll-snap-align: center;` and `scroll-snap-stop: always;` to prevent flicking past multiple slides. Pair with `scroll-padding-inline: 16px;` for edge preview. Support: iOS Safari 11+, Chrome Android 69+. Graceful degradation: degrades to normal horizontal scroll. [MDN: CSS Scroll Snap](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_snap).

- **PWA installability + `display_override`.** Pattern: manifest with `"display_override": ["window-controls-overlay", "standalone"], "display": "standalone"`, a maskable icon ≥ 512×512, `start_url`, and a service worker with a `fetch` handler. Listen for `beforeinstallprompt` (Chromium only) and stash it for a later custom install CTA. Support: Chrome Android / Edge have had install prompts for years; iOS 16.4+ supports Web Push and badging only for home-screen-added PWAs (no `beforeinstallprompt`), so show a platform-specific "Tap Share → Add to Home Screen" instruction when `navigator.userAgent` indicates iOS Safari and `window.matchMedia('(display-mode: standalone)').matches` is false. Graceful degradation: the site works fine in-browser. [web.dev: Installable PWAs](https://web.dev/articles/install-criteria), [WebKit: Web Push for iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

- **Display-mode + notch handling for installed PWAs.** Pattern: `@media (display-mode: standalone) { body { padding-top: env(safe-area-inset-top); } }` so your custom header clears the iOS status bar; combine with `apple-mobile-web-app-status-bar-style: black-translucent` for a full-bleed look. Support: iOS Safari 11.3+, Chrome Android 70+. [MDN: display-mode](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/display-mode).

- **Service Worker caching strategy.** Pattern: **cache-first** for hashed static assets (`/assets/app.[hash].js`), **stale-while-revalidate** for HTML shells and images, **network-first** with timeout fallback for API calls. Workbox still the ergonomic baseline but vanilla `caches.match`/`event.respondWith` is fine. Graceful degradation: non-SW browsers just hit the network (no installed-PWA capability). [web.dev: Offline cookbook](https://web.dev/articles/offline-cookbook).

- **`content-visibility` for long pages.** Pattern: `.card { content-visibility: auto; contain-intrinsic-size: 0 320px; }` lets the browser skip rendering/layout for off-screen sections, improving INP and TTI on long feeds. Support: Chrome 85+, Safari 18+ (2024), Firefox 125+. Graceful degradation: ignored silently. [web.dev: content-visibility](https://web.dev/articles/content-visibility).

- **Kill the 300 ms tap delay.** Pattern: either `<meta name="viewport" content="width=device-width,initial-scale=1">` (removes the delay by opting out of double-tap-zoom heuristics on Chrome Android) or `touch-action: manipulation` per-element. Already universal in 2026; the anti-pattern is still shipping old code that fights it (e.g., FastClick). [web.dev: 300ms tap delay, gone away](https://web.dev/articles/mobile-touch).

### Anti-patterns to flag in an audit

- **`height: 100vh` / `min-height: 100vh` without a `dvh`/`svh` fallback line.** Detect: CSS AST scan for `\b100vh\b` not followed by a sibling `100dvh` or `100svh` declaration in the same rule.
- **Missing `viewport-fit=cover`** in the viewport meta while `env(safe-area-inset-*)` is used anywhere in CSS. Detect: parse `<meta name="viewport">` content for `viewport-fit=cover` and cross-check CSS for `env(safe-area-inset`.
- **Fixed bottom nav without `padding-bottom: env(safe-area-inset-bottom)`** — overlaps the iOS home indicator. Detect: elements with `position: fixed; bottom: 0` and no `env(safe-area-inset-bottom)` in their padding/margin.
- **Tap target < 24×24 CSS px** (WCAG 2.2 SC 2.5.8 fail) or < 44 px for primary actions. Detect: computed bounding box on `a`, `button`, `[role=button]`, `input[type=checkbox/radio]`, interactive SVG icons.
- **Adjacent tap targets closer than 24 px center-to-center** without spacing exceptions. Detect: pairwise distance check between interactive elements in the same flow.
- **Non-passive `touchstart` / `touchmove` / `wheel` listener** added with `{ passive: false }` or without options when the handler calls `preventDefault()`. Detect: static analysis on `addEventListener` call sites; runtime observation of `[Violation] Added non-passive event listener` console warnings.
- **`e.preventDefault()` on `wheel` or `touchmove` at the document/window level** (scroll-hijacking). Detect: the above, plus observed scroll delay > 50 ms INP.
- **Missing `touch-action: manipulation`** on custom buttons / link-styled divs that still exhibit the 300 ms double-tap-zoom delay. Detect: computed `touch-action: auto` on elements with `role=button` or click handlers.
- **`user-scalable=no` or `maximum-scale=1`** in the viewport meta (accessibility fail, WCAG 1.4.4). Detect: parse viewport meta content.
- **Horizontal carousels without `scroll-snap-type`** or without `overscroll-behavior-x: contain` (causes back-swipe navigation hijack on iOS). Detect: `overflow-x: auto` containers lacking scroll-snap declarations.
- **Modals / drawers without `overscroll-behavior: contain`** — body scrolls behind them. Detect: `role=dialog`/`[aria-modal=true]` containers without `overscroll-behavior`.
- **PWA manifest missing `display_override`** or using `display: browser`. Detect: fetch `manifest.webmanifest`, check keys.
- **No `apple-touch-icon`** (≥ 180×180) or no maskable icon in manifest — bad Add-to-Home-Screen result. Detect: HTML head scan + manifest parse.
- **Service worker registered but no `fetch` handler** — fails Chrome installability criteria. Detect: static scan of `sw.js` for `self.addEventListener('fetch'`.
- **Web Push requested on iOS before PWA install** — silently fails on iOS Safari (Push only works once installed to home screen). Detect: `Notification.requestPermission()` call gated only on browser, not on `matchMedia('(display-mode: standalone)')`.
- **Hover-only affordances** (tooltip-only labels, `:hover` reveal menus with no touch equivalent). Detect: `:hover` rules that toggle `display`/`visibility`/`opacity` without a matching `:focus-visible` or click-toggle.
- **Long pages without `content-visibility: auto`** on repeated card/section blocks, when INP > 200 ms. Detect: Lighthouse INP + DOM node count heuristic.
- **`position: fixed` header that jumps when iOS URL bar hides/shows** because height is `vh`-based. Detect: sticky/fixed elements sized in `vh` rather than `dvh`/`svh` or fixed px.
- **Missing `interactive-widget` meta key** on pages with bottom-anchored inputs (chat composers, comment boxes). Detect: viewport meta parse; heuristic flag if a form input has `position: fixed; bottom: 0`.
- **`-webkit-overflow-scrolling: touch`** still present (no-op since iOS 13, dead code smell). Detect: CSS scan.
- **Double-tap-to-zoom disabled via JS** (`event.preventDefault()` on second `touchend`) instead of `touch-action: manipulation`. Detect: handler pattern analysis.

---

## Synthesis — implications for atelier

Four themes recur across all four areas and determine the shape of the next skill(s):

1. **Audit is the universal primitive.** Every technique above has a companion anti-pattern detectable by static CSS/JS/HTML analysis, runtime DOM inspection, or Playwright instrumentation. The atelier pattern for audits is well-understood (see `accessibility-design-audit`). Scaffolding (generators) is a distinct, optional follow-on.

2. **A `brand.json` extension is warranted.** Motion durations/easings, tap-target floor, z-index/elevation scale, and INP budget are all project-level knobs that the audit would compare actual values against. Today `brand.schema.json` has `palette`/`typography`/`logos`/`social`/`deploy` but no `motion`/`surfaces`/`targets` section.

3. **Browser-native first; library only when support matrix demands it.** Every 2026 recommendation favors Popover API, `<dialog>`, `@starting-style`, `dvh`, `anchor-name`, `scheduler.yield()`. Libraries (Floating UI, focus-trap) are now either redundant or only warranted for older-browser support matrices.

4. **Measurement must be separable from prescription.** INP estimation via Playwright trace is expensive and noisy; static checks (viewport meta, `100vh` without `dvh`, `<dialog>` without label) are fast and deterministic. The skill should stratify: fast static pass runs in CI, dynamic pass opt-in.

Detailed skill proposal: see [runtime-ux-audit.md](runtime-ux-audit.md).

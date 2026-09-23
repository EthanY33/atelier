# runtime-ux-audit v0.1 — Runtime-UX quality skill

**Status:** Implemented in atelier 1.0 as `plugins/atelier/skills/runtime-ux-audit/`. Filed 2026-04-17. Research base: [`runtime-ux-research.md`](runtime-ux-research.md). Where the shipped skill differs from this spec, see [Implementation deviations (1.0)](#implementation-deviations-10) at the end.

## Problem

Atelier's seven shipping skills cover brand, assets, and WCAG-correctness.
None cover **runtime UX quality**: how the page transitions, how fast it
acknowledges input, how its panels behave, or how it reads on a phone.
On goneidle.com build-out these four pain areas recurred — each fixed by
hand, none caught by existing atelier audits. The next site atelier touches
will hit the same gaps.

Concretely, atelier today cannot detect any of these (all cited from the
research doc):

- `window.addEventListener('unload', …)` — silently evicts page from bfcache.
- Non-passive `touchstart` on `window` — 100–300 ms scroll jank, regressing INP p75.
- `height: 100vh` on a hero — layout jumps when iOS URL bar hides.
- `<div role="dialog">` with `z-index: 9999` and a focus-trap library — a native `<dialog>` replaces all of it since 2024.
- Tap target < 24 × 24 CSS px — WCAG 2.2 SC 2.5.8 Level AA violation.
- `@view-transition { navigation: auto }` with no `prefers-reduced-motion` guard.

## Proposal

Add one new skill: **`runtime-ux-audit`**.

Input: a URL or local HTML file (plus optional `.atelier/brand.json`).
Output: `ux-report.md` + `ux-raw.json` in `outDir`, grouped by pain area and
severity. Exit code `1` when `critical + serious > 0`. Shape mirrors
`accessibility-design-audit` so the two compose in CI.

Extend `brand.schema.json` with three optional top-level sections —
`motion`, `surfaces`, `targets` — that the audit compares actual values
against when present; WCAG/Material/iOS defaults when absent.

Update `docs/skill-reference.md` with one new row.

## Design decisions

### One skill vs multiple

**Decision: one skill, `runtime-ux-audit`.** Not `transition-kit` +
`panel-kit` + `mobile-kit`.

- **For multiple skills:** Each pain area is conceptually distinct; a focused
  skill is easier to reason about in isolation; allows independent versioning.
- **For one skill:** Matches atelier's existing shape — `accessibility-design-audit`
  covers WCAG 2.0 A + 2.0 AA + 2.1 AA (three standards) in one pass. A
  single-URL-in, one-report-out contract is the atelier norm. The four areas
  overlap in practice: passive-listener failures show up as both mobile-scroll
  anti-patterns and INP anti-patterns; view-transitions without reduced-motion
  guard is both a transition concern and a motion concern. Splitting creates
  three commands to run, three reports to reconcile, three brand-token lookups.
- **Deciding factor:** CI ergonomics. A single `node …/runtime-ux-audit.mjs <url>`
  call that prints one severity total is the friction level atelier targets.

If scaffolding (section below) ever gets added, those would be separate
skills (`panel-scaffold`, `transition-scaffold`) because scaffolding has a
different input contract (template name, not a URL).

### Audit, scaffold, or both

**Decision: audit only for v0.1.** No scaffolding.

- **Scaffolding is a distinct ergonomic.** An audit takes a URL and produces a
  report. A scaffold takes a template name and produces source code. They share
  no infrastructure.
- **The research doc contains ~50 concrete detectable anti-patterns.** That is
  enough work for one skill.
- **If scaffolds are valuable later,** the natural home is a
  component-generation tool, not atelier. Atelier's charter is brand consistency and artifact generation
  *from brand*, not generic component authoring.

### Static vs dynamic checks

**Decision: static by default, dynamic opt-in via `--dynamic` flag.**

Static checks run in <5 s with zero flakiness:
- Parse the HTML (`<meta name="viewport">`, `<link>`, `<script>` URLs).
- Parse the CSS (reachable from the page — inline, linked, and `<style>`).
- Parse the JS (statically — look for `addEventListener('unload')` and similar string patterns; no V8 evaluation).

Dynamic checks require Playwright and a live page load:
- **Computed-style sweep** for tap-target size, z-index, `touch-action`.
- **INP estimation** via `web-vitals` injection + scripted interactions (Tab through focusable elements, click each visible button) under CPU throttling (4× slowdown, per Lighthouse mobile profile).
- **LoAF capture** via `PerformanceObserver('long-animation-frame')` — Chromium only.
- **bfcache probe** — navigate away, back, read `performance.getEntriesByType('navigation')[0].notRestoredReasons`.

Rationale: CI should run the static pass on every PR (fast, deterministic).
Dynamic is slower and requires Playwright-launched Chromium; run it before
release cuts or on-demand.

## API

### Node API

```js
import { auditRuntimeUx } from './plugins/atelier/skills/runtime-ux-audit/index.mjs';

const { violations, metrics, reportPath } = await auditRuntimeUx({
  url:     'https://example.com',
  outDir:  'ux-results',
  dynamic: false,            // default; set true to run Playwright pass
  brand:   '.atelier/brand.json',  // optional; used for project-specific budgets
});

console.log(`Critical: ${violations.critical.length}`);
console.log(`INP estimate: ${metrics.inpP75Ms ?? 'n/a (static only)'} ms`);
```

### CLI

```bash
# Static pass (fast, CI-suitable — exits 0 if no critical/serious)
node plugins/atelier/skills/runtime-ux-audit/index.mjs https://example.com

# With dynamic checks (Playwright)
node plugins/atelier/skills/runtime-ux-audit/index.mjs https://example.com --dynamic

# Custom outDir
node plugins/atelier/skills/runtime-ux-audit/index.mjs https://example.com ./reports/ux --dynamic
```

### SKILL.md frontmatter

```yaml
---
name: runtime-ux-audit
description: Audit a URL or local HTML file for runtime-UX quality — page transitions, INP-adjacent main-thread behavior, panel/surface correctness, and mobile-specific patterns. Static pass runs in CI; opt-in --dynamic flag adds Playwright-driven INP estimation and bfcache probing. Emits markdown report + raw JSON grouped by pain area and severity. Exits non-zero on critical or serious. Pair with accessibility-design-audit.
---
```

Body: `When to use` (before shipping any page with transitions/panels/mobile-adaptations; after framework updates that could regress INP; as CI gate) + `How to run` (API, CLI, `outDir` contract, how `brand.json` is consumed).

## Measurable outputs

### Files emitted to `outDir`

| File | Contents |
|---|---|
| `ux-report.md` | Human-readable; headline metrics, then sections 1–4 (transitions, INP, panels, mobile), each grouped by severity. |
| `ux-raw.json` | Full rule-result object: `{ url, timestamp, metrics: {...}, violations: [{ ruleId, severity, area, description, helpUrl, nodes: [{selector, snippet, location}] }] }`. |

### Headline metrics (top of `ux-report.md`)

```
URL:                  https://example.com
Timestamp:            2026-04-17T18:22:41Z
Total violations:     14  (critical: 1 · serious: 3 · moderate: 7 · minor: 3)
Pass:                 ✗ (1 critical, 3 serious)

Transitions:  bfcache blockers 1, VTA fallback gaps 0
INP quality:  non-passive listeners 2, long handlers 1, INP p75 est. 284 ms  [budget 200 ms]
Panels:       z-index smells 4, missing aria-label 2, no @starting-style 1
Mobile:       tap targets <24px 6, 100vh w/o dvh 3, safe-area gaps 1
```

`INP p75 est.` is only present under `--dynamic`. Budget is
`brand.targets.inpBudgetMs` when set, else 200 ms (Core Web Vitals pass).

### Rule result shape

Each violation in `ux-raw.json`:

```json
{
  "ruleId": "atelier/runtime-ux/no-unload-handler",
  "severity": "critical",
  "area": "transitions",
  "description": "Use of window.unload blocks the back/forward cache in all browsers.",
  "helpUrl": "https://web.dev/articles/bfcache#observe-unload-events",
  "nodes": [
    { "selector": "script[src='/js/analytics.js']:line=42", "snippet": "window.addEventListener('unload', beacon);", "location": "/js/analytics.js:42:3" }
  ]
}
```

### Exit codes

- `0` — no critical, no serious (CI-green).
- `1` — ≥ 1 critical or serious (CI-fail). Matches `accessibility-design-audit`.

Internal errors (Playwright launch failure, unreachable URL) propagate via uncaught throw, which Node exits `1` on — identical to the existing a11y audit behavior.

## brand.schema.json extensions

Three new optional top-level sections. No required changes; existing
`brand.json` files continue to validate. The audit falls back to WCAG /
web-vitals / Material defaults when a section is absent.

### `motion`

```json
"motion": {
  "duration": {
    "short":  "180ms",
    "medium": "240ms",
    "long":   "320ms"
  },
  "easing": {
    "standard":   "cubic-bezier(0.2, 0, 0, 1)",
    "emphasized": "cubic-bezier(0.3, 0, 0, 1)"
  }
}
```

Audit uses these to flag panels whose CSS `transition-duration` deviates by
>25% from the matching token. `design-token-sync` can emit matching CSS
custom properties (`--motion-duration-short`, etc.) in a follow-on version —
out of scope for this skill.

### `surfaces`

```json
"surfaces": {
  "radius": {
    "panel":   "12px",
    "control": "8px"
  },
  "elevation": {
    "popover": 2,
    "dialog":  3
  },
  "zIndexMax": 100
}
```

`zIndexMax` is the threshold above which the audit flags a z-index as smelly
(top-layer / popover API replaces it). `elevation` maps to box-shadow token
names that `design-token-sync` emits.

### `targets`

```json
"targets": {
  "minTapPx":     44,
  "inpBudgetMs":  200,
  "lcpBudgetMs":  2500,
  "clsBudget":    0.1
}
```

Per-project budgets. When absent, defaults are: `minTapPx = 24` (WCAG 2.2
floor; 44 only if `targets.minTapPx` explicitly set), `inpBudgetMs = 200`,
`lcpBudgetMs = 2500`, `clsBudget = 0.1` (all Core Web Vitals "good").

### Schema file changes

In `schemas/brand.schema.json`:
- Add `motion`, `surfaces`, `targets` under `properties` (all `"type": "object"`, `additionalProperties: false`, each field optional).
- Do NOT add them to `required`.
- Keep the rest of the schema unchanged.

## Rule catalog (v0.1)

~72 rules total (13 transitions, 13 inp, 26 panels, 20 mobile), all detectable with the listed strategy. `A` = area
(`transitions` | `inp` | `panels` | `mobile`). `S` = severity
(`C`ritical / `S`erious / `M`oderate / `m`inor). `M` = detection method
(`HTML` / `CSS` / `JS` / `DOM` = dynamic computed-style, `TRACE` = dynamic
Playwright trace). `B` = reads `brand.json` (yes/no).

### Transitions (area: `transitions`)

| Rule ID | A | S | M | B | Description |
|---|---|---|---|---|---|
| `no-unload-handler` | T | C | JS | n | `addEventListener('unload', …)` or `window.onunload = …` evicts bfcache. |
| `no-beforeunload-always-attached` | T | S | JS | n | `beforeunload` attached at script top level (should gate on dirty-state). |
| `prefer-pageshow-for-restore` | T | M | JS | n | Init code that should fire after bfcache restore does not listen for `pageshow(e.persisted)`. |
| `close-idb-on-pagehide` | T | S | JS | n | IndexedDB transactions / `Web Locks` / `BroadcastChannel` not closed in `pagehide`. |
| `vta-no-feature-check` | T | S | JS | n | `document.startViewTransition(` call without `'startViewTransition' in document` guard. |
| `vta-no-reduced-motion-guard` | T | M | CSS | n | `@view-transition` or `::view-transition-*` animations defined without a `@media (prefers-reduced-motion: reduce)` sibling that neutralizes them. |
| `vta-root-transformed` | T | M | CSS | n | `transform`, `filter`, `opacity < 1`, or `will-change: transform` on `:root`/`html`. |
| `vta-duplicate-names` | T | S | CSS | n | Same `view-transition-name` value declared on more than one selector. |
| `speculation-rules-immediate-abuse` | T | M | HTML | n | `<script type="speculationrules">` with `"eagerness":"immediate"` and `>10` `href_matches` candidates. |
| `speculation-rules-csp-gap` | T | S | HTML | n | Inline `speculationrules` script present and response CSP `script-src` lacks `'inline-speculation-rules'`, nonce, or hash. |
| `analytics-without-prerender-guard` | T | M | JS | n | Common analytics patterns (`gtag(`, `ga(`, `fbq(`, `_paq.push`) called at top level without `document.prerendering` check — double-counts on Chromium prerender. |
| `cache-control-no-store-on-html` | T | M | HTML | n | Document response carries `Cache-Control: no-store` (evicts bfcache in non-updated browsers — flag for review). Dynamic-only (reads response headers). |
| `bfcache-not-restored` | T | S | TRACE | n | `--dynamic`: `notRestoredReasons` reports a blocker on back-nav probe. |

### INP / input latency (area: `inp`)

| Rule ID | A | S | M | B | Description |
|---|---|---|---|---|---|
| `non-passive-scroll-listener` | I | C | JS | n | `addEventListener('scroll'/'wheel'/'touchstart'/'touchmove', …)` on `window`/`document` without `{ passive: true }`. |
| `settimeout-zero-as-yield` | I | M | JS | n | `setTimeout(fn, 0)` used inside a loop (heuristic: `setTimeout` inside `for`/`while`). Prefer `scheduler.yield()` with fallback. |
| `sync-large-json-parse` | I | S | JS | n | `JSON.parse(` call inside an event handler whose input is not a literal or small string (static taint; confidence-tagged). |
| `click-handler-forced-layout` | I | S | JS | n | Handler reads layout (`offsetTop`, `getBoundingClientRect`, `scrollHeight`) then writes styles inline without `requestAnimationFrame` boundary. |
| `mouse-and-touch-pair` | I | m | JS | n | Same element has both `mousedown`/`click` and `touchstart` listeners; should use `pointerdown`. |
| `requestidlecallback-no-timeout` | I | M | JS | n | `requestIdleCallback(fn)` without `{ timeout }` option. |
| `missing-content-visibility` | I | M | DOM | n | Page has >20 repeated card-like blocks below the fold with no `content-visibility: auto`. Dynamic-only (DOM heuristic). |
| `scroll-listener-animates-transform` | I | S | JS | n | Scroll listener writes `transform` / `opacity` — should be `animation-timeline: scroll()/view()` if `@supports` permits. |
| `framework-hydration-on-static-page` | I | M | HTML+JS | n | React/Vue/Svelte hydration runtime shipped and `<body>` interactive-element count is 0. Heuristic flag. |
| `missing-webvitals-onINP` | I | M | JS | n | Page has RUM (common analytics libs loaded) but does not import/call `onINP` from `web-vitals`. |
| `longtask-without-loaf` | I | m | JS | n | `PerformanceObserver({ type: 'longtask' })` declared without an accompanying `'long-animation-frame'` observer. |
| `inp-estimate-over-budget` | I | S | TRACE | y | `--dynamic`: estimated INP p75 > `targets.inpBudgetMs`. |
| `loaf-long-script` | I | S | TRACE | n | `--dynamic`: any LoAF entry with `scripts[].duration > 100ms` during the interaction probe. |

### Panels / surfaces (area: `panels`)

| Rule ID | A | S | M | B | Description |
|---|---|---|---|---|---|
| `z-index-over-budget` | P | M | CSS | y | `z-index > surfaces.zIndexMax` (default 100). Candidate for Popover API / `<dialog>` replacement. |
| `z-index-literal-smell` | P | M | CSS | n | Literal `z-index: 9999` / `99999` / `2147483647`. |
| `dialog-missing-label` | P | S | DOM | n | `<dialog>` element without `aria-labelledby` or `aria-label`. |
| `div-role-dialog` | P | M | DOM | n | `<div role="dialog">` with sibling `.backdrop`/`.overlay`; `<dialog>` would replace it. |
| `focus-trap-library-near-dialog` | P | m | JS | n | `focus-trap` / `react-focus-lock` import and any `<dialog open>` usage. |
| `custom-outside-click-on-auto-popover` | P | M | JS+DOM | n | Document-level `click`/`pointerdown` listener in the same module as a `[popover="auto"]` target. |
| `custom-escape-on-dialog-popover` | P | m | JS+DOM | n | Custom `keydown` Escape handler on a `<dialog>` / `[popover]`. |
| `tooltip-focusable` | P | S | DOM | n | `role="tooltip"` with `tabindex="0"` or receives programmatic `focus()`. |
| `menu-no-arrow-keys` | P | S | JS+DOM | n | `role="menu"` ancestor with no `keydown` handler for `ArrowUp`/`ArrowDown`/`Home`/`End`/`Escape`. |
| `combobox-focus-in-listbox` | P | S | JS+DOM | n | `role="combobox"` element whose associated `role="listbox"` is focused on open (should use `aria-activedescendant`). |
| `no-starting-style-on-transitioned-popover` | P | M | CSS | n | `[popover]` / `dialog` selector with `transition` but no matching `@starting-style` block. |
| `transition-all-on-popover` | P | m | CSS | n | `transition: all` on `[popover]` / `dialog`. |
| `motion-no-reduced-motion-guard` | P | M | CSS | n | `transition` or `animation` on `[popover]` / `dialog` / `.modal` class without `@media (prefers-reduced-motion: no-preference)` wrapper. |
| `exit-not-faster-than-enter` | P | m | CSS | n | Computed enter vs exit animation duration — exit ≥ enter. Heuristic; confidence-tagged. |
| `backdrop-as-sibling-div` | P | M | DOM | n | `.backdrop` / `.overlay` div sibling of a modal container (use `::backdrop`). |
| `inert-with-showmodal` | P | m | DOM | n | `[inert]` on `<body>`/main landmark while a `<dialog open>` is in the tree. |
| `focus-lost-after-close` | P | S | TRACE | n | `--dynamic`: after opening + closing a modal via scripted interaction, `document.activeElement === <body>`. |
| `anchor-name-no-supports` | P | M | CSS | n | `anchor-name` / `position-anchor` declared outside an `@supports (anchor-name: --x)` block. |
| `stale-inset-area` | P | m | CSS | n | `inset-area` keyword (renamed to `position-area`). |
| `fixed-max-height-no-overflow` | P | m | CSS | n | `max-height: <px>` on panel-like element without `overflow: auto`. |
| `destructive-dialog-closedby-any` | P | S | DOM | n | `<dialog>` whose label text matches `/delete|remove|destroy/i` with `closedby="any"`. Heuristic. |
| `motion-duration-off-token` | P | m | CSS | y | Panel `transition-duration` deviates >25% from `brand.motion.duration.short\|medium\|long`. Only runs if `brand.motion.duration` set. |
| `backdrop-filter-on-opaque-fill` | P | M | CSS | n | `backdrop-filter` on a selector whose same-rule `background` has alpha ≥ 0.9 (or is a hex/named opaque color). The blur is imperceptible and costs a compositor layer + per-frame blur eval. Deriving from the goneidle.com modal-stutter fix (2026-04-19): `.modal { background: rgba(2,3,7,0.96); backdrop-filter: blur(10px); }` — removing the filter and bumping to opaque was visually identical and fixed modal video FPS. |
| `backdrop-filter-on-video-modal` | P | S | CSS+DOM | n | `backdrop-filter` declared on `.modal` / `[role="dialog"]` / `[aria-modal="true"]` / `<dialog>` that contains a descendant `<video>` or `<iframe>` (common trailer/player pattern). Per-frame blur re-evaluation on a playing video tanks playback FPS even when the MP4 itself is fine. Flag whenever both conditions hold. |
| `fixed-nav-backdrop-filter-under-modal` | P | M | CSS+DOM | n | Element matches `position: fixed` + `backdrop-filter` AND the document contains a `[z-index >= 100]` modal/dialog that doesn't hide the nav when open. Fixed `.nav` with `blur(16px)` stays layer-promoted under a full-viewport modal, re-evaluating per paint. Fix: `body:has(.modal.on) .nav { display: none }` or equivalent. |
| `video-missing-gpu-hint-in-modal` | P | m | CSS+DOM | n | `<video>` descendant of `.modal` / `[role="dialog"]` / `<dialog>` with no `transform` / `will-change: transform` / `translate: 0 0` on the `video` selector (or a parent within the modal). Video benefits from explicit GPU-layer promotion during overlay playback; without it, Chromium sometimes falls back to software compositing. |

### Mobile (area: `mobile`)

| Rule ID | A | S | M | B | Description |
|---|---|---|---|---|---|
| `uses-vh-without-dvh` | Mo | S | CSS | n | `100vh` / `min-height: 100vh` in a rule with no sibling `dvh` or `svh` declaration. |
| `env-safe-area-without-viewport-fit-cover` | Mo | S | HTML+CSS | n | Any `env(safe-area-inset-*)` in CSS but `<meta name="viewport">` lacks `viewport-fit=cover`. |
| `fixed-bottom-no-safe-area` | Mo | S | DOM | n | Element with `position: fixed; bottom: 0` and no `env(safe-area-inset-bottom)` in padding/margin. |
| `tap-target-under-minimum` | Mo | S | DOM | y | Interactive element computed bounding box < `targets.minTapPx` × `targets.minTapPx` (default 24 per WCAG 2.2 SC 2.5.8). Dynamic-only. |
| `tap-targets-spacing-under-24` | Mo | M | DOM | n | Adjacent interactive elements (button/link/icon) with center-to-center < 24px. Dynamic-only. |
| `non-passive-touch-listener` | Mo | C | JS | n | `touchstart`/`touchmove` listener with explicit `{ passive: false }`. |
| `scroll-hijack` | Mo | C | JS | n | `e.preventDefault()` called inside a document- or window-level `wheel` / `touchmove` handler. |
| `missing-touch-action-manipulation` | Mo | M | DOM | n | Custom clickable (`role=button` or element with click listener) with computed `touch-action: auto`. Dynamic-only. |
| `user-scalable-no` | Mo | S | HTML | n | Viewport meta contains `user-scalable=no` or `maximum-scale=1` (WCAG 1.4.4 fail). |
| `carousel-no-scroll-snap` | Mo | M | CSS | n | `overflow-x: auto` container with children sized as a row but no `scroll-snap-type`. Heuristic. |
| `modal-no-overscroll-behavior` | Mo | M | CSS | n | `role="dialog"`/`[aria-modal="true"]` container without `overscroll-behavior: contain`. |
| `pwa-manifest-no-display-override` | Mo | m | HTML | n | `manifest.webmanifest` linked but missing `display_override` field. |
| `pwa-no-apple-touch-icon` | Mo | m | HTML | n | `<link rel="apple-touch-icon">` absent or image < 180×180. |
| `sw-no-fetch-handler` | Mo | M | JS | n | Service worker registered but `sw.js` source has no `self.addEventListener('fetch', …)`. |
| `push-permission-no-display-mode-guard` | Mo | M | JS | n | `Notification.requestPermission()` not gated on `matchMedia('(display-mode: standalone)').matches` (silently fails on iOS when not installed). |
| `hover-only-affordance` | Mo | S | CSS | n | `:hover` rule toggles `display`/`visibility`/`opacity` with no matching `:focus-visible` or click state. |
| `fixed-header-vh-sized` | Mo | M | CSS | n | `position: fixed`/`sticky` header sized in `vh` (jumps with iOS URL bar). |
| `missing-interactive-widget` | Mo | m | HTML+DOM | n | Viewport meta lacks `interactive-widget` and the page has a `position: fixed; bottom: …` form input. |
| `webkit-overflow-scrolling-touch` | Mo | m | CSS | n | Dead `-webkit-overflow-scrolling: touch` declaration. |
| `double-tap-js-override` | Mo | M | JS | n | JS `touchend` handler that calls `preventDefault()` on second tap within 300 ms (should use `touch-action: manipulation`). Heuristic. |

## Reference implementation

- **Skill directory layout:** Mirror `plugins/atelier/skills/accessibility-design-audit/` — `SKILL.md`, `index.mjs`, optional supporting files. No tests directory per skill; tests live under `tests/` at repo root.
- **Report renderer:** Follow `buildMarkdownReport()` in `accessibility-design-audit/index.mjs:34` — group by severity, emit rule id + description + help URL + up to 5 affected selectors.
- **CSS parsing:** Use `postcss` (already a transitive dep via Tailwind; add explicitly). Walk declarations + at-rules.
- **JS parsing:** `acorn` + `acorn-walk` for call-site detection. Do NOT evaluate. Pattern-match `addEventListener(literal, ...)` call expressions.
- **HTML parsing:** `parse5` (zero-dep). Extract `<meta>`, `<link>`, inline `<script type="speculationrules">`, and `manifest.webmanifest` link.
- **INP estimation (`--dynamic`):** Inject `web-vitals` v5 via Playwright `page.addInitScript`; script-drive interactions (Tab cycle, click each visible button below the fold); read `onINP` callbacks; derive p75 from the sample. CPU throttle via CDP `Emulation.setCPUThrottlingRate` at 4× (Lighthouse mobile profile).
- **LoAF capture (`--dynamic`, Chromium only):** `PerformanceObserver({ type: 'long-animation-frame', buffered: true })` init-script; flush to a `window.__atelierLoAF` array; read after interactions.
- **bfcache probe (`--dynamic`):** Navigate to URL, navigate away to `about:blank`, navigate back, read `performance.getEntriesByType('navigation')[0].notRestoredReasons`. Chromium 123+ only; skip with `notApplicable` on other engines.
- **Playwright launch:** Chromium only for `--dynamic` (LoAF + notRestoredReasons are Chromium-only). Print a note in the report: "Dynamic findings reflect Chromium-only APIs."

## Acceptance criteria

1. `plugins/atelier/skills/runtime-ux-audit/` directory exists with `SKILL.md` + `index.mjs`, matching the atelier skill contract.
2. `auditRuntimeUx({ url, outDir })` exported from `index.mjs`; CLI entry works.
3. Static pass: all rules in the catalog above marked method `HTML`/`CSS`/`JS` run without Playwright and complete in <5 s on a 100 KB page.
4. Dynamic pass (`--dynamic`): Playwright Chromium launches, computed-style and trace rules execute, INP estimate appears in report.
5. `ux-report.md` renders with headline metrics + per-area grouped violations; exit code `1` when `critical + serious > 0`, `0` otherwise.
6. `ux-raw.json` validates against a JSON schema `schemas/ux-audit.schema.json` (new file).
7. `schemas/brand.schema.json` extended with optional `motion`, `surfaces`, `targets` sections; all existing fixture brand.json files still validate unchanged; `npm run lint:schemas` green.
8. `docs/skill-reference.md` table has a new row (below).
9. Vitest coverage: one fixture HTML page per pain area, each triggering at least 3 rules; one golden-file test per area for the report output.
10. Dynamic-pass tests are tagged and skipped when Playwright Chromium is unavailable (match existing ffmpeg-skip pattern in html-to-video tests).
11. `npm run demo` runs the static pass on the bundled demo site; exits 0.
12. CI: Ubuntu + Windows matrix passes (existing CI shape).

## docs/skill-reference.md row

Add one row to the table:

```markdown
| `runtime-ux-audit` | URL or HTML file, `brand.json` | `ux-report.md` + `ux-raw.json` | `playwright, postcss, acorn, parse5, web-vitals` |
```

Placement: directly below `accessibility-design-audit` (both are audit
skills). Also append a short paragraph after the table:

> `brand.json` now optionally carries `motion`, `surfaces`, and `targets`
> sections (see `schemas/brand.schema.json`). `runtime-ux-audit` uses these
> as project-specific budgets; `design-token-sync` emits matching CSS
> custom properties. Both fall back to Core Web Vitals / WCAG 2.2 defaults
> when absent.

Update the `brand-memory` row's inputs column from
`brand name, colors, typography, logo path, voice` to
`brand name, colors, typography, logo path, voice, motion, surfaces, targets`.

## Out of scope (v0.1)

- **Scaffolding** (generating best-practice popover/dialog/transition
  components). Potential separate skill — `panel-scaffold`, `transition-scaffold` —
  or a `frontend-design` extension. Not this skill.
- **RUM collection.** The skill does not deploy a monitor or collect
  production field data. It audits a single URL at a point in time.
- **Lighthouse full-suite replication.** Lighthouse already covers LCP/CLS
  robustly; `runtime-ux-audit` focuses on the four pain areas Lighthouse
  under-covers (view-transitions, INP sub-part attribution, panel
  semantics, mobile-specific viewport tokens).
- **React-specific rules.** Anti-patterns like "missing `startTransition`
  on list updates" are out of scope; the skill is framework-agnostic and
  must not rely on React-source analysis.
- **Visual regression.** The audit does not screenshot panels or diff
  motion curves frame-by-frame. (Future skill potential.)
- **Fixing violations.** The skill reports; it does not rewrite code. A
  separate `runtime-ux-fix` codemod could follow, but is deferred.
- **Deep JS call-graph analysis.** Rules like `click-handler-forced-layout`
  are heuristic (pattern match on source text), not semantic. False
  positives are acceptable as long as they're easily explainable in the
  report; rules with >20% false-positive rate on the fixture corpus should
  be downgraded to `minor` or dropped before merge.

## Implementation deviations (1.0)

The skill shipped in atelier 1.0. This section records where it differs from the spec above. The skill's `SKILL.md` is the user reference; `schemas/ux-audit.schema.json` in the plugin describes `ux-raw.json`.

### Layout and packaging

- The skill lives in `plugins/atelier/skills/runtime-ux-audit/` (entry `index.mjs`, rules in `rules/<area>/`, the Chromium pass in `dynamic/`). It imports only postcss, acorn, acorn-walk, parse5 and Playwright, resolved from the plugin's own `package.json`. Playwright is loaded only under `--dynamic`.
- Schemas sit in `plugins/atelier/schemas/`: `ux-audit.schema.json` is new, and `brand.schema.json` gained `motion`, `surfaces` and `targets`. The skill never reads the schema files at runtime; it validates the brand fields it uses itself.
- CLI: `atelier ux <url|file> [outDir]` through `bin/atelier`, or `node index.mjs` directly. Local paths and `file://` URLs are accepted wherever a URL is. The CLI (not the API) loads `./.atelier/brand.json` when it exists.
- Errors reuse the plugin's shared preflight: `UxAuditError` extends `PreflightError`, so every failure prints `atelier: <message>` and a `Fix:` line. A missing Chromium names the exact `npx playwright@<version> install chromium` command.

### Exit codes

- `0` pass, `1` critical or serious findings, `2` the audit could not run (usage, missing input, failed or refused document fetch, HTML nested past 512 levels, invalid brand.json, missing Playwright or Chromium, dynamic failure). The spec's "an uncaught throw exits 1" would let CI mistake "did not run" for "found problems".

### Measurement (`--dynamic`)

- No `web-vitals` dependency. INP is estimated from the Event Timing API directly: a `PerformanceObserver` of type `event` with `durationThreshold: 16`, entries grouped by `interactionId`, and web-vitals' rule of skipping one outlier per 50 interactions. `metrics.inpP75Ms` keeps the spec's name but holds this lab estimate (Pixel 7 profile, 4x CPU through CDP), not a field p75.
- Full Chromium (`channel: 'chromium'`, new headless) with Playwright's default `--disable-back-forward-cache` switch removed. Verified on Playwright 1.63 and Chromium 153: the headless shell never restores from the back/forward cache and reports `masked` for every page.
- A settle phase (1 s plus two animation frames at 4x CPU) runs before the interaction probe. Without it the first interaction on a trivial page measured 416 ms.
- Local files are served from a loopback server (127.0.0.1, GET and HEAD only, confined to the site root, dot-named files and folders refused except `.well-known`), so bfcache, module scripts and same-origin fetches behave as in production. Served URLs are mapped back to file paths before they reach the report. For local inputs the browser context blocks requests (including WebSockets) to any origin other than the loopback server and `--allow-origin` entries, and blocks service workers, so page scripts cannot send files from the root elsewhere; blocked origins are listed as a `network` probe error.
- The dynamic pass only collects facts (Event Timing entries, long animation frames, a DOM sweep, dialog focus results, bfcache restore); the area rules judge them. It taps and tabs through safe controls only (never links, downloads, or submit buttons of a form whose method is not `dialog`, whether or not the form has an `action`) and closes popups.
- Chromium launches with its OS sandbox (Playwright's default is `--no-sandbox`). On Linux, when the sandbox cannot start, the launch is retried without it and a one-line warning goes to stderr.

### Static analysis

- The static pass never runs page code and never starts a browser. A source-scan test bans Playwright, `eval`, `new Function` and `node:vm` in `lib/` and `rules/`.
- `cache-control-no-store-on-html` is a static rule that reads the response headers of http(s) inputs; the spec listed it as dynamic-only. It is not applicable to local files.
- Several spec "DOM" rules run statically on the HTML: `dialog-missing-label`, `div-role-dialog`, `tooltip-focusable`, `menu-no-arrow-keys`, `backdrop-as-sibling-div`, `destructive-dialog-closedby-any`, `backdrop-filter-on-video-modal`, `user-scalable-no` and `missing-interactive-widget`. Under `--dynamic` they run again on the rendered DOM, which catches markup that scripts add; nodes already reported are not repeated. `fixed-bottom-no-safe-area` is static (CSS and HTML) and applies only with `viewport-fit=cover`.
- Findings that rest on missing evidence go to "Needs review" (the raw `incomplete` list) and never fail the audit: a same-origin file that could not be read, plus the calibration cases below.
- Suppression: `--ignore <rule-id>`, `data-atelier-ignore` on an element or ancestor, and `atelier-ignore` comments in CSS and JS.
- Output is deterministic: fixed ordering by code unit, no durations or machine paths, and `--timestamp` for the report time. Runtime findings keep the order their rule emits (longest script first, targets in DOM order).
- Async stylesheets are read as screen styles: `<link rel="stylesheet" media="print" onload="...">` (the loadCSS and Beasties pattern, with the media the handler assigns) and `<link rel="preload" as="style" onload="...rel='stylesheet'">`. Print-only sheets and `@import ... print` are listed in Coverage as skipped with reason `print-media` and do not make coverage incomplete.

### Hostile input

The static pass reads untrusted pages and runs in CI, so its cost is bounded by the input size and a page cannot hang it or forge its report:

- Selector matching memoizes each (element, compound) pair per query and walks ancestor and sibling chains iteratively, so descendant and `~` chains are polynomial and deep trees cannot overflow the stack.
- `@import` params, CSS comments, selector normalization, CSP hash sources and CSS numbers are parsed by linear scanners or unambiguous regexes (the earlier regexes were quadratic or cubic on long runs of spaces, parentheses, digits or `=`).
- CSS nesting stops at 64 levels, resolved nested selectors at 4 KB each and 1 MiB in total; rules past a bound are not analyzed, and the model reports `complete: false`, so findings that rest on absence move to Needs review.
- HTML nested deeper than 512 elements (Chromium's parser limit) stops the audit with `COLLECT_FAILED`, exit 2: parse5's work grows with depth squared. `--timeout` bounds network requests only.
- A document redirect from a public host to a loopback, link-local or private address, or from https to http, is refused with exit 2. Hosts are checked as written; DNS is not resolved.
- `atelier-ignore` comments are indexed once per script or CSS node, not scanned per finding.
- `ux-report.md` renders page-derived text on one line: selectors and snippets inside code spans with whitespace collapsed, and locations, paths, URLs and messages with backslashes, backticks, `<`, `[`, `]` and block-starting characters escaped. The report is appended to GitHub step summaries by the Action.

### Rule set: 65 shipped, from a catalog of 72

Deferred (9):

- `prefer-pageshow-for-restore`: nothing static can tell which init code must re-run after a restore, and most correct pages have no pageshow listener. `bfcache-not-restored` covers the measurable part.
- `close-idb-on-pagehide`: contradicted by measurement. Chromium 153 restored pages holding a Web Lock and an open BroadcastChannel.
- `sync-large-json-parse`: payload size is unknown statically; `loaf-long-script` shows the real cost with attribution.
- `combobox-focus-in-listbox`: needs a scripted open of each combobox; a candidate for a later dynamic probe.
- `video-missing-gpu-hint-in-modal`: no authoritative source; Chromium already composites video in its own layer.
- `tap-targets-spacing-under-24`: merged into `tap-target-under-minimum`, which applies the WCAG 2.5.8 spacing exception.
- `missing-touch-action-manipulation`: with `width=device-width` (enforced by `viewport-meta-missing`) no current engine has the 300 ms tap delay.
- `pwa-manifest-no-display-override`: `display_override` is optional, so the rule would flag every correct PWA.
- `sw-no-fetch-handler`: Chromium dropped the fetch-handler install requirement, and a no-op fetch handler slows navigations.

Added (2): `no-sync-xhr` (inp, serious) and `viewport-meta-missing` (mobile, serious).

Renamed: `missing-webvitals-onINP` ships as `missing-webvitals-oninp` to fit the lowercase id pattern.

### Severity changes

| Rule | Spec | 1.0 | Why |
|---|---|---|---|
| `non-passive-scroll-listener` | critical | moderate | Calibration. Root touch listeners are passive by default, so what is left (element listeners, or a root wheel listener with `passive: false` that never cancels) only delays scrolls that start on that element. It fired on 6 of 25 well-built sites, all in library code. Root opt-outs stay critical in `non-passive-touch-listener` and `scroll-hijack`. |
| `click-handler-forced-layout` | serious | moderate | Heuristic source analysis. |
| `scroll-listener-animates-transform` | serious | moderate | Heuristic; a scroll-driven CSS animation is an improvement, not a correctness fix. |
| `requestidlecallback-no-timeout` | moderate | minor | Often intentional for work that can wait. |
| `env-safe-area-without-viewport-fit-cover` | serious | minor | Calibration. Without `viewport-fit=cover` the browser keeps content inside the safe area, so the insets are dead code rather than a layout bug (4 of 25 sites, all harmless). |
| `z-index-over-budget` | moderate | minor | Calibration. With the default budget of 100 it flagged 16 of 25 sites (Bootstrap and design-system scales start at 1000). `z-index-literal-smell` keeps the 9999-style literals at moderate. |
| `fixed-header-vh-sized` | moderate | minor | vh follows the large viewport, so a fixed header sized in vh is a little taller than intended while the toolbar shows; it rarely hides content. |

### Brand budgets

- `motion.duration`, `motion.easing`, `surfaces.radius` and `surfaces.elevation` are named-token maps, so projects keep their own token names. `motion-duration-off-token` compares a panel duration with every duration token and flags one more than 25% away from all of them.
- `targets.minTapPx` defaults to 24. A brand value also turns off the WCAG 2.5.8 spacing exception, since a project that asks for 44 px means 44 px.
- `targets.lcpBudgetMs` and `targets.clsBudget` are validated and echoed in `ux-raw.json`, but no 1.0 rule reads them; LCP and CLS stay with Lighthouse.

### Area notes

These keep false positives down; each has tests with near misses.

- Transitions: body `onunload` and `onbeforeunload` properties count as window listeners. `vta-no-feature-check` follows one level of helper function whose call sites are all guarded. `vta-no-reduced-motion-guard` accepts a script guard (a script that reads `prefers-reduced-motion` and calls `startViewTransition` or `skipTransition`) and ignores durations of 1 ms or less; a global `*` reduce reset does not count, because `*` does not match `::view-transition` pseudo-elements. `vta-duplicate-names` resolves the cascade per element and per media condition set before grouping names, and under `--dynamic` confirms duplicates from rendered boxes. `speculation-rules-csp-gap` treats `'strict-dynamic'` as disabling `'unsafe-inline'` and prints the sha256 source to add, hashed over the element text the browser hashes.
- INP: the passive-listener rule treats any cancel (`preventDefault()`, `returnValue = false`, `return false` in attribute handlers) and an event passed to other code as a possible cancel. `click-handler-forced-layout` also flags a read and a write inside the same loop iteration. `scroll-listener-animates-transform` follows `requestAnimationFrame` hops and skips discrete toggles. `framework-hydration-on-static-page` needs real hydration calls, not text mentions.
- Panels: the z-index rules skip skip links and screen-reader text revealed on focus. `motion-no-reduced-motion-guard` ignores opacity and color-only fades (WCAG 2.3.3 is about motion). `menu-no-arrow-keys` passes when any script handles the arrow keys. The @starting-style, `transition: all` and `max-height` rules look at the selector subject, so `dialog .btn` and `[popovertarget]` invokers are not panels.
- Mobile: `viewport-meta-missing` also reads a viewport meta that scripts inject. `tap-target-under-minimum` ignores visually hidden 1x1 targets, checkboxes and radios, and links inside running text. `hover-only-affordance` accepts `:focus-within`, click-state classes and `(hover: none)` alternatives, including utility-class equivalents on the same element.

### Calibration (1.0)

The static pass ran over `examples/page.html`, `demos/storyboard/index.html`, the og-card template, every runtime-ux fixture, and 25 public pages fetched on 2026-09-22: web.dev, developer.mozilla.org, developer.chrome.com, gov.uk, nodejs.org, svelte.dev, astro.build, github.com, w3.org, css-tricks.com, smashingmagazine.com, en.wikipedia.org, news.ycombinator.com, bbc.com/news, react.dev, vuejs.org, tailwindcss.com, getbootstrap.com, apple.com, stripe.com, vercel.com, theverge.com, python.org, nextjs.org and docs.github.com. Changes made:

1. `menu-no-arrow-keys` goes to review when a script loads more scripts at run time (a `createElement('script')` loader, or `import()` of a computed specifier). web.dev and developer.chrome.com build their menus from JavaScript loaded that way.
2. `hover-only-affordance` goes to review when no element in the page HTML (or the rendered DOM) matches the revealed target, when every match is empty (no text, controls or media), when the reveal sits inside a link or button that a tap still reaches, or when it reveals `::before` or `::after` content. Cases: plugin CSS for markup the page lacks (css-tricks.com), a "View Theme" hint inside card links (astro.build), and decorative pseudo-elements (react.dev).
3. `uses-vh-without-dvh` goes to review when no element in the page uses the rule (framework utilities such as Bootstrap's `.vh-100` and unused Tailwind classes) or every match is an empty box (backdrops, decorative lines). A dvh utility on the same element now counts only when it wins the cascade.
4. `no-starting-style-on-transitioned-popover` accepts a keyframe animation on the open state as the entry animation (vercel.com and nextjs.org dialogs).
5. `settimeout-zero-as-yield` skips a call followed by `return`, `throw` or `break` out of the loop, which schedules one task rather than one per iteration (svelte.dev tooltip code).
6. The three severity changes marked "Calibration" in the table above.

After these changes 8 of the 25 sites fail the gate. The remaining blocking findings were reviewed: `uses-vh-without-dvh` on `body`, app shells and sticky panels that exist on the page (7 sites), a `width=1120` viewport (en.wikipedia.org) and `maximum-scale=1` (vercel.com). The 100vh findings are the pattern this spec was written for, so the rule stays serious.

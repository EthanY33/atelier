# Runtime UX audit

URL: index.html
Timestamp: 2026-01-01T00:00:00.000Z
Mode: static
Total violations: 5 rules, 13 instances (critical: 1, serious: 1, moderate: 2, minor: 1)
Pass: no (1 critical, 1 serious)

| Area | Critical | Serious | Moderate | Minor | Highlights |
|---|---|---|---|---|---|
| Transitions | 1 | 0 | 1 | 0 | bfcache blockers 0, view-transition gaps 0, speculation rules 0, prerender analytics 0 |
| INP | 0 | 0 | 0 | 0 | non-passive listeners 0, main-thread smells 0, long scripts 0, RUM gaps 0, INP est. n/a (static) |
| Panels | 0 | 0 | 1 | 1 | z-index smells 0, dialog semantics 0, popover/menu behavior 0, motion gaps 0, compositor costs 0 |
| Mobile | 0 | 1 | 0 | 0 | tap targets under 44px 0, vh without dvh 0, safe-area gaps 0, touch/scroll hijacks 0, viewport meta 0, PWA 0 |

## 1. Transitions

### Critical (1)

#### atelier/runtime-ux/fake-js-unload
- Description: Fake rule for the core tests.
- Confidence: high
- Help: https://example.com/help
- Instances (1):
  - `script[src="js/app.js"]` at js/app.js:1:1: `window.addEventListener('unload', function () { navigator.sendBeacon('/x'); })`
    unload listener via addEventListener

### Moderate (1)

#### atelier/runtime-ux/fake-body-attr
- Description: Fake rule for the core tests.
- Confidence: high
- Help: https://example.com/help
- Instances (1):
  - `body` at index.html:17:7: `<body onunload="sendBeacon()">`

## 2. INP

No violations.

## 3. Panels

### Moderate (1)

#### atelier/runtime-ux/fake-z-index
- Description: Fake rule for the core tests.
- Confidence: high
- Help: https://example.com/help
- Instances (2):
  - `.modal` at index.html:13:10: `.modal { z-index: 9999 }`
    9999 > 50
    Confidence: medium
  - `body > main > div.modal:nth-of-type(1)` at index.html:21:36: `style="z-index: 10000"`
    10000 > 50
    Confidence: medium

### Minor (1)

#### atelier/runtime-ux/fake-html-item
- Description: Fake rule for the core tests.
- Confidence: high
- Help: https://example.com/help
- Instances (7):
  - `body > main > ul.list > li.item:nth-of-type(1)` at index.html:23:5: `<li class="item">`
    item 1
  - `body > main > ul.list > li.item:nth-of-type(2)` at index.html:24:5: `<li class="item">`
    item 2
  - `body > main > ul.list > li.item:nth-of-type(3)` at index.html:25:5: `<li class="item">`
    item 3
  - `body > main > ul.list > li.item:nth-of-type(4)` at index.html:26:5: `<li class="item">`
    item 4
  - `body > main > ul.list > li.item:nth-of-type(5)` at index.html:27:5: `<li class="item">`
    item 5
  - ... and 2 more

## 4. Mobile

### Serious (1)

#### atelier/runtime-ux/fake-css-height
- Description: Fake rule for the core tests.
- Confidence: high
- Help: https://example.com/help
- Instances (2):
  - `.hero` at index.html:10:9: `.hero { min-height: 100vh }`
  - `.card .tip` at css/site.css:3:14: `.card .tip { height: 90vh }`

## Needs review

These findings rest on something being absent, but some inputs were missing (1 same-origin script could not be loaded). Check them by hand.

#### atelier/runtime-ux/fake-absence
- Description: Fake rule for the core tests.
- Confidence: low
- Help: https://example.com/help
- Instances (1):
  - `document` at index.html: `no scheduler.yield() anywhere`

## Coverage

- Resources: 1 document, 3 stylesheets, 3 scripts, 1 speculation rules block parsed; skipped: https://fonts.example.com/css2?family=Inter (cross-origin); failed: js/missing.js (not-found)
- Rules: 12 total; 5 failed, 1 incomplete, 1 passed, 2 not applicable, 1 skipped (dynamic only), 1 ignored, 1 error
- Suppressed instances: 3
- Rule error: atelier/runtime-ux/fake-throws: boom

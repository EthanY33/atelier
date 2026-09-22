---
name: accessibility-design-audit
description: WCAG 2.1 AA audit of a URL or local HTML file with axe-core via Playwright; writes a markdown report grouped by impact plus raw JSON, exits non-zero on critical or serious violations (CI gate). Use before shipping any page or major layout change, after design changes (tokens, colors, typography, forms/modals/alerts), when auditing a site for WCAG 2.1 AA, or as a CI regression gate.
---

## Run

```js
import { auditPage } from './plugins/atelier/skills/accessibility-design-audit/index.mjs';
const { violations, reportPath } = await auditPage({ url: 'https://example.com', outDir: 'a11y-results' });
// violations.critical, violations.serious: arrays
```

Local file: `url: pathToFileURL('/path/to/page.html').href` (from `url`).

CLI (usable directly as a CI step):
```bash
node plugins/atelier/skills/accessibility-design-audit/index.mjs <url> [outDir=a11y-report]
```
Exits `1` when critical + serious > 0, else `0`.

## Output

- `a11y-report.md`: human-readable, grouped by impact (critical to minor)
- `a11y-raw.json`: full axe-core result, pretty-printed

axe tags: `wcag2a`, `wcag2aa`, `wcag21aa` (baseline for ADA, Section 508, EN 301 549).

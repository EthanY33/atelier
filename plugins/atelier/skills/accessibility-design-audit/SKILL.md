---
name: accessibility-design-audit
description: Run WCAG 2.1 AA audit on a URL or local HTML file using axe-core via Playwright. Outputs a markdown report grouped by impact + raw JSON. Exits non-zero on critical or serious violations so it plugs directly into CI. Use before shipping any page, after design changes, or as a regression gate.
---

## When to use

- Before shipping any new page or major layout change
- After updating design tokens, colors, or typography
- As a CI regression gate to catch new violations automatically
- When auditing an existing site for WCAG 2.1 AA compliance
- After adding interactive components (forms, modals, alerts)

## How to run

### API (in code)

```js
import { auditPage } from './plugins/atelier/skills/accessibility-design-audit/index.mjs';

const { violations, reportPath } = await auditPage({
  url: 'https://example.com',
  outDir: 'a11y-results',
});

console.log(`Critical: ${violations.critical.length}`);
console.log(`Serious:  ${violations.serious.length}`);
console.log(`Report:   ${reportPath}`);
```

### Local HTML file

```js
import { pathToFileURL } from 'url';
import { auditPage } from './plugins/atelier/skills/accessibility-design-audit/index.mjs';

const fileUrl = pathToFileURL('/path/to/page.html').href;
const { violations } = await auditPage({ url: fileUrl, outDir: '/tmp/a11y' });
```

### CLI

```bash
# Audit a URL — exits 0 if no critical/serious violations
node plugins/atelier/skills/accessibility-design-audit/index.mjs https://example.com

# Audit a URL and write results to a custom directory
node plugins/atelier/skills/accessibility-design-audit/index.mjs https://example.com ./reports/a11y
```

## Output files

| File | Contents |
|------|----------|
| `a11y-report.md` | Human-readable report grouped by impact level (critical → minor) |
| `a11y-raw.json` | Full axe-core result object as pretty-printed JSON |

## Rule tags

The audit uses the following axe-core tag set:

- `wcag2a` — WCAG 2.0 Level A
- `wcag2aa` — WCAG 2.0 Level AA
- `wcag21aa` — WCAG 2.1 Level AA

This covers the baseline required by most accessibility standards (ADA, Section 508, EN 301 549).

## CI integration

Exit code `1` when `critical + serious > 0`, allowing direct use as a pipeline gate:

```yaml
- name: Accessibility audit
  run: node plugins/atelier/skills/accessibility-design-audit/index.mjs https://staging.example.com
```

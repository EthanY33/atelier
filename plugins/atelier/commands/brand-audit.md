---
description: List the recommended fields missing from .atelier/brand.json, what uses each one, and the /brand-set command that fills it.
argument-hint: "[--root <dir>]"
---

Arguments (may be empty): `$ARGUMENTS`. If they include `--root <dir>`, add `--root '<dir>'` to the commands below.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand audit
```

- Exit 2: show stderr verbatim and stop. A `not found` message means run `/brand-init` first.
- Exit 0 (audit always exits 0): if every recommended field is set, say so. Otherwise list each missing field with the hint the CLI prints, and turn each printed `atelier brand set <path> <value>` line into `/brand-set <path> <value>`, with the example value replaced by the user's own when you know it. What reads each field:
  - `brand.product`: og-card-generator uses it as the card title when a page has none.
  - `typography.display`: og-card-generator headline font; design-token-sync emits it as a font token.
  - `logos.mark`: brand-asset-pipeline uses it when no mark SVG is passed.
  - `brand.voice`, `logos.wordmark`, `social`, `deploy.target`: kept for your own tools and prompts; no atelier skill reads them yet.

If the output ends with `Note: brand.json has N schema error(s)`, also run the command below and show its errors verbatim. It exits 1 when it finds errors; that is the expected result here, not a failure.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand validate
```

# Fixture Files

These fixtures are used by `scripts/run-demo.mjs` to exercise the full atelier pipeline.

| File | Purpose |
|------|---------|
| `brand.json` | Source-of-truth brand config fed to every skill |
| `mark.svg` | SVG logo mark used by brand-asset-pipeline to generate favicons + covers |
| `page.html` | Accessible HTML page used by accessibility-design-audit |

Generated output lands in `examples/fixtures/output/` (gitignored). Re-run `npm run demo` to regenerate it.

Note: `photo.jpg` is a synthetic image generated at runtime into `examples/fixtures/output/photo.jpg` — it is not a committed fixture file.

# Fixture Files

These fixtures are used by `scripts/run-demo.mjs` (`atelier demo`) to exercise the full atelier pipeline.

| File | Purpose |
|------|---------|
| `brand.json` | Source-of-truth brand config fed to every skill |
| `mark.svg` | SVG logo mark used by brand-asset-pipeline to generate favicons + covers |
| `page.html` | Accessible HTML page used by accessibility-design-audit, runtime-ux-audit and html-to-video |

Generated output lands in the `--out` directory (default `./atelier-demo`; `npm run demo` in the repo uses `.atelier-demo/`, which is gitignored). Re-run the demo to regenerate it.

Note: `photo.jpg` is a synthetic image generated at runtime into `<out>/photo.jpg`. It is not a committed fixture file.

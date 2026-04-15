# QA checklist

Run before every tag.

## Install flow

- [ ] Fresh clone + `npm install` completes without errors or peer-dependency warnings.
- [ ] `npm test` passes — 0 failures, all skips intentional and documented.
- [ ] `node scripts/run-demo.mjs` runs to completion and populates `examples/fixtures/output/`.

## Per-skill smoke

- [ ] **brand-memory** — `/brand-init` creates a valid `.atelier/brand.json` that passes schema validation.
- [ ] **design-token-sync** — emits CSS custom properties, a Tailwind config snippet, and a TypeScript declaration file from `brand.json`.
- [ ] **og-card-generator** — produces a PNG at exactly 1200×630 pixels with visible brand color and text elements.
- [ ] **responsive-image-pipeline** — outputs WebP and AVIF variants at each configured breakpoint width.
- [ ] **brand-asset-pipeline** — generates sized PNGs, a favicon set, and social-media logo variants from the source SVG.
- [ ] **accessibility-design-audit** — returns a JSON report with no unhandled errors and writes `a11y-report.md` + `a11y-raw.json` to the output directory.
- [ ] **html-to-video** — produces a playable MP4 at the specified duration and frame rate (requires ffmpeg on PATH).

## CI

- [ ] `ubuntu-latest` job is green (test + validate).
- [ ] `windows-latest` job is green (test job).
- [ ] Coverage report artifact uploaded; line coverage ≥ 70%.

## Manifests

- [ ] `.claude-plugin/marketplace.json` and `plugins/atelier/plugin.json` both parse without errors (`node -e "JSON.parse(...)"`).
- [ ] Version number is bumped consistently in `package.json` and `plugins/atelier/plugin.json` before tagging the release.

# atelier

Public Claude Code plugin, MIT. 7 design-automation skills sharing `.atelier/brand.json` as source of truth.

## Commands

```
npm install
npm test                # vitest, 59 tests; needs `npx playwright install chromium` once or 3 skills fail; ffmpeg-gated tests skip cleanly without ffmpeg
npm run lint:schemas    # ajv-validate JSON schemas
npm run demo            # /atelier-demo locally
npm run demo:gif        # regenerate demos/overview.* (README embeds the animated WebP, not the GIF)
```

CI: Ubuntu + Windows, Node 20, 70% coverage gate (thresholds in `vitest.config.mjs`, enforced by `npm run test:coverage` in `.github/workflows/ci.yml`). Don't lower it.

## Skills

`plugins/atelier/skills/<name>/`, each self-contained and copyable alone:
- `brand-memory`: owns `.atelier/brand.json`. Both `loadBrand()` and `saveBrand()` must Ajv-validate (v0.2.1 PR #12); don't trust file contents.
- `design-token-sync`: emits `tokens.css`, `tailwind.config.js`, `tokens.d.ts`, Figma vars. Emit all user-controlled strings via `JSON.stringify` (v0.2.1 PR #12, prevents JS literal escape).
- `og-card-generator`: 1200x630 PNGs from HTML template.
- `responsive-image-pipeline`: AVIF + WebP at 480/768/1280/1920 + LQIP, SHA-cached.
- `brand-asset-pipeline`: favicons, app icons, social, Steam capsules. No `.ico` emission (SKILL.md "Why no `.ico`": 24-bit BMP pitfall).
- `accessibility-design-audit`: axe-core + Playwright, WCAG AA.
- `html-to-video`: Playwright + ffmpeg to MP4/WebM. No `shell: true` on spawn (v0.2.1 PR #11: Windows command injection via `outPath`); use PATH-resolved binary lookup.

Slash commands (`/atelier-demo`, `/brand-init`, `/brand-get`, `/brand-set`, `/brand-audit`) live alongside the skills. `tests/` mirrors skill names; shared JSON schemas in `schemas/`; helpers in `scripts/` (incl. `preflight.mjs`); plugin manifest `.claude-plugin/marketplace.json`.

## Conventions

- Exact dependency pins are intentional; `package.json` is source of truth, Dependabot bumps them via grouped PRs (e.g. PR #4). 0.1.0 CHANGELOG documents deviations from the original spec. Don't loosen pins to ranges or hand-edit versions.
- `.atelier/brand.json` is JSON, not YAML: Claude edits it via slash commands, so YAML ergonomics buy nothing.
- Binary-dep checks aren't centralized. `html-to-video`, `og-card-generator`, `accessibility-design-audit` call `chromium.launch()` unchecked and let Playwright throw its "run `npx playwright install`" error. `html-to-video` also checks ffmpeg via PATH (`resolveFfmpeg`/`findOnPath`) but only after Playwright succeeds, so it's unreachable on a fresh clone. `responsive-image-pipeline` has no check. `scripts/preflight.mjs` (`checkBinary`/`checkNodeModule`/`runPreflight`) is unit-tested but called by no skill; don't assume it's wired in.
- No telemetry: never add metrics or analytics calls.

## Pending work

`CHANGELOG.md` `## [Unreleased]` is source of truth. `runtime-ux-audit` spec (added 0.2.0; backdrop-filter compositor rules from goneidle.com) is not yet a shipped skill.

## Commits

Conventional Commits. Most land directly on `main`; PRs for Dependabot bumps and notable fixes (#11, #12 show the security-fix pattern).

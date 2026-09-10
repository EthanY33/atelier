# CLAUDE.md — atelier project memory

Public Claude Code plugin. MIT. 7 design-automation skills sharing `.atelier/brand.json` as source of truth.

## Build / test commands

```
npm install
npm test                # vitest, 59 tests (needs `npx playwright install chromium` once, or 3 skills fail outright; ffmpeg-gated tests skip cleanly without it)
npm run lint:schemas    # ajv-validate JSON schemas
npm run demo            # /atelier-demo locally
npm run demo:gif        # regenerate demos/overview.* (README embeds the animated WebP, not the GIF)
```

CI runs Ubuntu + Windows × Node 20 with a **70% coverage gate** (thresholds in `vitest.config.mjs`, enforced by `npm run test:coverage` in `.github/workflows/ci.yml`). Don't lower it.

## Skill map

`plugins/atelier/skills/<name>/` — each is self-contained and copyable in isolation:

- `brand-memory` — owns `.atelier/brand.json`. **Both `loadBrand()` and `saveBrand()` must Ajv-validate** (gap fixed in v0.2.1 PR #12). Don't trust file contents.
- `design-token-sync` — emits `tokens.css`, `tailwind.config.js`, `tokens.d.ts`, Figma vars. **All user-controlled strings emitted through `JSON.stringify`** (fix in v0.2.1 PR #12 — prevents JS literal escape).
- `og-card-generator` — 1200×630 PNGs from HTML template.
- `responsive-image-pipeline` — AVIF + WebP at 480/768/1280/1920 + LQIP. SHA-cached.
- `brand-asset-pipeline` — favicons, app icons, social, Steam capsules. No `.ico` emission — see SKILL.md "Why no `.ico`" (24-bit BMP pitfall).
- `accessibility-design-audit` — axe-core + Playwright, WCAG AA.
- `html-to-video` — Playwright + ffmpeg → MP4/WebM. **No `shell: true` on spawn** (fix in v0.2.1 PR #11 — Windows command-injection via `outPath`). Use PATH-resolved binary lookup.

Slash commands live alongside the skills: `/atelier-demo`, `/brand-init`, `/brand-get`, `/brand-set`, `/brand-audit`. Tests are in `tests/` (mirroring skill names), shared JSON schemas in `schemas/`, helper scripts in `scripts/` (incl. `preflight.mjs` binary-dep checks), plugin manifest in `.claude-plugin/marketplace.json`.

## Non-obvious conventions

- Exact dependency pins are intentional — `package.json` is the source of truth (Dependabot bumps them via grouped PRs, e.g. PR #4). 0.1.0 CHANGELOG documents the deviations from the original spec. **Don't loosen pins to ranges, and don't hand-edit versions — let Dependabot roll them.**
- JSON, not YAML, for `.atelier/brand.json` — Claude edits it via slash commands; YAML's human ergonomics buy nothing.
- Binary-dep checks aren't centralized: `html-to-video`, `og-card-generator`, and `accessibility-design-audit` all call `chromium.launch()` with no check and let Playwright throw its own "run `npx playwright install`" error; `html-to-video` additionally checks ffmpeg via PATH lookup (`resolveFfmpeg`/`findOnPath`) but only after the Playwright step succeeds, so that check is unreachable on a fresh clone. `responsive-image-pipeline` has no check at all. `scripts/preflight.mjs` (`checkBinary`/`checkNodeModule`/`runPreflight`) exists and is unit-tested but isn't called from any skill. Don't assume it's wired in.
- **No telemetry. MIT.** Don't add metrics calls or analytics.

## Pending work

`CHANGELOG.md` under `## [Unreleased]` is the source of truth. `runtime-ux-audit` *spec* was added in 0.2.0 (backdrop-filter compositor rules from goneidle.com) but is not yet a shipped skill.

## Commit conventions

Conventional Commits. Most commits land directly on `main`; PRs are used for Dependabot bumps and notable fixes (see #11, #12 for the security-fix pattern).

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-19

### Added
- `html-to-video`: optional `audioSource` option on `recordHtml()`. Caller-supplied synthesizer writes a WAV; the skill stream-copies the silent video and muxes the audio in via ffmpeg. Supports MP4 (AAC 192k) and WebM (Opus 160k). Backward-compatible — omitting `audioSource` keeps v0.1 silent-video behavior. New vitest coverage: round-trip probe asserts the output has exactly one video + one audio stream; failure case asserts a clear throw when the synth writes nothing. Closes #5.
- `runtime-ux-audit` spec: four new `panels` category rules codifying backdrop-filter compositor cost, filed from the 2026-04-19 goneidle.com modal-stutter fix — `backdrop-filter-on-opaque-fill`, `backdrop-filter-on-video-modal`, `fixed-nav-backdrop-filter-under-modal`, `video-missing-gpu-hint-in-modal`. Panels section grew 22 → 26 rules (total 68 → 72).
- `brand-asset-pipeline` SKILL.md: "Why no `.ico`" section documenting the `to-ico` 24-bit-BMP rendering pitfall observed in 2026 goneidle builds, and the safe PNG-only default this skill emits.
- `html-to-video` SKILL.md: "Production directives for marketing trailers" — virtual-clock 60fps capture, offline audio synthesis, ffprobe validation gate, and content-level rules (mockups over bullets, concrete numbers, no ambient pads, short outros). Codified from the goneIdle / TideWane trailer pipeline.

### Changed
- `html-to-video` v0.2 spec rewritten from browser `MediaRecorder` capture to caller-provided offline-synth + ffmpeg mux. The original architecture was abandoned by the TideWane pipeline before implementation — headless Chromium Web Audio drifts 10–50 ms/minute and `MediaRecorder` silently emits zeros on some Chromium versions. Rationale documented in the spec file.
- CI workflow: `actions/setup-node` 4 → 6, `actions/checkout` 4 → 6, `actions/upload-artifact` 4 → 7. Clears Node.js 20 deprecation annotations (GitHub Actions Node 20 runtime is being removed on 2026-09-16).
- Dependencies: grouped minor/patch rollup across `ajv`, `ajv-formats`, `sharp`, `playwright`, `@axe-core/playwright`, and vitest/coverage-v8 (PR #4). All passing on Ubuntu + Windows CI.

## [0.1.0] - 2026-04-14

### Added
- Initial public release of atelier — Claude Code plugin with 7 design-automation skills: `brand-memory`, `design-token-sync`, `og-card-generator`, `responsive-image-pipeline`, `brand-asset-pipeline`, `accessibility-design-audit`, `html-to-video`.
- JSON-Schema-validated `.atelier/brand.json` (Ajv 8).
- `/atelier-demo` end-to-end pipeline slash command.
- `/brand-init`, `/brand-get`, `/brand-set`, `/brand-audit` slash commands.
- Vitest unit tests (52 passing, 86% coverage) + integration chain test.
- GitHub Actions CI matrix (ubuntu-latest + windows-latest, Node 20).
- Dependabot config (weekly security, monthly minor/patch, grouped PRs).
- Launch-grade README with embedded demo GIF.
- `scripts/build-demo-gif.mjs` — automated storyboard → GIF pipeline using `html-to-video` + ffmpeg palettegen/paletteuse.
- MIT license.

### Notes
- Dependency pins deviate from the original spec: `vitest` `2.2.0` → `3.1.2` (major), `sharp` `0.34.1` → `0.34.5`, `playwright` `1.52.0` → `1.51.1`, `@axe-core/playwright` `4.10.2` → `4.10.1`. All substitutions are exact pins. Vitest 3 is API-compatible with the plan's usage (`defineConfig`, `test.include`, `coverage.provider: 'v8'`, `coverage.thresholds`).
- `svgo` dependency from the original spec was dropped — sharp's SVG rasterization is sufficient for Phase 1.

[Unreleased]: https://github.com/EthanY33/atelier/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/EthanY33/atelier/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EthanY33/atelier/releases/tag/v0.1.0

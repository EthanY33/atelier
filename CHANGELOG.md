# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-22

atelier 1.0 is the first release you can install straight from the marketplace and use anywhere. It adds an eighth skill, `runtime-ux-audit`, a single `atelier` CLI, a GitHub Action, and fixes to every existing skill. Upgrading from 0.x: reinstall the plugin, use Node 22 or newer, and see **Changed** for the few breaking changes.

### Added

- **runtime-ux-audit**, the eighth skill. It audits a URL or local HTML file for runtime UX problems with 65 rules in four areas: page transitions (bfcache, view transitions, speculation rules), INP and main-thread work, panels (dialogs, popovers, layering, motion, `backdrop-filter` cost) and mobile (`100vh`, safe areas, viewport meta, tap targets, scroll hijacking). The static pass parses HTML, CSS and JS without running page code and is fast enough for every pull request. `--dynamic` adds a Chromium pass on a Pixel 7 profile with 4x CPU: an INP estimate from the Event Timing API, long animation frames, a bfcache restore probe, dialog focus return and tap-target sizes. Writes `ux-report.md` and `ux-raw.json` (validated by `schemas/ux-audit.schema.json`, `schemaVersion` 1.0). Severities were calibrated against 25 public sites; unconfirmed findings go to a "Needs review" section instead of failing CI.
- **`atelier` CLI** (`plugins/atelier/bin/atelier`, on the Bash PATH inside Claude Code): `atelier doctor` checks Node, dependencies, sharp, Chromium, ffmpeg and your brand file and prints the fix for anything missing; `atelier demo --out <dir>` runs every skill on bundled fixtures; `atelier <skill>` runs any skill's CLI through short aliases (`brand`, `tokens`, `og`, `images`, `assets`, `a11y`, `video`, `ux`).
- **A CLI for every skill**, with `--help`, shared exit codes, and local file paths accepted wherever a URL is.
- **`atelier brand`** with `init`, `get`, `set`, `audit`, `validate` and `path`. `init` takes all eight `/brand-init` answers, writes a `$schema` key for editor autocomplete, and refuses to overwrite without `--force`.
- **Slash commands** `/atelier-doctor` and `/ux-audit <url-or-file>`.
- **GitHub Action** (`uses: EthanY33/atelier@v1`) that runs the accessibility and runtime-UX audits, writes both reports and appends them to the job summary.
- **brand.json** gains optional `motion`, `surfaces` and `targets` sections (budgets for `runtime-ux-audit`) and an optional `$schema` key.
- **design-token-sync** emits `tokens.js` next to `tokens.d.ts`, and takes `--root`, `--out` and `--targets`.
- **og-card-generator** renders a single card from flags (`atelier og --title ... --slug ...`), can inline brand font files (`--font-display`, `--font-body`), and accepts `description` as an alias for `subtitle`.
- **responsive-image-pipeline** CLI with `--widths`, `--formats`, `--fallback`, `--lqip-width`, `--sizes`, `--base-url`, `--loading` and `--json`; it accepts files, folders and file URLs.
- **brand-asset-pipeline** reads `.atelier/brand.json` with `--root`: `palette.bg` as the background, `logos.mark` as the default mark, and Steam capsules when `deploy.stores` lists steam.
- **accessibility-design-audit** options `--tags`, `--wait-for`, `--timeout`, `--settle-timeout`, `--analyze-timeout` and `--allow-http-error`.
- **html-to-video** CLI options for duration, fps, size, format, poster and audio, plus `browser` and `signal` API options.
- Shared helpers in `plugins/atelier/lib/`: shell-free binary lookup, Chromium launch with an actionable install hint, a symlink-safe `isMain`, and BOM and UTF-16 tolerant file reading.
- CI on Ubuntu, macOS and Windows with Node 22 and 24, `claude plugin validate`, an installed-plugin smoke test that repeats a marketplace install on every OS, a GitHub Action self-test, a release workflow, and a weekly dependency audit.
- `SECURITY.md`, a code of conduct, issue and pull request templates, `docs/architecture.md`, `docs/api.md`, and a redesigned README with light and dark artwork.

### Changed

- **Breaking:** Node 22 or newer is required (Node 20 reached end of life in April 2026).
- **Breaking:** the plugin is self-contained. `schemas/`, the demo runner and the fixtures moved into `plugins/atelier/`, and the plugin ships its own `package.json` and lockfile so Claude Code installs its dependencies. Code that imported `schemas/brand.schema.json` or `scripts/preflight.mjs` from the repo root must use the new paths.
- **Breaking:** CLIs exit `2` for usage errors and failures. Audits exit `1` only for critical or serious findings, so CI can tell "the page has problems" from "the tool could not run".
- **Breaking:** design-token-sync's `figma-variables.json` is now a real request body for Figma's `POST /v1/files/:file_key/variables`, and `tokens.d.ts` uses `export declare const`.
- **Breaking:** `buildPictureSnippet` defaults its fallback `<img>` to the last `<source>` format (WebP by default) instead of a PNG that was never written.
- `/brand-init`, `/brand-get`, `/brand-set` and `/brand-audit` call the brand CLI, and `/atelier-demo` writes into `./atelier-demo` in your project instead of running a repo-only script.
- Validation errors for brand.json name the property, the unknown key and the allowed values.
- og-card-generator renders a batch with one browser, and html-to-video encodes its poster from the first captured frame.
- Dependencies upgraded to current releases (sharp 0.35.4, Playwright 1.63.0, axe-core 4.13.0, Ajv 8.20.0, Vitest 5.0.1), clearing every `npm audit` finding.
- The README's overview clip is recorded by atelier's own `html-to-video` and covers all eight skills.

### Fixed

- **Installation.** 0.2.1 could not be installed from the marketplace: the marketplace `owner` and plugin `author` were strings (both rejected), the manifest sat outside `.claude-plugin/`, and the installed copy had no dependencies and no schema, so every skill failed at import. All of this is fixed and tested on every OS in CI.
- **html-to-video** recorded on the wall clock, so page animations played two to four times too fast and clips ended on blank frames. It now drives a virtual clock (Playwright clock plus stepped CSS, Web Animations and SMIL), so frame N shows the page at N/fps seconds. It also waits for fonts before the first frame, checks for ffmpeg before launching Chromium, rounds odd sizes up to even for H.264, and cleans up temporary frames on every failure.
- **html-to-video** recorded HTTP 4xx and 5xx error pages as if they were the page; they now fail with exit 2 unless `--allow-http-error` is given. A new `--timeout` bounds navigation.
- **responsive-image-pipeline** ignored EXIF orientation (sideways phone photos), upscaled small sources while labeling them with larger widths, pointed its `<img>` fallback at a file it never wrote, reused stale cache entries after option changes, let same-named sources overwrite each other, and turned transparent LQIP placeholders black.
- **design-token-sync** produced an invalid `tailwind.config.js` and `tokens.d.ts` for hyphenated or reserved-word palette keys, wrapped whole font stacks in one quoted string so none of the fonts applied, and nested absolute `outDir` paths under the project.
- **og-card-generator** corrupted titles containing `$` patterns, broke multi-word font names such as `Press Start 2P`, rendered white text on light backgrounds when `palette.fg` was missing, and let long titles push the footer off the canvas.
- **accessibility-design-audit** ran axe before late stylesheets and fonts loaded (missing contrast issues), audited 404 and 500 error pages as if they were the real page, could hang forever on a busy page, and exited 0 without auditing when run through a symlink.
- **brand-asset-pipeline** crashed on 3-digit hex backgrounds, failed on large SVG canvases, produced blank icons for SVGs with linked images, rejected UTF-16 SVGs, and wrote a transparent `apple-touch-icon.png` that iOS fills with black.
- **brand-memory** failed on brand.json files saved with a byte order mark, dropped five of the eight `/brand-init` answers, and returned inherited members such as `constructor` from `getPath`.
- Every CLI now runs when reached through a symlink or Windows junction, and importing a skill from `node -e` no longer throws.

### Security

- Removed `shell: true` from the preflight binary check, which let shell metacharacters in arguments run commands on Windows. Binaries are resolved on PATH and spawned directly everywhere, with regression tests.
- og-card-generator no longer builds an inline script from page text, so a `</script>` in a title cannot run script or make requests from the rendering browser. Cards render with JavaScript disabled and a restrictive Content Security Policy, palette colors are validated, font names are escaped, and page slugs that could write outside the output directory are rejected.
- design-token-sync escapes every brand value for its output format, so a typography value cannot inject CSS or break out of a generated file.
- brand.json typography values are capped at 300 characters and reject `< > { } ;`, backslashes and control characters, so a hand-edited brand file cannot inject HTML or CSS.
- brand-memory's `setPath` could pollute `Object.prototype` through a `__proto__` path segment; `__proto__`, `constructor` and `prototype` segments are now rejected.
- brand-asset-pipeline refuses network and device paths for linked images (`//host/share`, `\\host\share`, `\\?\`), which on Windows would connect over SMB and send the user's credentials. `logos.mark` in brand.json must be a relative path inside the project, and linked images are capped in size and count.
- accessibility-design-audit escapes page-controlled text in its Markdown report.
- responsive-image-pipeline validates widths and formats and URL-encodes file names in the `<picture>` snippet.
- runtime-ux-audit never executes page JavaScript in its static pass, fetches only same-origin subresources by default, and caps every response by size and time.
- `atelier demo` refuses to write into the current directory, its parents, the home directory, a filesystem root or the plugin itself, and only ever deletes its own previous output.

### Removed

- Node 20 support.
- The GIF version of the overview clip; the README uses the animated WebP.
- Dependabot version-update pull requests; dependencies are upgraded by hand and audited weekly.

## [0.2.1] - 2026-05-08

### Security

- `html-to-video`: dropped `shell: true` from `spawn('ffmpeg', …)` and replaced it with an explicit PATH-resolved binary lookup. Closes a Windows command-injection path where shell metacharacters in the `outPath` argument (e.g. `out.mp4 & calc.exe`) would execute attached commands. ([#11](https://github.com/EthanY33/atelier/pull/11))
- `brand-memory`: `loadBrand()` now validates the parsed `.atelier/brand.json` against the schema; previously only `saveBrand()` validated, so a hand-edited or attacker-modified file slipped through unchecked. ([#12](https://github.com/EthanY33/atelier/pull/12))
- `design-token-sync` (Tailwind emitter): switched single-quoted interpolation of palette/typography values to `JSON.stringify`, so a free-form typography value cannot escape its string literal and execute as JS during the consumer's `npm run build`. ([#12](https://github.com/EthanY33/atelier/pull/12))

### Changed

- Emitted Tailwind config now uses double-quoted strings (side-effect of the `JSON.stringify` switch). Generated config remains valid JS and Tailwind consumes it identically.

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

[Unreleased]: https://github.com/EthanY33/atelier/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/EthanY33/atelier/compare/v0.2.1...v1.0.0
[0.2.1]: https://github.com/EthanY33/atelier/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/EthanY33/atelier/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/EthanY33/atelier/releases/tag/v0.1.0

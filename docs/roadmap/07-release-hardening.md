Epic label: `epic:release-hardening`. Tracking issue: [#59](https://github.com/EthanY33/atelier/issues/59). Milestone(s): v1.2, v1.3, v1.4. Estimate: 39 h.

# Distribution, supply chain and test hardening

## Goal

Make atelier safer to run on untrusted pull-request content, keep its exact-pinned dependencies current without bots, raise test protection where it is thin, and let people install the CLI with `npx` instead of a git clone.

## Current state

- `.github/workflows/audit.yml` runs `npm audit` for `plugins/atelier` with `--omit=dev` only, so the root dev dependencies (`vitest`, `@vitest/coverage-v8`) that CI runs on three operating systems are never audited. Its `npm outdated --prefix plugins/atelier || true` writes to a log nobody is notified about and ignores the root tree.
- Every third-party `uses:` line in `ci.yml`, `audit.yml` and `release.yml` is a mutable tag (`actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`). `release.yml` holds `contents: write` and force-pushes the floating major tag. `scripts/check-versions.mjs` does not check workflows. `ci.yml` also uses the local `./` action.
- docs/contributing.md (dependency upgrades) lists a manual sequence: install the exact version, run `setup:browsers` after a Playwright change, `npm test`, `check:versions`, `smoke:plugin`. It is easy to skip a step.
- Inputs from brand.json are guarded (`lib/io.mjs` `resolveBrandPath`, `isNetworkPath`), but outputs are written with plain `writeFileSync` or sharp `toFile` after `mkdirSync({ recursive: true })` in accessibility-design-audit, runtime-ux-audit, design-token-sync, brand-asset-pipeline, brand-memory, responsive-image-pipeline and og-card-generator. Writes follow symlinks, so a checked-in `out/` symlink can redirect writes outside the workspace when the Action runs on pull-request content, and a crash or full disk can leave a truncated `brand.json` or `ux-raw.json` that other skills then read. Only `scripts/run-demo.mjs` uses `lstat`.
- `vitest.config.mjs` gates only the aggregate at 70%. The last `coverage/lcov.info` (dated 2026-09-23, so stale) shows `html-to-video/index.mjs` at 75.5% lines, `lib/doctor.mjs` at 63% branches, `runtime-ux-audit/dynamic/probes.mjs` at 71% branches, `runtime-ux-audit/index.mjs` at 70% branches and `rules/inp/shared.mjs` at 68% branches. The `recordHtml` suite is behind `describe.skipIf(!hasFfmpeg)` (tests/html-to-video.test.mjs) and CI installs ffmpeg on all three operating systems.
- `tests/og-card-generator.test.mjs` checks DOM text, fonts and pixel counts in regions, but nothing pins the rendered card as a whole; a `template.html` change that shifts the logo can pass every assertion.
- Both `package.json` files are `private: true`, the plugin package has no `bin`, and docs/api.md says atelier is not published to npm. Installation is the Claude Code marketplace or a git clone plus `npm ci --prefix`. Unscoped `atelier` and `atelier-cli` are taken on npm; a scoped name such as `@ethany33/atelier` is free at the time of writing.

## Proposed design

### Supply chain

- Add a root-lockfile `npm audit --audit-level=high` step to `audit.yml` that fails rather than reports.
- Pin every third-party `uses:` to a 40-character commit SHA with the tag in a trailing comment, in all three workflows. Exclude the local `./` action.
- `scripts/check-versions.mjs` fails on any unpinned third-party `uses:` line.

### Upgrade checker

- `scripts/check-upgrades.mjs`: runs `npm outdated --json` for both trees (spawned without a shell; the npm registry is the only network access, and this script never ships in the plugin) and prints a table classified as major, minor or patch.
- `npm run upgrade:dep -- <pkg>@<ver>`: installs the exact version in the right tree, runs `setup:browsers` when Playwright changes, then `npm test`, `check:versions`, `smoke:plugin`, stopping at the first failure. It never commits.
- `audit.yml` runs the checker monthly and creates or updates one labelled issue for the month with `gh`. It never opens a pull request, keeping the human-authored-commit rule.

### Safe writes

- `writeFileAtomic(path, data)` and `ensureOutDir(dir)` in `lib/io.mjs`: write a temp file in the same directory, then rename (copy fallback on `EXDEV`); refuse when the target or an existing output directory is a symlink or a Windows junction, with exit 2 and a one-line `atelier:` message naming the path.
- Route every listed write site through them, including sharp outputs (encode to a buffer, then write atomically). File names, contents and other exit codes do not change.

### Coverage gate

- Regenerate coverage first. Add targeted tests: ffmpeg missing or exiting non-zero, temp-directory cleanup on failure, doctor branches for missing Chromium and an old Node version, probe timeouts, and the uncovered branches of `rules/inp/shared.mjs`.
- Enable per-file thresholds (`perFile: true`) at a floor every file passes (about 80% lines and 70% branches), keeping the global 70% as a backstop. Document the floor in docs/contributing.md.

### Card reference images

- Six or more fixtures (short title, maximum-length title, light background, dark background, with mark, long unbroken word) rendered at 1200 x 630 with a committed, openly licensed font file so glyphs are deterministic.
- Downscale with sharp (already pinned) to about 120 x 63 grayscale and compare with committed references under `tests/og-card-generator/__golden__/` using a per-pixel tolerance and a maximum share of differing pixels. No new dependency.
- Strict on the Ubuntu CI job; loose or skipped on Windows and macOS. On failure, write the actual and a diff image to a gitignored folder. `UPDATE_GOLDEN=1` regenerates.

### npm package

- Flip `private` and add `bin` and `files` to `plugins/atelier/package.json` (or a thin wrapper package), shipping `bin/`, `lib/`, `skills/`, `schemas/`, `examples/`, `scripts/run-demo.mjs`. Exact pins and the no-install-scripts rule stay; Chromium remains an on-demand download with the existing doctor and preflight fix text.
- A `release.yml` job runs `npm publish --provenance` after `check:versions`, gated on an npm token secret the maintainer creates; without the secret it skips with a clear log line.
- `scripts/smoke-installed-plugin.mjs` gains a variant that packs the tarball, installs it in a temp directory on three operating systems, and runs `doctor --no-browser` and `demo` through the bin shim.
- `check-versions.mjs` includes the published package version; getting-started.md and README show `npx <name> doctor` next to the clone path.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| Refusing to write through a symlinked or junctioned output path | New exit-2 case, documented in docs/api.md and SECURITY.md. Outputs and flags unchanged. |
| npm package and `npx` install path | Additive distribution channel. docs/api.md's "not published to npm" sentence is updated. |
| Workflow, audit, coverage and test changes | Repository tooling only; not covered by the contract. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#47](https://github.com/EthanY33/atelier/issues/47), 3 h, v1.2. Good first issue.
2. [#48](https://github.com/EthanY33/atelier/issues/48), 7 h, v1.2.
3. [#49](https://github.com/EthanY33/atelier/issues/49), 7 h, v1.2.
4. [#50](https://github.com/EthanY33/atelier/issues/50), 9 h, v1.3. Before the card template work in epic `assets-media`.
5. [#51](https://github.com/EthanY33/atelier/issues/51), 5 h, v1.3.
6. [#52](https://github.com/EthanY33/atelier/issues/52), 8 h, v1.4. Needs the maintainer to create the npm scope and token.

## Test plan

- `check:versions` fails on a fixture workflow with a tag-pinned third-party action and passes on the local `./` action.
- Atomic writes: a simulated write failure leaves the previous `brand.json` or `ux-raw.json` byte-identical; a symlinked output directory (POSIX) and a junction (Windows) exit 2 naming the path; existing golden and CLI tests pass unchanged on all three operating systems; line endings and encoding unchanged.
- Coverage: `npm run test:coverage` meets the per-file floor, and lowering a file below it fails the run; ffmpeg tests still skip cleanly when it is absent.
- Card references: pass three consecutive Ubuntu CI runs; moving a `template.html` element by 8 px fails; failure writes actual and diff images; Windows and macOS stay green.
- Upgrade checker: table covers both trees; the helper stops at the first failing step (tested with a stub runner); nothing is committed.
- npm: `npm pack` contains only runtime files; `npm publish --dry-run` succeeds; tarball install plus `doctor --no-browser` and `demo` pass on Ubuntu, macOS and Windows; publish job skips without the secret.

## Open questions

- Package name: `@ethany33/atelier` versus another scope. Needs the maintainer's decision before the npm issue starts.
- Should the safe-write refusal have an explicit override flag for users who deliberately symlink an output directory? Proposed: an `ATELIER_ALLOW_SYMLINK_OUT=1` style opt-in is a configuration surface to maintain; start without it and add only on request.
- Which font file to commit for card references, and its license. It must be redistributable under terms compatible with MIT.

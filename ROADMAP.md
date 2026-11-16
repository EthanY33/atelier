# Roadmap

This is the public plan for atelier after 1.1.0. Each item below is a GitHub issue grounded in a specific file, function, rule or documented gap in this repository. Estimates are hours of work for one developer using an AI coding assistant, including tests and documentation. They are effort sizes, not dates.

Total planned work: 261 h across 32 issues.

## How this roadmap is organized

- **Milestones.** `v1.2`, `v1.3` and `v1.4` hold additive work that keeps the 1.x contract in [docs/api.md](docs/api.md). `v2.0` holds anything that breaks that contract: a changed default, a removed or renamed export, flag or output, a narrower brand.json schema, or a `ux-raw.json` removal or type change.
- **Epics.** Related issues are grouped into seven epics. Each epic has a plan document under [docs/roadmap/](docs/roadmap/) with the current state, the proposed design, the semver impact and a test plan, and a tracking issue that links its child issues.
- **Labels.** Every issue carries:
  - `area:<skill-or-area>`, for example `area:runtime-ux-audit`, `area:action`, `area:design-token-sync`, `area:lib`, `area:ci`.
  - `kind:feature`, `kind:security`, `kind:perf`, `kind:testing`, `kind:ops`, `kind:dx` or `kind:docs`.
  - `epic:<slug>`, matching the epic table below.
  - The existing labels where they fit: `enhancement` for features, `good first issue` for small, well-scoped items.
- **Tracking issues.** Each epic has a tracking issue labelled `epic` that checks off its child issues as they close.

### Cross-cutting rules for every item

- `ux-raw.json` rejects unknown keys, so any new field moves `schemaVersion` from `"1.0"` to `"1.1"` (docs/api.md, ux-raw.json versioning). If several such changes land in the same minor release they share one `"1.1"` bump.
- brand.json only gains optional fields in 1.x.
- New runtime-ux rules use one of the four existing areas (`transitions`, `inp`, `panels`, `mobile`), since `area` is an enum in `ux-audit.schema.json`. Every new rule updates the rule count in README.md, CLAUDE.md, the SKILL.md tables and `registry.test.mjs`.
- No new runtime dependency unless an item says so; dev dependencies use exact pins.
- No process is spawned through a shell, and no item adds a network call beyond the page being audited or recorded, except the npm registry access in the release and upgrade tooling, which never runs inside the plugin.

## Epics

| Epic | Label | Plan | Issues | Estimate |
|---|---|---|---|---|
| CI gating for the audits | `epic:ci-gating` | [docs/roadmap/01-ci-gating.md](docs/roadmap/01-ci-gating.md) | 2 | 31 h |
| Audit results in CI tools | `epic:ci-reporting` | [docs/roadmap/02-ci-reporting.md](docs/roadmap/02-ci-reporting.md) | 4 | 30 h |
| Whole-site audits and static-pass speed | `epic:site-scale` | [docs/roadmap/03-site-scale.md](docs/roadmap/03-site-scale.md) | 3 | 37 h |
| WCAG 2.2 coverage | `epic:wcag-coverage` | [docs/roadmap/04-wcag-coverage.md](docs/roadmap/04-wcag-coverage.md) | 6 | 61 h |
| Brand tokens and themes | `epic:brand-tokens` | [docs/roadmap/05-brand-tokens.md](docs/roadmap/05-brand-tokens.md) | 5 | 28 h |
| Asset, card and video outputs | `epic:assets-media` | [docs/roadmap/06-assets-media.md](docs/roadmap/06-assets-media.md) | 6 | 35 h |
| Distribution, supply chain and test hardening | `epic:release-hardening` | [docs/roadmap/07-release-hardening.md](docs/roadmap/07-release-hardening.md) | 6 | 39 h |

## v1.2

Adoption blockers for CI, the smallest high-value output fixes, and the security and coverage work that later items build on. 82 h.

| Issue title | Issue | Epic | Estimate |
|---|---|---|---|
| feat(audits): add a baseline file so CI can adopt the audits on an existing site | [#21](https://github.com/EthanY33/atelier/issues/21) | ci-gating | 17 h |
| feat(audits): add --fail-on and per-rule config via an audit config file | [#22](https://github.com/EthanY33/atelier/issues/22) | ci-gating | 14 h |
| feat(action): expose audit counts as outputs and a bounded PR summary | [#23](https://github.com/EthanY33/atelier/issues/23) | ci-reporting | 5 h |
| feat(action): inline PR annotations from audit findings | [#24](https://github.com/EthanY33/atelier/issues/24) | ci-reporting | 5 h |
| feat(accessibility-design-audit): add --wcag preset, WCAG 2.2 gap notice and a Needs review section | [#30](https://github.com/EthanY33/atelier/issues/30) | wcag-coverage | 9 h |
| feat(design-token-sync): emit motion and surface tokens from brand.json | [#36](https://github.com/EthanY33/atelier/issues/36) | brand-tokens | 5 h |
| feat(design-token-sync): add --check mode to fail CI when committed tokens are stale | [#37](https://github.com/EthanY33/atelier/issues/37) | brand-tokens | 3 h |
| feat(responsive-image-pipeline): add width and height attributes to the picture snippet | [#41](https://github.com/EthanY33/atelier/issues/41) | assets-media | 3 h |
| feat(brand-asset-pipeline): generate App Store, Google Play and itch.io assets for deploy.stores | [#42](https://github.com/EthanY33/atelier/issues/42) | assets-media | 4 h |
| fix(ci): audit root dev dependencies and pin GitHub Actions to commit SHAs | [#47](https://github.com/EthanY33/atelier/issues/47) | release-hardening | 3 h |
| fix(lib): atomic, symlink-safe writes for reports, tokens and assets | [#48](https://github.com/EthanY33/atelier/issues/48) | release-hardening | 7 h |
| test(coverage): raise html-to-video, doctor and dynamic probe coverage and add a per-file gate | [#49](https://github.com/EthanY33/atelier/issues/49) | release-hardening | 7 h |

## v1.3

Code scanning, multi-page runs, faster remote audits, the first WCAG 2.2 dynamic probes, and new token and card tooling. 102 h.

| Issue title | Issue | Epic | Estimate |
|---|---|---|---|
| feat(audits): emit SARIF 2.1.0 for GitHub code scanning from both audits | [#25](https://github.com/EthanY33/atelier/issues/25) | ci-reporting | 13 h |
| feat(audits): audit many pages in one run with --urls and an aggregated summary | [#27](https://github.com/EthanY33/atelier/issues/27) | site-scale | 16 h |
| feat(audits): discover pages from a sitemap with --sitemap | [#28](https://github.com/EthanY33/atelier/issues/28) | site-scale | 8 h |
| perf(runtime-ux-audit): fetch subresources concurrently and add a large-page benchmark test | [#29](https://github.com/EthanY33/atelier/issues/29) | site-scale | 13 h |
| feat(runtime-ux-audit): add dynamic keyboard probe for focus-not-obscured, focus visibility and keyboard traps | [#32](https://github.com/EthanY33/atelier/issues/32) | wcag-coverage | 16 h |
| feat(runtime-ux-audit): add reflow and text-spacing probes (WCAG 1.4.10 and 1.4.12) to the dynamic pass | [#33](https://github.com/EthanY33/atelier/issues/33) | wcag-coverage | 12 h |
| feat(design-token-sync): add scss and Tailwind v4 @theme CSS targets | [#40](https://github.com/EthanY33/atelier/issues/40) | brand-tokens | 5 h |
| feat(og-card-generator): skip unchanged cards with a content-hash cache | [#43](https://github.com/EthanY33/atelier/issues/43) | assets-media | 5 h |
| test(og-card-generator): add reference-image regression tests for card layouts | [#50](https://github.com/EthanY33/atelier/issues/50) | release-hardening | 9 h |
| feat(scripts): scripted monthly dependency upgrade check for exact pins | [#51](https://github.com/EthanY33/atelier/issues/51) | release-hardening | 5 h |

## v1.4

Remaining probes, non-GitHub CI output, themes, richer card and video controls, and npm distribution. 74 h.

| Issue title | Issue | Epic | Estimate |
|---|---|---|---|
| feat(audits): add JUnit XML output for GitLab, Jenkins and Azure Pipelines | [#26](https://github.com/EthanY33/atelier/issues/26) | ci-reporting | 7 h |
| feat(runtime-ux-audit): add a reduced-motion dynamic probe that measures whether motion stops | [#34](https://github.com/EthanY33/atelier/issues/34) | wcag-coverage | 13 h |
| feat(runtime-ux-audit): add the deferred combobox-focus-in-listbox dynamic probe | [#35](https://github.com/EthanY33/atelier/issues/35) | wcag-coverage | 8 h |
| feat(brand-memory): add optional dark theme to brand.json and emit it in tokens | [#38](https://github.com/EthanY33/atelier/issues/38) | brand-tokens | 9 h |
| feat(design-token-sync): add W3C DTCG tokens.json target for Style Dictionary | [#39](https://github.com/EthanY33/atelier/issues/39) | brand-tokens | 6 h |
| feat(og-card-generator): add built-in templates, custom template files and per-page accent and image overrides | [#44](https://github.com/EthanY33/atelier/issues/44) | assets-media | 10 h |
| feat(html-to-video): write animated GIF and animated WebP directly | [#45](https://github.com/EthanY33/atelier/issues/45) | assets-media | 6 h |
| feat(html-to-video): add scale, color scheme, quality and ready-selector capture controls | [#46](https://github.com/EthanY33/atelier/issues/46) | assets-media | 7 h |
| feat(cli): publish the atelier CLI to npm as a standalone package | [#52](https://github.com/EthanY33/atelier/issues/52) | release-hardening | 8 h |

## v2.0

Changes that break the 1.x contract in docs/api.md. 3 h.

| Issue title | Issue | Epic | Estimate |
|---|---|---|---|
| feat(accessibility-design-audit)!: make WCAG 2.2 AA the default rule set | [#31](https://github.com/EthanY33/atelier/issues/31) | wcag-coverage | 3 h |

## Dependencies between items

- The baseline fingerprint (ci-gating) is reused as SARIF `partialFingerprints` (ci-reporting), so SARIF follows the baseline.
- The Action outputs helper (ci-reporting) is reused by the annotations step and by the multi-page Action input (site-scale).
- SARIF upload uses a SHA-pinned `github/codeql-action`, which follows the SHA pinning item (release-hardening).
- Motion and surface tokens (brand-tokens) land before the scss, Tailwind v4 and DTCG targets so those targets emit them from the start.
- The reference-image card tests (release-hardening) land before the card template work (assets-media) so the default layout is pinned first.
- The WCAG 2.2 default (v2.0) depends on the `--wcag` preset (v1.2).

## Outside this list

Listing the GitHub Action on GitHub Marketplace is a pending owner step done in the GitHub release UI. It needs no code change and is not tracked as an issue here.

## Not planned

These are deliberate exclusions, drawn from CLAUDE.md, docs/architecture.md and docs/specs/runtime-ux-audit.md. A proposal that reverses one needs a new decision from the maintainer, not just a pull request.

| Not planned | Reason |
|---|---|
| Telemetry, usage analytics or crash reporting | CLAUDE.md and docs/architecture.md: no telemetry and no network calls beyond the page being audited or recorded. |
| Network calls beyond the audited or recorded page (remote rule packs, update checks, hosted reports) | Same rule. The static pass fetches only same-origin subresources with size and time caps. |
| Calling a model API from any skill | atelier is deterministic tooling; Claude Code drives it. Outputs must be byte-identical for the same inputs. |
| Dependabot or bot-authored upgrade pull requests | CLAUDE.md: exact pins upgraded by hand, every commit has a human author. The planned upgrade checker opens a report issue, never a pull request. |
| Install scripts or postinstall steps in the plugin | docs/architecture.md rule 2: marketplace installs run `npm ci --ignore-scripts`; Chromium is installed on demand. |
| Spawning processes through a shell | CLAUDE.md: binaries are resolved on PATH and spawned with `shell: false`. |
| Lab LCP and CLS rules reading `targets.lcpBudgetMs` and `targets.clsBudget` | docs/specs/runtime-ux-audit.md, Out of scope: Lighthouse covers LCP and CLS; throttled lab numbers on fixtures are too noisy for a CI gate. The fields stay validated and echoed. |
| Production field data (RUM) collection | docs/specs/runtime-ux-audit.md, Out of scope: the skill audits one page at a point in time and deploys nothing. |
| React-specific or framework-specific rules | docs/specs/runtime-ux-audit.md, Out of scope: the audit is framework-agnostic. |
| Automatic fixing of audit findings | docs/specs/runtime-ux-audit.md, Out of scope: the audits report; a codemod would be a separate tool. |
| Screenshot or frame-by-frame visual regression inside the audit | docs/specs/runtime-ux-audit.md, Out of scope. (The planned card reference-image test is a test of og-card-generator output, not an audit feature.) |
| Re-adding the deferred runtime-ux rules other than `combobox-focus-in-listbox` | docs/specs/runtime-ux-audit.md lists the reasons for each deferral, several contradicted by measurement. |
| A watch mode, shell completions, or a bespoke golden-file review tool | Reviewed and dropped as low value: regeneration takes seconds, most runs happen in Claude Code or CI, and `git diff` after `UPDATE_GOLDEN=1` already reviews goldens. |

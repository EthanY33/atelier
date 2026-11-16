Epic label: `epic:site-scale`. Tracking issue: [#55](https://github.com/EthanY33/atelier/issues/55). Milestone(s): v1.3. Estimate: 37 h.

# Whole-site audits and static-pass speed

## Goal

Audit every template of a site in one command and one Action step, with one summary, one exit code and one Chromium launch, and make remote static audits fast enough that the 30 second budget is not spent waiting on serial fetches.

## Current state

- `plugins/atelier/skills/runtime-ux-audit/lib/options.mjs` `parseCliArgs` rejects more than two positionals (`<url|file> [outDir]`). `accessibility-design-audit/index.mjs` `runCli` has the same check.
- `action.yml` input `target` is a single string. Gating a built `dist/` with many pages needs a matrix job that repeats checkout, Node setup, `npm ci` and the Chromium download per page.
- `accessibility-design-audit` `auditPage` already accepts a `browser` option, so a caller can share one Chromium across pages.
- `runtime-ux-audit/lib/fetch.mjs` applies a same-origin and redirect policy (no redirect to a private address), which a multi-page runner must apply per page.
- `runtime-ux-audit/lib/collect.mjs` loads subresources strictly in series: `addSheet` and `addScript` are awaited inside the `for` loop over `html.elements`, and `@import` chains and module graphs recurse with further awaits. `DEFAULT_LIMITS` sets `maxResources: 64` and `totalTimeoutMs: 30000`. Resource order comes from `nextOrder`, assigned inside the loader. On a remote page with dozens of assets the total budget can run out, which drops resources and moves findings to Needs review. Local file audits are not affected.

## Proposed design

### Multi-page orchestrator

- New `plugins/atelier/lib/multi.mjs`, used by both CLIs and the Action. The single-page API is not changed.
- Inputs: `--urls <file>` (one URL or path per line, `#` comments, blank lines ignored) on `atelier ux` and `atelier a11y`.
- Output layout: `<out>/<slug>/` per page, where the slug is derived from the URL path or file path and made unique deterministically (for example `index`, `blog-index`, `blog-index-2`). Plus `<out>/summary.md` and `<out>/summary.json` with per-page counts.
- Cross-page deduplication in the summary: a finding with the same rule id and selector on more than half the pages is listed once under "Site-wide" with the page count.
- Exit code: the highest per-page code with the existing meanings. A page that cannot run (exit 2) does not stop the others unless `--fail-fast` is given.
- Browsers: one shared Chromium for a11y and for ux `--dynamic`, with a small concurrency (default 2, `--concurrency`). Static ux pages run in sequence.
- The SSRF and redirect policy in `fetch.mjs` applies to each page unchanged.
- Action: the existing `target` input also accepts a newline- or comma-separated list and workspace-relative globs, expanded in node with `fs.glob` (Node 22), never by a shell. A `max-targets` cap (default 25) fails fast with exit 2 when exceeded. URLs are never globbed. With one resolved target the layout stays `<out>/a11y` and `<out>/ux`, byte-identical to today.

### Sitemap discovery

- `--sitemap <url|file>` feeds the same orchestrator.
- Strict, size-bounded parser for `sitemap.xml` and sitemap index files written for this purpose (no new dependency): reject DTDs and entities, cap the document at a few MB and the depth of index nesting at 2.
- Same-origin entries only; cross-origin entries are reported as skipped in the summary.
- `--max-pages` (default 25) caps the total.

### Concurrent subresource loading

- Split `collect()` into three phases. Discovery walks `html.elements` synchronously and records ordered fetch tasks (kind, URL, element, media) and assigns `order` from discovery order. Loading runs tasks through a bounded pool. Imports and module graphs are processed level by level through the same pool, with order assigned at discovery.
- New `limits.concurrency` (default 6, validated like other limits); `1` reproduces the serial behavior exactly.
- The `maxResources` check happens atomically before dispatch, so the cap is never exceeded by in-flight requests.
- All existing policies (same-origin, redirect, size caps, total timeout) stay as they are.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| Flags `--urls`, `--sitemap`, `--max-pages`, `--concurrency`, `--fail-fast` | Additive, minor. Single-target invocation, its output paths and stdout are byte-identical. |
| New files `summary.md`, `summary.json` and per-page folders | Written only in multi-page mode. `summary.json` gets its own small schema in `plugins/atelier/schemas`. |
| Action `target` accepting a list or glob, new `max-targets` input | Additive. A single string behaves as today. |
| `limits.concurrency` runtime-ux-audit option | Additive option with a documented default. |
| `ux-raw.json` per page | Unchanged; resource order is byte-identical by design. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#27](https://github.com/EthanY33/atelier/issues/27), 16 h. Orchestrator, per-page layout, summary and dedup, shared browser, Action list and glob input.
2. [#28](https://github.com/EthanY33/atelier/issues/28), 8 h. Parser, same-origin filter, caps.
3. [#29](https://github.com/EthanY33/atelier/issues/29), 13 h. Independent of the other two, but its value grows with multi-page runs.

## Test plan

- `--urls` with three local fixtures writes three page folders and a summary with correct counts; one unreachable page gives that page exit 2, the rest complete, overall exit 2; `--fail-fast` stops at the first.
- Slugs are unique for several `index.html` files in different folders.
- Site-wide dedup collapses a finding present on all pages.
- A test counts Chromium launches for a multi-page a11y run and expects one.
- Single-target runs compare byte-for-byte against current goldens.
- Action: CI self-test with a 2-page fixture directory and a glob; more matches than `max-targets` exits 2.
- Sitemap: index with children, cross-origin entries skipped and reported, `--max-pages` honored, a DTD or entity declaration rejected, an oversized document rejected.
- Concurrency: across all existing golden fixtures, resource order and `ux-raw.json` are byte-identical to the serial implementation; with a fake `fetchImpl` adding 150 ms latency to 60 resources, the test asserts the observed peak of in-flight requests equals the configured concurrency (not a wall-clock ceiling, which is flaky on CI); `concurrency: 1` matches serial order; `tests/runtime-ux-audit/hardening.test.mjs` passes unmodified.
- A large synthetic page (about 3 MB HTML, 20k elements) runs twice with identical raw JSON.

## Open questions

- Should multi-page mode be a separate `atelier site` subcommand instead of flags on `ux` and `a11y`? Proposed: flags, so both audits share one orchestrator and the Action needs no new command.
- Default concurrency for dynamic runs on 2-core CI runners: 2 is a guess; measure on `ubuntu-latest` before release.

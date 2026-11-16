Epic label: `epic:ci-reporting`. Tracking issue: [#54](https://github.com/EthanY33/atelier/issues/54). Milestone(s): v1.2, v1.3, v1.4. Estimate: 30 h.

# Audit results in CI tools

## Goal

Put audit findings where reviewers already look: as Action outputs that later steps can branch on, as inline annotations on the pull request, as GitHub code-scanning alerts that can be dismissed and tracked, and as JUnit XML for GitLab, Jenkins and Azure Pipelines.

## Current state

- `action.yml` exposes one output, `report-dir`, which echoes `inputs.out`. Callers who want counts must parse `a11y-raw.json` and `ux-raw.json` themselves.
- The last step of `action.yml` appends every `*/*-report.md` to `$GITHUB_STEP_SUMMARY` with a plain `cat`. There is no size guard against GitHub's 1 MiB step-summary limit. (The a11y report caps selectors at 5 per rule, so this is a guard, not a frequent failure.)
- No step emits `::error` or `::warning` workflow commands, so a failing check gives reviewers no per-finding pointer.
- Neither audit writes SARIF or JUnit; a repository-wide search for `sarif` and `junit` finds nothing. `accessibility-design-audit/index.mjs` `auditPage` writes only `a11y-report.md` and `a11y-raw.json`; runtime-ux-audit writes `ux-report.md` and `ux-raw.json`.
- `runtime-ux-audit/lib/report-raw.mjs` already records each rule's `id`, `area`, `severity`, `helpUrl` and `status` (`failed`, `passed`, `incomplete`, `notApplicable`, `skipped`, `error`) and cleaned nodes with `selector`, `snippet` and, for static findings, `location` (`file:line`). These map directly onto SARIF results and JUnit test cases.
- `ajv` 8.20.0 is already a plugin dependency, so SARIF output can be validated in tests without a new dependency.
- `.github/workflows/ci.yml` has an `action` job that runs the Action on the example page and checks that files exist.

## Proposed design

### Shared findings helper

`plugins/atelier/lib/findings.mjs` reads `a11y-raw.json` and `ux-raw.json` (or the in-memory results) and returns one normalized list: `{ tool, ruleId, severity, helpUrl, message, selector, snippet, location?, fingerprint }`. The fingerprint comes from `lib/baseline.mjs` (epic `ci-gating`). Every output in this epic is a pure function of that list, which keeps them deterministic and testable without Chromium.

### Action outputs and summary

- A node script under `plugins/atelier/scripts/` (no shell parsing) writes `a11y-critical`, `a11y-serious`, `ux-critical`, `ux-serious`, `violations-total`, `failed` and `exit-code` to `$GITHUB_OUTPUT`.
- The summary step is replaced by a generated summary: a counts table first, then each report truncated at about 900 KB with a pointer to the uploaded report artifact.
- With `audits: a11y` only the a11y outputs are set.

### Annotations

- New input `annotations` (default `true`).
- Critical and serious become `::error`, moderate becomes `::warning`, minor is omitted. `title=` is the rule id; `file=` is set only when the target is a local file inside the workspace (and `line=` when a ux static `location` is known).
- Output is capped at 10 errors and 10 warnings per step, GitHub's display limit, followed by one `::notice` with the omitted count.
- Escaping follows GitHub's workflow-command rules: `%`, CR and LF in messages; additionally `:` and `,` in properties.

### SARIF 2.1.0

- `plugins/atelier/lib/sarif.mjs`: one `reportingDescriptor` per rule (`id`, `helpUri`, default level: critical and serious to `error`, moderate to `warning`, minor to `note`), one result per node.
- Every result carries a `physicalLocation`, because GitHub code scanning drops results without one: the node's `file:line` when known (ux static findings on local files), otherwise the audited file at `startLine: 1`. Selector and snippet go in the message and a `logicalLocation`. For URL targets the artifact is the URL; the docs state that code-scanning alerts are most useful for file and built-HTML targets.
- `partialFingerprints` use the baseline fingerprint so alerts track across runs.
- Incomplete (needs review) entries are omitted by default.
- CLI flag `--sarif <file>` on `atelier ux` and `atelier a11y`; API option `sarifPath`.
- Action input `upload-sarif` (default `false`) runs `github/codeql-action/upload-sarif` pinned to a commit SHA; docs state the `security-events: write` permission it needs.
- The official SARIF 2.1.0 JSON schema is vendored under `tests/fixtures/` so tests validate offline with `ajv`.

### JUnit XML

- `plugins/atelier/lib/junit.mjs`: a hand-written writer with escaping, no dependency.
- ux: one `testsuite` per area, one `testcase` per rule; `failed` becomes `<failure type="<severity>">` with up to 5 nodes; `incomplete`, `notApplicable` and suppressed rules become `<skipped message>`.
- a11y: one `testsuite`; a `testcase` per axe rule from `passes`, `violations`, `incomplete` and `inapplicable`.
- XML-illegal characters (control characters, unpaired surrogates, U+FFFE and U+FFFF) are stripped from page-derived text, and `]]>` cannot terminate a section because text is entity-escaped rather than wrapped in CDATA.
- CLI flag `--junit <file>` on both audits.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| Action outputs `a11y-critical`, `a11y-serious`, `ux-critical`, `ux-serious`, `violations-total`, `failed`, `exit-code` | Additive. Documented in docs/api.md and getting-started.md. `report-dir` unchanged. |
| Action inputs `annotations`, `upload-sarif` | Additive. |
| Step summary content | Not covered by the contract; still starts with the reports' content after the counts table. |
| CLI flags `--sarif <file>`, `--junit <file>`; API option `sarifPath` (and `junitPath`) | Additive. New files written only when requested. |
| Existing files, `ux-raw.json`, exit codes | Unchanged. No `schemaVersion` bump in this epic. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#23](https://github.com/EthanY33/atelier/issues/23), 5 h, v1.2. Introduces `lib/findings.mjs` and the outputs script.
2. [#24](https://github.com/EthanY33/atelier/issues/24), 5 h, v1.2. Reuses the findings helper.
3. [#25](https://github.com/EthanY33/atelier/issues/25), 13 h, v1.3. Needs the baseline fingerprint (epic `ci-gating`) and the SHA pinning work (epic `release-hardening`).
4. [#26](https://github.com/EthanY33/atelier/issues/26), 7 h, v1.4.

## Test plan

- Outputs: values equal the counts in the raw JSON for `examples/page.html`; `audits: a11y` leaves ux outputs empty; `ci.yml` `action` job asserts at least two outputs.
- Summary: a synthetic 3 MB report produces a summary under 1 MiB that starts with the counts table and names the artifact.
- Annotations: at most 10 `::error` and 10 `::warning` lines plus the notice; hostile selectors with newlines, `%0A`, `::`, `:` and `,` cannot start a second command (unit test on the escaper).
- SARIF: output validates against the vendored 2.1.0 schema; rule ids match `ux-raw.json` and axe ids; a static finding with `location` yields a repo-relative `artifactLocation.uri` and `startLine`; every result has a `physicalLocation`; byte-identical output for the same inputs and `--timestamp`. Upload to a test repository's Security tab is verified by hand and noted in the pull request.
- JUnit: output parses back (a minimal parser in the test, no dependency); `tests`, `failures` and `skipped` counts equal the rule statuses; page text containing `]]>`, NUL, other control characters and unpaired surrogates cannot break the document or inject elements; deterministic output.

## Open questions

- Should annotations and SARIF both be on by default? Proposed: annotations on, SARIF upload off (it needs an extra permission).
- Should needs-review entries be emitted as SARIF `note` results behind a flag? Proposed: not in the first version.
- GitLab users may also want the Code Quality JSON format. Out of scope until someone asks; JUnit covers the common case.

Epic label: `epic:ci-gating`. Tracking issue: [#53](https://github.com/EthanY33/atelier/issues/53). Milestone(s): v1.2. Estimate: 31 h.

# CI gating for the audits

## Goal

Let a team with an existing site turn on the accessibility and runtime UX gates in CI today, fail only on new problems, and tune the failure threshold and rule set for their design system, without forking atelier or disabling rules everywhere.

## Current state

- `plugins/atelier/skills/runtime-ux-audit/lib/report-raw.mjs`, `summarize()`: `pass` is `critical + serious === 0`. The CLI exits 1 whenever that is false.
- `plugins/atelier/skills/accessibility-design-audit/index.mjs`, `runCli`: exits 1 on any critical or serious axe violation. `auditPage` builds `new AxeBuilder({ page }).withTags(tags)` and nothing else, so there is no way to disable an axe rule or exclude a region.
- The only escape hatches are `atelier ux --ignore <rule-id>` (whole rule, whole page, handled in `runtime-ux-audit/lib/options.mjs` `normalizeOptions`) and in-source `atelier-ignore` markers (`runtime-ux-audit/lib/suppress.mjs`). The a11y audit has neither.
- `action.yml` "Run audits" step runs both CLIs and fails the job on their exit code. It has no input to change the threshold or accept known findings.
- docs/api.md describes the exit codes (0, 1 on critical or serious, 2 could not run) and states that `ux-raw.json` rejects unknown keys, so any new field means `schemaVersion` `"1.1"`.

The result: a legacy page with a few known serious findings cannot enable the gate, and the workaround (`--ignore` on whole rules) hides every future regression of that rule.

## Proposed design

### Baseline file

- New shared module `plugins/atelier/lib/baseline.mjs`.
- Fingerprint per finding node, independent of line numbers so edits above a finding do not invalidate it:
  - ux: `sha256(ruleId + "\n" + normalizedSelector + "\n" + normalizedSnippet)`, where normalization collapses whitespace and strips volatile attributes already removed by `cleanNode` in `report-raw.mjs`.
  - a11y: `sha256(axeRuleId + "\n" + formatTarget(target))`, using the existing shadow DOM and iframe target notation.
- File format: `.atelier/ux-baseline.json` and `.atelier/a11y-baseline.json`, each `{ "schemaVersion": "1", "tool": "ux" | "a11y", "entries": [{ "fingerprint", "ruleId", "selector" }] }`, sorted by fingerprint so the file diffs cleanly. Schema in `plugins/atelier/schemas/audit-baseline.schema.json`, checked by `scripts/validate-schemas.mjs`.
- CLI: `--baseline <file>` reads it; `--update-baseline` writes the current findings to it and exits 0. Baselined nodes are excluded from `pass` and the exit code and counted as "Baselined" in the report. Entries with no matching finding are listed as "Fixed since baseline" so the file can be tightened.
- API: optional `baseline` (path or parsed object) and `updateBaseline` options on both audits.
- Action: optional `baseline` input (path), passed to both CLIs.

### Audit config and threshold

- Optional `.atelier/audits.json`, auto-loaded by the CLIs only (the API takes a `config` object), validated against `plugins/atelier/schemas/audits.schema.json` with unknown keys rejected:
  - `failOn`: `"critical" | "serious" | "moderate" | "minor" | "none"`, default `"serious"` (today's behavior).
  - `ux`: `{ "severity": { "<rule-id>": "<level>" }, "disable": ["<rule-id>"] }`.
  - `a11y`: `{ "disableRules": ["<axe-id>"], "tags": [...], "include": ["<css>"], "exclude": ["<css>"] }`, passed to `AxeBuilder.disableRules`, `.include` and `.exclude`.
- CLI flags override the file: `--fail-on <level>` on both, `--disable-rule <id>` (repeatable) and `--exclude <selector>` (repeatable) on a11y.
- Effective severity drives `summary.pass` and the exit code. Overrides are shown in both reports ("severity overridden by config") and in `ux-raw.json` `rules[]`.
- Unknown rule ids in the config are a usage error (exit 2) that lists the closest known ids.
- Action: optional `fail-on` and `config` inputs.

## API, schema and CLI changes and semver impact

| Change | Covered by docs/api.md | Impact |
|---|---|---|
| New flags `--baseline`, `--update-baseline`, `--fail-on`, `--disable-rule`, `--exclude` | Flags | Additive, minor. Defaults keep today's behavior. |
| New API options `baseline`, `updateBaseline`, `failOn`, `config` | Option names and defaults | Additive, minor. |
| New files `.atelier/*-baseline.json`, `.atelier/audits.json` and their schemas | Files written | Additive. Written only on request. |
| `ux-raw.json` gains `summary.baselined`, per-rule `overridden` data | ux-raw.json | Additive, so `schemaVersion` becomes `"1.1"`. One bump shared by both issues if they ship together in v1.2. Schema, goldens and docs/api.md updated in the same pull request. |
| `a11y-raw.json` | Full axe result | Unchanged. Baseline and override data appear in `a11y-report.md` and stdout only. |
| Exit codes | Exit codes | Meaning unchanged. docs/api.md gains a sentence that the threshold is configurable and defaults to critical plus serious. A malformed baseline or config is exit 2 with a `Fix:` line, matching existing usage errors. |
| Action inputs `baseline`, `fail-on`, `config` | Action docs in getting-started.md | Additive. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#21](https://github.com/EthanY33/atelier/issues/21), 17 h. Fingerprinting, baseline schema, both CLIs, report sections, `ux-raw.json` 1.1, Action input, docs.
2. [#22](https://github.com/EthanY33/atelier/issues/22), 14 h. Config schema and loader, threshold, overrides in both reports, a11y include, exclude and disable, Action inputs, docs.

Order: the baseline first. The config work then reuses the same "effective findings" step that decides `pass`, so baselined and overridden findings are computed in one place.

## Test plan

- Fingerprint stability: a fixture where lines are inserted above a finding keeps the same fingerprint; changing the element's snippet changes it.
- A11y fingerprints over shadow DOM and iframe targets.
- `--update-baseline` exits 0 with serious findings; a rerun with `--baseline` exits 0; one added serious finding exits 1 and names only that finding.
- Stale entries appear as "Fixed since baseline" in `ux-report.md` and `a11y-report.md`.
- `--fail-on moderate` fails a page with only a moderate finding; `--fail-on none` exits 0 unless the audit cannot run.
- A severity override changes both the report and `summary.pass`; unknown rule ids exit 2 with suggestions.
- `--exclude '#cookie-banner'` removes violations inside that element (Chromium fixture).
- Malformed baseline or config: exit 2 with a `Fix:` line.
- Determinism: same inputs and `--timestamp` give byte-identical reports, raw JSON and baseline files.
- `ux-raw.json` 1.1 validates against the updated schema; goldens regenerated with `UPDATE_GOLDEN=1` and reviewed.

## Open questions

- Should `--update-baseline` refuse to drop entries for findings that still exist but moved to a lower severity, or simply rewrite the file? Proposed: rewrite, since the file is committed and reviewed in a diff.
- Should `audits.json` also hold the baseline path so the Action needs one input instead of two? Proposed: yes, as an optional `baseline` key.
- If the config issue slips to v1.3, it needs its own `schemaVersion` bump (`"1.2"`). Decide at release time.

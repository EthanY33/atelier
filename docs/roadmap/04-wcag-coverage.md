Epic label: `epic:wcag-coverage`. Tracking issue: [#56](https://github.com/EthanY33/atelier/issues/56). Milestone(s): v1.2, v1.3, v1.4, v2.0. Estimate: 61 h.

# WCAG 2.2 coverage

## Goal

Close the gaps between what a clean atelier run implies and what it actually checks: make WCAG 2.2 AA selectable and later the default in the a11y audit, say plainly which criteria no automated tool covers, and add measured dynamic probes for focus, reflow, text spacing, reduced motion and comboboxes that axe does not test.

## Current state

- `plugins/atelier/skills/accessibility-design-audit/index.mjs` `DEFAULT_TAGS` is `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. WCAG 2.2 rules such as `target-size` run only with `--tags wcag22aa` (SKILL.md documents this). docs/api.md lists `DEFAULT_TAGS` as an export with this value.
- `buildMarkdownReport` reduces `result.incomplete` to a count line and renders only selectors per violation node; the `html` and `failureSummary` that axe returns are dropped.
- No report states which WCAG 2.2 A and AA criteria axe cannot automate (2.4.11 Focus Not Obscured, 2.5.7 Dragging Movements, 3.2.6 Consistent Help, 3.3.7 Redundant Entry, 3.3.8 Accessible Authentication), so a clean run reads as compliant.
- `runtime-ux-audit/dynamic/probes.mjs` `runInteractions` presses Tab up to `maxTabs` (12) times and records `activePath()` into `attempted[]`, but never checks where focus lands. The only focus rule is `focus-lost-after-close` in `rules/panels/dynamic.mjs`.
- The dynamic pass uses one Pixel 7 profile (`DEVICE` in `probes.mjs`, 412 px wide), never resizes the viewport and never injects styles. The mobile rules in `rules/mobile/viewport.mjs` inspect the static viewport meta and CSS. Axe has `avoid-inline-spacing` for inline `!important` spacing only; nothing measures reflow at 320 CSS px (1.4.10) or clipping under raised text spacing (1.4.12).
- `vta-no-reduced-motion-guard` (`rules/transitions/view-transitions.mjs`) and `motion-no-reduced-motion-guard` (`rules/panels/css.mjs`) judge source text only. `dynamic/index.mjs` `setup()` creates the browser context without `reducedMotion`, so nothing verifies that motion actually stops.
- docs/specs/runtime-ux-audit.md "Deferred (9)" lists `combobox-focus-in-listbox` as needing a scripted open of each combobox, "a candidate for a later dynamic probe". `probeDialogs` and `DYNAMIC_LIMITS.maxDialogTriggers` in `lib/options.mjs` are the pattern to follow.
- `ux-audit.schema.json` restricts `area` to `transitions`, `inp`, `panels`, `mobile` and rule ids to `atelier/runtime-ux/<kebab-id>`. Dynamic limits are not echoed into `ux-raw.json`.

## Proposed design

### a11y: `--wcag` preset and honest reports (1.x)

- `--wcag <2.0|2.1|2.2>` and API `wcagVersion` expand to the cumulative tag set (2.2 adds `wcag22aa`). `--tags` with `--wcag` is a usage error, so precedence never surprises anyone. `DEFAULT_TAGS` is unchanged.
- A static, documented table of WCAG 2.2 A and AA success criteria marks which ones axe cannot automate. Whenever the effective tags include `wcag22aa` the report appends "Not covered by automated checks" with a manual-test pointer per criterion; every report gets a one-line note under the Rules header.
- `incomplete` rules render as "Needs manual review" (rule, help URL, up to 5 selectors).
- Each violation node shows the first line of `failureSummary` and a truncated `html` snippet, all through `mdCodeSpan`.
- A unit test reads the installed axe rule metadata and fails if a `wcag22aa` rule is neither covered nor listed, so an axe upgrade cannot silently drift from the table.

### a11y: WCAG 2.2 AA default (2.0)

`DEFAULT_TAGS` gains `wcag22aa`; `--wcag 2.1` reproduces the 1.x rule set; the Action default, SKILL.md, docs/api.md and a CHANGELOG migration note change together.

### runtime-ux dynamic probes

All probes follow the existing architecture: probes collect facts, rules judge. Each is a separate step in `dynamic/index.mjs` so a failure lands in `errors[]` without stopping the others, each is bounded by `dynamicTimeoutMs` or its own limit, and none submits a form, follows a link or activates a control beyond what is stated.

- **Keyboard** (area `panels`). Per Tab stop: focused element rect; `document.elementFromPoint` at center and corners to find an overlapping `position: fixed` or `sticky` element; computed `outline`, `box-shadow` and `border` against the unfocused state. Rules:
  - `focus-obscured-by-fixed-element`: serious only when the focused element is entirely hidden (2.4.11 AA); partial overlap is at most minor, since partial obscuring is 2.4.12 (AAA).
  - `no-visible-focus-indicator` (2.4.7): serious; `:focus-visible` rings and box-shadow rings pass.
  - `keyboard-trap` (2.1.2): focus cycles among the same elements for N presses without reaching the document end; reported as Needs review unless reproduced twice.
  - New limit `maxKeyboardTabs` (default 40). Tab only.
- **Reflow and text spacing** (area `mobile`).
  - Reflow: viewport 320 x 256, settle, compare `scrollWidth` with `clientWidth`, list up to 5 widest offenders using the existing `__atelierCssPath` helper from `dynamic/browser/sweep.js`, excluding elements inside an `overflow-x: auto` scroll container (data tables, maps). Rule `reflow-horizontal-scroll-at-320`, serious.
  - Text spacing: inject the four WCAG 1.4.12 declarations with `!important` via `page.addStyleTag`, flag text containers whose content is clipped by `overflow: hidden` or a fixed height. Rule `text-spacing-clips-content`, moderate.
  - Both restore the viewport and styles afterwards.
- **Reduced motion** (area `transitions`). A second context with `reducedMotion: 'reduce'` loads the page, runs the same safe dialog opening as `probeDialogs`, and records running `CSSAnimation` and `CSSTransition` objects from `document.getAnimations()` longer than 100 ms on transform-like properties (`transform`, `translate`, `scale`, `rotate`, `margin`, `inset`), ignoring opacity and color as the static rules do. An init script records whether `document.startViewTransition` was called, without changing its behavior. Rule `motion-persists-under-reduced-motion`, moderate. The static guard rules stay unchanged; the new rule is additive and does not promote or suppress them. New limit `motionTimeoutMs`.
- **Combobox** (area `panels`). `probeComboboxes` beside `probeDialogs`: up to `maxComboboxes` (default 3) `role=combobox` elements, focus, ArrowDown only (never Enter, never free typing), wait for `aria-expanded="true"`, record whether DOM focus moved into the listbox or stayed on the combobox with `aria-activedescendant`, then Escape and check collapse and focus return. Comboboxes inside forms are skipped the same way the existing probes skip them. Rule `combobox-focus-in-listbox`, moderate. The Deferred list in docs/specs goes from 9 to 8.

Rule count after this epic: 65 + 3 + 2 + 1 + 1 = 72. Each issue updates README.md, CLAUDE.md, SKILL.md and `registry.test.mjs` for its own rules.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| `--wcag` flag and `wcagVersion` option | Additive. `DEFAULT_TAGS` unchanged in 1.x. |
| a11y report sections (Needs manual review, Not covered, richer nodes) | Markdown content is not a covered output; `a11y-raw.json` unchanged. |
| `DEFAULT_TAGS` gains `wcag22aa` | Breaking: documented export value and CI outcomes change. v2.0 only. |
| New rule ids (7) | Additive: rule ids are covered and never reused; ids fit the schema pattern and existing areas, so `ux-raw.json` stays `"1.0"`. |
| New dynamic limits `maxKeyboardTabs`, `motionTimeoutMs`, `maxComboboxes` | Additive options with defaults; `normalizeOptions` already rejects unknown keys, so older versions reject the new keys, which is expected for a 1.y feature. |
| New findings in `--dynamic` runs | The dynamic pass is opt-in. CHANGELOG entries must say that upgrading can surface new findings in dynamic runs. |

## Task breakdown

1. [#30](https://github.com/EthanY33/atelier/issues/30), 9 h, v1.2.
2. [#32](https://github.com/EthanY33/atelier/issues/32), 16 h, v1.3.
3. [#33](https://github.com/EthanY33/atelier/issues/33), 12 h, v1.3.
4. [#34](https://github.com/EthanY33/atelier/issues/34), 13 h, v1.4.
5. [#35](https://github.com/EthanY33/atelier/issues/35), 8 h, v1.4.
6. [#31](https://github.com/EthanY33/atelier/issues/31), 3 h, v2.0. Depends on task 1.

## Test plan

- a11y: `--wcag 2.2` runs the five tags and the header says WCAG 2.2 AA; `--wcag` plus `--tags` exits 2; the five uncovered criteria appear when 2.2 is selected; Needs manual review counts equal `a11y-raw.json` `incomplete`; hostile-markdown tests extended to `failureSummary` and `html`; default runs unchanged.
- v2.0: `--wcag 2.1` reproduces the 1.x rule id set exactly (compared as sets).
- Each probe: a triggering fixture, a near miss, a fixture trigger and a regenerated golden, per CLAUDE.md. Specifically:
  - sticky header covering a tab stop flags both selectors; `scroll-padding-top` passes; partial overlap is minor at most.
  - `outline: none` with no replacement flags; `:focus-visible` ring and box-shadow ring pass; a focus-trap script lands in Needs review.
  - a fixed 600 px container flags reflow; an `overflow-x: auto` data table does not; `height: 20px; overflow: hidden` label flags text spacing; `min-height` does not.
  - a transform transition without a reduced-motion override is reported with selector and duration; a correct `@media (prefers-reduced-motion: reduce)` passes; a global `* { animation: none !important }` reset is judged by measurement; an unconditional `startViewTransition` is reported; opacity-only fades never count.
  - a combobox that moves DOM focus to an option flags; an APG `aria-activedescendant` combobox passes; no combobox gives not-applicable; a form-wrapped combobox is never submitted.
- Every probe: failure or timeout appears in `errors[]` while other probes still run; two runs on the same fixtures give identical output; static-only runs and their goldens are unchanged.

## Open questions

- Should new serious dynamic rules ship at `minor` for one release so dynamic CI users are not surprised? Proposed: no, ship the documented severity and call it out in the CHANGELOG; the baseline file (epic `ci-gating`) is the adoption path.
- The keyboard-trap heuristic needs a cycle length threshold; start at 3 elements repeated over 2 full cycles and tune on fixtures.
- Whether the reflow probe should also run at 256 CSS px height-constrained landscape (1.4.10 vertical scrolling content). Proposed: width only in the first version.

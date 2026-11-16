Epic label: `epic:brand-tokens`. Tracking issue: [#57](https://github.com/EthanY33/atelier/issues/57). Milestone(s): v1.2, v1.3, v1.4. Estimate: 28 h.

# Brand tokens and themes

## Goal

Make design-token-sync emit everything brand.json already describes, in the formats current projects consume (CSS, Tailwind 3 and 4, SCSS, W3C DTCG for Style Dictionary), support a dark theme without a second hand-maintained palette, and let CI catch committed tokens that went stale.

## Current state

- `plugins/atelier/schemas/brand.schema.json` defines `motion.duration`, `motion.easing`, `surfaces.radius`, `surfaces.elevation` and `surfaces.zIndexMax`. runtime-ux-audit reads motion and `zIndexMax`; no emitter outputs any of them.
- `design-token-sync/emitters/css.mjs` loops only `paletteEntries` and `fontEntries` from `emitters/shared.mjs` into one `:root` block (`--color-*`, `--font-*`).
- `emitters/tailwind.mjs` writes a Tailwind 3 style `tailwind.config.js` (`export default { theme: { extend } }`). Tailwind 4 configures themes in CSS with `@theme`. There is no SCSS output.
- `emitters/figma.mjs` creates one collection and renames its initial mode to `default`.
- `design-token-sync/index.mjs` `TARGETS` is `css`, `tailwind`, `dts`, `figma` (`ARTIFACTS` maps them to five files). There is no tool-neutral format, so Style Dictionary, Tokens Studio and native iOS and Android pipelines need a custom converter.
- `palette` is a flat map with `patternProperties` and `additionalProperties: false`; a brand cannot describe a dark theme.
- `syncTokens` always calls `mkdirSync` and `writeFileSync` for every requested file (index.mjs, the write loop). Nothing in the CLI or the Action detects that brand.json changed without regenerating committed tokens.
- docs/api.md: brand.schema.json only gains optional fields in 1.x; unknown keys are rejected, so a brand using a 1.y field needs atelier 1.y or newer.

## Proposed design

### Motion and surface tokens

- `motionEntries` and `surfaceEntries` in `emitters/shared.mjs`, reusing `cssIdent` and `propKey` for safe names.
- CSS: `--duration-<key>`, `--easing-<key>`, `--radius-<key>`. Tailwind 3: `theme.extend.borderRadius`, `transitionDuration`, `transitionTimingFunction`. dts and js: frozen `motion` and `radius` objects. Figma: radius as FLOAT variables, durations as STRING.
- `elevation` (an unlabeled 0 to 24 integer) and `zIndexMax` (an audit budget) are not emitted; the SKILL.md says why.
- A brand without `motion` or `surfaces` produces exactly today's files.

### `--check`

- CLI `--check`, API `check: true`: render the requested targets, compare with files on disk after normalizing CRLF to LF, write nothing (not even the output directory), return `{ stale: [...], missing: [...] }`. CLI exits 1 on drift, 0 when clean, 2 on usage errors, matching the audit convention.
- SKILL.md gets a CI snippet.

### Dark theme

- Optional top-level `themes.dark.palette` with the same hex pattern as `palette`; keys must be a subset of `palette` keys. `validateBrand` reports unknown keys; `brand set themes.dark.palette.bg '#111111'` works.
- CSS: `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` and `:root[data-theme="dark"] { ... }`. Tailwind 3: `darkMode` set and documented. dts: a `themes` export. Figma: a second mode named `dark` on the palette collection, with a value for every key the dark theme defines (missing keys fall back to the light value).
- runtime-ux-audit and og-card-generator are unchanged here.

### SCSS and Tailwind 4 targets

- `emitters/scss.mjs`: `tokens.scss` with `$color-<key>`, `$font-<key>` and `$colors`, `$fonts` maps (plus motion and radius maps once available).
- `emitters/tailwind-theme.mjs`: `tailwind-theme.css` with an `@theme` block using Tailwind 4's `--color-*`, `--font-*`, `--radius-*` and `--ease-*` namespaces.
- Opt-in targets `scss` and `tailwind4`; the default target set is unchanged.

### DTCG target

- `emitters/dtcg.mjs`: `tokens.json` in the W3C Design Tokens Community Group format. Palette becomes a `color` group, fonts become `fontFamily` tokens from the parsed family list, durations become `duration`, cubic-bezier easings become `cubicBezier`, radii become `dimension`. Named easings that are not cubic-bezier go under `$extensions.atelier`. Use the color value shape from the current stable spec text (checked when the work starts) and keep hex as a fallback field. If a dark theme exists, emit it as a separate group or extension per the spec's guidance at that time.
- Opt-in target `dtcg`. SKILL.md documents the exact Style Dictionary config for Swift and Kotlin output instead of adding native emitters.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| New CSS variables, Tailwind extensions, dts and Figma entries for motion and radius | Additive content in existing files; brands without these fields get identical files. |
| `--check` flag, `check` option and its return shape | Additive. Exit 1 on drift is documented for this mode only. |
| `themes.dark.palette` in brand.schema.json | Optional field: allowed in 1.x. A brand using it needs the release that adds it. |
| New targets `scss`, `tailwind4`, `dtcg` and their files | Additive and opt-in; `parseTargets` error message lists them. Default targets unchanged. |
| New dev dependency `sass` (exact pin) for the SCSS compile test | Root dev dependency only; not shipped in the plugin. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#36](https://github.com/EthanY33/atelier/issues/36), 5 h, v1.2.
2. [#37](https://github.com/EthanY33/atelier/issues/37), 3 h, v1.2. Good first issue.
3. [#40](https://github.com/EthanY33/atelier/issues/40), 5 h, v1.3. After task 1.
4. [#38](https://github.com/EthanY33/atelier/issues/38), 9 h, v1.4.
5. [#39](https://github.com/EthanY33/atelier/issues/39), 6 h, v1.4. After tasks 1 and 4 so it covers motion, radius and themes from the start.

## Test plan

- Snapshot: a brand without `motion`, `surfaces` or `themes` produces byte-identical output across all default targets.
- Escaping: keys needing escape and font names with quotes cannot break out of CSS declarations, SCSS maps, `@theme` blocks or JS strings (`cssIdent`, `propKey`, `jsString`).
- `--check`: clean, stale, missing, and combined with `--targets`; CRLF-only differences count as clean; no file or directory is created.
- Dark theme: schema and `validate-schemas` tests pass unchanged; a `themes.dark` key not in `palette` is rejected with a clear message; tokens.css has both blocks; figma-variables.json has a `dark` mode.
- SCSS compiles with the pinned `sass` package; `@theme` names match Tailwind 4 namespaces.
- DTCG: structural check vendored in tests (every token has `$type` and `$value`, groups nest correctly); `$type` correct for colors, families, durations and radii.
- `check:versions` and the exact-pin rule still pass.

## Open questions

- Should `--check` also run inside the Action as an optional `tokens-check` input? Proposed: not yet; one line of YAML in the docs covers it.
- Should the dark theme also cover `logos` (a light mark on dark)? Proposed: no, palette only in the first version.

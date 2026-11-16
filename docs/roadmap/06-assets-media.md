Epic label: `epic:assets-media`. Tracking issue: [#58](https://github.com/EthanY33/atelier/issues/58). Milestone(s): v1.2, v1.3, v1.4. Estimate: 35 h.

# Asset, card and video outputs

## Goal

Close the gaps where a skill's output falls short of what the brand file already promises or what users then do by hand: store assets for every listed store, picture markup that does not cause layout shift, cards that do not repaint on every run and can vary by page, and videos that can be GIFs, recorded at 2x, in dark mode, after an app is ready.

## Current state

- `brand-asset-pipeline/index.mjs` `brandTargets()` adds a preset only for `steam`, and `PRESETS` has no `apple`, `google` or `itch` entries, although `brand.schema.json` `deploy.stores` allows `steam`, `itch`, `apple` and `google`. Listing the others produces nothing. `makeOpaqueIcon` and `makeBanner` exist.
- `responsive-image-pipeline/index.mjs` `buildPictureSnippet` emits `<img src alt loading decoding>` with no `width` or `height`, while `processImage` already records each output's dimensions in `manifest.images`. runtime-ux-audit flags images without dimensions as a layout-shift risk, so atelier's own markup can fail atelier's own audit.
- `og-card-generator/index.mjs` `generateCards` renders and encodes every page's PNG on every run. `responsive-image-pipeline` already has a content-hash cache (`createHash`, `readCache`, `PIPELINE_VERSION`) to copy.
- og-card-generator uses one `TEMPLATE_PATH` (`template.html`); `renderHtml` hard-codes the placeholders (`style`, `title`, `subtitle`, `studio`, `product`, `slug`, `mark`); a page accepts only `slug`, `title`, `subtitle`, `description` (docs/api.md); the accent is always `palette.accent`. Rendering already runs without JavaScript, under a CSP, with network requests aborted, and `markImage` validates logo files (allowed types, 2 MB cap, no network paths).
- `html-to-video/index.mjs` `resolveFormat` throws unless the format is `mp4` or `webm`; SKILL.md "Trailers and GIFs" documents a manual two-pass ffmpeg palettegen recipe.
- html-to-video creates its context with `browser.newContext({ viewport })` only (no `deviceScaleFactor`, no `colorScheme`); `videoCodecArgs` fixes crf 20 for H.264 and 2 Mbit/s for VP9; capture starts after `load` and `document.fonts.ready`, so single-page apps can record blank frames. `MAX_DIMENSION` is 8192.

## Proposed design

### Store presets

`apple` (1024 x 1024 opaque App Store icon, no alpha channel), `google` (512 x 512 Play icon and 1024 x 500 feature graphic), `itch` (630 x 500 cover). Each size is checked against the store's current asset guide before coding. `brandTargets` adds a preset for each listed store, as `steam` does today, reusing `makeOpaqueIcon` and `makeBanner`. No schema change.

### Picture dimensions

`buildPictureSnippet` writes `width` and `height` from the fallback (largest) variant; passing the `processImage` result straight in needs no extra arguments. `--no-dimensions` (API `noDimensions`) restores today's markup. `--json` output gains the dimensions.

### Card cache

Per-card key: sha256 of the rendered card HTML (which already contains escaped page values, colors, font stacks and inlined mark and font bytes), the Playwright and Chromium version, and a pipeline version constant. Keys live in `<outDir>/.og-cache.json`, written after the batch. All hits: Chromium is not launched. A missing PNG is a miss. `--force` (API `force`) bypasses the cache. Cache read or write failures never fail a build. Returned paths stay in page order and include skipped cards.

### Card templates and overrides

- Two or three built-in layouts next to `template.html` (for example centered title, and text left with an image panel right), selected by optional `page.template` or `--template <name>`. Unknown names list the valid ones.
- Optional `page.accent` (validated with `parseHex`) and `page.image` (embedded through the same checks as `markImage`).
- `--template <file>` for a user HTML file using the same placeholders, rendered under the existing no-JS, CSP and request-abort sandbox.
- The current layout stays the default.

### GIF and animated WebP

`gif` and `webp` formats. GIF uses one ffmpeg invocation with a `split`, `palettegen`, `paletteuse` filter graph and `--gif-width` and `--gif-fps` (capped, default 15 fps). WebP uses `libwebp_anim` with `-loop 0`. Audio with these formats is a usage error. ffmpeg is resolved with `ensureFfmpeg` and spawned with argument arrays, as today; output moves into place only on success.

### Capture controls

`--scale` (`deviceScaleFactor`, rejected when width times scale exceeds 8192), `--color-scheme light|dark`, `--crf` and `--bitrate` with validated ranges, and `--wait-for <selector>` (plus an API `waitForFunction`) run before the virtual clock starts, bounded by `--timeout`. All validated before Chromium launches. Defaults produce the same ffmpeg arguments as today.

## API, schema and CLI changes and semver impact

| Change | Impact against docs/api.md |
|---|---|
| New brand-asset-pipeline presets and files for listed stores | Additive. Brands listing only `steam` or no stores get the same file list. |
| `buildPictureSnippet` adds `width` and `height`; `noDimensions` option; `--json` field | Additive attributes in generated markup, opt-out provided. Called out in the CHANGELOG because the default snippet text changes. |
| `.og-cache.json`, `--force`, `force` option | Additive. The cache file name is documented. |
| `page.template`, `page.accent`, `page.image`, `--template` | Additive optional page fields and flag; default layout unchanged. |
| html-to-video `gif`, `webp` formats and flags; `scale`, `colorScheme`, `crf`, `bitrate`, `waitForSelector`, `waitForFunction` | Additive with defaults identical to today. |

Nothing in this epic needs v2.0.

## Task breakdown

1. [#41](https://github.com/EthanY33/atelier/issues/41), 3 h, v1.2. Good first issue.
2. [#42](https://github.com/EthanY33/atelier/issues/42), 4 h, v1.2. Good first issue.
3. [#43](https://github.com/EthanY33/atelier/issues/43), 5 h, v1.3.
4. [#44](https://github.com/EthanY33/atelier/issues/44), 10 h, v1.4. After the reference-image card tests in epic `release-hardening`.
5. [#45](https://github.com/EthanY33/atelier/issues/45), 6 h, v1.4.
6. [#46](https://github.com/EthanY33/atelier/issues/46), 7 h, v1.4.

## Test plan

- Stores: `apple` icon has no alpha channel (sharp metadata); `google` sizes; `itch` cover; preset names validate through `resolveTargets` and appear in `--help`.
- Picture: `width` and `height` equal the fallback file's real dimensions, including a downscaled source and an EXIF-rotated portrait source; `--no-dimensions` matches today's markup; escaping tests still pass.
- Cache: a second identical run writes no PNG and does not launch Chromium (spy on the launcher); one changed title re-renders one card; palette, font or mark changes invalidate all; deleting a PNG or the cache re-renders; `--force` bypasses.
- Templates: default output unchanged (existing tests and the reference images); unknown template name errors; oversized, network or wrong-type `page.image` rejected; a custom template with a script tag and an external image cannot run the script or reach the network.
- Video: GIF and WebP probed with ffprobe as animated with the expected frame count; audio plus GIF exits 2; mp4 and webm tests unchanged; `--scale 2` doubles frame size with the same layout width; `--color-scheme dark` matches a media query; crf and bitrate change size monotonically and reject bad ranges; `--wait-for` delays the first frame and times out with a clear error. ffmpeg-dependent tests skip with the existing `ffmpegAvailable` pattern.

## Open questions

- Store asset sizes change over time; should the presets carry the date they were checked in a comment and the SKILL.md? Proposed: yes.
- Should custom card templates be allowed to load local font files, or only use the brand fonts already inlined? Proposed: brand fonts only in the first version.

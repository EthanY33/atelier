# API and CLI reference

This page is the atelier 1.0 stability contract: for each skill, the functions it exports, the options they take and their defaults, what they return and throw, the CLI flags, the files written and the exit codes. Everything listed here follows semver from 1.0.0. Each skill's `SKILL.md` is the version Claude reads; this page is for people and scripts.

[Semver policy](#semver-policy) / [Conventions](#conventions) / [atelier CLI](#the-atelier-cli) / [brand-memory](#brand-memory) / [design-token-sync](#design-token-sync) / [og-card-generator](#og-card-generator) / [responsive-image-pipeline](#responsive-image-pipeline) / [brand-asset-pipeline](#brand-asset-pipeline) / [accessibility-design-audit](#accessibility-design-audit) / [html-to-video](#html-to-video) / [runtime-ux-audit](#runtime-ux-audit) / [Shared library](#shared-library) / [brand.json](#brandjson) / [ux-raw.json](#ux-rawjson) / [Error codes](#error-codes)

## Semver policy

A breaking change to anything covered below ships only in a major release. Minor releases add features; patch releases fix bugs.

Covered:

- Every export listed on this page: its name, parameters, option names and defaults, return shape, and the `code` of each error it throws.
- Every CLI command, argument and flag listed here, its default, the files it writes and their names, the `--json` output shapes, and the exit codes.
- The `atelier` subcommands and skill aliases, and the slash command names.
- `brand.schema.json`. In 1.x it only gains optional fields: no new required field, no removed field, no narrower type, pattern or enum. A brand.json that is valid under 1.0 stays valid in every 1.x release. A brand.json that uses a field added in 1.y needs atelier 1.y or newer, because unknown keys are rejected.
- `ux-raw.json` with `schemaVersion: "1.0"` ([below](#ux-rawjson)).
- runtime-ux-audit rule ids and suppression markers. A rule id is never reused for a different check.
- The minimum Node version, 22. Raising it is a breaking change.

Not covered (may change in any release; the CHANGELOG lists each change):

- Human-readable text: `--help` output, progress lines, warning and error message wording, and the layout of `a11y-report.md` and `ux-report.md`. Match errors on `err.code`, not on the message.
- Which pages pass an audit. Minor releases may add runtime-ux rules, any release may tune a rule's detection or severity to cut false positives, and a dependency upgrade may add axe-core rules. A page that passes on 1.0 can fail on a later 1.x. To keep a CI gate fixed, pin an exact release (`EthanY33/atelier@v1.0.0`) instead of `@v1`.
- Byte-exact output. Images, cards and videos can differ across releases as sharp, libvips, Chromium and ffmpeg change.
- Exports and files not on this page: modules under a skill's `lib/`, `rules/`, `dynamic/` or `emitters/` folders, `USAGE` strings, test hooks, `scripts/run-demo.mjs` and the layout of `atelier demo` output.
- Dependency versions. Pins can move in any release.

Deprecation: a covered API that is going away is marked deprecated on this page and in the CHANGELOG first, keeps working for the rest of that major version, and is removed in the next one.

## Conventions

**Importing.** atelier is not published to npm. Import a skill by path from an installed plugin or a clone of the repo; every module is ESM. Pass absolute paths through `pathToFileURL`, which also makes Windows paths work:

```js
import { pathToFileURL } from 'node:url';
const root = '/path/to/atelier/plugins/atelier';
const { syncTokens } = await import(pathToFileURL(`${root}/skills/design-token-sync/index.mjs`).href);
```

Importing a skill never starts its CLI, including under `node -e`.

**Paths.** Relative paths resolve against `process.cwd()` unless an option says otherwise.

**Errors.** Errors a caller may want to handle carry a string `code` ([index](#error-codes)). A missing prerequisite is a `PreflightError` whose `fix` is the command that repairs it. An option of the wrong type is a `TypeError`, usually without a code.

**CLIs.** Every skill runs as `atelier <alias> ...` or `node <plugin>/skills/<name>/index.mjs ...`. `-h` or `--help` prints usage to stdout and exits 0. A usage error prints the message and the usage to stderr. A runtime failure prints `atelier: <message>` to stderr, plus `  Fix: <command>` when there is a known fix. Each skill also exports its CLI as a function that returns the exit code and never calls `process.exit`.

| Exit code | Meaning |
|---|---|
| `0` | Success. For audits: no critical or serious findings. |
| `1` | Audits: critical or serious findings. `atelier brand validate`: schema errors. `atelier doctor`: a check failed. |
| `2` | Usage error, or the command could not run: missing input, missing prerequisite, invalid brand.json, runtime failure. |

## The atelier CLI

`plugins/atelier/bin/atelier`. Claude Code puts the plugin's `bin/` on the Bash tool's PATH, so inside a session it runs as `atelier`. Anywhere else, run `node <plugin>/bin/atelier`.

| Command | What it does | Exit codes |
|---|---|---|
| `atelier`, `atelier --help` | Print usage | 0 |
| `atelier --version` | Print the plugin version | 0 |
| `atelier doctor [--no-browser] [--json]` | Check Node, dependencies, sharp, Chromium, ffmpeg and `./.atelier/brand.json`, with a fix for each problem | 0 ready (warnings allowed), 1 a check failed, 2 usage error |
| `atelier demo [-o, --out <dir>]` | Run every skill on the bundled fixtures into `<dir>` (default `./atelier-demo`) | 0, or 2 on a usage error or failure |
| `atelier <alias> [args...]` | Run a skill's CLI | the skill's code; 2 for an unknown command |

Aliases: `brand` (brand-memory), `tokens` (design-token-sync), `og` (og-card-generator), `images` (responsive-image-pipeline), `assets` (brand-asset-pipeline), `a11y` (accessibility-design-audit), `video` (html-to-video), `ux` (runtime-ux-audit). The full skill name works too: `atelier runtime-ux-audit ...`.

`doctor --json` prints `{ ok, version, pluginRoot, checks }`. Each check is `{ name, status, detail, fix? }`, with `name` one of `node`, `dependencies`, `sharp`, `chromium`, `ffmpeg`, `brand.json` and `status` one of `ok`, `warn`, `fail`. `ok` is false when any check has status `fail`. Chromium, ffmpeg and a missing brand.json only warn. `--no-browser` skips the `chromium` check.

`demo` writes only inside `<dir>`, which must be new, empty, or an earlier demo output. It refuses the working directory, its parents, the home directory, a filesystem root and the plugin itself. The video step is skipped when ffmpeg is not on PATH.

## brand-memory

`skills/brand-memory/index.mjs`, CLI `atelier brand`. Owns `<root>/.atelier/brand.json`; no other skill writes it. Every function is synchronous.

### Exports

- `loadBrand(projectRoot: string): object`. Reads `<projectRoot>/.atelier/brand.json` and validates it against the schema. A UTF-8 or UTF-16 byte order mark is accepted. Throws `BRAND_NOT_FOUND`, `BRAND_INVALID` (malformed JSON or a schema failure; `err.errors` is a `string[]` of messages that name the dotted property) or `BRAND_UNREADABLE`.
- `saveBrand(projectRoot: string, cfg: object): void`. Validates, then writes 2-space JSON with a trailing newline, creating `.atelier/` if needed. Throws `BRAND_INVALID` before writing anything, or `BRAND_UNWRITABLE`.
- `initBrand(projectRoot: string, opts): object`. Builds a config from `opts`, validates it and writes it in one step, then returns it. Blank optional values are left out of the file.

  | Option | Default | Written to |
  |---|---|---|
  | `studio` | required | `brand.studio` |
  | `primaryColor` | required | `palette.bg` |
  | `bodyFont` | required | `typography.body` |
  | `product` | none | `brand.product` |
  | `voice` | none | `brand.voice`; a comma-separated string or an array |
  | `accent` | none | `palette.accent` |
  | `displayFont`, `monoFont` | none | `typography.display`, `typography.mono` |
  | `deployTarget` | none | `deploy.target` |
  | `withSchema` | `false` | adds `"$schema": BRAND_SCHEMA_URL` |
  | `overwrite` | `true` | `false` throws `BRAND_EXISTS` when the file exists |

  A missing required value fails validation (`BRAND_INVALID`).
- `validateBrand(cfg: unknown): { valid: boolean, errors: string[] }`. Validates without touching disk.
- `auditBrand(cfg: object): { missing: string[] }`. Recommended fields that are absent or empty, in this order: `brand.product`, `brand.voice`, `typography.display`, `logos.mark`, `logos.wordmark`, `social`, `deploy.target`.
- `getPath(obj: object, path: string): unknown`. Value at a dotted path such as `palette.bg`, or `undefined`. Follows own properties only.
- `setPath(obj: object, path: string, value: unknown): object`. Deep clone of `obj` with the value set; missing objects are created and `obj` is not changed. Throws `TypeError` for an empty or non-string path, and `Error` for an empty segment, a `__proto__`, `constructor` or `prototype` segment, a non-numeric key inside an array, or an index that leaves a gap.
- `brandFilePath(projectRoot: string): string`. `<projectRoot>/.atelier/brand.json`.
- `BRAND_SCHEMA_URL: string`. Public URL of `brand.schema.json`.
- `runCli(argv?: string[], { cwd?, stdout?, stderr? }?): number`. The CLI, synchronous. `stdout` and `stderr` are objects with `write(s)`.

### CLI

```
atelier brand <init|get|set|audit|validate|path> [options]
```

| Command | Flags | Does |
|---|---|---|
| `init` | `--studio`, `--product`, `--voice <a,b,c>`, `--bg <hex>`, `--accent <hex>`, `--body-font`, `--display-font`, `--mono-font`, `--deploy <target>`, `--force` | Creates brand.json with a `$schema` key, then prints the audit. Defaults: studio = the root folder name, `--bg #111111`, `--body-font "system-ui, sans-serif"`. Refuses to overwrite without `--force`. |
| `get <path>` | `--raw` | Prints the JSON value at a dotted path; `--raw` prints a string without quotes. |
| `set <path> <value>` | | Sets one value, validates the whole file, saves it, prints `<path> = <json>`. The value is parsed as JSON when it is valid JSON, otherwise kept as a string. String fields keep numbers as text, `brand.voice` and `deploy.stores` split a comma list, palette values may omit the `#`, and extra words are joined with spaces. |
| `audit` | `--json` | Lists missing recommended fields with a `set` command for each. Always exits 0. |
| `validate` | `--json` | Checks the file against the schema. |
| `path` | | Prints the absolute path of brand.json. |

Every command takes `--root <dir>` (default: the current directory). A value that starts with `-` goes after `--` (`set -- typography.body "-apple-system, sans-serif"`) or uses `=` (`--body-font=-apple-system`). `get`, `set` and `audit` read the file without validating it, so `set` can repair an invalid field.

`audit --json` prints `{ path, complete, missing, valid, errors }`. `validate --json` prints `{ path, valid, errors }`.

Exit codes: 0 success; 1 `validate` found errors (including malformed JSON); 2 usage error, missing or unreadable brand.json, `get` on an unset path, or a rejected `init` or `set`.

## design-token-sync

`skills/design-token-sync/index.mjs`, CLI `atelier tokens`. Reads `palette` and `typography` from brand.json and writes token files. It never reads its outputs back and never calls Figma.

### Exports

- `syncTokens(opts?): Promise<string[]>`. Loads `<projectRoot>/.atelier/brand.json`, renders the requested files, then writes them. All files are rendered before any is written, so a bad value leaves earlier output untouched. Resolves to absolute paths in the order `tokens.css`, `tailwind.config.js`, `tokens.d.ts`, `figma-variables.json`, `tokens.js`, limited to the requested targets.

  | Option | Default | Meaning |
  |---|---|---|
  | `projectRoot` | `process.cwd()` | Directory holding `.atelier/brand.json` |
  | `outDir` | `'dist/tokens'` | Output directory; absolute, or relative to `projectRoot` |
  | `targets` | all | Array or comma-separated string of `css`, `tailwind`, `dts`, `figma` |

  Throws the brand-memory codes, a `TypeError` for an empty or unknown target, or `DEPS_MISSING`.
- `emitCss(cfg)`, `emitTailwind(cfg)`, `emitDts(cfg)`, `emitJs(cfg)`, `emitFigmaVariables(cfg)`: each takes a brand config object and returns the file content as a string, with no I/O. They throw a `TypeError` for a palette value that is not a CSS color (brand.json only allows hex, so this only happens with a hand-built config).
- `TARGETS: readonly string[]`. `['css', 'tailwind', 'dts', 'figma']`.
- `parseTargets(targets?: string | string[]): Set<string>`. Normalizes a target list; `undefined` means all. Throws a `TypeError` for an empty or unknown target.
- `runCli(argv?: string[], { stdout?, stderr? }?): Promise<number>`. `stdout` and `stderr` are objects with `write(s)`.

### CLI

```
atelier tokens [projectRoot] [--root <dir>] [--out <dir>] [--targets css,tailwind,dts,figma]
```

Give the project root as the argument or with `--root`, not both. Prints each written file's absolute path on its own line.

| Target | File | Contents |
|---|---|---|
| `css` | `tokens.css` | `:root` with `--color-<key>` per palette entry and `--font-<slot>` per font |
| `tailwind` | `tailwind.config.js` | ESM `export default { theme: { extend: { colors, fontFamily } } }` |
| `dts` | `tokens.js`, `tokens.d.ts` | Frozen `colors` and `fonts` objects, one `export const` per color, and their types |
| `figma` | `figma-variables.json` | Request body for Figma `POST /v1/files/:file_key/variables` |

Exit codes: 0 written; 2 usage error or failure.

## og-card-generator

`skills/og-card-generator/index.mjs`, CLI `atelier og`. Renders 1200x630 PNG cards in headless Chromium. Reads `palette.bg` (default `#111111`), `palette.fg` (default black or white, whichever contrasts more with `bg`), `palette.accent` (shapes and glow only; default `palette.fg`), `typography.display` (falls back to `body`), `typography.body`, `brand.studio` (falls back to `brand.product`), `brand.product` (title fallback) and, in the CLI, `logos.mark`.

### Exports

- `generateCards(opts): Promise<string[]>`. One `<outDir>/<slug>.png` per page with one browser for the whole batch. Every page and slug is checked before anything is written. Resolves to the paths in page order; an empty `pages` array resolves to `[]` without starting a browser.
- `generateCard(opts): Promise<string>`. One card at `outPath`; resolves to `outPath`.
- `buildCardHtml(brand, page, { fonts?, mark? }?): string`. The card HTML without rendering it.

| Option | Default | Meaning |
|---|---|---|
| `brand` | required | Brand object, as returned by brand-memory `loadBrand` |
| `pages` (`generateCards`) | required | Array of pages |
| `outDir` (`generateCards`) | required | Output directory |
| `page` (`generateCard`) | required | One page |
| `outPath` (`generateCard`) | required | PNG path to write |
| `fonts` | none | `{ display?, body? }`: font files (`.woff2`, `.woff`, `.ttf`, `.otf`) inlined for the brand fonts |
| `mark` | none | Logo file (`.svg`, `.png`, `.jpg`, `.webp`, at most 2 MB) inlined on the card. The API does not read `logos.mark`; pass it |
| `browser` | launch one | A Playwright `Browser` to reuse; it is left open |
| `onWarning` | print to stderr | `(message: string) => void` for low contrast, missing fonts and shortened text |

A page is `{ slug?, title?, subtitle?, description? }`. `slug` is the file name and footer path: lowercase letters, digits, `-` and `_`, with `/` between segments for nested folders; default `index`. `title` falls back to `brand.product`; `description` is an alias for `subtitle`.

Throws an `Error` for an invalid brand value, page, slug, duplicate output path, unreadable font file or unusable mark (missing, too large, unsupported type, network path), and `CHROMIUM_MISSING`, `CHROMIUM_DEPS_MISSING` or `PLAYWRIGHT_MISSING` when the browser cannot start.

- `runCli(argv: string[], { cwd?, stdout?, stderr? }?): Promise<number>`. Here `stdout` and `stderr` are functions `(s: string) => void`.

### CLI

```
atelier og <pages.json> [outDir] [options]
atelier og --title <text> [--subtitle <text>] [--slug <slug>] [--out <dir>] [options]
```

| Flag | Default | Meaning |
|---|---|---|
| `<pages.json>` | | `{ "pages": [ ... ] }` or a bare array of pages |
| `[outDir]`, `--out <dir>` | `og-cards` | Output directory (give it once) |
| `--title`, `--subtitle`, `--slug` | | One card without a manifest; `--subtitle` and `--slug` need `--title` |
| `--project <dir>` | current directory | Project root holding `.atelier/brand.json` |
| `--font-display <file>`, `--font-body <file>` | | Font files for the brand fonts |
| `--mark <file>` | `logos.mark` when set | Logo on the card. A `logos.mark` outside the project root is refused |
| `--no-mark` | | Leave the logo off (not with `--mark`) |

Prints the written paths. Warnings go to stderr as `atelier: warning: ...`; cards are still written.

Exit codes: 0 cards written; 2 usage or runtime error.

## responsive-image-pipeline

`skills/responsive-image-pipeline/index.mjs`, CLI `atelier images`. Resizes images with sharp. Does not read brand.json.

### Exports

- `processImage(opts): Promise<Result>`. Applies EXIF orientation, then writes AVIF and WebP variants (never upscaled), a fallback file for `<img src>` and an LQIP placeholder. Widths above the source are skipped and the source width becomes the top size. A rerun with the same input bytes, options, pipeline version and sharp version, whose files all exist, is a cache hit and writes nothing.

  | Option | Default | Meaning |
  |---|---|---|
  | `input` | required | File path or `file://` URL (string or `URL`) |
  | `outDir` | required | Output folder |
  | `widths` | `[480, 768, 1280, 1920]` | Target widths in px |
  | `formats` | `['avif', 'webp']` | `<source>` formats, best first; also `jpg`, `png` |
  | `fallback` | `'auto'` | `<img src>` format: `auto` (png for transparent, PNG or GIF sources, jpg otherwise), `jpg`, `png`, `webp`, `avif`, or `false` for none |
  | `lqipWidth` | `24` | Placeholder width in px |
  | `quality` | `{ avif: 60, webp: 78, jpg: 80 }` | Encoder quality per format |
  | `background` | `'#ffffff'` | Color transparent pixels are flattened onto for JPEG output |
  | `name` | input file name without extension | Output file stem |

  `Result` is `{ cached, variants, lqip, basename, widths, skippedWidths, formats, fallback, fallbackFormat, lqipPath, source: { path, format, width, height, transparent }, images: [{ path, format, width, height }] }`. `variants` lists the `<source>` files only; `lqip` is a data URL; `fallback` and `fallbackFormat` are `null` when there is no fallback file.

  Throws a `TypeError` for an invalid option, an `Error` for an unreadable input, a variant larger than the format allows (AVIF 16384 px, WebP 16383 px; the message names the largest width that fits) or an output name that belongs to another source, and `SHARP_MISSING` when sharp cannot load. Files written for a failed input are removed.
- `buildPictureSnippet(opts): string`. A `<picture>` element. Pass the `processImage` result straight in (`{ ...result, alt }`) so the srcset matches the files on disk.

  | Option | Default | Meaning |
  |---|---|---|
  | `basename` | required | File stem on disk; URL-encoded in full |
  | `widths` | required | Widths to list |
  | `formats` | `['avif', 'webp']` | One `<source>` per format |
  | `fallbackFormat` | last of `formats` | Extension of the `<img src>` file |
  | `alt` | `''` | Alt text (empty means decorative) |
  | `sizes` | `'100vw'` | `sizes` attribute |
  | `baseUrl` | `''` | Prefix for every URL, such as `/img/`; existing `%XX` escapes are kept |
  | `loading` | `'lazy'` | `lazy` or `eager` |

  Every attribute is HTML-escaped. Throws a `TypeError` for a missing `basename`, an unsupported `fallbackFormat` or an invalid `loading`.
- `runCli(argv?: string[], { stdout?, stderr? }?): Promise<number>`. `stdout` and `stderr` are objects with `write(s)`.

### CLI

```
atelier images <input...> --out <dir> [options]
```

An input is an image file, a `file://` URL or a folder (its images, not recursive). Flags: `-o, --out <dir>` (required), `-w, --widths <list>`, `-f, --formats <list>`, `--fallback <fmt>` (`none` for no fallback), `--lqip-width <px>`, `--name <stem>` (one input only), `--alt <text>`, `--sizes <value>`, `--base-url <url>`, `--loading <lazy|eager>`, `--json`. Defaults match the API. In one run, inputs that share a stem get distinct names. Remote URLs are not fetched.

Output per source `<name>`: `<name>-<w>.avif` and `<name>-<w>.webp` per width, `<name>-<top>.jpg` or `.png` (the fallback, unless it is already a variant), `<name>-lqip.txt` (the placeholder data URL) and `<name>.cache` (the cache manifest; delete it to force regeneration). Text mode prints a summary and the snippet per input. `--json` prints one JSON array with an entry per input: `{ input, ok: true, ...Result, snippet }` or `{ input, ok: false, error }`.

Exit codes: 0 every input processed or cached; 2 usage error, or at least one input failed (the others still run).

## brand-asset-pipeline

`skills/brand-asset-pipeline/index.mjs`, CLI `atelier assets`. Renders one mark into PNG icons and banners with sharp. With a brand, reads `palette.bg` (background), `logos.mark` (default mark) and `deploy.stores` (adds `steam` when it lists `steam`).

### Exports

- `generateAssets(opts): Promise<{ files: string[], targets: string[], backgroundColor: string }>`. Nothing is written until every input is valid and every image has rendered. Existing files with the same names are overwritten.

  | Option | Default | Meaning |
  |---|---|---|
  | `outDir` | required | Output directory, created if missing |
  | `markSvg` | brand `logos.mark` | The mark: SVG (UTF-8 or UTF-16) or PNG, JPEG, WebP. A `logos.mark` default must be a relative path inside the project root. |
  | `targets` | `favicons`, `app-icons`, `social`, plus `steam` when brand `deploy.stores` lists it | Array of preset names |
  | `backgroundColor` | brand `palette.bg`, else `#110f1b` | `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; the `#` is optional |
  | `brand` | none | Brand object from `loadBrand` |
  | `projectRoot` | none | Reads `<projectRoot>/.atelier/brand.json` when `brand` is not given; also the base for `logos.mark` (default `process.cwd()`) |

  Explicit options win over the brand. Throws a `TypeError` for a missing `outDir` or mark or a wrongly typed option; an `Error` for an unknown target, a bad hex color, an unreadable mark, a `logos.mark` outside the root, a remote, network or device `<image>` link, a link over the size or count limits, or a mark that renders fully transparent; the brand-memory codes when loading brand.json; and `SHARP_MISSING`.
- `PRESETS`. Frozen table of targets: `{ favicons, 'app-icons', social, steam }`, each an array of `{ name, size }` (square icons) or `{ name, w, h }` (banners); `opaque: true` marks `apple-touch-icon.png`.
- `runCli(argv?: string[], { stdout?, stderr? }?): Promise<number>`. `stdout` and `stderr` are objects with `write(s)`.

### CLI

```
atelier assets [<mark.svg>] --out <dir> [-t, --targets <list>] [--bg <hex>] [--root <dir>] [--json]
```

`-o, --out` is required. Pass the mark, or `--root <dir>` with `logos.mark` set. `--root` reads `<dir>/.atelier/brand.json` for all three defaults. `--json` prints the result object.

| Target | Files |
|---|---|
| `favicons` | `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-64.png`, `favicon-180.png` (transparent) |
| `app-icons` | `apple-touch-icon.png` 180 (opaque), `android-chrome-192.png`, `android-chrome-512.png` |
| `social` | `og-cover.png` 1200x630, `twitter-cover.png` 1500x500, `linkedin-cover.png` 1584x396 |
| `steam` | `steam-header.png` 460x215, `steam-capsule-main.png` 616x353, `steam-capsule-small.png` 231x87 |

No `favicon.ico` is written.

Exit codes: 0 assets written; 2 usage error or failure.

## accessibility-design-audit

`skills/accessibility-design-audit/index.mjs`, CLI `atelier a11y`. WCAG 2.1 A and AA audit with axe-core in headless Chromium. Does not read brand.json.

### Exports

- `auditPage(opts): Promise<{ violations, reportPath, rawPath, url, tags }>`. Opens the page, waits for the load event, then up to `settleTimeoutMs` for network idle and web fonts, then `waitFor`; runs axe; writes the report and the raw JSON. Nothing is written when the audit fails. `violations` is `{ critical, serious, moderate, minor, all }`, each an array of axe violation objects. `url` is the audited URL (a file path becomes a `file://` URL).

  | Option | Default | Meaning |
  |---|---|---|
  | `url` | required | http(s), `file:` or `data:` URL, or a path to an HTML file |
  | `outDir` | required | Directory for `a11y-report.md` and `a11y-raw.json` |
  | `tags` | `DEFAULT_TAGS` | axe tags, array or comma-separated string; unknown tags throw |
  | `waitFor` | none | CSS selector that must be in the DOM before the audit |
  | `timeoutMs` | `30000` | Navigation, load event and `waitFor` timeout |
  | `settleTimeoutMs` | `10000` | Maximum wait for network idle and fonts (best effort) |
  | `analyzeTimeoutMs` | `60000` | Maximum time for the axe run |
  | `allowHttpError` | `false` | Audit a page that answers HTTP 4xx or 5xx instead of throwing |
  | `browser` | launch one | A Playwright `Browser` to reuse; it is left open |

  Throws an `AuditError` with one of these codes: `INPUT_NOT_FOUND`, `INPUT_IS_DIRECTORY`, `INVALID_URL`, `UNSUPPORTED_SCHEME`, `INVALID_TAGS`, `UNKNOWN_TAG`, `NAVIGATION_FAILED`, `HTTP_ERROR`, `LOAD_TIMEOUT`, `WAIT_FOR_FAILED`, `ANALYZE_TIMEOUT`, `NO_RULES`. Throws `AXE_MISSING`, `PLAYWRIGHT_MISSING`, `CHROMIUM_MISSING` or `CHROMIUM_DEPS_MISSING` when a prerequisite is missing, and a `TypeError` for an invalid option.
- `AuditError`. `Error` subclass with `name: 'AuditError'` and `code`.
- `DEFAULT_TAGS: readonly string[]`. `['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']`.
- `groupByImpact(violations: object[]): { critical, serious, moderate, minor, all }`. Violations without a known impact appear only in `all`.
- `buildMarkdownReport({ url, finalUrl?, timestamp, violations, tags?, axeVersion?, incompleteCount? }): string`. The report text; `violations` is the grouped object.
- `runCli(argv?: string[], { stdout?, stderr? }?): Promise<number>`. `stdout` and `stderr` are objects with `write(s)`.

`mdCodeSpan`, `formatTarget` and `USAGE` are also exported, for the tests; they are not covered.

### CLI

```
atelier a11y <url|file> [outDir] [options]
```

`[outDir]` or `-o, --out <dir>` (default `a11y-report`), `--tags <list>`, `--wait-for <selector>`, `--timeout <ms>`, `--settle-timeout <ms>`, `--analyze-timeout <ms>`, `--allow-http-error`. A bare host such as `example.com` is not guessed; pass `https://example.com`.

Writes `<outDir>/a11y-report.md` (counts, then one section per impact with up to 5 selectors per rule) and `<outDir>/a11y-raw.json` (the full axe result). stdout: `Report written to: <path>`, then `Violations: critical N, serious N, moderate N, minor N`.

Exit codes: 0 no critical or serious violations; 1 at least one; 2 usage error or the audit could not run.

## html-to-video

`skills/html-to-video/index.mjs`, CLI `atelier video`. Records a page to MP4 (H.264) or WebM (VP9) on a virtual clock, so frame N shows the page N/fps seconds after the first frame. Needs ffmpeg on PATH and Playwright Chromium. Does not read brand.json.

### Exports

- `recordHtml(opts): Promise<string>`. Resolves to `outPath` as given. Frames, the intermediate video and the WAV live in a temp directory that is removed on success and on every failure; finished files are moved into place last, so a failed run never leaves a truncated file at `outPath`.

  | Option | Default | Meaning |
  |---|---|---|
  | `url` | required | http(s), `file:` or `data:` URL, or a path to an HTML file |
  | `outPath` | required | `.mp4` or `.webm` file; parent directories are created |
  | `duration` | `5` | Seconds of page time; frames = round(duration x fps), at least 1 |
  | `fps` | `30` | Frames per second, at most 240 |
  | `width`, `height` | `1280`, `720` | Viewport size, integers 1 to 8192. MP4 rounds an odd value up by 1 px. |
  | `format` | from the extension, else `'mp4'` | `'mp4'` or `'webm'`; must agree with a `.mp4` or `.webm` extension |
  | `poster` | `false` | Also write `<name>-poster.jpg` (the first frame) next to the video |
  | `audioSource` | none | `(wavPath: string) => void or Promise<void>`; must write a WAV at `wavPath` (48 kHz 16-bit PCM recommended). Audio is encoded to AAC (MP4) or Opus (WebM) and the output ends with the shorter stream. |
  | `timeoutMs` | `30000` | Navigation and load event timeout |
  | `allowHttpError` | `false` | Record a page that answers HTTP 4xx or 5xx |
  | `browser` | launch one | A Playwright Chromium `Browser` to reuse; it is left open |
  | `signal` | none | `AbortSignal`; aborting stops the capture or encode, removes the temp files and rejects with the abort reason |

  Throws a `TypeError` for an invalid option before any work starts. Throws `FFMPEG_MISSING` (checked before Chromium launches), `PLAYWRIGHT_MISSING`, `CHROMIUM_MISSING` or `CHROMIUM_DEPS_MISSING` for a missing prerequisite, and an `Error` for a page that answers HTTP 4xx or 5xx, cannot be opened or misses its load event, or an `audioSource` that writes an empty file.
- `findOnPath`. Re-export of the shared [`findOnPath`](#preflightmjs), kept for 0.2 callers.
- `runCli(argv?: string[], { stdout?, stderr? }?): Promise<number>`. `stdout` and `stderr` are objects with `write(s)`. The first Ctrl+C aborts the recording and cleans up.

### CLI

```
atelier video <url|file.html> <out.mp4|out.webm> [seconds] [options]
```

`-d, --duration <s>` (same as `[seconds]`; give one), `--fps <n>`, `--width <px>`, `--height <px>`, `-f, --format <mp4|webm>`, `--poster`, `--audio <file>` (copied in as the audio track; any format ffmpeg reads), `--timeout <ms>`, `--allow-http-error`. stdout: `Video written to: <path>`, and `Poster written to: <path>` with `--poster`.

Exit codes: 0 video written; 2 usage or runtime error.

## runtime-ux-audit

`skills/runtime-ux-audit/index.mjs`, CLI `atelier ux`. Audits a page for runtime UX problems with 65 rules in four areas: `transitions`, `inp`, `panels`, `mobile`. The static pass parses HTML, CSS and JS and never runs page code; `dynamic` adds a Chromium pass. Budgets come from brand.json `targets.minTapPx` (default 24), `targets.inpBudgetMs` (200), `surfaces.zIndexMax` (100) and `motion.duration` tokens; `targets.lcpBudgetMs` and `targets.clsBudget` are validated and echoed but no rule reads them. The skill validates only these fields, with the schema's ranges.

### Exports

- `auditRuntimeUx(opts): Promise<Result>`.

  | Option | Default | Meaning |
  |---|---|---|
  | `url` | required | Path to an HTML file, `file://` URL or http(s) URL (string or `URL`) |
  | `outDir` | `'ux-report'` | Output directory, relative to `cwd` |
  | `dynamic` | `false` | Also run the Chromium pass (Pixel 7, 4x CPU throttle) |
  | `brand` | `null` | Path to a brand.json or a brand object. The API never loads `./.atelier/brand.json` on its own. |
  | `root` | the HTML file's folder | Local site root; `/x` hrefs map to `<root>/x`, and `dynamic` serves it from a loopback server |
  | `areas` | all four | Array of area names |
  | `ignore` | `[]` | Rule ids to skip, short (`no-unload-handler`) or full |
  | `allowOrigins` | `[]` | Extra http(s) origins to fetch subresources from (and, under `dynamic`, that a local page may reach) |
  | `limits` | `{ timeoutMs: 10000, maxBytes: 2097152 }` | Per-request network timeout and size cap |
  | `timestamp` | now | ISO 8601 report time; fix it for byte-identical output |
  | `write` | `true` | `false` returns the reports without writing files |
  | `cwd` | `process.cwd()` | Base for relative `url`, `brand` and `outDir` |

  `Result` is `{ violations: { critical, serious, moderate, minor, all }, incomplete, metrics, summary, pass, raw, markdown, reportPath, rawPath }`. `raw` is the `ux-raw.json` object; `violations`, `incomplete`, `metrics` and `summary` are taken from it; `pass` is true when there are no critical or serious violations; `markdown` is the `ux-report.md` text; the paths are `null` when `write` is `false`.

  Throws a `UxAuditError` with one of these codes: `USAGE` (invalid option, bad URL or origin, document outside `root`), `INPUT_NOT_FOUND`, `SCHEME_NOT_ALLOWED`, `COLLECT_FAILED` (document fetch failed, refused redirect, document over the size cap, HTML nested more than 512 elements deep), `BRAND_INVALID` (`err.path` names the field), `PLAYWRIGHT_MISSING`, `CHROMIUM_MISSING`, `DYNAMIC_FAILED`.
- `UxAuditError`. Subclass of the shared `PreflightError` with `code`, `hint` (the same string as `fix`) and, for `BRAND_INVALID`, `path`.
- `RULES`. Frozen array of the rule objects. Covered fields: `id` (`atelier/runtime-ux/<name>`), `area`, `severity` (`critical`, `serious`, `moderate`, `minor`), `confidence` (`high`, `medium`, `low`), `methods`, `phase` (`static` or `dynamic`), `requires` (`['http']` when the rule needs an http(s) input), `description`, `helpUrl`. Rule `check` functions are internal. Minor releases may add rules.
- `main(argv?: string[]): Promise<number>`. The CLI; it writes to `process.stdout` and `process.stderr`.

Other `auditRuntimeUx` options (`rules`, `fetchImpl`, `dynamicImpl`, `dynamicLimits`, and `limits` keys other than the two above) are test hooks and tuning knobs, not covered.

### CLI

```
atelier ux <url|file> [outDir] [options]
```

| Flag | Default | Meaning |
|---|---|---|
| `[outDir]`, `--out <dir>` | `ux-report` | Output directory (give it once) |
| `--dynamic` | off | Chromium pass |
| `--brand <path>` | `./.atelier/brand.json` when it exists | Budgets |
| `--no-brand` | | Do not load `./.atelier/brand.json` |
| `--root <dir>` | the HTML file's folder | Local site root |
| `--area <name>` | all four | Repeatable or comma separated |
| `--ignore <rule-id>` | | Repeatable |
| `--allow-origin <origin>` | | Repeatable |
| `--timeout <ms>` | `10000` | Per-request network timeout |
| `--max-bytes <n>` | `2097152` | Per-resource size cap |
| `--timestamp <iso>` | now | Fixed report time |

Writes `<outDir>/ux-report.md` and `<outDir>/ux-raw.json`. stdout: `Report written to: <path>`, `Violations: critical N, serious N, moderate N, minor N`, and under `--dynamic` `INP est.: N ms (budget M ms)`. The same inputs and timestamp give byte-identical files.

Suppression: `data-atelier-ignore="<rule-id>"` on an element or an ancestor, `/* atelier-ignore <rule-id> */` before a CSS rule or declaration, or `// atelier-ignore <rule-id>` on or above a JS line. Without an id the marker suppresses every rule at that spot.

Exit codes: 0 no critical or serious findings; 1 critical or serious findings; 2 usage error or the audit could not run. "Needs review" findings (`incomplete`) never fail the audit.

## Shared library

`plugins/atelier/lib/` holds the helpers every skill uses. These exports are covered.

### preflight.mjs

- `PreflightError(message, { code?, fix?, cause? })`. `Error` subclass with `name: 'PreflightError'`, `code` and `fix` (the command that repairs the problem).
- `findOnPath(name: string, { env?, platform? }?): string | null`. Resolves an executable on PATH the way a shell would, without a shell. On Windows only `.exe` and `.com` match; elsewhere the file must be executable. A name with a path separator is checked directly, and the current directory is never searched implicitly.
- `checkBinary(cmd: string, args = ['--version'], { env?, timeoutMs = 15000 }?): Promise<{ ok, path?, version?, error? }>`. Runs the binary without a shell and reports the first line of its output.
- `checkNodeModule(name: string): Promise<{ ok, error? }>`. Whether a module resolves from the plugin's `node_modules`.
- `runPreflight(checks): Promise<object[]>`. Runs `{ kind: 'bin', cmd, args?, install? }` and `{ kind: 'module', name, install? }` checks and throws one `PreflightError` with code `PREFLIGHT_FAILED` listing every failure.
- `playwrightVersion(): string | null`. The installed Playwright version.
- `launchChromium(launchOptions?): Promise<Browser>`. Launches Playwright's Chromium. Throws `PLAYWRIGHT_MISSING`, `CHROMIUM_MISSING` (with `fix` = `npx playwright@<version> install chromium`) or `CHROMIUM_DEPS_MISSING` (with the matching `install-deps` command).
- `ensureFfmpeg({ env?, platform? }?): string`. Absolute path to ffmpeg, or throws `FFMPEG_MISSING` with a per-OS install hint.
- `formatError(err: unknown): string`. `atelier: <message>`, plus `\n  Fix: <fix>` when the error has a string `fix`.

### io.mjs

- `decodeText(buf: Buffer | Uint8Array | ArrayBuffer | string): string`. Decodes UTF-8, UTF-16LE or UTF-16BE by byte order mark (UTF-8 without one) and drops the mark.
- `readTextFile(path: string): string`. Reads a file with `decodeText`; errors name the file.
- `readJsonFile(path: string): any`. Reads and parses JSON; errors name the file.
- `isNetworkPath(p: string): boolean`. True for `\\host\share`, `//host/share` and the `\\?\` and `\\.\` device namespaces, which Windows opens over SMB.
- `resolveBrandPath(value: string, root: string, field: string): string`. Resolves a path written in brand.json inside `root`; throws for an absolute, drive, network or `../` path.

### cli.mjs

- `isMain(metaUrl: string, argv1 = process.argv[1]): boolean`. True when the module is the script Node started, compared by real path, so it holds through symlinks, Windows junctions, drive-letter case and 8.3 names. False under `node -e`, the REPL and stdin.

### doctor.mjs

- `runDoctor({ cwd = process.cwd(), launchBrowser = true }?): Promise<{ ok, version, pluginRoot, checks }>`. The checks behind `atelier doctor` (shape [above](#the-atelier-cli)).
- `formatDoctor(result): string`. The text `atelier doctor` prints.

## brand.json

`.atelier/brand.json`, validated against [`plugins/atelier/schemas/brand.schema.json`](../plugins/atelier/schemas/brand.schema.json) (JSON Schema 2020-12) on every load and save. Unknown keys are rejected everywhere except the platform names under `social`. Add `"$schema": "https://raw.githubusercontent.com/EthanY33/atelier/main/plugins/atelier/schemas/brand.schema.json"` for editor autocomplete; `atelier brand init` writes it.

| Section | Required | Fields |
|---|---|---|
| `$schema` | no | Schema URL; ignored by atelier |
| `brand` | yes | `studio` (required, non-empty), `product`, `voice` (string array) |
| `palette` | yes, at least one entry | Named colors: keys start with a letter (letters, digits, `_`, `-`), values `#rgb`, `#rrggbb` or `#rrggbbaa` |
| `typography` | yes | `body` (required), `display`, `mono`: CSS font stacks, at most 300 characters, no `< > { } ;`, backslash or control characters |
| `logos` | no | `mark`, `wordmark`: paths |
| `social` | no | Handle per platform, strings |
| `deploy` | no | `target` (`cloudflare-pages`, `netlify`, `github-pages`, `vercel`, `custom`), `project`, `stores` (array of `steam`, `itch`, `apple`, `google`) |
| `motion` | no | `duration` (named durations such as `180ms` or `0.2s`), `easing` (named strings, at most 120 characters) |
| `surfaces` | no | `radius` (named lengths in `px`, `rem`, `em` or `%`), `elevation` (named integers 0 to 24), `zIndexMax` (integer, 0 or more) |
| `targets` | no | `minTapPx` (integer 1 to 200), `inpBudgetMs` (above 0, at most 10000), `lcpBudgetMs` (above 0, at most 60000), `clsBudget` (0 to 10) |

Named-token maps (`motion.duration`, `motion.easing`, `surfaces.radius`, `surfaces.elevation`) use the same key rule as `palette`. In 1.x the schema only gains optional fields ([policy](#semver-policy)). See the [skill reference](skill-reference.md#what-reads-brandjson) for which skill reads which field.

## ux-raw.json

Written by runtime-ux-audit next to `ux-report.md`. It validates against [`plugins/atelier/schemas/ux-audit.schema.json`](../plugins/atelier/schemas/ux-audit.schema.json), which rejects unknown keys. It holds no durations, host names, absolute local paths or tool versions, so the same inputs and timestamp give the same bytes.

| Field | Contents |
|---|---|
| `schemaVersion` | `"1.0"` |
| `tool` | `"atelier/runtime-ux-audit"` |
| `url` | The audited page as displayed in the report (a local file relative to its root) |
| `timestamp` | ISO 8601 date-time |
| `mode` | `{ dynamic, areas, engine }`; `engine` is `{ name, version, device, cpuThrottle }` under `--dynamic`, else `null` |
| `budgets` | `{ minTapPx, minTapPxSource, inpBudgetMs, lcpBudgetMs, clsBudget, zIndexMax, longScriptMs, motionDurationsMs }`; `minTapPxSource` is `default` or `brand`, `motionDurationsMs` maps token names to ms or is `null` |
| `summary` | `{ pass, rules, instances, byArea }`: `rules` and `instances` count failed rules and their instances per severity; `byArea` has the same counts plus `instances` for each audited area |
| `metrics` | `{ inpP75Ms, inp, bfcache, highlights }`. `inpP75Ms` is the lab INP estimate under `--dynamic`, else `null`. `inp` is `{ estimateMs, p75InteractionMs, maxMs, count, belowThreshold, worst }` or `null`. `bfcache` is `{ restored, reasons }` or `null`. `highlights` maps area to headline label to count. |
| `violations` | Failed rules: `{ ruleId, severity, area, confidence, methods, description, helpUrl, nodes, nodesTruncated? }` |
| `incomplete` | "Needs review" entries, same shape; they never fail the audit |
| `rules` | Every rule in the audited areas: `{ id, area, severity, status, reason?, suppressed? }`, `status` one of `failed`, `passed`, `notApplicable`, `skipped`, `incomplete`, `error` |
| `resources` | What was read: `{ kind, url, status, reason? }`; `kind` is `document`, `stylesheet`, `script`, `module`, `manifest`, `image` or `speculation-rules`; `status` is `parsed`, `skipped`, `failed`, `parse-error` or `too-large` |
| `errors` | `{ phase, ruleId?, message }` with `phase` `collect`, `rule` or `dynamic` |

A node is `{ selector, snippet, location, message?, confidence?, data? }`: `snippet` is at most 200 characters, `location` is `file:line:col` where known, and `data` holds rule-specific scalars. Each rule keeps at most 50 nodes; `nodesTruncated` counts the rest.

Versioning: every atelier 1.x release writes `schemaVersion` `"1.0"` until the format changes. Because the schema rejects unknown keys, any change to the format, including a new field, changes `schemaVersion`: an additive change becomes `"1.1"`, and a removal or type change waits for atelier 2.0 and `"2.0"`. Check the major part before reading a file.

## Error codes

| Code | Thrown by | Meaning |
|---|---|---|
| `BRAND_NOT_FOUND` | brand-memory, and skills that load brand.json | No `.atelier/brand.json` in the project root |
| `BRAND_INVALID` | brand-memory; runtime-ux-audit (`UxAuditError`) | Malformed JSON or a schema failure; brand-memory sets `err.errors`, runtime-ux-audit sets `err.path` |
| `BRAND_UNREADABLE` | brand-memory | The path cannot be read (a directory, no permission) |
| `BRAND_UNWRITABLE` | brand-memory | brand.json cannot be written |
| `BRAND_EXISTS` | brand-memory `initBrand` | The file exists and `overwrite` is `false` |
| `DEPS_MISSING` | design-token-sync | A plugin module is missing; reinstall the plugin |
| `SHARP_MISSING` | responsive-image-pipeline, brand-asset-pipeline | sharp cannot load |
| `AXE_MISSING` | accessibility-design-audit | `@axe-core/playwright` is missing |
| `PLAYWRIGHT_MISSING` | lib, og-card-generator, accessibility-design-audit, html-to-video, runtime-ux-audit | Playwright is not installed next to the plugin |
| `CHROMIUM_MISSING` | same | Playwright's Chromium is not installed; `fix` is the install command |
| `CHROMIUM_DEPS_MISSING` | same (not runtime-ux-audit) | Linux system libraries for Chromium are missing |
| `FFMPEG_MISSING` | lib, html-to-video | ffmpeg is not on PATH |
| `PREFLIGHT_FAILED` | lib `runPreflight` | One or more checks failed |
| `INPUT_NOT_FOUND` | accessibility-design-audit, runtime-ux-audit | The file does not exist |
| `INPUT_IS_DIRECTORY` | accessibility-design-audit | A directory was given instead of an HTML file |
| `INVALID_URL`, `UNSUPPORTED_SCHEME` | accessibility-design-audit | Not a URL, or not http, https, file or data |
| `INVALID_TAGS`, `UNKNOWN_TAG`, `NO_RULES` | accessibility-design-audit | The tag list is empty, names an unknown tag, or runs no rule |
| `NAVIGATION_FAILED`, `HTTP_ERROR`, `LOAD_TIMEOUT`, `WAIT_FOR_FAILED`, `ANALYZE_TIMEOUT` | accessibility-design-audit | The page could not be opened, answered 4xx or 5xx, missed its load event, never showed the `waitFor` selector, or axe timed out |
| `USAGE`, `SCHEME_NOT_ALLOWED`, `COLLECT_FAILED`, `DYNAMIC_FAILED` | runtime-ux-audit | Invalid option or input, unsupported scheme, document could not be collected, the dynamic pass failed |

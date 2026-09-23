# Skill reference

Each skill lives in `plugins/atelier/skills/<name>/`: `SKILL.md` is what Claude reads to decide when and how to use it, and `index.mjs` holds the JavaScript API and the CLI. Run any of them as `atelier <alias>`; add `--help` for its options. The full contract (signatures, defaults, errors, exit codes) is in [api.md](api.md).

| Skill | Alias | Inputs | Outputs | Dependencies |
|---|---|---|---|---|
| `brand-memory` | `brand` | `/brand-init` answers or `init` flags; a dotted path and value for `get` and `set` | `.atelier/brand.json`, validated on every load and save | ajv, ajv-formats |
| `design-token-sync` | `tokens` | brand.json | `tokens.css`, `tailwind.config.js`, `tokens.js`, `tokens.d.ts`, `figma-variables.json` (default `dist/tokens/`) | none beyond brand-memory |
| `og-card-generator` | `og` | brand.json; a `pages.json` manifest or `--title`, `--subtitle`, `--slug`; optional font files | one 1200x630 `<slug>.png` per page (default `og-cards/`) | playwright, sharp; Chromium |
| `responsive-image-pipeline` | `images` | image files, `file://` URLs or folders | AVIF and WebP per width, a JPEG or PNG fallback, `<name>-lqip.txt`, `<name>.cache`, a `<picture>` snippet on stdout | sharp |
| `brand-asset-pipeline` | `assets` | an SVG mark (or PNG, JPEG, WebP); brand.json with `--root` | favicons, app icons, social covers, Steam capsules (PNG) | sharp |
| `accessibility-design-audit` | `a11y` | a URL or HTML file | `a11y-report.md`, `a11y-raw.json` (default `a11y-report/`); exit 1 on critical or serious | playwright, @axe-core/playwright; Chromium |
| `html-to-video` | `video` | a URL or HTML file; duration, fps, size; optional audio file | MP4 (H.264) or WebM (VP9), optional `<name>-poster.jpg` | playwright; Chromium, ffmpeg |
| `runtime-ux-audit` | `ux` | a URL or HTML file; brand.json budgets when present | `ux-report.md`, `ux-raw.json` (default `ux-report/`); exit 1 on critical or serious | parse5, postcss, acorn, acorn-walk; playwright and Chromium only with `--dynamic` |

Dependencies are npm packages from `plugins/atelier/package.json`, installed with the plugin. Chromium is Playwright's build, installed once with the command `atelier doctor` prints. ffmpeg must be on PATH.

## What reads brand.json

| Skill | How it finds brand.json | Fields it reads |
|---|---|---|
| `brand-memory` | `<--root>/.atelier/brand.json` | all of it; writes it too |
| `design-token-sync` | `<projectRoot>/.atelier/brand.json`, required | every `palette` entry; `typography.display`, `body`, `mono` |
| `og-card-generator` | `<--project>/.atelier/brand.json`, required by the CLI; the API takes the object | `palette.bg`, `palette.fg`, `typography.display`, `typography.body`, `brand.studio` (footer), `brand.product` (title fallback) |
| `brand-asset-pipeline` | only with `--root` (API: `projectRoot` or `brand`) | `palette.bg` (background), `logos.mark` (default mark), `deploy.stores` (adds Steam capsules when it lists `steam`) |
| `runtime-ux-audit` | CLI: `./.atelier/brand.json` when it exists, or `--brand <path>`; `--no-brand` skips it. API: only the `brand` option. | `targets.minTapPx`, `targets.inpBudgetMs`, `surfaces.zIndexMax`, `motion.duration`; `targets.lcpBudgetMs` and `targets.clsBudget` are checked and echoed in `ux-raw.json` but no rule uses them |
| `responsive-image-pipeline` | never | none |
| `accessibility-design-audit` | never | none |
| `html-to-video` | never | none |

No skill reads `brand.voice`, `logos.wordmark`, `social`, `deploy.target`, `deploy.project`, `motion.easing`, `surfaces.radius` or `surfaces.elevation` in 1.0. They are part of the schema so the brand file can hold them for your own tools and prompts. The schema is summarized in [api.md](api.md#brandjson).

## Slash commands

| Command | Runs |
|---|---|
| `/brand-init` | An interview, then `atelier brand init` and the audit |
| `/brand-get <path>`, `/brand-set <path> <value>` | `atelier brand get` or `set` on one field, validated |
| `/brand-audit` | `atelier brand audit`, with a `/brand-set` line for each missing field |
| `/ux-audit <url-or-file>` | `atelier ux`, then a summary of the blocking findings and the top fixes |
| `/atelier-doctor` | `atelier doctor`, then an offer to run each fix |
| `/atelier-demo [dir]` | `atelier demo` into `./atelier-demo` (or `dir`), then a tour of the output |

The other skills have no slash command: ask Claude in plain words and it picks the skill from its description.

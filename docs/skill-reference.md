# Skill reference

Each skill is a self-contained module under `plugins/atelier/skills/<name>/` with its own `SKILL.md` contract, `index.mjs` entry point, and optional supporting files.

| Skill | Inputs | Outputs | Deps |
|---|---|---|---|
| `brand-memory` | brand name, colors, typography, logo path, voice | `.atelier/brand.json` | `ajv` |
| `design-token-sync` | `brand.json` | CSS vars · Tailwind config · TS defs · Figma variables | `none` |
| `og-card-generator` | `brand.json`, page title, description | PNG at 1200×630 | `playwright, sharp` |
| `responsive-image-pipeline` | source image path, `brand.json` | WebP/AVIF at multiple breakpoints | `sharp` |
| `brand-asset-pipeline` | source logo SVG, `brand.json` | Sized PNGs, favicons, social variants | `sharp` |
| `accessibility-design-audit` | URL or HTML file, `brand.json` | a11y-report.md + a11y-raw.json | `playwright, axe-core` |
| `html-to-video` | HTML file or URL, duration, fps | MP4 video | `playwright, ffmpeg` |

See each skill's `SKILL.md` under `plugins/atelier/skills/<name>/` for detailed contracts.

# atelier

> Design-automation plugin for Claude Code. Define your brand once — every skill uses it.

Seven skills around a shared `brand-memory` source of truth:

| Skill | Produces |
|---|---|
| `brand-memory` | `.atelier/brand.json` — brand source of truth |
| `design-token-sync` | CSS vars · Tailwind config · TS defs · Figma variables |
| `og-card-generator` | Open Graph + Twitter card PNGs per page |
| `responsive-image-pipeline` | AVIF/WebP variants + srcset + LQIP |
| `brand-asset-pipeline` | Favicons · app icons · social covers · Steam capsules |
| `accessibility-design-audit` | WCAG AA markdown report + screenshots |
| `html-to-video` | MP4 (H.264) + WebM (VP9) from any HTML |

## Install

```
/plugin marketplace add EthanY33/atelier
/plugin install atelier@atelier
```

Then:

```
/atelier-demo
```

MIT · [Contributing](docs/contributing.md) · [Getting started](docs/getting-started.md) · [Skill reference](docs/skill-reference.md)

*Full README with GIF demos and deeper docs lands at v0.1.0 launch (Phase 2).*

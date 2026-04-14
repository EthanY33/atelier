---
name: og-card-generator
description: Render 1200x630 Open Graph and Twitter card PNGs per page using brand-memory palette, typography, and wordmark. Batch-generate from a pages.json manifest. Use when setting up social previews for a new site or regenerating cards after a brand update.
---

## When to use

- Setting up social share previews for a new site
- Regenerating cards after a brand palette or typography update
- Adding `og:image` / `twitter:image` meta tags to any page

## How to run

### Single card (API)

```js
import { generateCard } from './plugins/atelier/skills/og-card-generator/index.mjs';
import { loadBrand } from './plugins/atelier/skills/brand-memory/index.mjs';

const brand = await loadBrand(process.cwd());
await generateCard({
  brand,
  page: { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' },
  outPath: 'public/og/home.png',
});
```

### Batch via CLI

```bash
node plugins/atelier/skills/og-card-generator/index.mjs pages.json public/og
```

### Manifest format (pages.json)

```json
{
  "pages": [
    { "slug": "home",    "title": "TideWane",      "subtitle": "A deep-sea idle dungeon crawler" },
    { "slug": "about",   "title": "About goneIdle", "subtitle": "The studio behind TideWane" },
    { "slug": "contact", "title": "Contact",         "subtitle": "Get in touch" }
  ]
}
```

## Output spec

- Format: PNG (compression level 9)
- Dimensions: 1200 × 630 px
- File names: `<slug>.png` (one per page)
- CSS custom properties applied: `--bg`, `--fg`, `--font-display`, `--font-body`

## Recommended meta snippet

Paste inside `<head>` for each page, replacing `{slug}` with the page slug:

```html
<meta property="og:image"         content="https://yourdomain.com/og/{slug}.png" />
<meta property="og:image:width"   content="1200" />
<meta property="og:image:height"  content="630" />
<meta name="twitter:card"         content="summary_large_image" />
<meta name="twitter:image"        content="https://yourdomain.com/og/{slug}.png" />
```

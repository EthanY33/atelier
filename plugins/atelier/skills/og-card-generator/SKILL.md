---
name: og-card-generator
description: Render 1200x630 Open Graph and Twitter card PNGs per page from brand-memory palette, typography, and wordmark; batch from a pages.json manifest. Use when setting up social previews for a new site, regenerating cards after a brand palette/typography update, or adding og:image/twitter:image meta tags.
---

## Run

```js
import { generateCard } from './plugins/atelier/skills/og-card-generator/index.mjs';
import { loadBrand } from './plugins/atelier/skills/brand-memory/index.mjs';
await generateCard({
  brand: await loadBrand(process.cwd()),
  page: { slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' },
  outPath: 'public/og/home.png',
});
```

Batch: `node plugins/atelier/skills/og-card-generator/index.mjs pages.json public/og`, where `pages.json` is `{ "pages": [ { "slug", "title", "subtitle" }, … ] }`.

Output: PNG (compression level 9), 1200x630, `<slug>.png` per page. CSS vars applied: `--bg`, `--fg`, `--font-display`, `--font-body`.

## Meta snippet (`<head>`, per page)

```html
<meta property="og:image" content="https://yourdomain.com/og/{slug}.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://yourdomain.com/og/{slug}.png" />
```

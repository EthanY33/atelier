---
name: brand-asset-pipeline
description: Turn a single mark.svg into a full brand asset pack — favicons (16/32/48/64/180), Apple/Android app icons, social covers (OG/Twitter/LinkedIn), and Steam store capsules. Reads deploy target from brand-memory to pick the right preset. Use when bootstrapping a new site, rebranding, or generating store assets.
---

## When to use

- Bootstrapping a new site and needing every favicon, app icon, and social cover in one pass.
- Rebranding — swap `mark.svg` and regenerate everything in seconds.
- Shipping to Steam — the `steam` target produces all required capsule sizes.
- Adding or updating social preview images (OG, Twitter, LinkedIn).

## Targets

| Target      | Files generated | Dimensions |
|-------------|-----------------|------------|
| `favicons`  | `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon-64.png`, `favicon-180.png` | Square icons at each size |
| `app-icons` | `apple-touch-icon.png` (180), `android-chrome-192.png` (192), `android-chrome-512.png` (512) | Square icons |
| `social`    | `og-cover.png` (1200×630), `twitter-cover.png` (1500×500), `linkedin-cover.png` (1584×396) | Banner, mark centred at 50% of short edge |
| `steam`     | `steam-header.png` (460×215), `steam-capsule-main.png` (616×353), `steam-capsule-small.png` (231×87) | Banner |

All square icons use `fit: contain` with a transparent background.  
All banners composite the mark centred on `backgroundColor` (default `#110f1b`).

## How to run

### API

```js
import { generateAssets } from './plugins/atelier/skills/brand-asset-pipeline/index.mjs';

const { files } = await generateAssets({
  markSvg:         'brand/mark.svg',
  outDir:          'public/brand',
  targets:         ['favicons', 'app-icons', 'social'], // default
  backgroundColor: '#110f1b',                           // optional
});
console.log(`Generated ${files.length} assets`);
```

### CLI (one-liner)

```bash
node -e "
import('./plugins/atelier/skills/brand-asset-pipeline/index.mjs')
  .then(m => m.generateAssets({ markSvg: 'brand/mark.svg', outDir: 'public/brand' }))
  .then(r => console.log(r.files));
"
```

## HTML wiring snippet

Paste inside `<head>` after generating favicons and app-icons:

```html
<!-- Favicons -->
<link rel="icon"             type="image/png" sizes="32x32"  href="/brand/favicon-32.png">
<link rel="icon"             type="image/png" sizes="16x16"  href="/brand/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180"                 href="/brand/apple-touch-icon.png">
<!-- Do NOT add <link rel="icon" href="/favicon.ico"> — see "Why no .ico" below. -->

<!-- Android / PWA -->
<link rel="icon" type="image/png" sizes="192x192" href="/brand/android-chrome-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/brand/android-chrome-512.png">

<!-- OG / Social -->
<meta property="og:image"        content="https://yourdomain.com/brand/og-cover.png">
<meta property="og:image:width"  content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card"        content="summary_large_image">
<meta name="twitter:image"       content="https://yourdomain.com/brand/twitter-cover.png">
```

## Why no `.ico`

This skill intentionally emits **PNG favicons only** — no `favicon.ico`. Every
evergreen browser since 2017 handles `<link rel="icon" type="image/png">`
natively, and PNG gives sharper rendering on HiDPI displays.

The common Node generators for `.ico` (most notably `to-ico`) produce 24-bit
BMP-encoded `.ico` files. Chromium, Firefox, and Safari misinterpret the
pixel layout on some of those BMPs and render the favicon as vertical RGB
stripes instead of the mark. It looks fine locally in the OS preview but
broken in the browser tab — a pattern repeatedly observed in 2026 goneidle
builds before the `.ico` was removed entirely.

If you must support IE / early Edge (which you do not, in 2026): build the
`.ico` manually from 16/32/48 PNGs using `png2icojs` or ImageMagick
`convert png:… ico:…`, and verify the result in a real browser tab — not the
OS file preview.

Safe default: ship only PNGs; drop `<link rel="icon" href="/favicon.ico">`
from the `<head>`.

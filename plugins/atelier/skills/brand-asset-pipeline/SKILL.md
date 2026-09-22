---
name: brand-asset-pipeline
description: Turn one mark.svg into a full brand asset pack (favicons 16/32/48/64/180, Apple/Android app icons, OG/Twitter/LinkedIn social covers, Steam store capsules). Reads deploy target from brand-memory to pick the preset. Use when bootstrapping a new site, rebranding, shipping to Steam, generating store assets, or updating social preview images.
---

## Targets

- `favicons`: `favicon-16.png`, `-32`, `-48`, `-64`, `-180`
- `app-icons`: `apple-touch-icon.png` (180), `android-chrome-192.png`, `android-chrome-512.png`
- `social`: `og-cover.png` 1200x630, `twitter-cover.png` 1500x500, `linkedin-cover.png` 1584x396
- `steam`: `steam-header.png` 460x215, `steam-capsule-main.png` 616x353, `steam-capsule-small.png` 231x87

Square icons: `fit: contain`, transparent background. Banners: mark centred at 50% of short edge on `backgroundColor` (default `#110f1b`).

## Run

No CLI entry; call the API (from a shell, via `node -e` dynamic `import()`).

```js
import { generateAssets } from './plugins/atelier/skills/brand-asset-pipeline/index.mjs';
const { files } = await generateAssets({
  markSvg: 'brand/mark.svg',
  outDir: 'public/brand',
  targets: ['favicons', 'app-icons', 'social'], // default
  backgroundColor: '#110f1b',                   // optional
});
```

## HTML wiring (`<head>`)

```html
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png">
<!-- Do NOT add <link rel="icon" href="/favicon.ico">, see "Why no .ico" -->
<link rel="icon" type="image/png" sizes="192x192" href="/brand/android-chrome-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/brand/android-chrome-512.png">
<meta property="og:image" content="https://yourdomain.com/brand/og-cover.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://yourdomain.com/brand/twitter-cover.png">
```

## Why no `.ico`

PNG favicons only, never `favicon.ico`. Node `.ico` generators (notably `to-ico`) emit 24-bit BMP-encoded `.ico` files that Chromium, Firefox, and Safari can render as vertical RGB stripes in the tab while the OS preview looks fine (seen repeatedly in 2026 goneidle builds until `.ico` was removed). Every evergreen browser since 2017 supports PNG icons, sharper on HiDPI.

Only if IE/early Edge support is truly required (it isn't in 2026): build `.ico` by hand from 16/32/48 PNGs with `png2icojs` or ImageMagick `convert png:… ico:…`, and verify in a real browser tab, not the OS file preview.

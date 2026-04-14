---
name: responsive-image-pipeline
description: Convert source PNGs/JPGs into AVIF and WebP variants at multiple widths, emit a base64 LQIP placeholder, and generate a copy-pasteable <picture> snippet. SHA-cached so repeated runs on unchanged sources are no-ops. Use for site images, gallery screenshots, and hero art.
---

## When to use

- Converting hero images, gallery screenshots, or any site artwork into modern formats (AVIF + WebP).
- Reducing page-weight with responsive `srcset` at 480 / 768 / 1280 / 1920 px breakpoints.
- Generating a tiny blurred placeholder (LQIP) to show before the full image loads.
- Automating the process after swapping in a new asset — unchanged sources are skipped via SHA cache.

## How to run

### API

```js
import {
  processImage,
  buildPictureSnippet,
} from './plugins/atelier/skills/responsive-image-pipeline/index.mjs';

// Convert source image → AVIF + WebP variants + LQIP
const { cached, variants, lqip } = await processImage({
  input:  'public/img/hero.png',
  outDir: 'public/img/processed',
  widths: [480, 768, 1280, 1920], // optional, these are the defaults
  lqipWidth: 24,                  // optional, default 24px
});
console.log(cached ? 'skipped (no change)' : `wrote ${variants.length} files`);

// Build a <picture> snippet to paste into HTML
const html = buildPictureSnippet({
  basename:       'hero',
  widths:         [480, 768, 1280, 1920],
  alt:            'TideWane hero',
  fallbackFormat: 'png',   // optional, default 'png'
  sizes:          '100vw', // optional, default '100vw'
});
```

### CLI (one-liner)

```bash
node -e "
import('./plugins/atelier/skills/responsive-image-pipeline/index.mjs')
  .then(m => m.processImage({ input: 'hero.png', outDir: 'dist/img' }))
  .then(r => console.log(r));
"
```

## Output files

| File | Description |
|------|-------------|
| `<name>-<w>.avif` | AVIF at width `w` (quality 60, effort 4) |
| `<name>-<w>.webp` | WebP at width `w` (quality 78) |
| `<name>-lqip.txt` | `data:image/jpeg;base64,…` (24 px wide, quality 40) |
| `<name>.cache`    | SHA-256 fingerprint — delete to force regeneration |

## Example `<picture>` output

```html
<picture>
  <source type="image/avif" srcset="hero-480.avif 480w, hero-768.avif 768w, hero-1280.avif 1280w, hero-1920.avif 1920w" sizes="100vw">
  <source type="image/webp" srcset="hero-480.webp 480w, hero-768.webp 768w, hero-1280.webp 1280w, hero-1920.webp 1920w" sizes="100vw">
  <img src="hero-1920.png" alt="TideWane hero" loading="lazy" decoding="async">
</picture>
```

Inline the LQIP data URL as the `<img>` placeholder style for progressive loading:

```html
<img style="background-image:url(data:image/jpeg;base64,…)" ...>
```

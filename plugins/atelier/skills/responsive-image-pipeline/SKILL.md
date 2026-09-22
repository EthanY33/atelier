---
name: responsive-image-pipeline
description: Convert source PNGs/JPGs into AVIF and WebP variants at multiple widths, emit a base64 LQIP placeholder, and generate a copy-pasteable <picture> snippet. SHA-cached, so reruns on unchanged sources are no-ops. Use for site images, gallery screenshots, hero art, srcset/page-weight work, or reprocessing after swapping an asset.
---

## Run

No CLI entry; call the API (from a shell, via `node -e` dynamic `import()`).

```js
import { processImage, buildPictureSnippet } from './plugins/atelier/skills/responsive-image-pipeline/index.mjs';

const { cached, variants, lqip } = await processImage({
  input: 'public/img/hero.png',
  outDir: 'public/img/processed',
  widths: [480, 768, 1280, 1920], // default
  lqipWidth: 24,                  // default
}); // cached === true: source unchanged, skipped

const html = buildPictureSnippet({
  basename: 'hero',
  widths: [480, 768, 1280, 1920],
  alt: 'TideWane hero',
  fallbackFormat: 'png', // default
  sizes: '100vw',        // default
});
```

## Output files

- `<name>-<w>.avif`: quality 60, effort 4
- `<name>-<w>.webp`: quality 78
- `<name>-lqip.txt`: `data:image/jpeg;base64,…` (24 px wide, quality 40)
- `<name>.cache`: SHA-256 fingerprint; delete to force regeneration

Snippet: `<picture>` with AVIF then WebP `<source srcset="hero-480.avif 480w, …" sizes="100vw">` and fallback `<img src="hero-1920.png" alt="…" loading="lazy" decoding="async">`. For progressive loading, inline the LQIP data URL as the placeholder: `<img style="background-image:url(data:image/jpeg;base64,…)" ...>`.

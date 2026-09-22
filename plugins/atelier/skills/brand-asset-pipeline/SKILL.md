---
name: brand-asset-pipeline
description: Render one SVG logo mark into a PNG brand asset pack (favicons 16 to 180 px, apple-touch-icon and Android Chrome icons, Open Graph, Twitter and LinkedIn covers, Steam store capsules). With --root it takes the background color, mark path and Steam target from .atelier/brand.json. Use when bootstrapping site icons, rebranding, or making social or Steam store art.
---

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" assets brand/mark.svg --out public/brand
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" assets brand/mark.svg --out public/brand --targets favicons,app-icons --bg "#0b1020"
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" assets --root . --out public/brand
```

When the project has `.atelier/brand.json`, pass `--root .` so its `palette.bg`, `logos.mark` and `deploy.stores` apply.

JS API (pass the skill dir as an argument so the import also works with Windows paths):

```bash
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const { generateAssets } = await import(pathToFileURL(process.argv[1] + '/index.mjs').href);
const { files, targets, backgroundColor } = await generateAssets({
  markSvg: 'brand/mark.svg',
  outDir: 'public/brand',
  projectRoot: process.cwd(), // omit when there is no .atelier/brand.json
});
console.log(targets.join(','), backgroundColor, files.length);
" "${CLAUDE_SKILL_DIR}"
```

Also exported: `PRESETS` (frozen target table) and `runCli(argv, { stdout, stderr })`, which returns the exit code.

## Options

- `<mark.svg>` / `markSvg`: the mark. SVG in UTF-8 or UTF-16, or a PNG/JPEG/WebP. Default: brand `logos.mark`, resolved against the root.
- `--out <dir>` (`-o`) / `outDir`: required; created if missing.
- `--targets <list>` (`-t`) / `targets` (array): any of `favicons`, `app-icons`, `social`, `steam`. Default: `favicons,app-icons,social`, plus `steam` when brand `deploy.stores` includes `steam`.
- `--bg <hex>` / `backgroundColor`: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; the `#` is optional, so quote it or drop it in a shell. Default: brand `palette.bg`, else `#110f1b`.
- `--root <dir>` / `projectRoot`: read `<dir>/.atelier/brand.json` for the defaults above. The API also takes `brand` (an object from brand-memory `loadBrand`) instead.
- `--json`: print the result object instead of the file list.

Explicit options always win over brand.json. Relative mark and output paths resolve against the current directory.

## Output

- `favicons`: `favicon-16.png`, `-32`, `-48`, `-64`, `-180`. Mark fit inside a transparent square.
- `app-icons`: `apple-touch-icon.png` 180 (opaque: mark at 80% on the background color, no alpha channel; iOS would fill transparency with black or white), `android-chrome-192.png` and `android-chrome-512.png` (transparent).
- `social`: `og-cover.png` 1200x630, `twitter-cover.png` 1500x500, `linkedin-cover.png` 1584x396.
- `steam`: `steam-header.png` 460x215, `steam-capsule-main.png` 616x353, `steam-capsule-small.png` 231x87.

Banners (social, steam) put the mark at 50% of the short edge, centred on the background color; an 8-digit hex keeps its alpha there. The API returns `{ files, targets, backgroundColor }`. Nothing is written until every input is valid and every image has rendered, so a failure leaves the output directory untouched. Existing files with the same names are overwritten.

## Exit codes

- `0`: assets written.
- `2`: usage error (message plus usage on stderr), or a failure such as an unreadable mark, an invalid brand.json or a remote image link (`atelier: <message>` on stderr).

## Notes

- Linked `<image>` files (relative, `../`, absolute or `file://`) are embedded before rendering, and WebP or GIF images are converted to PNG, because the renderer drops them silently otherwise. Remote `http(s)` links are refused, since atelier makes no network calls: download the image first. A mark that renders fully transparent is an error.
- Render density follows the SVG's own size, so 4096 px or larger canvases work.
- `twitter-cover.png` and `linkedin-cover.png` are profile header uploads (3:1 and 4:1), not link previews. X shows `summary_large_image` at about 2:1, which `og-cover.png` fits. For per-page cards with titles, use og-card-generator.
- No `favicon.ico`: Node `.ico` encoders such as `to-ico` write 24-bit BMP entries that browsers can draw as vertical RGB stripes in the tab while the OS preview looks fine, and every current browser takes PNG icons. If a legacy browser needs one, build it from the 16/32/48 PNGs (`magick favicon-16.png favicon-32.png favicon-48.png favicon.ico`) and check it in a real browser tab.

`<head>` wiring, with the files served from `/brand/`:

```html
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/brand/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/brand/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="192x192" href="/brand/android-chrome-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="/brand/android-chrome-512.png">
<meta property="og:image" content="https://example.com/brand/og-cover.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://example.com/brand/og-cover.png">
```

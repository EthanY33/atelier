---
name: og-card-generator
description: Render 1200x630 Open Graph and Twitter card PNGs, one per page, from .atelier/brand.json colors, fonts and studio name; single card from flags or a batch from a pages.json manifest. Use when adding og:image or twitter:image meta tags, setting up social link previews for a site or blog, or regenerating cards after a brand color or font change.
---

## Run

Run from the project root that holds `.atelier/brand.json` (or pass `--project <dir>`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" og pages.json public/og
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" og --title "TideWane" --subtitle "A deep-sea idle dungeon crawler" --slug home --out public/og
```

`pages.json` is `{ "pages": [ { "slug": "home", "title": "...", "subtitle": "..." } ] }` or a bare array of pages.

JS API:

```bash
node --input-type=module -e "
import { generateCards } from '${CLAUDE_SKILL_DIR}/index.mjs';
import { loadBrand } from '${CLAUDE_SKILL_DIR}/../brand-memory/index.mjs';
const paths = await generateCards({
  brand: loadBrand(process.cwd()),
  pages: [{ slug: 'home', title: 'TideWane', subtitle: 'A deep-sea idle dungeon crawler' }],
  outDir: 'public/og',
});
console.log(paths.join('\n'));
"
```

Also exported: `generateCard({ brand, page, outPath })` for one card, and `buildCardHtml(brand, page)` for the HTML without rendering.

## Options

CLI:
- `<pages.json> [outDir]`: batch; `outDir` defaults to `og-cards` (or use `--out <dir>`).
- `--title <text>`, `--subtitle <text>`, `--slug <slug>`, `--out <dir>`: one card without a manifest.
- `--project <dir>`: where `.atelier/brand.json` lives (default: current directory).
- `--font-display <file>`, `--font-body <file>`: font files (.woff2, .woff, .ttf, .otf) for the brand fonts.

API (both functions): `fonts: { display?, body? }` (font file paths), `browser` (reuse an open Playwright browser; it is left open), `onWarning(message)` (default: printed to stderr).

Page fields:
- `slug`: file name and footer path. Lowercase letters, digits, `-` and `_`, with `/` for nested folders (`blog/launch`). Default `index`.
- `title`: falls back to `brand.product`.
- `subtitle`: `description` is accepted as an alias.

Brand fields read (nothing else, no logos):
- `palette.bg`: default `#111111`.
- `palette.fg`: default `#111111` or `#ffffff`, whichever contrasts more with `bg`.
- `typography.display` (title; falls back to `body`) and `typography.body`.
- `brand.studio`: footer text.

## Output

`<outDir>/<slug>.png` per page, 1200x630 PNG. The CLI prints the written paths. Title is 88px bold, shrinks to 48px to fit 4 lines, then is shortened with an ellipsis; the subtitle keeps 2 lines; the footer shows `<studio> /` and `/<slug>` and always stays on the card.

Warnings (stderr, cards are still written): text contrast below 4.5:1, a brand font that is not installed and has no font file, a font file that fails to load, text shortened to fit.

## Exit codes

- `0`: cards written.
- `2`: usage error (usage printed to stderr) or runtime failure (`atelier: <message>`, plus a `Fix:` line when Chromium is missing).

## Notes

- Fonts: without a font file the card uses fonts installed on the rendering machine, so web fonts such as Inter usually fall back. Pass the file to get the real font; it is inlined, never fetched.
- Font stacks are quoted per family, so names like `Press Start 2P` work.
- Every slug is checked before anything is written: a slug that could leave `outDir` (`..`, `:`, backslashes, dots) or two pages writing the same file is an error.
- Page text is HTML-escaped. The card page runs with JavaScript disabled and all network requests blocked, so a title or brand value cannot run script or fetch anything.
- Needs Playwright Chromium. Check with `node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" doctor`.
- One PNG serves both tags:

```html
<meta property="og:image" content="https://example.com/og/home.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://example.com/og/home.png" />
```

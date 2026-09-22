---
name: brand-memory
description: Define the project's brand identity once (palette, typography, logos, voice, social handles, deploy target) in .atelier/brand.json, which every other atelier skill reads. Use at the start of any design-automation workflow, when initializing a project's design source of truth, updating brand fields, or auditing completeness.
---

## Exports

- `brandFilePath(projectRoot)` → `string`, canonical path to `brand.json`
- `loadBrand(projectRoot)` → `Promise<object>`; throws a helpful error if missing
- `saveBrand(projectRoot, cfg)` → `Promise<void>`; validates against the JSON Schema, writes pretty JSON with trailing newline
- `getPath(obj, 'dotted.path')` → value, or `undefined` if missing
- `setPath(obj, 'dotted.path', value)` → deep clone with value set; creates intermediate objects; never mutates the original
- `initBrand(projectRoot, { studio, bodyFont, primaryColor })` → `Promise<object>`; creates and saves the minimal valid config
- `auditBrand(cfg)` → `{ missing: string[] }`: recommended fields absent or empty

## Interactive init flow

On `/brand-init`, prompt for these 8 values before writing:

1. Studio name: developer/company (e.g. `goneIdle`)
2. Product name: game or product (e.g. `TideWane`)
3. Brand voice: 2-4 adjectives (e.g. `atmospheric, mysterious, deep-sea`)
4. Primary background color, hex (e.g. `#110f1b`)
5. Accent color, hex (e.g. `#67e8f9`)
6. Body font stack: full CSS font-family (e.g. `Silkscreen, 'Courier New', monospace`)
7. Display font stack: optional, Enter skips
8. Deploy target: `cloudflare-pages`, `netlify`, `github-pages`, `vercel`, or `custom`

Then call `initBrand`, then `auditBrand`, and report still-missing fields with suggestions.

## Schema

`schemas/brand.schema.json` (JSON Schema 2020-12). Required top-level keys: `brand`, `palette`, `typography`. Palette values must be hex (`#rgb`, `#rrggbb`, `#rrggbbaa`). `deploy.target` must be one of the 5 values above.

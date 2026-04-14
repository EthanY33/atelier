---
name: brand-memory
description: Define the project's brand identity once — palette, typography, logos, voice, social handles, deploy target — in .atelier/brand.json. Every other atelier skill reads from it. Use when initializing a project's design source of truth, updating brand fields, or auditing completeness.
---

## When to Use

Use `brand-memory` at the start of any design-automation workflow. It creates and maintains `.atelier/brand.json` — the single file all other atelier skills read from for palette values, typography stacks, logo paths, and deploy targets. Return to it whenever a brand detail changes or you want to check completeness.

## The 6 Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `brandFilePath` | `(projectRoot) → string` | Returns the canonical path to `brand.json` |
| `loadBrand` | `(projectRoot) → Promise<object>` | Reads and parses `brand.json`; throws a helpful error if missing |
| `saveBrand` | `(projectRoot, cfg) → Promise<void>` | Validates cfg against the JSON Schema, then writes pretty JSON with a trailing newline |
| `getPath` | `(obj, 'dotted.path') → *` | Reads a nested value; returns `undefined` for missing paths |
| `setPath` | `(obj, 'dotted.path', value) → object` | Returns a deep clone with the value set; creates intermediate objects; never mutates the original |
| `initBrand` | `(projectRoot, { studio, bodyFont, primaryColor }) → Promise<object>` | Creates the minimal valid config and saves it |
| `auditBrand` | `(cfg) → { missing: string[] }` | Returns a list of recommended fields that are absent or empty |

## Interactive Init Flow

When a user runs `/brand-init`, prompt for these 8 values before writing the file:

1. **Studio name** — the developer/company name (e.g. `goneIdle`)
2. **Product name** — the game or product name (e.g. `TideWane`)
3. **Brand voice** — 2–4 adjectives describing tone (e.g. `atmospheric, mysterious, deep-sea`)
4. **Primary background color** — hex (e.g. `#110f1b`)
5. **Accent color** — hex (e.g. `#67e8f9`)
6. **Body font stack** — full CSS font-family value (e.g. `Silkscreen, 'Courier New', monospace`)
7. **Display font stack** — optional; press Enter to skip
8. **Deploy target** — one of `cloudflare-pages`, `netlify`, `github-pages`, `vercel`, `custom`

After collecting answers, call `initBrand` then `auditBrand` and report any still-missing fields with suggestions.

## Schema Reference

The config is validated against `schemas/brand.schema.json` (JSON Schema 2020-12). Required top-level keys are `brand`, `palette`, and `typography`. All palette values must be valid hex colors (`#rgb`, `#rrggbb`, or `#rrggbbaa`). The `deploy.target` must be one of the five allowed enum values. See the schema file for the complete definition.

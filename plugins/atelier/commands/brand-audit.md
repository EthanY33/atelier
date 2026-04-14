---
description: Report missing recommended fields in .atelier/brand.json.
---

You are running `/brand-audit` for the current project.

1. Call `loadBrand(projectRoot)` to read the config. If the file is missing, tell the user to run `/brand-init` first.

2. Call `auditBrand(cfg)` to get the list of missing recommended fields.

3. If `missing` is empty, report that the brand config is complete and all recommended fields are present.

4. Otherwise, display a table of missing fields and explain why each one matters:
   - **brand.product** — the product/game name; used by og-card-generator and responsive-image-pipeline for meta titles.
   - **brand.voice** — tone adjectives; used by copy-generation prompts to stay on-brand.
   - **typography.display** — headline font stack; used by og-card-generator and html-to-video for title renders.
   - **logos.mark** — path to the icon/symbol logo; used in og cards, favicons, and Steam assets.
   - **logos.wordmark** — path to the text logo; used in trailers, hero banners, and press kits.
   - **social** — platform handles; used in Open Graph tags and footer templates.
   - **deploy.target** — hosting platform; used by the deploy step to pick the right adapter.

5. For each missing field, suggest the `/brand-set` command the user can run to fill it in (e.g. `/brand-set logos.mark brand/mark.svg`).

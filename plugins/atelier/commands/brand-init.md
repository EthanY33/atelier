---
description: Initialize .atelier/brand.json interactively (studio, colors, typography).
---

You are running `/brand-init` for the current project.

1. **Check for an existing file.** Call `brandFilePath(projectRoot)` and check whether `.atelier/brand.json` already exists. If it does, warn the user that it will be overwritten and ask for explicit confirmation before proceeding. If the user declines, stop here.

2. **Run the interactive init flow.** Ask the user the 8 questions defined in the `brand-memory` SKILL.md one at a time (or in a single grouped prompt if the context supports it):
   - Studio name
   - Product name
   - Brand voice (2–4 adjectives)
   - Primary background color (hex)
   - Accent color (hex)
   - Body font stack
   - Display font stack (optional)
   - Deploy target (cloudflare-pages / netlify / github-pages / vercel / custom)

3. **Write the file.** Call `initBrand(projectRoot, { studio, bodyFont, primaryColor })` to create the minimal valid config, then use `setPath` to merge in the remaining fields (product, voice, accent, display font, deploy target).

4. **Run an audit.** Call `auditBrand(cfg)` and report the result. If `missing` is non-empty, list each field and briefly explain what it is used for so the user knows what to fill in next.

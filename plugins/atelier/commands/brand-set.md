---
description: Set a value in .atelier/brand.json by dotted path.
---

You are running `/brand-set $ARGUMENTS` where `$ARGUMENTS` is `<dotted.path> <value>` (e.g. `brand.product TideWane` or `deploy.target netlify`).

1. Parse `$ARGUMENTS`: split on the first space to get the dotted path and the remaining string as the value. If the value looks like a JSON array or object (starts with `[` or `{`), parse it as JSON. Otherwise treat it as a plain string.

2. Call `loadBrand(projectRoot)` to read the current config. If the file is missing, tell the user to run `/brand-init` first.

3. Call `setPath(cfg, path, value)` to produce the updated config (the original is not mutated).

4. Call `saveBrand(projectRoot, updatedCfg)`. If schema validation fails, report the error clearly without writing the file.

5. On success, confirm the update by echoing the new value back: `brand.product → TideWane`.

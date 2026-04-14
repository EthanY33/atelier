---
description: Read a value from .atelier/brand.json by dotted path.
---

You are running `/brand-get $ARGUMENTS` where `$ARGUMENTS` is the dotted path to read (e.g. `brand.studio`, `palette.bg`, `deploy.target`).

1. Call `loadBrand(projectRoot)` to read the current config. If the file is missing, the function will throw a helpful error — surface it to the user.

2. Call `getPath(cfg, '$ARGUMENTS')` to retrieve the value at the requested path.

3. If the value is `undefined`, tell the user the field is not set and suggest using `/brand-set $ARGUMENTS <value>` to add it.

4. Otherwise, display the value clearly. If it is an object or array, format it as pretty JSON.

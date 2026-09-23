---
description: Print one value from .atelier/brand.json by dotted path, for example palette.bg, typography.body or brand.voice.
argument-hint: "<dotted.path> [--root <dir>]"
---

Arguments (may be empty): `$ARGUMENTS`

The first argument is the dotted path. If there is none, ask the user which one (common: `brand.studio`, `palette.bg`, `palette.accent`, `typography.body`, `deploy.target`).

Run it with the path in single quotes (POSIX quoting; write a single quote inside a value as `'\''`). Add `--root '<dir>'` if the user gave `--root`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand get '<dotted.path>' --raw
```

- Exit 0: show the value. Strings print as-is; objects and arrays print as JSON.
- Exit 2 and the message says `is not set`: say so and suggest `/brand-set <dotted.path> <value>`.
- Exit 2 and the message says `not found`: there is no brand.json yet; suggest `/brand-init`.
- Any other failure: show stderr verbatim and stop.

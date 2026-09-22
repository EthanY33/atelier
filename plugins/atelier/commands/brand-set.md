---
description: Set one value in .atelier/brand.json by dotted path (a color, font stack, voice, logo path, social handle or deploy target), validated against the schema before it is saved.
argument-hint: "<dotted.path> <value>"
---

Arguments (may be empty): `$ARGUMENTS`

The first word is the dotted path; everything after it is the value, which may contain spaces. If the user wrapped the whole value in one pair of quotes, drop them. If the path or the value is missing, ask for it.

Run once, with the path and the whole value each in single quotes (POSIX quoting; write a single quote inside a value as `'\''`). The `--` keeps a value that starts with `-` from being read as an option. If the user gave `--root <dir>`, put `--root '<dir>'` before the `--`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand set -- '<dotted.path>' '<value>'
```

How the CLI reads the value: valid JSON is parsed (`true`, `12`, `["a","b"]`, `{"twitter":"@studio"}`), anything else stays a string. String fields keep numbers as text, `brand.voice` and `deploy.stores` turn a comma list into an array, and palette colors may omit the `#`.

- Exit 0: report the line it prints, for example `palette.accent = "#67e8f9"`.
- Exit 2: show stderr verbatim and stop. Nothing was written. A validation message names the field and its allowed values; `not found` means run `/brand-init` first.

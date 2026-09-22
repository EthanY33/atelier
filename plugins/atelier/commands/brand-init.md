---
description: Create the project's brand file, .atelier/brand.json, from a short interview (studio, product, voice, colors, fonts, deploy target), then show the audit.
argument-hint: "[--root <dir>]"
---

Create `.atelier/brand.json` with the atelier brand CLI. Never write or edit brand.json by hand: every write goes through the CLI, which validates it.

Arguments (may be empty): `$ARGUMENTS`. The only one is `--root <dir>`, the folder that holds `.atelier/` (default: the current directory). If given, add `--root '<dir>'` to every command below.

Commands use POSIX shell quoting (the Bash tool). Wrap each value in single quotes and write a single quote inside a value as `'\''`.

1. Check for an existing file:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand audit
   ```

   - Exit 2 and the message says `not found`: there is no file yet. Continue.
   - Exit 0: a brand.json exists. Show its path and ask whether to replace it. Continue only on an explicit yes (step 3 then adds `--force`). Otherwise stop and suggest `/brand-set` for single changes.
   - Any other error (for example a file that is not valid JSON): show stderr verbatim and ask whether to replace the file, same rule as above.

2. Ask the user for all of these in one message, with the defaults shown:
   1. Studio or company name (default: the project folder name)
   2. Product or game name (optional)
   3. Brand voice: 2 to 4 adjectives, for example `calm, precise`
   4. Background color hex, for example `#110f1b` (default `#111111`)
   5. Accent color hex (optional)
   6. Body font stack, for example `Inter, system-ui, sans-serif` (default `system-ui, sans-serif`)
   7. Display (headline) font stack (optional)
   8. Deploy target: `cloudflare-pages`, `netlify`, `github-pages`, `vercel` or `custom` (optional)

   Check the answers before running anything and re-ask only for the bad ones: colors are `#rgb`, `#rrggbb` or `#rrggbbaa` (add a missing `#`); font stacks are at most 300 characters with no `<`, `>`, `{`, `}`, `;` or backslash; voice is 2 to 4 comma-separated words; the deploy target is one of the five values.

3. Run ONE init command with every answer. Use the `--flag='value'` form (safe when a value starts with `-`) and leave out any flag the user skipped; the CLI fills studio, background and body font with defaults and says so. Example:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" brand init --studio='goneIdle' --product='TideWane' --voice='atmospheric, mysterious' --bg='#110f1b' --accent='#67e8f9' --body-font='Silkscreen, '\''Courier New'\'', monospace' --display-font='Space Grotesk, sans-serif' --deploy='cloudflare-pages'
   ```

   Add `--force` only when the user agreed in step 1 to replace an existing file.

4. On exit 0, show the CLI output: the `Wrote` line, any `Defaults used` line, and the audit. For each missing field in the audit, give the matching `/brand-set <path> <value>` command.

   On a non-zero exit, show stderr verbatim and stop. Nothing was written. If the message names a field (for example `palette.bg: must be a hex color`), ask the user for a corrected value before running init again.

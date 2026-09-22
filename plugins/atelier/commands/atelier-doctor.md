---
description: Check that atelier can run here (Node, plugin dependencies, sharp, Chromium, ffmpeg, ./.atelier/brand.json), explain each warning or failure, and offer to run the fix.
argument-hint: "[--no-browser]"
---

Arguments (may be empty): `$ARGUMENTS`. Add `--no-browser` only if the user passed it; it skips the Chromium launch.

Run it from the user's project directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" doctor
```

Exit 0 means ready (warnings allowed), 1 means a check failed, 2 means a usage error. Show the output verbatim. On exit 2, stop.

If every line is `ok`, say atelier is ready. Otherwise, for each `warn` or `fail` line, say in one sentence what it affects and show its `fix:` line:

- `node` (fail): atelier needs Node 22 or newer; nothing runs until it is upgraded.
- `dependencies` or `sharp` (fail): the plugin's npm packages are missing or broken; the image skills (brand-asset-pipeline, responsive-image-pipeline, og-card-generator) and anything that needs Playwright fail.
- `chromium` (warn): og-card-generator, accessibility-design-audit, html-to-video and `ux --dynamic` need it; the other skills work without it.
- `ffmpeg` (warn): only html-to-video needs it.
- `brand.json` (warn): no brand file in this directory; design-token-sync and og-card-generator read one. Suggest `/brand-init`.
- `brand.json` (fail): the file does not pass the schema; the detail names the field. Suggest `/brand-set` to fix it, or `/brand-audit`.

Then offer to run the fixes one at a time, and run each only after the user says yes. Some fixes are for the user to run: a fix that starts with `/` (such as `/plugin install atelier@atelier`) is a Claude Code command, and a fix that starts with `sudo` needs their password. After any fix, run the doctor again and report the new result.

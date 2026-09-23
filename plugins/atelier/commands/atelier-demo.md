---
description: Run every atelier skill on the bundled sample brand, logo and page, write the results to ./atelier-demo, and walk through what it made.
argument-hint: "[output-dir]"
---

Arguments (may be empty): `$ARGUMENTS`. The output directory is the first argument, or `atelier-demo` when there is none.

Run it from the user's project directory, with the chosen directory in single quotes (POSIX quoting; write a single quote inside a value as `'\''`, here and in the `find` command below):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" demo --out 'atelier-demo'
```

The directory must be new, empty, or an earlier demo output; the CLI refuses anything else, and a re-run replaces only the demo's own files. Nothing is written outside it.

- Non-zero exit: show stderr verbatim, including any `Fix:` line, and stop. If it refused the directory, suggest `/atelier-demo <new-folder>`. If a `Fix:` line is a shell command (for example installing Chromium), offer to run it, and run it only after the user says yes.
- `atelier: warning:` lines about fonts that are not installed are not failures: the social card falls back to another font.

On exit 0:

1. List the generated files (Glob `<dir>/**/*`, or `find '<dir>' -type f | sort`), one line per folder:
   - `tokens/`: CSS variables, Tailwind config, JS and TypeScript tokens, Figma variables (design-token-sync)
   - `brand/`: favicons, app icons, social covers (brand-asset-pipeline)
   - `img/`: responsive AVIF, WebP and JPEG widths plus a blur placeholder (responsive-image-pipeline)
   - `og/`: the Open Graph social card (og-card-generator)
   - `a11y/`, `ux/`: accessibility and runtime UX reports, markdown plus raw JSON
   - `video/`: a short MP4 of the sample page (only when ffmpeg is on PATH)
   - `stage/` and `photo.jpg`: the sample brand.json and the synthetic photo the run used as input
2. Point out 3 artifacts worth opening, with their paths: `og/home.png` (Read it to show the image), `tokens/tokens.css` (show its first lines), and `ux/ux-report.md` (or `video/demo.mp4` when it exists).
3. Suggest the next step: `/brand-init` to create the user's own brand file, then `/atelier-doctor` if anything was skipped.

# Getting started

atelier is a Claude Code plugin with eight design-automation skills that share one brand file, `.atelier/brand.json`. This page takes you from install to your first results, then shows how to run the same skills from a terminal or GitHub Actions.

## Requirements

- Claude Code with plugin support
- Node.js 22 or newer
- Playwright's Chromium, for `og-card-generator`, `accessibility-design-audit`, `html-to-video` and `runtime-ux-audit --dynamic`
- `ffmpeg` on PATH, for `html-to-video` only

## Install

In Claude Code:

```
/plugin marketplace add EthanY33/atelier
/plugin install atelier@atelier
```

Claude Code copies the plugin and installs its Node dependencies (`npm ci` inside the plugin folder). It does not download a browser; the next step covers that.

## Check your setup with /atelier-doctor

```
/atelier-doctor
```

It runs `atelier doctor` from your project folder and explains each line:

```
atelier 1.0.0 doctor  (<plugin folder>)

  ok    node          v22.13.0
  ok    dependencies  9 of 9 resolve
  ok    sharp         libvips 8.18.6
  warn  chromium      Playwright Chromium is not installed.
                      fix: npx playwright@1.63.0 install chromium
  warn  ffmpeg        not on PATH (only html-to-video needs it)
                      fix: winget install Gyan.FFmpeg  (or: choco install ffmpeg), then restart the terminal
  warn  brand.json    none at <project>/.atelier/brand.json
                      fix: Run /brand-init in Claude Code, or see: atelier brand --help

Ready.
```

`ok` lines are fine. A `warn` line turns off the skills that need that piece and nothing else. A `fail` line (old Node, broken dependencies, an invalid brand.json) stops everything until it is fixed. Claude offers to run each `fix:` command and runs it only after you say yes. Run `/atelier-doctor` again afterwards; it ends with `Ready.` when nothing fails.

## Install Chromium and ffmpeg

**Chromium.** Use the exact command the doctor prints. For atelier 1.0.0 it is:

```bash
npx playwright@1.63.0 install chromium
```

The version matters: a bare `npx playwright install chromium` uses whatever Playwright your project or npm resolves and can install a Chromium build the plugin cannot use. On Linux, if the doctor reports missing system libraries, run the `sudo npx playwright@<version> install-deps chromium` command it prints.

**ffmpeg** (only `html-to-video` needs it):

| OS | Command |
|---|---|
| Windows | `winget install Gyan.FFmpeg` (or `choco install ffmpeg`) |
| macOS | `brew install ffmpeg` |
| Debian, Ubuntu | `sudo apt install ffmpeg` |

Restart the terminal and Claude Code afterwards so the new PATH is picked up, then check with `ffmpeg -version`.

## Create your brand file with /brand-init

In your project folder:

```
/brand-init
```

Claude asks for everything in one message: studio name, product name, 2 to 4 voice adjectives, background and accent colors, body and display font stacks, and deploy target. Studio, background and body font have defaults, and the rest are optional, so skip anything you do not know yet. It then writes `.atelier/brand.json` through `atelier brand init`, which validates every value, and shows which recommended fields are still empty.

```json
{
  "$schema": "https://raw.githubusercontent.com/EthanY33/atelier/main/plugins/atelier/schemas/brand.schema.json",
  "brand": { "studio": "goneIdle", "product": "TideWane", "voice": ["atmospheric", "mysterious"] },
  "palette": { "bg": "#110f1b", "accent": "#67e8f9" },
  "typography": { "body": "Inter, system-ui, sans-serif", "display": "Space Grotesk, sans-serif" },
  "deploy": { "target": "cloudflare-pages" }
}
```

Later changes:

- `/brand-set palette.accent #e07a5f` sets one field, validated before it is saved.
- `/brand-get typography.body` reads one.
- `/brand-audit` lists the recommended fields that are still missing.

You can also edit the file by hand. Every skill validates it when it loads it, and `atelier brand validate` checks it on demand. Commit `.atelier/brand.json` with your project. The optional `logos`, `motion`, `surfaces` and `targets` sections are described in [the API reference](api.md#brandjson).

## First three things to ask Claude

You do not need to name skills or flags; Claude picks the skill from what you ask.

1. **"Generate design tokens from our brand into src/styles/tokens."** `design-token-sync` writes `tokens.css` (CSS custom properties), `tailwind.config.js` (use it as a Tailwind preset), `tokens.js` with `tokens.d.ts`, and a Figma variables request body. Regenerate after every brand change.
2. **"Make favicons, app icons and social covers from brand/mark.svg into public/brand."** `brand-asset-pipeline` renders the PNG set, using your brand background, and gives you the `<head>` tags. Set `logos.mark` in brand.json and you can drop the path from the request.
3. **"Audit dist/index.html for accessibility and runtime UX problems."** `accessibility-design-audit` checks WCAG 2.1 AA with axe-core, and `runtime-ux-audit` checks transitions, input latency, dialogs and mobile behavior. Reports land in `a11y-report/` and `ux-report/`, and Claude summarizes the blocking findings. `/ux-audit dist/index.html` runs the second one directly; add `--dynamic` to measure INP in Chromium.

More to try: "social cards for every post in /blog" (`og-card-generator`), "make the hero images responsive" (`responsive-image-pipeline`), "record the landing page as a 10 second clip" (`html-to-video`).

## Try the demo

```
/atelier-demo
```

Runs every skill on a bundled sample brand, logo and page and writes the results into `./atelier-demo` in your project (or `/atelier-demo <folder>`). The folder must be new, empty, or an earlier demo output, and nothing is written outside it. You get `tokens/`, `brand/`, `img/`, `og/`, `a11y/`, `ux/` and, when ffmpeg is installed, `video/`. Claude points out the social card, the tokens and the UX report. Delete the folder when you are done.

## Use the CLI outside Claude Code

Every skill is also a command-line tool, so the same work runs in scripts and CI. Inside a Claude Code session the plugin's `bin/` is on the PATH, so `atelier doctor` just works. Elsewhere, get a copy of the plugin and run it with Node 22 or newer:

```bash
git clone --depth 1 --branch v1.0.0 https://github.com/EthanY33/atelier
npm ci --prefix atelier/plugins/atelier
npm exec --prefix atelier/plugins/atelier -- playwright install chromium
node atelier/plugins/atelier/bin/atelier doctor
```

You can also use the copy Claude Code installed: run inside a session, `atelier doctor` prints its folder on the first line.

Then, from your project folder (with `ATELIER` set to the `bin/atelier` path):

```bash
node "$ATELIER" brand init --studio Acme --bg "#0b1020" --accent "#e07a5f" --body-font "Inter, system-ui, sans-serif"
node "$ATELIER" tokens --out src/styles/tokens
node "$ATELIER" assets brand/mark.svg --out public/brand --root .
node "$ATELIER" a11y dist/index.html
node "$ATELIER" ux dist/index.html
```

Run `node "$ATELIER" <alias> --help` for any skill's options, and `node "$ATELIER" --help` for the list. Every command exits `0` on success and `2` when it could not run; the two audits exit `1` on critical or serious findings, so they work as CI gates.

## Use the GitHub Action

The repository is also a GitHub Action that runs both audits and fails the job on critical or serious findings:

```yaml
name: UX checks
on: pull_request

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run build          # whatever produces your HTML
      - uses: EthanY33/atelier@v1
        with:
          target: dist/index.html
      - if: always()
        uses: actions/upload-artifact@v7
        with:
          name: atelier-reports
          path: atelier-reports
```

| Input | Default | Meaning |
|---|---|---|
| `target` | required | Path to an HTML file (relative to the workspace), `file://` URL, or http(s) URL. For a URL, start your preview server in an earlier step. |
| `audits` | `a11y,ux` | Which audits to run |
| `dynamic` | `false` | `true` adds runtime-ux-audit's Chromium pass (INP estimate, bfcache, focus, tap targets) |
| `brand` | none | Path to a brand.json whose `targets`, `motion` and `surfaces` set the budgets |
| `out` | `atelier-reports` | Report directory; the `report-dir` output points to it |

The action uses the job's Node when it is 22 or newer and installs Node 22 otherwise, installs the plugin's dependencies and Chromium, then writes `<out>/a11y/` and `<out>/ux/` and appends both reports to the job summary. The step fails with the highest exit code of the audits it ran. It is tested on `ubuntu-latest`.

`@v1` follows the newest 1.x release, which may add runtime-ux rules. To keep the gate fixed, pin a release: `EthanY33/atelier@v1.0.0`.

## Next

- [Skill reference](skill-reference.md): inputs, outputs and brand.json fields per skill
- [API reference](api.md): functions, flags, outputs, exit codes and the 1.0 stability contract
- [Architecture](architecture.md): how the plugin is laid out and installed

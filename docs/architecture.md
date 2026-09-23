# Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.webp">
  <img alt="brand.json feeds brand-memory, which feeds five generate skills and two audit skills" src="assets/architecture-dark.webp" width="100%">
</picture>

## The one idea

Every skill reads the same `.atelier/brand.json`. `brand-memory` owns that file: it creates it, validates it against [`brand.schema.json`](../plugins/atelier/schemas/brand.schema.json) on every load and save, and is the only code that writes it. Everything else derives artifacts from it and never stores brand values of its own. Changing the brand is a one-line edit followed by a regenerate.

## Repository layout

```
.claude-plugin/marketplace.json     marketplace entry (what /plugin marketplace add reads)
plugins/atelier/                    the plugin: the only directory users receive
  .claude-plugin/plugin.json        manifest (name, version, author)
  package.json, package-lock.json   runtime dependencies; Claude Code runs `npm ci` here
  bin/atelier                       CLI on the Bash PATH inside Claude Code
  commands/*.md                     slash commands (/brand-init, /ux-audit, ...)
  skills/<name>/SKILL.md            what Claude reads to decide when and how to use a skill
  skills/<name>/index.mjs           the skill: exported functions plus a CLI
  lib/                              preflight, CLI and file helpers shared by skills
  schemas/                          brand.schema.json, ux-audit.schema.json
  examples/                         fixtures for `atelier demo`
  scripts/run-demo.mjs              the demo pipeline
tests/                              Vitest suites (not shipped)
scripts/                            repo tooling: schema lint, version check, install smoke test
action.yml                          the GitHub Action wrapper around the two audits
docs/                               this documentation and the README art
```

## Install model

Claude Code installs a marketplace plugin by copying `plugins/atelier/` into `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and running `npm ci --ignore-scripts` there, with a 60 second budget. Three rules follow, and CI enforces all of them with [`scripts/smoke-installed-plugin.mjs`](../scripts/smoke-installed-plugin.mjs), which repeats that copy and install on Ubuntu, macOS and Windows and then runs every skill from the copy:

1. **Nothing outside `plugins/atelier/` exists at runtime.** Schemas, fixtures and helpers live inside the plugin and are resolved relative to it.
2. **Dependencies come from the plugin's own lockfile**, pinned exactly. No install scripts run, so nothing may depend on a postinstall step. Playwright's browser is installed on demand, and preflight says so with the exact command.
3. **Paths in instructions use Claude Code's placeholders.** `SKILL.md` and command files refer to `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}`, which Claude Code substitutes when it loads them. They are not environment variables, so scripts never read them.

## How a request flows

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.webp">
  <source media="(prefers-color-scheme: light)" srcset="assets/how-it-works-light.webp">
  <img alt="Install once, then every request: you ask, Claude picks a skill by its description, runs it, and it writes files into your repo" src="assets/how-it-works-dark.webp" width="100%">
</picture>

1. Claude Code loads each skill's `name` and `description` up front, so it can match a request like "make social cards for the blog" to `og-card-generator` without the user naming it.
2. When a skill is chosen, its `SKILL.md` body loads, with the CLI and API calls written against the substituted plugin path.
3. The skill's CLI runs in the user's project. It reads `.atelier/brand.json` from the working directory (or `--root`), writes into the output directory it was given, and exits with a documented code.

## Shared library

`plugins/atelier/lib/` holds the code every skill needs and nothing skill-specific:

| Module | Responsibility |
|---|---|
| `preflight.mjs` | Find binaries on `PATH` without a shell, launch Chromium with an actionable error when it is missing, resolve `ffmpeg`, format errors for the CLI |
| `cli.mjs` | `isMain()` that holds through symlinks, Windows junctions and `node -e` |
| `io.mjs` | Read text and JSON written by Windows tools (UTF-8 BOM, UTF-16) and name the file in every error |
| `doctor.mjs` | The checks behind `atelier doctor` and `/atelier-doctor` |

## Exit codes

All CLIs share one convention so they compose in scripts and CI:

| Code | Meaning |
|---|---|
| `0` | Success. For audits: no critical or serious findings. |
| `1` | Audits only: critical or serious findings. |
| `2` | Could not run: bad arguments, missing input, missing prerequisite, or an internal error. |

## Security posture

- No process is ever spawned through a shell; binaries are resolved on `PATH` and invoked directly.
- Values from `brand.json` or page content are escaped for the context they land in: HTML text and attributes, CSS, inline scripts, JavaScript string literals, Markdown.
- Skills write only inside the output directory they are given; the demo refuses to touch the working directory, its parents, the home directory, or the plugin itself.
- `runtime-ux-audit`'s static pass never executes page JavaScript and fetches only same-origin subresources, with size and time caps.
- No telemetry and no network access beyond the pages you ask atelier to audit or record.

See [SECURITY.md](../SECURITY.md) for reporting.

## Continuous integration

| Job | What it proves |
|---|---|
| Test (3 OS x Node 22, 24) | Unit, integration and CLI tests, 70% coverage gate |
| Validate | JSON schemas compile, versions agree, `claude plugin validate` passes |
| Installed-plugin smoke (3 OS) | A marketplace-style install works and every skill runs from it |
| GitHub Action self-test | `action.yml` runs both audits end to end |

Releases are cut by pushing a `vX.Y.Z` tag. The release workflow checks that the tag matches every version string, publishes the matching `CHANGELOG.md` section, and moves the floating major tag (for example `v1`, which `uses: EthanY33/atelier@v1` resolves) when the release is the newest of its major. See [releasing.md](releasing.md).

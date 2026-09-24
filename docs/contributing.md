# Contributing

Thanks for helping. This page covers the development setup, tests, how to add a skill or a runtime-ux rule, the dependency policy and commit style. The [architecture notes](architecture.md) explain how the plugin is laid out and installed, and [api.md](api.md) is the public contract your change must keep.

## Setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/EthanY33/atelier
cd atelier
npm install              # root dev dependencies; postinstall runs `npm ci` in plugins/atelier
npm run setup:browsers   # Chromium that matches the plugin's pinned Playwright
npm test
```

Install `ffmpeg` too (`winget install Gyan.FFmpeg`, `brew install ffmpeg` or `sudo apt install ffmpeg`) to run the `html-to-video` tests.

The repository holds two npm projects. The root one has Vitest and the repo scripts. `plugins/atelier/` is the plugin that users receive, with its own `package.json` and lockfile for the runtime dependencies. Tests load those dependencies through `tests/helpers/plugin-deps.mjs`, so a test and the skill under test share one copy of sharp or Ajv. Do not add plugin dependencies to the root `package.json`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | The suite with the coverage gate, as CI runs it |
| `npm run lint:schemas` | Manifests parse, schemas compile, the example brand.json validates |
| `npm run check:versions` | Version strings, README badge, CHANGELOG section and mirrored pins agree |
| `npm run smoke:plugin` | Install the plugin the way Claude Code does, then run every skill from the copy |
| `npm run demo` | `atelier demo` into `./.atelier-demo` |
| `npm run demo:trailer` | Re-render the trailer (`demos/atelier-trailer.mp4`, with sound) and the README clip (`demos/overview.mp4`, `demos/overview.webp`); needs ffmpeg |

Run the CLI from the checkout with `node plugins/atelier/bin/atelier <command>`.

## Tests

Tests live in `tests/`, never inside the plugin: `tests/<skill>.test.mjs` for the API, `tests/<skill>-cli.test.mjs` for the CLI, and folders for the larger suites (`design-token-sync/`, `runtime-ux-audit/`, `lib/`, `integration/`). Run one file with `npx vitest run tests/lib/io.test.mjs`.

Tests that need Chromium, ffmpeg or a particular OS use `it.skipIf(...)` and skip when the prerequisite is missing. CI installs Chromium and ffmpeg on Ubuntu, macOS and Windows, so a test that skips on your machine still runs there.

Every behavior change needs a test. A bug fix needs a test that fails without the fix.

### Coverage gate

`npm run test:coverage` fails below 70% lines, functions, branches or statements, measured over `plugins/atelier/skills/**` and `plugins/atelier/lib/**` (thresholds in `vitest.config.mjs`). CI runs it on every OS and Node version. Do not lower the thresholds; add tests.

### Installed-plugin smoke test

`npm run smoke:plugin` repeats what Claude Code does on `/plugin install`: it copies `plugins/atelier/` to a temp folder outside the repo, runs `npm ci --ignore-scripts` there (and fails if that takes more than 60 seconds), imports every skill, runs `atelier --version` and `atelier doctor --no-browser`, installs Chromium from the copy and runs `atelier demo`. `npm run smoke:plugin -- --skip-browser` stops before Chromium, and `-- --keep` keeps the temp folder. Run it after changing dependencies, moving files, or changing how a skill finds files at runtime. CI runs it on all three OS.

## Adding a skill

Layout:

```
plugins/atelier/skills/<name>/
  SKILL.md     frontmatter and instructions; what Claude reads
  index.mjs    exported API plus the CLI
  ...          supporting modules or templates, optional
```

### SKILL.md contract

- Frontmatter has `name` (the folder name) and `description`. Claude chooses a skill from the description alone, so say what it produces and when to use it, in the words users say. Keep it to a few sentences.
- Follow the sections the other skills use: Run, Options, Output, Exit codes, Notes.
- Commands are `node "${CLAUDE_PLUGIN_ROOT}/bin/atelier" <alias> ...`. The JS API example passes `"${CLAUDE_SKILL_DIR}/index.mjs"` as an argument to `node --input-type=module -e "..."` and imports it through `pathToFileURL(process.argv[1])`, so it works on Windows. Claude Code substitutes both placeholders when it loads the file. They are not environment variables, so code must never read them.
- Refer only to paths inside the plugin. After install nothing else exists, so never mention `plugins/atelier/`, repo `scripts/` or `tests/`.
- ASCII only, no em or en dashes.

### CLI contract

- `index.mjs` exports the API and `runCli(argv, io)`, which returns the exit code and never calls `process.exit`. Take `stdout` and `stderr` as injectable objects so tests run in-process.
- Parse arguments with `node:util` `parseArgs` in strict mode. `-h` and `--help` print usage to stdout and return 0.
- A usage error prints the message and the usage to stderr and returns 2. A runtime failure prints `formatError(err)` to stderr and returns 2. Audits return 1 for critical or serious findings and 0 otherwise.
- Start the CLI only when the file is run as a script: `isMain(import.meta.url)` plus the `process.execArgv` guard for `-e` and `-p` that every skill has. Importing the module, including from `node -e`, must never run it.
- Add the alias to `ALIASES` in `plugins/atelier/bin/atelier`.

### Use the shared helpers

`plugins/atelier/lib/` exists so every skill handles the hard cases the same way:

- `launchChromium()` from `preflight.mjs` instead of `chromium.launch()`: a missing browser becomes a `PreflightError` with the exact install command.
- `findOnPath()` or `ensureFfmpeg()` to resolve a binary, then `spawn(path, args, { shell: false })`. Never use a shell.
- `readJsonFile()` and `readTextFile()` from `io.mjs` for user files, so Windows byte order marks and UTF-16 work and errors name the file.
- `formatError()` for CLI error output, and `PreflightError` with a `code` and `fix` for a missing prerequisite. Load heavy dependencies lazily so `--help` works on a broken install.
- brand-memory's `loadBrand()` to read brand.json. Never parse it yourself and never write it.

Also: write only inside the output path you were given; escape brand and page values for the context they land in (HTML text and attributes, CSS, JavaScript string literals through `JSON.stringify`, Markdown); make no network requests beyond the page the user asked for; add no telemetry.

### Checklist

- Tests for the API and the CLI, with coverage still above the gate
- A section in [api.md](api.md), a row in [skill-reference.md](skill-reference.md) and in the README skills table
- A new prerequisite gets a check in `lib/doctor.mjs`
- A CHANGELOG entry under `## [Unreleased]`
- `npm run smoke:plugin` passes

## Adding a runtime-ux rule

Rules live in `plugins/atelier/skills/runtime-ux-audit/rules/<area>/`, one exported object each. The runner checks every rule against this contract (`validateRule` in `lib/runner.mjs`):

| Field | Value |
|---|---|
| `id` | `atelier/runtime-ux/<kebab-name>`; never reuse an old id |
| `area` | `transitions`, `inp`, `panels` or `mobile` |
| `severity` | `critical`, `serious`, `moderate` or `minor`. Only the first two fail the audit, so keep heuristic rules at moderate or below. |
| `confidence` | `high`, `medium` or `low` |
| `methods` | Non-empty array of `html`, `css`, `js`, `dom`, `trace`, `headers` |
| `phase` | `static`, or `dynamic` for rules that need `--dynamic` facts |
| `requires` | `['http']` for rules that only apply to http(s) inputs; otherwise leave it out |
| `description` | One sentence, ASCII, under 200 characters |
| `helpUrl` | An https URL that explains the fix |
| `check(ctx)` | Synchronous. Returns an array of findings `{ node, message?, data?, confidence?, incomplete? }`, where `node` is built with one of the `ctx.ref.*` helpers, or `{ notApplicable: '<reason>' }`. `incomplete: true` sends a finding to Needs review, which never fails the audit. |

Static rules must never run page code. Steps:

1. Write the rule next to the related rules and add it to that area's `rules/<area>/index.mjs`.
2. Add a row to the area's table in the skill's `SKILL.md` with the id, severity and flag, marking `(d)` for dynamic and `(h)` for http-only rules. `tests/runtime-ux-audit/registry.test.mjs` compares these tables with `RULES`.
3. Put the rule in a headline group in `lib/headline.mjs` and mirror that in `DESIGN_HEADLINES` in the registry test, or list it in the test's `NO_HEADLINE`. Update the rule counts in the same test. A rule that is not in the spec's catalog also goes in the spec's "Implementation deviations" section and the test's `ADDED` list.
4. In `tests/runtime-ux-audit/<area>.test.mjs`, add a case that triggers the rule and a near miss that must pass: the closest correct code you can write. Use `contextFor()` and `runRule()` from `tests/runtime-ux-audit/helpers.mjs`.
5. Add a trigger to the area fixture in `tests/fixtures/runtime-ux/<area>/` so the golden report covers the rule.
6. Regenerate the goldens and read the diff before committing:

   ```bash
   UPDATE_GOLDEN=1 npx vitest run tests/runtime-ux-audit
   npx vitest run tests/runtime-ux-audit
   git diff tests/runtime-ux-audit/__golden__
   ```

   In PowerShell, set the variable with `$env:UPDATE_GOLDEN = '1'` and remove it afterwards with `Remove-Item Env:UPDATE_GOLDEN`.

A new rule can fail pages that passed before, so note it in the CHANGELOG under `### Added` with its severity.

## Dependencies

- Every dependency is pinned to an exact version, in both `package.json` files. No `^` or `~` ranges.
- Runtime dependencies go in `plugins/atelier/package.json`. Claude Code installs them with `npm ci --ignore-scripts` within 60 seconds, so a dependency must work without its install scripts, and the tree should stay small.
- Upgrades are made by hand. Install the exact version inside the plugin, which updates `package.json` and regenerates `plugins/atelier/package-lock.json`:

  ```bash
  npm install --prefix plugins/atelier --save-exact <package>@<version>
  ```

  After a Playwright upgrade, run `npm run setup:browsers` for the matching Chromium. Then run `npm test`, `npm run check:versions` and `npm run smoke:plugin`, and commit both files.
- `.github/workflows/audit.yml` runs `npm audit` on the plugin's dependencies every Monday (and on demand) and reports outdated pins. It only reports.
- There is no Dependabot, so every commit has a human author.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/): `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`, `build`, with the skill as the scope when there is one (`fix(og-card-generator): ...`). Mark breaking changes with `!` and a `BREAKING CHANGE:` footer.
- Every commit has a human author. No AI attribution lines, no `Co-Authored-By` trailers for tools or assistants, and no commits authored by bots.
- Keep pull requests to one change. Fill in the template: tests, a CHANGELOG entry under `## [Unreleased]`, `SKILL.md` and `docs/api.md` matching the code, and no new network calls, telemetry or `shell: true` spawns.
- CI must pass on every job before merge.
- Report security problems privately, as [SECURITY.md](../SECURITY.md) describes, not in a public issue.
- Prose and tool output are ASCII, with no em or en dashes and no emoji.

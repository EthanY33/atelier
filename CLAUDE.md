# atelier

Public Claude Code plugin, MIT, version 1.0. Eight design-automation skills share one brand file, `.atelier/brand.json`. Users receive only `plugins/atelier/`.

## Commands

```
npm install              # root dev deps; postinstall runs npm ci in plugins/atelier
npm run setup:browsers   # Chromium matching the plugin's pinned Playwright
npm test                 # Vitest; Chromium, ffmpeg and OS-specific tests skip when unavailable
npm run test:coverage    # 70% gate on plugins/atelier/{skills,lib}; never lower it
npm run lint:schemas     # manifests parse, schemas compile, example brand.json validates
npm run check:versions   # versions, README badge, CHANGELOG section agree
npm run smoke:plugin     # marketplace-style install (npm ci --ignore-scripts, 60 s), then every skill
npm run demo             # atelier demo into .atelier-demo/
UPDATE_GOLDEN=1 npx vitest run tests/runtime-ux-audit   # rewrite ux goldens, then review the diff
node plugins/atelier/bin/atelier <doctor|demo|brand|tokens|og|images|assets|a11y|video|ux> --help
```

## Layout

- `plugins/atelier/`: the installable unit and its own npm project (`package.json`, lockfile). Nothing outside it exists at runtime. `.claude-plugin/plugin.json` holds the version (never `marketplace.json`); `bin/atelier` is the CLI; `commands/*.md` the slash commands; `skills/<name>/{SKILL.md,index.mjs}` the 8 skills; `lib/` preflight, cli, io, doctor; `schemas/` brand and ux-audit; `examples/` and `scripts/run-demo.mjs` the demo.
- `tests/`: Vitest suites. Plugin deps are imported through `tests/helpers/plugin-deps.mjs`, never added to the root `package.json`.
- `scripts/`: repo tooling. `action.yml`: composite GitHub Action. `.github/workflows/`: `ci`, `release`, `audit`.
- `docs/`: `api.md` (the 1.0 semver contract), `architecture.md`, `getting-started.md`, `skill-reference.md`, `contributing.md`, `releasing.md`, `specs/`.

## Conventions

- Exact dependency pins, no ranges. Upgrade by hand (`npm install --prefix plugins/atelier --save-exact pkg@x.y.z`) and commit the regenerated `plugins/atelier/package-lock.json`. No Dependabot; `audit.yml` reports weekly. Nothing may rely on install scripts.
- brand.json is JSON, validated against `schemas/brand.schema.json` on every load and save. Only brand-memory writes it; other skills call its `loadBrand()`. In 1.x the schema only gains optional fields.
- No telemetry and no network calls beyond the page being audited or recorded.
- Never spawn through a shell: resolve with `findOnPath` or `ensureFfmpeg`, spawn with `shell: false`. Launch Chromium with `launchChromium` from `lib/preflight.mjs`.
- Escape brand and page values for where they land: HTML, CSS, JS string literals via `JSON.stringify`, Markdown.
- Exit codes: 0 ok; 1 audits found critical or serious (also `brand validate` errors, `doctor` failures); 2 usage error or could not run. `runCli` returns the code and never calls `process.exit`; importing a skill (even under `node -e`) never starts its CLI.
- `SKILL.md` and command files use `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}`. Claude Code substitutes them when loading the file; they are not env vars, so code never reads them. Never reference repo paths there.
- Exports, flags, outputs, exit codes and `ux-raw.json` are semver-covered: update `docs/api.md` with any change to them.
- Prose and tool output: ASCII, no em or en dashes, no emoji.

## Testing

- Every behavior change gets a test: API in `tests/<skill>.test.mjs`, CLI in `tests/<skill>-cli.test.mjs`.
- A runtime-ux rule needs a triggering case, a near miss, a fixture trigger and a regenerated golden. `registry.test.mjs` checks the SKILL.md rule tables, headline groups and rule counts.
- Run `npm run smoke:plugin` after touching dependencies, file layout or runtime path resolution.

## Commits

Conventional Commits (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `ci`, `build`), scope = skill name. No AI attribution, no `Co-Authored-By` or other co-author trailers, and no bot authors: every commit has a human author. User-facing changes get an entry under `## [Unreleased]` in `CHANGELOG.md`. Releases: `docs/releasing.md`.

# Contributing

## Development setup

```bash
git clone https://github.com/EthanY33/atelier
cd atelier
npm install
npx playwright install chromium
npm test
```

All tests should pass before you begin making changes.

## Coding conventions

- **ESM only** — the package uses `"type": "module"`. All scripts use the `.mjs` extension.
- **One skill per directory** — each skill lives under `plugins/atelier/skills/<name>/`. Do not co-locate skills.
- **Skill structure** — every skill owns:
  - `SKILL.md` — input/output contract, usage examples, dependency notes.
  - `index.mjs` — the skill entry point (named exports only; no default export).
  - Optional supporting files (helpers, templates, fixtures) alongside `index.mjs`.
- **Tests** — test files live in `tests/<skill-name>.test.mjs`. Use Vitest. Each skill must have a corresponding test file.
- **Coverage gate** — the CI enforces ≥ 70% line coverage. New skills must meet this threshold.

## PR guidelines

- Keep changes small and focused — one skill addition or one bug fix per PR.
- Include a test for any behavior change or new feature.
- Update `CHANGELOG.md` under the `[Unreleased]` heading with a brief summary of your change.
- CI must pass on both `ubuntu-latest` and `windows-latest` matrix runners before merge.

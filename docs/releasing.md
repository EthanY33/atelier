# Releasing

For maintainers. A release is a commit on `main` whose version strings agree and whose CHANGELOG has a section for that version, plus a `vX.Y.Z` tag. Pushing the tag publishes the GitHub release and moves the `v1` tag that `uses: EthanY33/atelier@v1` resolves through.

Marketplace installs read the default branch, so users can install a release as soon as it is merged to `main`. Merge only a finished release, and tag it right after.

## 1. Choose the version

Follow the [semver policy](api.md#semver-policy). Anything that breaks a covered export, flag, output file, exit code, `brand.schema.json` or `ux-raw.json` needs a major version. New features, including new runtime-ux rules, are minor. Fixes are patches.

## 2. Bump the versions

Work on a branch named `release/X.Y.Z`. Four places carry the version:

| File | How |
|---|---|
| `package.json` (and `package-lock.json`) | `npm version X.Y.Z --no-git-tag-version` |
| `plugins/atelier/package.json` (and its `package-lock.json`) | `npm version X.Y.Z --no-git-tag-version --prefix plugins/atelier` |
| `plugins/atelier/.claude-plugin/plugin.json` | edit `"version"` |
| `README.md` version badge | edit `badge/version-X.Y.Z-e07a5f.svg`; in a prerelease badge, double each hyphen (`1.1.0--rc.1`) |

`--no-git-tag-version` keeps npm from committing or tagging. Do not add a `version` to the plugin entry in `.claude-plugin/marketplace.json`: Claude Code reads it from `plugin.json`, and `check:versions` rejects a second copy.

## 3. Write the CHANGELOG section

In `CHANGELOG.md`, rename the `## [Unreleased]` entries into a new section and leave an empty `## [Unreleased]` above it:

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

### Added
### Changed
### Fixed
### Security
### Removed
```

Keep only the headings that have entries, and mark breaking changes with `**Breaking:**`. Update the compare links at the bottom of the file:

```markdown
[Unreleased]: https://github.com/EthanY33/atelier/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/EthanY33/atelier/compare/vPREVIOUS...vX.Y.Z
```

The section body becomes the GitHub release notes. Preview exactly what will be published:

```bash
node scripts/changelog-section.mjs X.Y.Z
```

## 4. Check

```bash
npm run check:versions
npm run lint:schemas
npm run test:coverage
npm run smoke:plugin
```

`check:versions` fails unless the three version fields and the README badge agree, the CHANGELOG has a `## [X.Y.Z]` section, the marketplace entry carries no version, and any root dev dependency that mirrors a plugin dependency uses the same pin.

## 5. Merge to main

Open a pull request from `release/X.Y.Z` to `main` and wait for every CI job: tests on Ubuntu, macOS and Windows with Node 22 and 24, schema and manifest validation (including `claude plugin validate`), the installed-plugin smoke test on all three OS, and the GitHub Action self-test. Then merge.

## 6. Tag

Tag the merged commit on `main` with an annotated tag and push only the tag:

```bash
git fetch origin
git tag -a vX.Y.Z origin/main -m "atelier vX.Y.Z"
git push origin vX.Y.Z
```

## 7. The release workflow

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`:

1. `npm run check:versions -- --tag vX.Y.Z` fails the run unless the tag matches every version string.
2. `scripts/changelog-section.mjs` extracts the CHANGELOG section as the release notes.
3. `gh release create` publishes the release as "atelier vX.Y.Z", unless one already exists.
4. For a stable tag (no `-` in the name) that is the newest release of its major version, the workflow force-moves the major tag (`v1`) to the release commit. A prerelease, or a patch for an older minor, leaves `v1` where it is.

If the run fails before the release is created, fix the cause on `main`, then delete the tag and tag again:

```bash
git push --delete origin vX.Y.Z
git tag -d vX.Y.Z
```

### Moving v1 by hand

Only needed when step 4 of the workflow failed or `v1` must be repointed:

```bash
git fetch --tags origin
git tag -f v1 "vX.Y.Z^{commit}"
git push -f origin refs/tags/v1
```

Check that both tags name the same commit (for the annotated tag, compare the `^{}` line):

```bash
git ls-remote --tags origin v1 "vX.Y.Z^{}"
```

## 8. After the release

- The release page shows the notes you previewed, and `git ls-remote` shows `v1` on the release commit.
- **Marketplace install in a clean config directory.** Start Claude Code with a fresh `CLAUDE_CONFIG_DIR`, so no cached plugin or setting from your normal setup is used (it asks you to log in):

  ```bash
  export CLAUDE_CONFIG_DIR="$(mktemp -d)"
  claude
  ```

  In PowerShell: `$env:CLAUDE_CONFIG_DIR = (New-Item -ItemType Directory -Path "$env:TEMP\atelier-release-check" -Force).FullName; claude`.

  Then, in a scratch project folder:

  ```
  /plugin marketplace add EthanY33/atelier
  /plugin install atelier@atelier
  /atelier-doctor
  /atelier-demo
  ```

  The doctor's first line must show `atelier X.Y.Z`, and the demo must finish. Afterwards, close Claude Code, unset `CLAUDE_CONFIG_DIR` (`Remove-Item Env:CLAUDE_CONFIG_DIR` in PowerShell) and delete the temporary directory.
- **Action.** In any repository, run a workflow that uses `EthanY33/atelier@vX.Y.Z` (and `@v1` for a stable release) on a small HTML page, and check that both reports reach the job summary.

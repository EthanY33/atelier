#!/usr/bin/env node
/**
 * check-versions.mjs: fail when version strings drift apart.
 *
 * Checks, in one pass:
 *   - package.json, plugins/atelier/package.json and
 *     plugins/atelier/.claude-plugin/plugin.json carry the same version
 *   - the marketplace entry does not also set a version (plugin.json wins
 *     silently, so a second copy only goes stale)
 *   - the README version badge matches
 *   - CHANGELOG.md has a section for the version
 *   - root devDependencies that mirror plugin dependencies (for tests) use
 *     the exact same pins
 *   - with --tag vX.Y.Z, the tag matches too
 *
 * Usage: node scripts/check-versions.mjs [--tag v1.0.0]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const problems = [];
const rootPkg = json('package.json');
const pluginPkg = json('plugins/atelier/package.json');
const manifest = json('plugins/atelier/.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const version = rootPkg.version;

if (pluginPkg.version !== version) problems.push(`plugins/atelier/package.json is ${pluginPkg.version}, expected ${version}`);
if (manifest.version !== version) problems.push(`plugin.json is ${manifest.version}, expected ${version}`);
for (const p of marketplace.plugins ?? []) {
  if ('version' in p) problems.push(`marketplace.json entry "${p.name}" sets version; keep it only in plugin.json`);
}

const badge = read('README.md').match(/badge\/version-([0-9A-Za-z.\-]+?)-[0-9a-f]{6}/);
if (!badge) problems.push('README.md has no version badge');
else if (badge[1].replace(/--/g, '-') !== version) problems.push(`README badge is ${badge[1]}, expected ${version}`);

if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(read('CHANGELOG.md'))) {
  problems.push(`CHANGELOG.md has no "## [${version}]" section`);
}

for (const [name, pin] of Object.entries(rootPkg.devDependencies ?? {})) {
  const pluginPin = pluginPkg.dependencies?.[name];
  if (pluginPin && pluginPin !== pin) problems.push(`${name}: root pins ${pin}, plugin pins ${pluginPin}`);
}

const tagIdx = process.argv.indexOf('--tag');
if (tagIdx !== -1) {
  const tag = process.argv[tagIdx + 1] ?? '';
  if (tag.replace(/^v/, '') !== version) problems.push(`tag ${tag} does not match version ${version}`);
}

if (problems.length) {
  console.error(`Version check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`All version strings agree on ${version}.`);

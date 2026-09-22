#!/usr/bin/env node
/**
 * Print one version's section from CHANGELOG.md (without its heading) so the
 * release workflow can use it as the GitHub release body.
 *
 * Usage: node scripts/changelog-section.mjs 1.0.0
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/changelog-section.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf8');
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)));
if (end === -1) end = lines.length;

const body = lines.slice(start + 1, end).join('\n').trim();
process.stdout.write(`${body}\n\nFull changelog: [CHANGELOG.md](https://github.com/EthanY33/atelier/blob/v${version}/CHANGELOG.md)\n`);

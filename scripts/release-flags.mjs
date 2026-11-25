#!/usr/bin/env node
/**
 * Print the extra `gh release create` flags for a tag, so a prerelease or a
 * backported patch is not published as the repository's Latest release.
 *
 * Usage: git ls-remote --tags --refs origin | sed 's|.*refs/tags/||' \
 *          | node scripts/release-flags.mjs v1.2.0
 * Stdin is the list of remote tag names, one per line.
 *
 *   tag contains "-"                    -> --prerelease
 *   stable tag, newer stable tag exists -> --latest=false
 *   newest stable tag                   -> (nothing)
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;

function cmp(a, b) {
  const x = STABLE.exec(a).slice(1).map(Number);
  const y = STABLE.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function releaseFlags(tag, remoteTags) {
  if (tag.includes('-')) return ['--prerelease'];
  const newest = [...new Set([...remoteTags, tag])].filter((t) => STABLE.test(t)).sort(cmp).pop();
  return newest === tag ? [] : ['--latest=false'];
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: release-flags.mjs <tag>   (remote tag names on stdin)');
    process.exit(2);
  }
  const tags = readFileSync(0, 'utf8').split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  process.stdout.write(`${releaseFlags(tag, tags).join(' ')}\n`);
}

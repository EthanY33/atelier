#!/usr/bin/env node
/**
 * Pre-release gates for .github/workflows/release.yml.
 *
 *   node scripts/release-gate.mjs ancestry <sha> [ref]
 *     Exit 1 unless <sha> is an ancestor of <ref> (default origin/main).
 *   node scripts/release-gate.mjs checks <file> [--ignore <name>]...
 *     <file> holds check runs as one JSON object per line (or a JSON array),
 *     as printed by `gh api .../check-runs --paginate --jq '.check_runs[]'`.
 *     Exit 1 unless at least one run exists and every run has completed with
 *     success, skipped or neutral. Runs named by --ignore are left out.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PASSING = new Set(['success', 'skipped', 'neutral']);

export function isAncestor(sha, ref) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8' });
  return r.status === 0;
}

export function parseRuns(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** Returns a problem string per run that is not a pass; [] when CI is green. */
export function checkProblems(runs, ignore = []) {
  const relevant = runs.filter((r) => !ignore.includes(r.name));
  if (relevant.length === 0) return ['no check runs found for this commit'];
  return relevant
    .filter((r) => r.status !== 'completed' || !PASSING.has(r.conclusion))
    .map((r) => `${r.name}: ${r.status === 'completed' ? r.conclusion : r.status}`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'ancestry') {
    const [sha, ref = 'origin/main'] = rest;
    if (!sha) {
      console.error('Usage: release-gate.mjs ancestry <sha> [ref]');
      return 2;
    }
    if (!isAncestor(sha, ref)) {
      console.error(`${sha} is not on ${ref}. Merge the release to main and tag the merged commit.`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'checks') {
    const file = rest[0];
    if (!file) {
      console.error('Usage: release-gate.mjs checks <file> [--ignore <name>]...');
      return 2;
    }
    const ignore = [];
    for (let i = 1; i < rest.length; i++) if (rest[i] === '--ignore' && rest[i + 1]) ignore.push(rest[++i]);
    const problems = checkProblems(parseRuns(readFileSync(file, 'utf8')), ignore);
    if (problems.length) {
      console.error(`CI is not green for this commit:\n  ${problems.join('\n  ')}`);
      return 1;
    }
    return 0;
  }
  console.error('Usage: release-gate.mjs <ancestry|checks> ...');
  return 2;
}

process.exit(main(process.argv.slice(2)));

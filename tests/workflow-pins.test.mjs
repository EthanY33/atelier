import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { checkWorkflowPins, findUnpinnedActions } from '../scripts/workflow-pins.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

describe('findUnpinnedActions', () => {
  it('accepts a full SHA with a version comment', () => {
    expect(findUnpinnedActions(`      - uses: actions/checkout@${SHA} # v7.0.1\n`)).toEqual([]);
    expect(findUnpinnedActions(`        uses: actions/upload-artifact@${SHA} # v7.0.2\n`)).toEqual([]);
  });

  it('accepts the local action', () => {
    expect(findUnpinnedActions('        uses: ./\n')).toEqual([]);
    expect(findUnpinnedActions('        uses: ./.github/actions/thing\n')).toEqual([]);
  });

  it('rejects a tag, a branch and a short SHA, naming the file and line', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - uses: actions/setup-node@main # main',
      `      - uses: actions/cache@${SHA.slice(0, 7)} # v4`,
      '      - uses: actions/checkout',
    ].join('\n');
    const problems = findUnpinnedActions(text, 'ci.yml');
    expect(problems).toHaveLength(4);
    expect(problems[0]).toBe('ci.yml:4: "actions/checkout@v7" is not pinned to a 40-character commit SHA');
    expect(problems[1]).toContain('ci.yml:5');
    expect(problems[2]).toContain('ci.yml:6');
    expect(problems[3]).toContain('ci.yml:7');
  });

  it('requires a version comment on a pinned line', () => {
    const problems = findUnpinnedActions(`      - uses: actions/checkout@${SHA}\n`, 'ci.yml');
    expect(problems).toEqual([`ci.yml:1: "actions/checkout@${SHA}" needs a trailing "# <version>" comment`]);
  });

  it('handles quoted values and CRLF line endings', () => {
    expect(findUnpinnedActions(`- uses: "actions/checkout@${SHA}" # v7.0.1\r\n- uses: 'actions/checkout@v7'\r\n`)).toHaveLength(1);
  });

  it('ignores comments that merely mention uses:', () => {
    expect(findUnpinnedActions('      # `uses: EthanY33/atelier@v1` resolves through a floating major tag.\n')).toEqual([]);
  });
});

describe('repository workflows', () => {
  it('pin every third-party action to a commit SHA', () => {
    expect(checkWorkflowPins(repo)).toEqual([]);
  });
});

describe('npm run check:versions', () => {
  const dirs = [];
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  /** A copy of the files check-versions reads, with an optional extra workflow. */
  function sandbox(extraWorkflow) {
    const root = mkdtempSync(join(tmpdir(), 'atelier-pins-'));
    dirs.push(root);
    for (const f of [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'plugins/atelier/package.json',
      'plugins/atelier/.claude-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.github/workflows',
      'scripts/check-versions.mjs',
      'scripts/workflow-pins.mjs',
    ]) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      cpSync(join(repo, f), join(root, f), { recursive: true });
    }
    if (extraWorkflow) writeFileSync(join(root, '.github', 'workflows', 'extra.yml'), extraWorkflow);
    return root;
  }

  const run = (root) => spawnSync(process.execPath, [join(root, 'scripts', 'check-versions.mjs')], { encoding: 'utf8' });

  it('passes on the repository as it is', () => {
    const r = run(sandbox());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails on a tag-pinned third-party action', () => {
    const r = run(sandbox('jobs:\n  x:\n    steps:\n      - uses: actions/checkout@v7\n'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.github/workflows/extra.yml:4: "actions/checkout@v7" is not pinned');
  });

  it('passes the local ./ action', () => {
    const r = run(sandbox('jobs:\n  x:\n    steps:\n      - uses: ./\n'));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

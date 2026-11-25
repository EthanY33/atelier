import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'scripts/check-versions.mjs',
  'package.json',
  'plugins/atelier/package.json',
  'plugins/atelier/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'docs/getting-started.md',
];
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'atelier-checkver-'));
  for (const f of FILES) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true });
    cpSync(join(repo, f), join(tmp, f));
  }
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = () => spawnSync(process.execPath, [join(tmp, 'scripts/check-versions.mjs')], { encoding: 'utf8' });
const edit = (file, fn) => writeFileSync(join(tmp, file), fn(readFileSync(join(tmp, file), 'utf8')));

describe('check-versions doc pins', () => {
  it('passes on the repo as committed', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails when getting-started.md pins another release', () => {
    edit('docs/getting-started.md', (s) => s.replaceAll(version, '0.9.0'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/getting-started.md');
    expect(r.stderr).toContain('0.9.0');
  });

  it('allows the floating major tag', () => {
    edit('docs/getting-started.md', (s) => `${s}\nUse EthanY33/atelier@v1 to float.\n`);
    expect(run().status).toBe(0);
  });

  it('fails when CLAUDE.md names another minor version', () => {
    edit('CLAUDE.md', (s) => s.replace(/version \d+\.\d+/, 'version 0.9'));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CLAUDE.md');
  });
});

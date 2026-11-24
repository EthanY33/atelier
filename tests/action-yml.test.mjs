/**
 * Guards on the composite action's shell and its pins: the Chromium install
 * must not resolve tools from the caller's workspace, setup-node must be
 * pinned by commit SHA, and an audits input that selects nothing must fail.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const action = readFileSync(join(ROOT, 'action.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The `run: |` block of the step with the given name, dedented. */
function runBlock(stepName) {
  const lines = action.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (at === -1) throw new Error(`no step named ${stepName}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const out = [];
  for (let i = run + 1; i < lines.length && (lines[i] === '' || lines[i].startsWith('        ')); i++) {
    out.push(lines[i].slice(8));
  }
  return out.join('\n');
}

describe('action.yml Install atelier step', () => {
  const install = runBlock('Install atelier');

  it('does not run the Playwright CLI through npm exec from the workspace', () => {
    expect(install).not.toMatch(/npm exec/);
    expect(install).toMatch(/cd "\$GITHUB_ACTION_PATH\/plugins\/atelier" && node node_modules\/playwright\/cli\.js install --with-deps chromium/);
  });

  it('installs dependencies with --ignore-scripts', () => {
    expect(install).toMatch(/npm ci [^\n]*--ignore-scripts/);
  });
});

describe('action.yml pins', () => {
  it('pins every third-party uses: to a 40-character commit SHA', () => {
    const uses = [...action.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

const bash = spawnSync('bash', ['--version']);
const hasBash = bash.status === 0;

describe.skipIf(!hasBash)('action.yml Run audits step', () => {
  const script = runBlock('Run audits');
  const tmp = mkdtempSync(join(tmpdir(), 'action-yml-'));
  const actionPath = join(tmp, 'action');
  mkdirSync(join(actionPath, 'plugins', 'atelier', 'bin'), { recursive: true });
  // Stub CLI: ignore its arguments and succeed.
  writeFileSync(join(actionPath, 'plugins', 'atelier', 'bin', 'atelier'), 'process.exit(0);\n');
  writeFileSync(join(tmp, 'summary.md'), '');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (audits) =>
    spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionPath.split(sep).join('/'),
        GITHUB_STEP_SUMMARY: join(tmp, 'summary.md').split(sep).join('/'),
        TARGET: 'page.html',
        AUDITS: audits,
        DYNAMIC: 'false',
        BRAND: '',
        OUT: 'out',
      },
    });

  it('exits 2 when the audits input is empty', () => {
    expect(run('').status).toBe(2);
  });

  it('exits 2 when the audits input holds only separators', () => {
    expect(run(',').status).toBe(2);
    expect(run(' , ').status).toBe(2);
  });

  it('still exits 2 for an unknown audit name', () => {
    expect(run('bogus').status).toBe(2);
  });

  it('exits 0 when a named audit runs and passes', () => {
    expect(run('a11y').status).toBe(0);
    expect(run('a11y, ux').status).toBe(0);
  });
});

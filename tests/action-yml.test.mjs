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

// Prove the resolved bash inherits the environment and can run node. The WSL
// launcher on Windows answers --version but sees neither env nor Windows paths.
const probe = spawnSync(
  'bash',
  ['--noprofile', '--norc', '-c', 'test "$ATELIER_BASH_PROBE" = ok && node -e ""'],
  { env: { ...process.env, ATELIER_BASH_PROBE: 'ok' } },
);
const hasBash = probe.status === 0;

describe.skipIf(!hasBash)('action.yml Run audits step', () => {
  const script = runBlock('Run audits');
  const tmp = mkdtempSync(join(tmpdir(), 'action-yml-'));
  const actionPath = join(tmp, 'action');
  mkdirSync(join(actionPath, 'plugins', 'atelier', 'bin'), { recursive: true });
  // Stub CLI: report which audit it was asked for and succeed.
  writeFileSync(
    join(actionPath, 'plugins', 'atelier', 'bin', 'atelier'),
    "console.log('ran ' + process.argv.slice(2).join(' '));\nprocess.exit(0);\n",
  );
  writeFileSync(join(tmp, 'summary.md'), '');
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (audits, root = '') =>
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
        ROOT: root,
        OUT: 'out',
      },
    });

  it('exits 2 when the audits input is empty', () => {
    const r = run('');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('No audits selected');
  });

  it('exits 2 when the audits input holds only separators', () => {
    for (const input of [',', ' , ']) {
      const r = run(input);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain('No audits selected');
    }
  });

  it('still exits 2 for an unknown audit name', () => {
    const r = run('bogus');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('Unknown audit: bogus');
  });

  it('exits 0 when a named audit runs and passes', () => {
    expect(run('a11y').status).toBe(0);
    expect(run('a11y, ux').status).toBe(0);
  });

  it('runs every audit when the input is separated by newlines', () => {
    for (const input of ['a11y\nux\n', 'a11y\r\nux\r\n']) {
      const r = run(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ran a11y');
      expect(r.stdout).toContain('ran ux');
    }
  });

  it('passes --root to both audits only when ROOT is set', () => {
    const withRoot = run('a11y,ux', 'dist');
    expect(withRoot.status).toBe(0);
    expect(withRoot.stdout).toContain('ran a11y page.html --out out/a11y --root dist');
    expect(withRoot.stdout).toMatch(/ran ux page\.html --out out\/ux .*--root dist/);
    const without = run('a11y,ux');
    expect(without.status).toBe(0);
    expect(without.stdout).not.toContain('--root');
  });

  it('still exits 2 when the input is only newlines', () => {
    expect(run('\n\n').status).toBe(2);
  });
});

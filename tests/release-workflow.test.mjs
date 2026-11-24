import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gate = join(root, 'scripts', 'release-gate.mjs');
const flagsScript = join(root, 'scripts', 'release-flags.mjs');
const read = (p) => readFileSync(join(root, p), 'utf8');

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('release-gate ancestry (atelier-20)', () => {
  let dir;
  let mainSha;
  let sideSha;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-gate-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'two');
    mainSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'release/9.9.9');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'bump');
    sideSha = git(dir, 'rev-parse', 'HEAD');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (sha) => spawnSync(process.execPath, [gate, 'ancestry', sha, 'main'], { cwd: dir, encoding: 'utf8' });

  it('passes for a commit on main', () => {
    expect(run(mainSha).status).toBe(0);
  });
  it('fails for a commit only on a side branch', () => {
    const r = run(sideSha);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not on main/i);
  });
  it('fails when the ref does not exist', () => {
    const r = spawnSync(process.execPath, [gate, 'ancestry', mainSha, 'nope'], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(1);
  });
});

describe('release-gate checks (atelier-20)', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-checks-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (runs, ...extra) => {
    const file = join(dir, 'runs.ndjson');
    writeFileSync(file, runs.map((r) => JSON.stringify(r)).join('\n'));
    return spawnSync(process.execPath, [gate, 'checks', file, ...extra], { encoding: 'utf8' });
  };
  const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });

  it('passes when every check succeeded or was skipped', () => {
    expect(run([ok('a'), { name: 'b', status: 'completed', conclusion: 'skipped' }]).status).toBe(0);
  });
  it('fails on a red check', () => {
    const r = run([ok('a'), { name: 'b', status: 'completed', conclusion: 'failure' }]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('b');
  });
  it('fails on a pending check', () => {
    expect(run([ok('a'), { name: 'b', status: 'in_progress', conclusion: null }]).status).toBe(1);
  });
  it('fails when no check ran at all', () => {
    expect(run([]).status).toBe(1);
  });
  it('ignores the named release job itself', () => {
    const own = { name: 'Publish GitHub release', status: 'in_progress', conclusion: null };
    expect(run([ok('a'), own], '--ignore', 'Publish GitHub release').status).toBe(0);
    expect(run([own], '--ignore', 'Publish GitHub release').status).toBe(1);
  });
});

describe('release-flags (atelier-23)', () => {
  const flags = (tag, tags) =>
    spawnSync(process.execPath, [flagsScript, tag], { input: tags.join('\n'), encoding: 'utf8' });

  it('marks an rc tag as a prerelease', () => {
    const r = flags('v1.2.0-rc.1', ['v1.1.0', 'v1.2.0-rc.1']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('--prerelease');
  });
  it('keeps a backport off Latest', () => {
    const r = flags('v1.0.1', ['v1.0.0', 'v1.0.1', 'v1.1.0']);
    expect(r.stdout.trim()).toBe('--latest=false');
  });
  it('adds nothing for the newest stable tag', () => {
    const r = flags('v1.10.0', ['v1.2.0', 'v1.9.0', 'v1.10.0', 'v1.11.0-rc.1']);
    expect(r.stdout.trim()).toBe('');
  });
  it('fails without a tag', () => {
    expect(spawnSync(process.execPath, [flagsScript], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('workflow wiring', () => {
  const release = read('.github/workflows/release.yml');

  it('release checks out full history and runs the gate before publishing (atelier-20)', () => {
    expect(release).toMatch(/fetch-depth:\s*0/);
    const gateAt = release.indexOf('scripts/release-gate.mjs ancestry');
    const createAt = release.indexOf('gh release create');
    expect(gateAt).toBeGreaterThan(-1);
    expect(release.indexOf('scripts/release-gate.mjs checks')).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(createAt);
    expect(release).toMatch(/checks:\s*read/);
  });

  it('release passes computed flags to gh release create (atelier-23)', () => {
    expect(release).toContain('scripts/release-flags.mjs');
    expect(release).toMatch(/gh release create[\s\S]*\$flags/);
  });

  it('ci pins the claude-code package to an exact version (atelier-22)', () => {
    const ci = read('.github/workflows/ci.yml');
    const calls = [...ci.matchAll(/npx\s+(?:--yes\s+)?(\S+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const spec of calls) expect(spec).toMatch(/^(@[^/@]+\/)?[^@\s]+@\d+\.\d+\.\d+$/);
  });
});

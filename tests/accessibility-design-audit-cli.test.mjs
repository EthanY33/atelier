/**
 * The accessibility-design-audit CLI contract, checked by spawning node on
 * index.mjs (no shell): exit codes, stdout/stderr, report content, local
 * paths, and running through a symlink or Windows junction.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BAD_HTML, CLEAN_HTML, startServer } from './accessibility-design-audit/fixtures.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILL_DIR = join(ROOT, 'plugins', 'atelier', 'skills', 'accessibility-design-audit');
const INDEX = join(SKILL_DIR, 'index.mjs');
const BIN = join(ROOT, 'plugins', 'atelier', 'bin', 'atelier');

let tmp;
let server;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'a11y-cli-'));
  writeFileSync(join(tmp, 'bad.html'), BAD_HTML, 'utf8');
  writeFileSync(join(tmp, 'clean.html'), CLEAN_HTML, 'utf8');
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}, 60_000);

/** Run node with args (async so the in-process test server keeps answering). */
function run(args, { cwd = tmp, env = process.env } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', fail);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe('accessibility-design-audit CLI (spawned)', () => {
  it('--help prints usage to stdout and exits 0, directly and through bin/atelier', async () => {
    const direct = await run([INDEX, '--help']);
    expect(direct.status).toBe(0);
    expect(direct.stdout).toMatch(/^Usage: atelier a11y <url\|file> \[outDir\] \[options\]/);
    expect(direct.stdout).toContain('--tags <list>');
    expect(direct.stderr).toBe('');

    const viaBin = await run([BIN, 'a11y', '-h']);
    expect(viaBin.status).toBe(0);
    expect(viaBin.stdout).toBe(direct.stdout);
  });

  it('no arguments: usage on stderr, exit 2', async () => {
    const r = await run([INDEX]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('atelier: missing <url|file>');
    expect(r.stderr).toContain('Usage: atelier a11y');
  });

  it('relative local path with violations: exit 1 and a report naming the rules', async () => {
    const r = await run([INDEX, 'bad.html', 'out-bad']);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toContain('Report written to:');
    expect(r.stdout).toMatch(/Violations: critical 1, serious 1/);
    const report = readFileSync(join(tmp, 'out-bad', 'a11y-report.md'), 'utf8');
    expect(report).toContain('### image-alt');
    expect(report).toContain('### html-has-lang');
    expect(report).toContain('  - `html`');
    expect(existsSync(join(tmp, 'out-bad', 'a11y-raw.json'))).toBe(true);
  });

  it('clean page over HTTP with --out: exit 0', async () => {
    const r = await run([INDEX, server.url('/ok'), '--out', 'out-ok']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(tmp, 'out-ok', 'a11y-report.md'), 'utf8')).toContain('No violations found.');
  });

  it('HTTP 404: exit 2 with a clear message and no report', async () => {
    const r = await run([INDEX, server.url('/missing'), 'out-404']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^atelier: .*answered HTTP 404/);
    expect(r.stdout).toBe('');
    expect(existsSync(join(tmp, 'out-404'))).toBe(false);
  });

  it('missing file: exit 2 without a stack trace', async () => {
    const r = await run([INDEX, 'nope.html']);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`atelier: no such file: ${join(tmp, 'nope.html')}`);
  });

  it('missing Chromium: exit 2 with the install command, not a Playwright stack', async () => {
    const empty = join(tmp, 'no-browsers');
    mkdirSync(empty, { recursive: true });
    const r = await run([INDEX, 'bad.html', 'out-nb'], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^atelier: Playwright Chromium is not installed\.\n {2}Fix: npx playwright@[\d.]+ install chromium/);
    expect(existsSync(join(tmp, 'out-nb'))).toBe(false);
  });

  it('runs through a symlink or junction to the skill directory (CI gate still fails)', async () => {
    const link = join(tmp, 'skill-link');
    symlinkSync(SKILL_DIR, link, 'junction');
    const r = await run([join(link, 'index.mjs'), 'bad.html', 'out-link']);
    expect(r.status, r.stderr).toBe(1);
    expect(existsSync(join(tmp, 'out-link', 'a11y-report.md'))).toBe(true);
  });

  it('importing index.mjs under node -e with its path as argv[1] does not start the CLI', async () => {
    // The SKILL.md JS API form puts this file in argv[1]; isMain alone would
    // then run the CLI with no arguments (usage on stderr, exit 2).
    const code = "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); console.log(typeof m.auditPage);";
    for (const evalFlag of ['-e', '--eval']) {
      const r = await run(['--input-type=module', evalFlag, code, `${SKILL_DIR}/index.mjs`]);
      expect(r.status, `${evalFlag}: ${r.stderr}`).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout.trim()).toBe('function');
    }
  });

  it('the JS API line in SKILL.md runs as written and does not trigger the CLI', async () => {
    const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const snippet = skillMd.match(/^node --input-type=module -e "(.+)" "\$\{CLAUDE_SKILL_DIR\}\/index\.mjs"\r?$/m);
    expect(snippet, 'API line not found in SKILL.md').not.toBeNull();
    const code = snippet[1];
    expect(code).toMatch(/^const \{ pathToFileURL \} = await import\('node:url'\); const m = await import\(pathToFileURL\(process\.argv\[1\]\)\.href\);/);
    // Inside bash double quotes these would be expanded; the snippet must not rely on them.
    expect(code).not.toMatch(/["$`\\]/);
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'index.html'), BAD_HTML, 'utf8');

    // Exactly what Claude Code produces: the skill dir substituted, then "/index.mjs"
    // (mixed separators on Windows).
    const r = await run(['--input-type=module', '-e', code, `${SKILL_DIR}/index.mjs`]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe(`1 1 ${join('a11y-report', 'a11y-report.md')}`);
    expect(existsSync(join(tmp, 'a11y-report', 'a11y-raw.json'))).toBe(true);
  });
});

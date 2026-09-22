#!/usr/bin/env node
/**
 * smoke-installed-plugin.mjs: prove the plugin works the way users get it.
 *
 * Claude Code installs a marketplace plugin by copying its directory into
 * ~/.claude/plugins/cache/... and running `npm ci --ignore-scripts` there with
 * a 60 second budget. Nothing from the repo root comes along. This script
 * reproduces that: it copies plugins/atelier to a temp dir outside the repo,
 * installs, then imports every skill and runs `atelier doctor` and
 * `atelier demo` from the copy.
 *
 * Usage: node scripts/smoke-installed-plugin.mjs [--keep] [--skip-browser]
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'plugins', 'atelier');
const keep = process.argv.includes('--keep');
const skipBrowser = process.argv.includes('--skip-browser');
const INSTALL_BUDGET_MS = 60_000;

const work = mkdtempSync(join(tmpdir(), 'atelier-install-'));
const plugin = join(work, 'cache', 'atelier', 'atelier', 'smoke');
let failed = false;

function run(label, cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' }, ...opts });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label} (${(ms / 1000).toFixed(1)}s)`);
  if (!ok) {
    failed = true;
    console.log((r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : ''));
  }
  return { ...r, ms, ok };
}

function npmCli() {
  if (process.env.npm_execpath && process.env.npm_execpath.endsWith('.js')) return process.env.npm_execpath;
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Cannot locate npm-cli.js next to this Node binary.');
  return found;
}

try {
  cpSync(source, plugin, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('node_modules'),
  });
  console.log(`copied plugins/atelier -> ${plugin}`);
  if (existsSync(join(plugin, 'node_modules'))) throw new Error('copy unexpectedly contains node_modules');

  const install = run('npm ci --ignore-scripts (what Claude Code runs)', process.execPath, [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: plugin });
  if (install.ms > INSTALL_BUDGET_MS) {
    failed = true;
    console.log(`FAIL  install took ${(install.ms / 1000).toFixed(1)}s, over Claude Code's 60s budget`);
  }

  const skills = readdirSync(join(plugin, 'skills'));
  const importAll = `for (const s of ${JSON.stringify(skills)}) { const m = await import(${JSON.stringify(pathToFileURL(join(plugin, 'skills')).href)} + '/' + s + '/index.mjs'); if (!Object.keys(m).length) throw new Error(s + ' exports nothing'); console.log('  ' + s + ': ' + Object.keys(m).join(', ')); }`;
  const imp = run(`import all ${skills.length} skills from the copy`, process.execPath, ['--input-type=module', '-e', importAll]);
  if (imp.ok) process.stdout.write(imp.stdout);

  run('atelier --version', process.execPath, [join(plugin, 'bin', 'atelier'), '--version']);
  run('atelier doctor --no-browser', process.execPath, [join(plugin, 'bin', 'atelier'), 'doctor', '--no-browser']);

  if (!skipBrowser) {
    run('playwright install chromium (from the copy)', process.execPath, [join(plugin, 'node_modules', 'playwright', 'cli.js'), 'install', ...(process.platform === 'linux' ? ['--with-deps'] : []), 'chromium'], { cwd: plugin });
    const demo = run('atelier demo (every skill, from the copy)', process.execPath, [join(plugin, 'bin', 'atelier'), 'demo', '--out', join(work, 'demo-out')]);
    if (demo.ok) process.stdout.write(demo.stdout.split('\n').filter((l) => l.includes('ok ')).join('\n') + '\n');
  }
} catch (err) {
  failed = true;
  console.error(`FAIL  ${err.message}`);
} finally {
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(failed ? '\nInstalled-plugin smoke test FAILED.' : '\nInstalled-plugin smoke test passed.');
process.exit(failed ? 1 : 0);

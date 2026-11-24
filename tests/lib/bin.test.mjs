import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binPath, envWithPath, isWin, makeTmp, pluginRoot, runNode, touch } from './helpers.mjs';

const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
const ALIASES = {
  brand: 'brand-memory',
  tokens: 'design-token-sync',
  og: 'og-card-generator',
  images: 'responsive-image-pipeline',
  assets: 'brand-asset-pipeline',
  a11y: 'accessibility-design-audit',
  video: 'html-to-video',
  ux: 'runtime-ux-audit',
};

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('bin')); });
afterEach(() => cleanup());

const atelier = (args, opts = {}) => runNode([binPath, ...args], { cwd: tmp, ...opts });

/**
 * A preload that records every Node process's argv to a log file and makes
 * a forwarded skill process exit at once with code 7, so forwarding is tested
 * without depending on any skill's own CLI.
 */
function spyEnv() {
  const log = join(tmp, 'argv.log');
  const preload = join(tmp, 'spy.cjs');
  writeFileSync(preload, `
const fs = require('node:fs');
fs.appendFileSync(process.env.ATELIER_SPY_LOG, JSON.stringify(process.argv) + '\\n');
if (/[\\\\/]skills[\\\\/][^\\\\/]+[\\\\/]index\\.mjs$/.test(process.argv[1] || '')) {
  if (process.env.ATELIER_SPY_MODE === 'kill') process.kill(process.pid, 'SIGKILL');
  process.exit(7);
}
`);
  // NODE_OPTIONS treats backslashes inside quotes as escapes; use forward slashes.
  const env = { ...process.env, NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`, ATELIER_SPY_LOG: log };
  const entries = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { env, entries };
}

describe('atelier help and version', () => {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    it(`prints usage to stdout and exits 0 for [${args.join(' ')}]`, () => {
      const r = atelier(args);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(new RegExp(`^atelier ${pkg.version.replaceAll('.', '\\.')}: `));
      expect(r.stdout).toContain('atelier doctor');
      expect(r.stdout).toContain('atelier demo');
      for (const [alias, skill] of Object.entries(ALIASES)) expect(r.stdout).toMatch(new RegExp(`^ {2}${alias} +${skill}$`, 'm'));
    });
  }

  for (const flag of ['--version', '-v', 'version']) {
    it(`prints the package version for ${flag}`, () => {
      const r = atelier([flag]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(pkg.version);
      expect(r.stdout.trim()).toBe(manifest.version);
    });
  }
});

describe('atelier unknown commands', () => {
  it('exits 2 with the error and usage on stderr', () => {
    const r = atelier(['nope']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^atelier: unknown command "nope"\n\natelier /);
    expect(r.stderr).toContain('Skills (alias -> skill):');
  });

  // Regression: `__proto__` and `constructor` resolved to Object.prototype
  // members and crashed with a TypeError (exit 1) instead of a usage error.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '../lib', 'lib', 'Brand', 'skills/brand-memory', '']) {
    it(`rejects ${JSON.stringify(name)} as a usage error`, () => {
      const r = atelier([name]);
      if (name === '') {
        // An empty first argument is "no command": usage on stdout.
        expect(r.status).toBe(0);
        return;
      }
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`unknown command ${JSON.stringify(name)}`);
      expect(r.stderr).not.toMatch(/TypeError|must be of type string/);
    });
  }
});

describe('atelier doctor arguments', () => {
  it('prints doctor help and exits 0', () => {
    for (const flag of ['--help', '-h']) {
      const r = atelier(['doctor', flag]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^Usage: atelier doctor/);
      expect(r.stdout).toContain('--no-browser');
    }
  });

  it('exits 2 with doctor usage on stderr for an unknown flag or a stray argument', () => {
    for (const args of [['doctor', '--bogus'], ['doctor', 'extra']]) {
      const r = atelier(args);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/^atelier: .+\n\nUsage: atelier doctor/);
    }
  });
});

describe('atelier demo arguments', () => {
  it('prints demo help and exits 0 without writing anything', () => {
    const r = atelier(['demo', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Usage: atelier demo/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('exits 2 with demo usage on stderr for bad arguments', () => {
    for (const args of [['demo', '--bogus'], ['demo', '--out'], ['demo', 'positional']]) {
      const r = atelier(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage: atelier demo');
    }
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('refuses the current directory as output, exits 2, and deletes nothing', () => {
    writeFileSync(join(tmp, 'keep.txt'), 'user data');
    const r = atelier(['demo', '--out', '.']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^atelier: Refusing to use .+ current directory/m);
    expect(readFileSync(join(tmp, 'keep.txt'), 'utf8')).toBe('user data');
    expect(existsSync(join(tmp, '.atelier-demo-output'))).toBe(false);
  });
});

describe('atelier skill forwarding', () => {
  it('spawns node on the aliased skill entry with the remaining args, unchanged', () => {
    const { env, entries } = spyEnv();
    const args = ['--help', '--out', 'a b', '&', 'echo', 'pwned', '$(id)'];
    const r = atelier(['tokens', ...args], { env });
    expect(r.status).toBe(7);
    const child = entries().find((argv) => argv[1]?.endsWith('index.mjs'));
    expect(child[0]).toBe(process.execPath);
    expect(child[1]).toBe(join(pluginRoot, 'skills', 'design-token-sync', 'index.mjs'));
    expect(child.slice(2)).toEqual(args);
  });

  it('maps every alias to its skill directory', () => {
    const { env, entries } = spyEnv();
    const present = Object.entries(ALIASES).filter(([, s]) => existsSync(join(pluginRoot, 'skills', s, 'index.mjs')));
    for (const [alias] of present) expect(atelier([alias, '--help'], { env }).status).toBe(7);
    const spawned = entries().map((argv) => argv[1]).filter((p) => p?.endsWith('index.mjs'));
    expect(spawned).toEqual(present.map(([, s]) => join(pluginRoot, 'skills', s, 'index.mjs')));
  });

  it('accepts a full skill name as well as its alias', () => {
    const { env, entries } = spyEnv();
    expect(atelier(['brand-memory', 'get', 'x'], { env }).status).toBe(7);
    const child = entries().find((argv) => argv[1]?.endsWith('index.mjs'));
    expect(child.slice(1)).toEqual([join(pluginRoot, 'skills', 'brand-memory', 'index.mjs'), 'get', 'x']);
  });

  it('exits 1 when the skill process is killed by a signal', () => {
    const { env } = spyEnv();
    const r = atelier(['tokens'], { env: { ...env, ATELIER_SPY_MODE: 'kill' } });
    expect(r.status).toBe(1);
  });

  it('atelier tokens --help prints the skill usage, the same as running the skill directly', () => {
    const entry = join(pluginRoot, 'skills', 'design-token-sync', 'index.mjs');
    const direct = runNode([entry, '--help'], { cwd: tmp });
    const viaBin = atelier(['tokens', '--help']);
    expect(viaBin.status).toBe(0);
    expect(viaBin.stdout).toMatch(/^Usage: /);
    expect(viaBin.status).toBe(direct.status);
    expect(viaBin.stdout).toBe(direct.stdout);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe.skipIf(!isWin)('atelier.cmd shim', () => {
  const cmdPath = join(pluginRoot, 'bin', 'atelier.cmd');
  const comspec = process.env.ComSpec || 'cmd.exe';
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (file, args, opts) => spawnSync(file, args, { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 60_000, ...opts });

  // A command line in cmd syntax, the way a cmd prompt, a batch file or
  // `shell: true` runs it. cmd /s /c strips the first and the last quote of
  // the command line, so the whole line gets its own pair around the quoted
  // path. `switches` go before /s.
  const viaCmd = (args, shim = cmdPath, switches = []) =>
    run(comspec, ['/d', ...switches, '/s', '/c', `""${shim}" ${args}"`], { windowsVerbatimArguments: true });

  // cmd.exe exactly as Windows starts it when a program launches the .cmd
  // file itself: `cmd.exe /c ""<file>" <arguments>"`, the arguments quoted
  // for a program and not for cmd. PowerShell is the usual such launcher;
  // Node refuses to spawn a .cmd file without a shell.
  const direct = (rawArgs, shim = cmdPath) => run(comspec, ['/c', `""${shim}" ${rawArgs}"`], { windowsVerbatimArguments: true });

  // Windows PowerShell with `binDir` first on PATH, so a bare `atelier` is
  // the shim. `command` is PowerShell syntax. Progress records are off
  // because a redirected PowerShell writes them to stderr as CLIXML.
  const viaPowerShell = (command, binDir) => run(powershell, [
    '-NoProfile', '-NonInteractive', '-Command', `$ProgressPreference = 'SilentlyContinue'; ${command}; exit $LASTEXITCODE`,
  ], { env: envWithPath(`${binDir};${process.env.PATH}`) });

  /**
   * A copy of the shim under a directory with a space in its name, beside a
   * stub `atelier` that prints its arguments as JSON and exits 3. Returns the
   * bin directory.
   */
  function stubInstall() {
    const bin = join(tmp, 'sp ace', 'bin');
    touch(join(bin, 'atelier'), 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 3;\n');
    copyFileSync(cmdPath, join(bin, 'atelier.cmd'));
    return bin;
  }

  /** The arguments the stub received, after checking it ran cleanly. */
  function argvOf(r) {
    expect(r.stderr).toBe('');
    expect(r.status).toBe(3);
    return JSON.parse(r.stdout);
  }

  it('runs the bin and passes its output through', () => {
    const r = viaCmd('--version');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it('propagates the exit code', () => {
    expect(viaCmd('nope').status).toBe(2);
  });

  // Regression: viaCmd passed `"<path>" <args>` to cmd /s /c, which strips
  // the first and last quote, so a path with a space was cut at the space
  // and these tests failed from a checkout such as C:\Users\Jane Doe\atelier.
  it('runs from a path with a space and passes quoted arguments unchanged', () => {
    const r = viaCmd('og --title "a b" --x "50% & more" "p|q" "c^d" "wow!" "<x>" "a&b" "say \\"hi\\""', join(stubInstall(), 'atelier.cmd'));
    expect(argvOf(r)).toEqual(['og', '--title', 'a b', '--x', '50% & more', 'p|q', 'c^d', 'wow!', '<x>', 'a&b', 'say "hi"']);
  });

  // Regression: the shim's own line was expanded a second time when the
  // calling cmd.exe had delayed expansion on, which ate every `!`.
  it('keeps ! in an argument when the calling cmd.exe has delayed expansion on', () => {
    const r = viaCmd('"wow^!" "a^!b^!c"', join(stubInstall(), 'atelier.cmd'), ['/v:on']);
    expect(argvOf(r)).toEqual(['wow!', 'a!b!c']);
  });

  it('leaves cmd operators after the shim to a caller that wrote cmd syntax', () => {
    const r = viaCmd('x & echo AFTER', join(stubInstall(), 'atelier.cmd'));
    expect(r.stderr).toBe('');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['["x"]', 'AFTER']);
  });

  // The shim reads %CMDCMDLINE% and may end cmd.exe; neither may touch a
  // session it was merely called from. (A substitution made directly on
  // %CMDCMDLINE% rewrites it for the rest of the session.)
  it('does not end an interactive cmd.exe session or change its %CMDCMDLINE%', () => {
    const shim = join(stubInstall(), 'atelier.cmd');
    const r = run(comspec, ['/d', '/q', '/k'], { input: `"${shim}" a\r\necho SEEN=%CMDCMDLINE%\r\nexit 4\r\n` });
    expect(r.stdout).toContain('["a"]');
    expect(r.stdout).toMatch(/SEEN=.+ \/d \/q \/k/);
    expect(r.status).toBe(4);
  });

  // Regression: a program that starts the .cmd file itself (PowerShell above
  // all) does not quote a whitespace-free argument for cmd, so cmd.exe cut the
  // command line at an &, expanded %VAR%, dropped ^ and ran the remainder as
  // a command: `atelier a11y "https://x.example/?a=1&b=2"` audited
  // https://x.example/?a=1 and then executed `b=2`.
  it('passes cmd metacharacters through when the shim is started directly', () => {
    const r = direct('og --title Q&A --slug faq a^b 100%PATHEXT% x&&y p||q wow! (z) "a b" "50% & more"', join(stubInstall(), 'atelier.cmd'));
    expect(argvOf(r)).toEqual(['og', '--title', 'Q&A', '--slug', 'faq', 'a^b', '100%PATHEXT%', 'x&&y', 'p||q', 'wow!', '(z)', 'a b', '50% & more']);
  });

  // Not covered, because no .cmd file can fix it: a | < or > in a
  // whitespace-free argument. cmd.exe starts the other side of the pipe or
  // opens the file before the shim runs. See the note in atelier.cmd.
  describe.skipIf(!existsSync(powershell))('from PowerShell', () => {
    it('passes arguments to node unchanged', () => {
      const r = viaPowerShell("atelier og --title 'Q&A' --slug faq 'a^b' '100%PATHEXT%' 'wow!' 'a b' '50% & more' 'p | q'", stubInstall());
      expect(r.stdout.trim()).toBe(JSON.stringify(['og', '--title', 'Q&A', '--slug', 'faq', 'a^b', '100%PATHEXT%', 'wow!', 'a b', '50% & more', 'p | q']));
      expect(r.status).toBe(3);
    });

    it('runs nothing after an & in an argument', () => {
      const r = viaPowerShell("atelier 'nope&echo=INJECTED'", join(pluginRoot, 'bin'));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('unknown command "nope&echo=INJECTED"');
      expect(r.stdout).toBe('');
    });
  });
});

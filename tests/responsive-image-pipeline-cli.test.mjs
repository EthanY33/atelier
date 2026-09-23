import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import { runCli } from '../plugins/atelier/skills/responsive-image-pipeline/index.mjs';

const pluginRoot = fileURLToPath(new URL('../plugins/atelier/', import.meta.url));
const skillDir = join(pluginRoot, 'skills', 'responsive-image-pipeline');
const skillEntry = join(skillDir, 'index.mjs');
const binEntry = join(pluginRoot, 'bin', 'atelier');
const skillMd = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const API_LINE_RE = /^node --input-type=module -e "([^"\r\n]*)" "\$\{CLAUDE_SKILL_DIR\}\/index\.mjs"\r?$/m;

/** A POSIX shell to run SKILL.md lines through, or undefined when there is none. */
function posixShell() {
  if (process.platform !== 'win32') return existsSync('/bin/sh') ? '/bin/sh' : undefined;
  const roots = [process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
  return roots.map((r) => join(r, 'Git', 'bin', 'bash.exe')).find((p) => existsSync(p));
}
const sh = posixShell();

const dirs = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'rip-cli-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

async function image(path, { width = 300, height = 200, format = 'png', background = '#3366cc' } = {}) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, await sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer());
}

/** Run the CLI in-process and capture its output. */
async function cli(...argv) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

describe('responsive-image-pipeline CLI', { timeout: 60_000 }, () => {
  it('--help prints usage to stdout and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await cli(flag);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^Usage: atelier images <input\.\.\.> --out <dir>/);
      expect(r.stderr).toBe('');
    }
  });

  it('usage errors print usage to stderr and exit 2', async () => {
    const tmp = scratch();
    const img = join(tmp, 'a.png');
    await image(img);
    const cases = [
      [[], /no input images/],
      [[img], /--out <dir> is required/],
      [[img, '--out', tmp, '--bogus'], /Unknown option '--bogus'/],
      [[img, '--out', join(tmp, 'o'), '--widths', '480,abc'], /--widths: "abc"/],
      [[img, '--out', join(tmp, 'o'), '--widths', ','], /--widths must be a non-empty/],
      [[img, '--out', join(tmp, 'o'), '--formats', 'avif,gif'], /--formats: unsupported format "gif"/],
      [[img, '--out', join(tmp, 'o'), '--fallback', 'bmp'], /fallback: unsupported/],
      [[img, '--out', join(tmp, 'o'), '--lqip-width', '0'], /--lqip-width/],
      [[img, '--out', join(tmp, 'o'), '--loading', 'soon'], /--loading must be lazy or eager/],
      [[img, '--out', join(tmp, 'o'), '--name', '../x'], /name must be a plain file name/],
      [[img, img.replace('a.png', 'b.png'), '--out', join(tmp, 'o'), '--name', 'x'], /--name works with exactly one input/],
      [['https://example.com/a.png', '--out', join(tmp, 'o')], /only local files are supported/],
      [[tmp, '--out', tmp], /is also the --out folder/],
    ];
    for (const [argv, re] of cases) {
      const r = await cli(...argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr, argv.join(' ')).toMatch(re);
      expect(r.stderr, argv.join(' ')).toContain('Usage: atelier images');
      expect(r.stdout).toBe('');
    }
    const empty = join(tmp, 'empty');
    mkdirSync(empty);
    const r = await cli(empty, '--out', join(tmp, 'o'));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/contains no images/);
    expect(existsSync(join(tmp, 'o'))).toBe(false);
  });

  it('processes files and folders, disambiguates shared stems, and prints snippets', async () => {
    const tmp = scratch();
    await image(join(tmp, 'I1', 'hero.png'));
    await image(join(tmp, 'I1', 'notes.txt'), { format: 'png' }); // ignored: not an image extension
    await image(join(tmp, 'I2', 'Hero.jpg'), { format: 'jpeg' });
    await image(join(tmp, 'I3', 'hero.png'));
    await image(join(tmp, 'solo photo.png'), { width: 150, height: 100 });
    const out = join(tmp, 'out');

    const r = await cli(join(tmp, 'I1'), join(tmp, 'I2', 'Hero.jpg'), join(tmp, 'I3', 'hero.png'), join(tmp, 'solo photo.png'),
      '--out', out, '-w', '100,200', '--alt', 'A "hero"', '--base-url', '/img/', '--loading', 'eager');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.match(/<picture>/g)).toHaveLength(4);
    expect(r.stdout).toContain('alt="A &quot;hero&quot;" loading="eager"');
    expect(r.stdout).toContain('srcset="/img/solo%20photo-100.avif 100w, /img/solo%20photo-150.avif 150w"');
    expect(r.stdout).toContain('150 px (200 skipped: larger than the 150 px source)');
    expect(r.stdout).toMatch(/\/img\/Hero-jpg-200\.jpg/);
    // Same stem and same extension: a short path hash keeps the names apart.
    const pngNames = [...r.stdout.matchAll(/(hero-png-[0-9a-f]{6})-200\.png/g)].map((m) => m[1]);
    expect(new Set(pngNames).size).toBe(2);
    expect(existsSync(join(out, 'Hero-jpg-200.avif'))).toBe(true);
    expect(existsSync(join(out, 'notes-lqip.txt'))).toBe(false);

    // Rerun: same names, all cached.
    const again = await cli(join(tmp, 'I1'), join(tmp, 'I2', 'Hero.jpg'), join(tmp, 'I3', 'hero.png'), join(tmp, 'solo photo.png'),
      '--out', out, '-w', '100,200', '--alt', '');
    expect(again.code).toBe(0);
    expect(again.stdout.match(/\(cached\)/g)).toHaveLength(4);
  });

  it('--json reports every input, accepts file URLs, and --name sets the stem', async () => {
    const tmp = scratch();
    const img = join(tmp, 'pic.jpg');
    await image(img, { format: 'jpeg' });
    const out = join(tmp, 'out');

    const r = await cli(pathToFileURL(img).href, '--out', out, '--widths', '120', '--formats', 'webp', '--name', 'cover', '--json');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe(''); // no alt note in JSON mode
    const [entry] = JSON.parse(r.stdout);
    expect(entry).toMatchObject({ ok: true, cached: false, basename: 'cover', widths: [120], formats: ['webp'], fallbackFormat: 'jpg' });
    expect(existsSync(entry.fallback)).toBe(true);
    expect(entry.snippet).toContain('<img src="cover-120.jpg" alt=""');
  });

  it('keeps going after a failed input and exits 2', async () => {
    const tmp = scratch();
    const good = join(tmp, 'good.png');
    await image(good);
    const out = join(tmp, 'out');

    const r = await cli(join(tmp, 'missing.png'), good, '--out', out, '--widths', '100');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/note: no --alt given/);
    expect(r.stderr).toMatch(/atelier: Cannot read .*missing\.png: file not found/);
    expect(r.stderr).not.toContain('Usage:');
    expect(r.stdout).toContain('good-100.avif 100w');

    const json = await cli(join(tmp, 'missing.png'), '--out', out, '--json');
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ ok: false, error: expect.stringMatching(/file not found/) });

    // Two runs, same output name, different sources: refused, not overwritten.
    const other = join(tmp, 'b', 'good.jpg');
    await image(other, { format: 'jpeg' });
    const clash = await cli(other, '--out', out, '--widths', '100');
    expect(clash.code).toBe(2);
    expect(clash.stderr).toMatch(/already belongs to .*good\.png/);
  });

  it('refuses a --base-url that is a Windows path (what Git Bash makes of /img/) with exit 2', async () => {
    const tmp = scratch();
    const img = join(tmp, 'a.png');
    await image(img);
    const out = join(tmp, 'o');
    const saved = process.env.MSYSTEM;
    try {
      process.env.MSYSTEM = 'MINGW64';
      // MSYS rewrites both spellings before node sees them.
      for (const argv of [['--base-url', 'C:/Program Files/Git/img/'], ['--base-url=C:/Program Files/Git/img/']]) {
        const r = await cli(img, '--out', out, ...argv);
        expect(r.code, argv.join(' ')).toBe(2);
        expect(r.stderr).toContain('--base-url C:/Program Files/Git/img/ is a Windows path, not a URL prefix.');
        expect(r.stderr).toContain('MSYS_NO_PATHCONV=1');
        expect(r.stderr).not.toContain('//img/'); // protocol-relative: never suggest it
        expect(r.stderr).toContain('Usage: atelier images');
        expect(r.stdout).toBe('');
      }
      delete process.env.MSYSTEM;
      const plain = await cli(img, '--out', out, '--base-url', 'D:\\site\\img\\');
      expect(plain.code).toBe(2);
      expect(plain.stderr).toContain('is a Windows path, not a URL prefix. Pass a URL path such as /img/.');
      expect(plain.stderr).not.toContain('MSYS_NO_PATHCONV');
    } finally {
      if (saved === undefined) delete process.env.MSYSTEM;
      else process.env.MSYSTEM = saved;
    }
    expect(existsSync(out)).toBe(false);

    // Real URL prefixes still pass, schemes included.
    const ok = await cli(img, '--out', out, '-w', '100', '--alt', 'x', '--base-url', 'https://cdn.example.com/img/');
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('<img src="https://cdn.example.com/img/a-100.png"');
  });

  it.skipIf(!sh)('the documented MSYS_NO_PATHCONV=1 form keeps --base-url /img/ through a POSIX shell', async () => {
    const tmp = scratch();
    await image(join(tmp, 'a.png'));
    const node = `"${process.execPath}"`;
    const args = `"${binEntry}" images a.png --out o -w 100 --alt x --base-url /img/`;

    const fixed = spawnSync(sh, ['-c', `MSYS_NO_PATHCONV=1 ${node} ${args}`], { cwd: tmp, encoding: 'utf8' });
    expect(fixed.status, fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('<img src="/img/a-100.png"');

    // Without it, Git Bash rewrites /img/ to a drive path, which is refused rather
    // than printed into the snippet. Other shells pass /img/ through untouched.
    const env = { ...process.env };
    delete env.MSYS_NO_PATHCONV; // MSYS skips conversion when it is set at all, even empty
    const bare = spawnSync(sh, ['-c', `${node} ${args}`], { cwd: tmp, encoding: 'utf8', env });
    if (process.platform === 'win32') {
      expect(bare.status).toBe(2);
      expect(bare.stderr).toMatch(/--base-url [A-Za-z]:\/.*img\/ is a Windows path/);
      expect(bare.stdout).not.toContain('<picture>');
    } else {
      expect(bare.status, bare.stderr).toBe(0);
      expect(bare.stdout).toContain('<img src="/img/a-100.png"');
    }
  });

  it('runs as a script directly and through bin/atelier', () => {
    const direct = spawnSync(process.execPath, [skillEntry, '--help'], { encoding: 'utf8' });
    expect(direct.status).toBe(0);
    expect(direct.stdout).toContain('Usage: atelier images');

    const viaBin = spawnSync(process.execPath, [binEntry, 'images'], { encoding: 'utf8' });
    expect(viaBin.status).toBe(2);
    expect(viaBin.stderr).toContain('no input images given');

    // Importing the module must not run the CLI.
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(skillEntry).href)}); console.log('ok')`], { encoding: 'utf8' });
    expect(imported.status).toBe(0);
    expect(imported.stdout.trim()).toBe('ok');

    // Nor when its own path is argv[1] under -e, as the SKILL.md JS API line passes it.
    const code = "const { pathToFileURL } = await import('node:url'); const m = await import(pathToFileURL(process.argv[1]).href); console.log(typeof m.runCli)";
    const asArg = spawnSync(process.execPath, ['--input-type=module', '-e', code, skillEntry], { encoding: 'utf8' });
    expect(asArg.stderr).toBe('');
    expect(asArg.status).toBe(0);
    expect(asArg.stdout.trim()).toBe('function');
  });
});

describe('responsive-image-pipeline SKILL.md', { timeout: 60_000 }, () => {
  /** A project folder with src/hero.jpg, as the JS API line expects. */
  async function project() {
    const root = scratch();
    await image(join(root, 'src', 'hero.jpg'), { width: 600, height: 400, format: 'jpeg' });
    return root;
  }

  function expectApiLineEffect(r, root) {
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^<picture>\n[\s\S]*<img src="\/img\/hero-600\.jpg" alt="Harbor at dusk"[\s\S]*<\/picture>\n$/);
    expect(readdirSync(join(root, 'public', 'img')).sort()).toEqual([
      'hero-480.avif', 'hero-480.webp', 'hero-600.avif', 'hero-600.jpg', 'hero-600.webp', 'hero-lqip.txt', 'hero.cache',
    ]);
  }

  it('has the cross-platform JS API line, with nothing a shell expands inside the double quotes', () => {
    const m = skillMd.match(API_LINE_RE);
    expect(m, 'JS API line not found in SKILL.md').not.toBeNull();
    expect(m[1]).toMatch(/^const \{ pathToFileURL \} = await import\('node:url'\); const m = await import\(pathToFileURL\(process\.argv\[1\]\)\.href\); /);
    expect(m[1]).not.toMatch(/["$`\\!]/);
    expect(skillMd).not.toContain('String.raw');
  });

  it('the JS API line runs with the real absolute skill path and does not start the CLI', async () => {
    const root = await project();
    const code = skillMd.match(API_LINE_RE)[1];
    expectApiLineEffect(spawnSync(process.execPath, ['--input-type=module', '-e', code, join(skillDir, 'index.mjs')], { cwd: root, encoding: 'utf8' }), root);
  });

  it.skipIf(!sh)('the JS API line runs as written through a POSIX shell (Git Bash on Windows)', async () => {
    const root = await project();
    // Claude Code substitutes the placeholder with the native absolute path
    // (backslashes on Windows). Pin node to the one running the tests.
    const line = skillMd
      .match(API_LINE_RE)[0]
      .trimEnd()
      .replace('${CLAUDE_SKILL_DIR}', skillDir)
      .replace(/^node /, `"${process.execPath}" `);
    expectApiLineEffect(spawnSync(sh, ['-c', line], { cwd: root, encoding: 'utf8' }), root);
  });

  it('every CLI flag SKILL.md mentions is in --help, and every --help flag is in SKILL.md', async () => {
    const help = (await cli('--help')).stdout;
    const flags = (text) => new Set([...text.matchAll(/(?<![\w-])(--[a-z][a-z-]*|-h)\b/g)].map((x) => x[1]));
    const inDoc = flags(skillMd);
    inDoc.delete('--input-type'); // a node flag in the JS API line
    const inHelp = flags(help);
    expect([...inDoc].filter((f) => !inHelp.has(f))).toEqual([]);
    expect([...inHelp].filter((f) => !inDoc.has(f))).toEqual([]);
    expect(inHelp.size).toBe(13);
  });

  it('is plain ASCII prose with no em or en dashes', () => {
    expect([...skillMd].filter((c) => c.charCodeAt(0) > 127)).toEqual([]);
  });
});

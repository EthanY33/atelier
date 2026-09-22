import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import { runCli } from '../plugins/atelier/skills/responsive-image-pipeline/index.mjs';

const pluginRoot = fileURLToPath(new URL('../plugins/atelier/', import.meta.url));
const skillEntry = join(pluginRoot, 'skills', 'responsive-image-pipeline', 'index.mjs');
const binEntry = join(pluginRoot, 'bin', 'atelier');

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
  });
});

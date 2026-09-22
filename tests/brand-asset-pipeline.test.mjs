import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import { PRESETS, generateAssets } from '../plugins/atelier/skills/brand-asset-pipeline/index.mjs';

const MARK_COLOR = [224, 122, 95]; // #e07a5f
const MARK_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#e07a5f"/></svg>`;
const RED_SVG = (attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="100%" height="100%" fill="#ff0000"/></svg>`;

let tmp;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

/** Fresh temp dir with mark.svg written into it. */
function setup(svg = MARK_SVG) {
  tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
  const markSvg = join(tmp, 'mark.svg');
  writeFileSync(markSvg, svg);
  return { markSvg, outDir: join(tmp, 'out') };
}

async function pixel(file, x, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const px = x === 'center' ? Math.floor(info.width / 2) : x;
  const py = y === 'center' ? Math.floor(info.height / 2) : y;
  const i = (py * info.width + px) * info.channels;
  return [...data.subarray(i, i + info.channels)];
}

const near = (actual, expected, tol = 3) => expected.every((v, i) => Math.abs(actual[i] - v) <= tol);

const fileNamed = (files, name) => files.find((f) => basename(f) === name);

describe('brand-asset-pipeline', { timeout: 30_000 }, () => {
  it('favicons target generates all 5 sizes', async () => {
    const { markSvg, outDir } = setup();
    const { files } = await generateAssets({ markSvg, outDir, targets: ['favicons'] });
    const names = files.map((f) => basename(f));
    expect(names).toEqual(['favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'favicon-64.png', 'favicon-180.png']);
    for (const f of files) expect(existsSync(f)).toBe(true);
  });

  it('app-icons target generates apple and android-chrome files', async () => {
    const { markSvg, outDir } = setup();
    const { files } = await generateAssets({ markSvg, outDir, targets: ['app-icons'] });
    expect(files.map((f) => basename(f))).toEqual(['apple-touch-icon.png', 'android-chrome-192.png', 'android-chrome-512.png']);
  });

  it('defaults to favicons, app-icons and social on #110f1b', async () => {
    const { markSvg, outDir } = setup();
    const result = await generateAssets({ markSvg, outDir });
    expect(result.targets).toEqual(['favicons', 'app-icons', 'social']);
    expect(result.backgroundColor).toBe('#110f1b');
    expect(result.files).toHaveLength(11);
    expect(await pixel(fileNamed(result.files, 'og-cover.png'), 0, 0)).toEqual([17, 15, 27, 255]);
  });

  it('drops duplicate targets', async () => {
    const { markSvg, outDir } = setup();
    const { files, targets } = await generateAssets({ markSvg, outDir, targets: ['favicons', 'favicons'] });
    expect(targets).toEqual(['favicons']);
    expect(files).toHaveLength(5);
  });

  it('still accepts a raster (PNG) mark', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    const markSvg = join(tmp, 'mark.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: '#00ff00' } }).png().toFile(markSvg);
    const { files } = await generateAssets({ markSvg, outDir: join(tmp, 'out'), targets: ['favicons'] });
    expect(near(await pixel(files[1], 'center', 'center'), [0, 255, 0, 255])).toBe(true);
  });
});

describe('every preset', { timeout: 60_000 }, () => {
  let dir;
  let result;
  const allSpecs = Object.entries(PRESETS).flatMap(([target, specs]) => specs.map((s) => ({ target, ...s })));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bap-all-'));
    const markSvg = join(dir, 'mark.svg');
    writeFileSync(markSvg, MARK_SVG);
    result = await generateAssets({ markSvg, outDir: join(dir, 'out'), targets: Object.keys(PRESETS) });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes all 14 files', () => {
    expect(result.files).toHaveLength(14);
    expect(result.targets).toEqual(['favicons', 'app-icons', 'social', 'steam']);
  });

  it.each(allSpecs)('$name is $size$w x $h', async (spec) => {
    const meta = await sharp(fileNamed(result.files, spec.name)).metadata();
    expect(meta.width).toBe(spec.size ?? spec.w);
    expect(meta.height).toBe(spec.size ?? spec.h);
  });

  it('keeps favicons and android-chrome icons transparent around the mark', async () => {
    for (const name of ['favicon-32.png', 'favicon-180.png', 'android-chrome-512.png']) {
      const f = fileNamed(result.files, name);
      expect((await pixel(f, 0, 0))[3]).toBe(0);
      expect(near(await pixel(f, 'center', 'center'), [...MARK_COLOR, 255])).toBe(true);
    }
  });

  it('makes apple-touch-icon opaque on the background color', async () => {
    const f = fileNamed(result.files, 'apple-touch-icon.png');
    const meta = await sharp(f).metadata();
    expect(meta.hasAlpha).toBe(false);
    expect(meta.channels).toBe(3);
    expect(await pixel(f, 0, 0)).toEqual([17, 15, 27]);
    expect(near(await pixel(f, 'center', 'center'), MARK_COLOR)).toBe(true);
  });

  it('centres the mark on every banner', async () => {
    for (const spec of allSpecs.filter((s) => s.w)) {
      const f = fileNamed(result.files, spec.name);
      expect(await pixel(f, 0, 0)).toEqual([17, 15, 27, 255]);
      expect(near(await pixel(f, 'center', 'center'), [...MARK_COLOR, 255])).toBe(true);
    }
  });
});

describe('backgroundColor', { timeout: 30_000 }, () => {
  it.each([
    ['#fff', [255, 255, 255, 255]],
    ['#F00', [255, 0, 0, 255]],
    ['#abcd', [170, 187, 204, 221]],
    ['#ff0000', [255, 0, 0, 255]],
    ['#ff000080', [255, 0, 0, 128]],
    ['00ff00', [0, 255, 0, 255]],
  ])('%s fills the banner background', async (backgroundColor, expected) => {
    const { markSvg, outDir } = setup();
    const { files } = await generateAssets({ markSvg, outDir, targets: ['social'], backgroundColor });
    expect(await pixel(fileNamed(files, 'og-cover.png'), 0, 0)).toEqual(expected);
  });

  it('apple-touch-icon ignores background alpha and stays opaque', async () => {
    const { markSvg, outDir } = setup();
    const { files } = await generateAssets({ markSvg, outDir, targets: ['app-icons'], backgroundColor: '#ff000080' });
    const f = fileNamed(files, 'apple-touch-icon.png');
    expect((await sharp(f).metadata()).hasAlpha).toBe(false);
    expect(await pixel(f, 0, 0)).toEqual([255, 0, 0]);
  });

  it.each(['#12345g', 'white', 'rgb(1,2,3)', '#12', '#1234567', ''])(
    'rejects %j before writing anything',
    async (backgroundColor) => {
      const { markSvg, outDir } = setup();
      await expect(generateAssets({ markSvg, outDir, backgroundColor })).rejects.toThrow(/Invalid backgroundColor/);
      expect(existsSync(outDir)).toBe(false);
    },
  );
});

describe('input validation writes nothing', { timeout: 30_000 }, () => {
  it.each([
    [['favicons', 'bogus'], /Unknown target "bogus"/],
    [['favicons', 'Steam'], /Unknown target "Steam"/],
    [['toString'], /Unknown target "toString"/],
    [['__proto__'], /Unknown target "__proto__"/],
    [['constructor'], /Unknown target "constructor"/],
    [['hasOwnProperty'], /Unknown target/],
    [[42], /Unknown target 42/],
    [[], /targets is empty/],
    ['favicons', /targets must be an array/],
  ])('targets %j rejects', async (targets, message) => {
    const { markSvg, outDir } = setup();
    await expect(generateAssets({ markSvg, outDir, targets })).rejects.toThrow(message);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a missing mark without creating outDir', async () => {
    const { outDir } = setup();
    await expect(generateAssets({ markSvg: join(tmp, 'nope.svg'), outDir })).rejects.toThrow(/Cannot read mark .*file not found/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a file that is not an SVG or image', async () => {
    const { markSvg, outDir } = setup('just some text, not markup');
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/is not a valid SVG or supported image/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('rejects a mark that renders fully transparent', async () => {
    const { markSvg, outDir } = setup('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>');
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/fully transparent/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('requires outDir and markSvg, and a plain-object brand', async () => {
    const { markSvg, outDir } = setup();
    await expect(generateAssets({ markSvg })).rejects.toThrow(TypeError);
    await expect(generateAssets({ outDir })).rejects.toThrow(/markSvg is required/);
    await expect(generateAssets({ markSvg, outDir, brand: 'nope' })).rejects.toThrow(/brand must be an object/);
    await expect(generateAssets({ markSvg, outDir, projectRoot: 42 })).rejects.toThrow(/projectRoot/);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('large and tiny canvases', { timeout: 60_000 }, () => {
  it.each([
    ['viewBox-only 4096', 'viewBox="0 0 4096 4096"'],
    ['4096 px', 'width="4096" height="4096"'],
    ['20000 px', 'width="20000" height="20000"'],
    ['viewBox 0 0 1 1', 'viewBox="0 0 1 1"'],
  ])('%s renders the largest icon and the banners', async (_label, attrs) => {
    const { markSvg, outDir } = setup(RED_SVG(attrs));
    const { files } = await generateAssets({ markSvg, outDir, targets: ['app-icons', 'social'] });
    expect(files).toHaveLength(6);
    expect(await pixel(fileNamed(files, 'android-chrome-512.png'), 'center', 'center')).toEqual([255, 0, 0, 255]);
    expect(await pixel(fileNamed(files, 'og-cover.png'), 'center', 'center')).toEqual([255, 0, 0, 255]);
  });
});

describe('text encodings', { timeout: 30_000 }, () => {
  const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const utf16be = (s) => {
    const b = Buffer.from(s, 'utf16le');
    b.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  };
  const withDecl = (enc, body = MARK_SVG.replace('<?xml version="1.0"?>', '')) => `<?xml version="1.0" encoding="${enc}"?>${body}`;

  it.each([
    ['UTF-16LE with BOM', utf16le(MARK_SVG)],
    ['UTF-16BE with BOM', utf16be(MARK_SVG)],
    ['UTF-16LE declaring encoding="UTF-16"', utf16le(withDecl('UTF-16'))],
    ['UTF-16LE without BOM', Buffer.from(MARK_SVG, 'utf16le')],
    ['UTF-8 with BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MARK_SVG)])],
    ['ISO-8859-1 with a non-ASCII comment', Buffer.from(withDecl('ISO-8859-1', `<!-- caf${String.fromCharCode(0xe9)} -->${MARK_SVG.replace('<?xml version="1.0"?>', '')}`), 'latin1')],
  ])('%s', async (_label, bytes) => {
    const { markSvg, outDir } = setup(bytes);
    const { files } = await generateAssets({ markSvg, outDir, targets: ['favicons'] });
    expect(near(await pixel(fileNamed(files, 'favicon-64.png'), 'center', 'center'), [...MARK_COLOR, 255])).toBe(true);
  });
});

describe('linked images', { timeout: 30_000 }, () => {
  const imageSvg = (href, attr = 'href') =>
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64"><image ${attr}="${href}" width="64" height="64"/></svg>`;
  const redPng = () => sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer();

  async function expectRedIcon(markSvg) {
    const { files } = await generateAssets({ markSvg, outDir: join(tmp, 'out'), targets: ['favicons'] });
    expect(await pixel(fileNamed(files, 'favicon-64.png'), 'center', 'center')).toEqual([255, 0, 0, 255]);
  }

  it('embeds a sibling PNG (href)', async () => {
    const { markSvg } = setup(imageSvg('red.png'));
    writeFileSync(join(tmp, 'red.png'), await redPng());
    await expectRedIcon(markSvg);
  });

  it('embeds a parent-directory link (xlink:href), which librsvg drops on its own', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    mkdirSync(join(tmp, 'assets'));
    mkdirSync(join(tmp, 'brand'));
    writeFileSync(join(tmp, 'assets', 'red.png'), await redPng());
    const markSvg = join(tmp, 'brand', 'mark.svg');
    writeFileSync(markSvg, imageSvg('../assets/red.png', 'xlink:href'));
    await expectRedIcon(markSvg);
  });

  it('embeds an absolute file:// link and decodes XML entities in the href', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bap-test-'));
    writeFileSync(join(tmp, 'a&b.png'), await redPng());
    const href = pathToFileURL(join(tmp, 'a&b.png')).href.replaceAll('&', '&amp;');
    const markSvg = join(tmp, 'mark.svg');
    writeFileSync(markSvg, imageSvg(href));
    await expectRedIcon(markSvg);
  });

  it('decodes numeric character references in the href', async () => {
    const { markSvg } = setup(imageSvg('red&#32;icon&#x2E;png'));
    writeFileSync(join(tmp, 'red icon.png'), await redPng());
    await expectRedIcon(markSvg);
  });

  it.runIf(process.platform === 'win32')('embeds a Windows drive-letter path', async () => {
    const { markSvg } = setup();
    writeFileSync(join(tmp, 'red.png'), await redPng());
    writeFileSync(markSvg, imageSvg(join(tmp, 'red.png')));
    await expectRedIcon(markSvg);
  });

  it('leaves an undecodable data URI alone, then reports the blank mark', async () => {
    const { markSvg, outDir } = setup(imageSvg('data:image/webp;base64,AAAA'));
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/fully transparent/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('converts a linked WebP (which librsvg cannot decode) to PNG', async () => {
    const { markSvg } = setup(imageSvg('red.webp'));
    writeFileSync(join(tmp, 'red.webp'), await sharp(await redPng()).webp({ lossless: true }).toBuffer());
    await expectRedIcon(markSvg);
  });

  it('converts an embedded WebP data URI to PNG', async () => {
    const webp = await sharp(await redPng()).webp({ lossless: true }).toBuffer();
    const { markSvg } = setup(imageSvg(`data:image/webp;base64,${webp.toString('base64')}`));
    await expectRedIcon(markSvg);
  });

  it('embeds a linked SVG and the images it links to', async () => {
    const { markSvg } = setup(imageSvg('inner.svg'));
    writeFileSync(join(tmp, 'inner.svg'), imageSvg('red.png'));
    writeFileSync(join(tmp, 'red.png'), await redPng());
    await expectRedIcon(markSvg);
  });

  it('refuses a remote image instead of fetching it', async () => {
    const { markSvg, outDir } = setup(imageSvg('https://example.com/red.png'));
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/remote image .*no network calls/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('names a missing linked file', async () => {
    const { markSvg, outDir } = setup(imageSvg('missing.png'));
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/"missing.png", which cannot be read \(file not found\)/);
    expect(existsSync(outDir)).toBe(false);
  });

  it('detects a cycle of SVG links', async () => {
    const { markSvg, outDir } = setup(imageSvg('b.svg'));
    writeFileSync(join(tmp, 'b.svg'), imageSvg('mark.svg'));
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/cycle/);
  });

  it('rejects a linked file that is not an image', async () => {
    const { markSvg, outDir } = setup(imageSvg('notes.txt'));
    writeFileSync(join(tmp, 'notes.txt'), 'hello');
    await expect(generateAssets({ markSvg, outDir })).rejects.toThrow(/not a supported image/);
  });
});

describe('brand.json defaults', { timeout: 30_000 }, () => {
  function project(brandExtra = {}) {
    tmp = mkdtempSync(join(tmpdir(), 'bap-brand-'));
    mkdirSync(join(tmp, '.atelier'));
    mkdirSync(join(tmp, 'brand'));
    writeFileSync(join(tmp, 'brand', 'mark.svg'), MARK_SVG);
    const cfg = {
      brand: { studio: 'Test' },
      palette: { bg: '#ff0000' },
      typography: { body: 'Inter' },
      logos: { mark: 'brand/mark.svg' },
      ...brandExtra,
    };
    writeFileSync(join(tmp, '.atelier', 'brand.json'), JSON.stringify(cfg));
    return { projectRoot: tmp, outDir: join(tmp, 'out'), cfg };
  }

  it('adds steam, uses palette.bg and logos.mark from projectRoot', async () => {
    const { projectRoot, outDir } = project({ deploy: { stores: ['itch', 'steam'] } });
    const result = await generateAssets({ projectRoot, outDir });
    expect(result.targets).toEqual(['favicons', 'app-icons', 'social', 'steam']);
    expect(result.backgroundColor).toBe('#ff0000');
    const header = fileNamed(result.files, 'steam-header.png');
    const meta = await sharp(header).metadata();
    expect([meta.width, meta.height]).toEqual([460, 215]);
    expect(await pixel(fileNamed(result.files, 'og-cover.png'), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(await pixel(fileNamed(result.files, 'apple-touch-icon.png'), 0, 0)).toEqual([255, 0, 0]);
  });

  it('leaves steam out when deploy.stores does not list it', async () => {
    const { projectRoot, outDir } = project({ deploy: { target: 'netlify', stores: ['itch'] } });
    const { targets } = await generateAssets({ projectRoot, outDir });
    expect(targets).toEqual(['favicons', 'app-icons', 'social']);
  });

  it('lets explicit options win over brand.json', async () => {
    const { projectRoot, outDir } = project({ deploy: { stores: ['steam'] } });
    const result = await generateAssets({ projectRoot, outDir, targets: ['social'], backgroundColor: '#00f' });
    expect(result.targets).toEqual(['social']);
    expect(await pixel(fileNamed(result.files, 'og-cover.png'), 0, 0)).toEqual([0, 0, 255, 255]);
  });

  it('accepts a brand object directly, with a 3-digit palette.bg', async () => {
    const { markSvg, outDir } = setup();
    const brand = { brand: { studio: 'T' }, palette: { bg: '#0f0' }, typography: { body: 'Inter' }, deploy: { stores: ['steam'] } };
    const result = await generateAssets({ markSvg, outDir, brand });
    expect(result.targets).toContain('steam');
    expect(await pixel(fileNamed(result.files, 'steam-header.png'), 0, 0)).toEqual([0, 255, 0, 255]);
  });

  it('ignores inherited brand keys', async () => {
    const { markSvg, outDir } = setup();
    const brand = Object.create({ palette: { bg: '#0000ff' }, deploy: { stores: ['steam'] } });
    const result = await generateAssets({ markSvg, outDir, brand });
    expect(result.targets).toEqual(['favicons', 'app-icons', 'social']);
    expect(result.backgroundColor).toBe('#110f1b');
  });

  it('names the palette.bg source when it is invalid', async () => {
    const { markSvg, outDir } = setup();
    await expect(generateAssets({ markSvg, outDir, brand: { palette: { bg: 'navy' } } })).rejects.toThrow(/Invalid brand palette.bg "navy"/);
  });

  it('fails clearly when projectRoot has no brand.json', async () => {
    const { markSvg, outDir } = setup();
    await expect(generateAssets({ markSvg, outDir, projectRoot: tmp })).rejects.toThrow(/brand.json not found/);
    expect(existsSync(outDir)).toBe(false);
  });
});

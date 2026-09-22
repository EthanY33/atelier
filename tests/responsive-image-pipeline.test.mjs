import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { sharp } from './helpers/plugin-deps.mjs';
import {
  processImage,
  buildPictureSnippet,
} from '../plugins/atelier/skills/responsive-image-pipeline/index.mjs';
import { launchChromium, PreflightError } from '../plugins/atelier/lib/preflight.mjs';

const dirs = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'rip-test-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** Write a solid-color image. Formats: png, jpeg, webp. */
async function solid(path, { width, height, background = { r: 100, g: 150, b: 200 }, channels = 3, format = 'png' }) {
  mkdirSync(join(path, '..'), { recursive: true });
  const buf = await sharp({ create: { width, height, channels, background } })[format]().toBuffer();
  writeFileSync(path, buf);
  return buf;
}

// Read through a buffer: sharp keeps file handles open on Windows otherwise.
const meta = (p) => sharp(readFileSync(p)).metadata();
const dataUrlBuffer = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');

async function pixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + info.channels)];
}

describe('responsive-image-pipeline', { timeout: 30_000 }, () => {
  it('produces AVIF + WebP variants at requested widths', async () => {
    const tmp = scratch();
    const inputPath = join(tmp, 'photo.png');
    await solid(inputPath, { width: 2000, height: 1500 });

    const outDir = join(tmp, 'out');
    const result = await processImage({ input: inputPath, outDir, widths: [480, 1280] });

    expect(result.cached).toBe(false);
    for (const name of ['photo-480.avif', 'photo-480.webp', 'photo-1280.avif', 'photo-1280.webp']) {
      expect(existsSync(join(outDir, name)), `${name} should exist`).toBe(true);
    }
    expect(result.variants).toHaveLength(4);
    expect(result.widths).toEqual([480, 1280]);
    expect(result.skippedWidths).toEqual([]);
    const m480 = await meta(join(outDir, 'photo-480.webp'));
    expect([m480.width, m480.height]).toEqual([480, 360]);
    const m1280 = await meta(join(outDir, 'photo-1280.avif'));
    expect([m1280.width, m1280.height]).toEqual([1280, 960]);
  });

  it('writes a base64 LQIP placeholder file starting with data:image/', async () => {
    const tmp = scratch();
    const inputPath = join(tmp, 'photo.png');
    await solid(inputPath, { width: 2000, height: 1500, background: { r: 80, g: 120, b: 180 } });

    const outDir = join(tmp, 'out');
    const { lqip } = await processImage({ input: inputPath, outDir, widths: [480] });

    const lqipPath = join(outDir, 'photo-lqip.txt');
    expect(existsSync(lqipPath)).toBe(true);
    const content = readFileSync(lqipPath, 'utf8').trim();
    expect(content.startsWith('data:image/')).toBe(true);
    expect(lqip.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect((await sharp(dataUrlBuffer(lqip)).metadata()).width).toBe(24);
  });

  it('buildPictureSnippet produces correct HTML', () => {
    const html = buildPictureSnippet({ basename: 'photo', widths: [480, 1280], alt: 'A photo' });

    expect(html).toContain('<picture>');
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('type="image/webp"');
    expect(html).toContain('photo-480.avif 480w');
    expect(html).toContain('alt="A photo"');
    // Without a processImage result, the fallback is the last <source> format,
    // which is always written, never an unproduced .png.
    expect(html).toContain('<img src="photo-1280.webp"');
  });

  it('buildPictureSnippet HTML-escapes alt, basename, and sizes', () => {
    const html = buildPictureSnippet({
      basename: 'photo',
      widths: [480],
      alt: 'Say "hi" <script>',
      sizes: '(max-width: 480px) 100vw, 50vw',
    });

    expect(html).toContain('&quot;');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('alt="Say "hi"');
    expect(html).not.toContain('<script>');
  });

  it('skips unchanged sources on second run (caching)', async () => {
    const tmp = scratch();
    const inputPath = join(tmp, 'photo.png');
    await solid(inputPath, { width: 2000, height: 1500, background: { r: 60, g: 90, b: 130 } });

    const outDir = join(tmp, 'out');
    const opts = { input: inputPath, outDir, widths: [480] };

    const first = await processImage(opts);
    expect(first.cached).toBe(false);

    const second = await processImage(opts);
    expect(second.cached).toBe(true);
    expect(second.variants.some((v) => v.endsWith('photo-480.avif'))).toBe(true);
    expect(second.variants.some((v) => v.endsWith('photo-480.webp'))).toBe(true);
    // A cache hit returns the same shape as a fresh run.
    const { cached: _a, ...firstRest } = first;
    const { cached: _b, ...secondRest } = second;
    expect(secondRest).toEqual(firstRest);
  });

  it('applies EXIF orientation before resizing', async () => {
    const tmp = scratch();
    const input = join(tmp, 'rot.jpg');
    // Stored 200x100, left half red and right half blue; orientation 6 displays
    // it as 100x200 with red on top.
    const red = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const buf = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#0000ff' } })
      .composite([{ input: red, left: 0, top: 0 }])
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    writeFileSync(input, buf);

    const outDir = join(tmp, 'out');
    const result = await processImage({ input, outDir, widths: [50] });

    expect(result.source).toMatchObject({ width: 100, height: 200 });
    for (const f of ['rot-50.webp', 'rot-50.avif', 'rot-50.jpg']) {
      const m = await meta(join(outDir, f));
      expect([m.width, m.height], f).toEqual([50, 100]);
      expect(m.orientation, f).toBeUndefined();
    }
    const webp = readFileSync(join(outDir, 'rot-50.webp'));
    const [r, , b] = await pixel(webp, 25, 5);
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
    const lqipMeta = await sharp(dataUrlBuffer(result.lqip)).metadata();
    expect([lqipMeta.width, lqipMeta.height]).toEqual([24, 48]);
  });

  it('never upscales: skips widths above the source and labels files truthfully', async () => {
    const tmp = scratch();
    const input = join(tmp, 'small.png');
    await solid(input, { width: 600, height: 400 });
    const outDir = join(tmp, 'out');

    const result = await processImage({ input, outDir, widths: [1920, 300, 1280] });

    expect(result.widths).toEqual([300, 600]);
    expect(result.skippedWidths).toEqual([1280, 1920]);
    expect(existsSync(join(outDir, 'small-1280.webp'))).toBe(false);
    expect(existsSync(join(outDir, 'small-1920.avif'))).toBe(false);
    for (const img of result.images) {
      const m = await meta(img.path);
      expect(m.width, img.path).toBe(img.width);
      expect(img.path).toContain(`-${img.width}.`);
    }

    const html = buildPictureSnippet({ ...result, alt: 'x' });
    expect(html).toContain('small-600.avif 600w');
    expect(html).not.toMatch(/1280w|1920w/);

    // A source narrower than every requested width still yields one size.
    const tiny = join(tmp, 'tiny.png');
    await solid(tiny, { width: 90, height: 60 });
    const t = await processImage({ input: tiny, outDir, widths: [480, 768] });
    expect(t.widths).toEqual([90]);
    expect((await meta(join(outDir, 'tiny-90.webp'))).width).toBe(90);
  });

  it('writes the fallback <img> file the snippet points to', async () => {
    const tmp = scratch();
    const outDir = join(tmp, 'out');
    const imgSrc = (html) => html.match(/<img src="([^"]+)"/)[1];

    const jpg = join(tmp, 'photo.jpg');
    await solid(jpg, { width: 800, height: 500, format: 'jpeg' });
    const rj = await processImage({ input: jpg, outDir, widths: [200, 400] });
    expect(rj.fallbackFormat).toBe('jpg');
    expect(rj.fallback).toBe(join(outDir, 'photo-400.jpg'));
    expect(existsSync(rj.fallback)).toBe(true);
    expect(rj.variants).toHaveLength(4); // the fallback is not a <source> variant
    expect(existsSync(join(outDir, decodeURIComponent(imgSrc(buildPictureSnippet({ ...rj, alt: '' })))))).toBe(true);

    const png = join(tmp, 'shot.png');
    await solid(png, { width: 800, height: 500 });
    const rp = await processImage({ input: png, outDir, widths: [400] });
    expect(rp.fallbackFormat).toBe('png');
    expect(existsSync(join(outDir, 'shot-400.png'))).toBe(true);

    // A fallback format that is already a variant reuses that file.
    const rw = await processImage({ input: png, outDir: join(tmp, 'w'), widths: [400], fallback: 'webp' });
    expect(rw.fallback).toBe(join(tmp, 'w', 'shot-400.webp'));
    expect(rw.images).toHaveLength(2);

    // No fallback: the snippet falls back to the last <source> format.
    const rn = await processImage({ input: png, outDir: join(tmp, 'n'), widths: [400], fallback: false });
    expect(rn.fallback).toBeNull();
    expect(rn.fallbackFormat).toBeNull();
    expect(imgSrc(buildPictureSnippet({ ...rn }))).toBe('shot-400.webp');
  });

  it('URL-encodes file names in srcset and src, and keeps names on disk', async () => {
    expect(buildPictureSnippet({ basename: 'Hero Image', widths: [480] })).toContain('srcset="Hero%20Image-480.avif 480w"');
    const comma = buildPictureSnippet({ basename: 'Hero, Image', widths: [480], formats: ['webp'] });
    expect(comma).toContain('Hero%2C%20Image-480.webp 480w');
    const odd = buildPictureSnippet({ basename: 'a#b?c "d"', widths: [10], formats: ['webp'] });
    expect(odd).toContain('a%23b%3Fc%20%22d%22-10.webp 10w');
    const unicode = buildPictureSnippet({ basename: String.fromCharCode(99, 97, 102, 0xe9), widths: [10], formats: ['webp'] });
    expect(unicode).toContain('caf%C3%A9-10.webp');
    const pre = buildPictureSnippet({ basename: 'Hero%20Image', widths: [10], formats: ['webp'] });
    expect(pre).toContain('Hero%20Image-10.webp'); // not double-encoded
    const base = buildPictureSnippet({ basename: 'h', widths: [10], formats: ['webp'], baseUrl: '/my img/"x"/' });
    expect(base).toContain('src="/my%20img/%22x%22/h-10.webp"');

    const tmp = scratch();
    const input = join(tmp, 'Hero Image.png');
    await solid(input, { width: 300, height: 200 });
    const outDir = join(tmp, 'out');
    const result = await processImage({ input, outDir, widths: [100] });
    expect(result.basename).toBe('Hero Image');
    expect(existsSync(join(outDir, 'Hero Image-100.avif'))).toBe(true);
    expect(buildPictureSnippet({ ...result, alt: 'x' })).toContain('Hero%20Image-100.avif 100w');
  });

  it('a browser loads the encoded srcset for a name with spaces', { timeout: 60_000 }, async (ctx) => {
    const tmp = scratch();
    const input = join(tmp, 'src', 'Hero, Image.png');
    await solid(input, { width: 400, height: 300 });
    const outDir = join(tmp, 'site');
    const result = await processImage({ input, outDir, widths: [200, 400] });
    const page = join(outDir, 'index.html');
    writeFileSync(page, `<!doctype html><html><body style="margin:0">${buildPictureSnippet({ ...result, alt: 'hero', loading: 'eager' })}</body></html>`);

    let browser;
    try {
      browser = await launchChromium();
    } catch (err) {
      if (err instanceof PreflightError) return ctx.skip();
      throw err;
    }
    try {
      const tab = await browser.newPage({ viewport: { width: 400, height: 300 } });
      await tab.goto(pathToFileURL(page).href);
      await tab.waitForFunction(() => document.querySelector('img').complete);
      const { src, natural } = await tab.evaluate(() => {
        const img = document.querySelector('img');
        return { src: img.currentSrc, natural: img.naturalWidth };
      });
      expect(decodeURIComponent(src)).toMatch(/Hero, Image-400\.avif$/);
      expect(natural).toBe(400);
    } finally {
      await browser.close();
    }
  });

  it('rejects values that could break out of snippet attributes', () => {
    const base = { basename: 'h', widths: [480], alt: 'x' };
    expect(() => buildPictureSnippet({ ...base, fallbackFormat: 'png" onerror="alert(1)' })).toThrow(/fallbackFormat/);
    expect(() => buildPictureSnippet({ ...base, widths: ['480 1x" onerror="alert(1)'] })).toThrow(/widths/);
    expect(() => buildPictureSnippet({ ...base, widths: ['480"><script>alert(1)</script>'] })).toThrow(/widths/);
    expect(() => buildPictureSnippet({ ...base, widths: [] })).toThrow(/widths/);
    expect(() => buildPictureSnippet({ ...base, widths: [1.5] })).toThrow(/widths/);
    expect(() => buildPictureSnippet({ ...base, formats: ['webp" x="'] })).toThrow(/formats/);
    expect(() => buildPictureSnippet({ ...base, loading: 'soon' })).toThrow(/loading/);
    expect(() => buildPictureSnippet({ widths: [480] })).toThrow(/basename/);
    // Numeric strings are accepted and sorted.
    expect(buildPictureSnippet({ ...base, widths: ['960', 480], formats: ['webp'] })).toContain('h-480.webp 480w, h-960.webp 960w');
    // A missing alt is empty, never the string "undefined".
    expect(buildPictureSnippet({ basename: 'h', widths: [480] })).toContain('alt=""');
    // Legacy explicit fallbackFormat is kept.
    expect(buildPictureSnippet({ ...base, fallbackFormat: 'png' })).toContain('<img src="h-480.png"');
    expect(buildPictureSnippet({ ...base, formats: ['jpeg'] })).toContain('type="image/jpeg" srcset="h-480.jpg 480w"');
  });

  it('invalidates the cache when any output-changing option changes', async () => {
    const tmp = scratch();
    const input = join(tmp, 'photo.png');
    await solid(input, { width: 400, height: 300 });
    const outDir = join(tmp, 'out');
    const base = { input, outDir, widths: [100] };

    expect((await processImage(base)).cached).toBe(false);
    expect((await processImage(base)).cached).toBe(true);

    const bigger = await processImage({ ...base, lqipWidth: 64 });
    expect(bigger.cached).toBe(false);
    expect((await sharp(dataUrlBuffer(bigger.lqip)).metadata()).width).toBe(64);

    expect((await processImage({ ...base, lqipWidth: 64, formats: ['webp'] })).cached).toBe(false);
    expect((await processImage({ ...base, lqipWidth: 64, formats: ['webp'], quality: { webp: 50 } })).cached).toBe(false);
    expect((await processImage({ ...base, lqipWidth: 64, formats: ['webp'], quality: { webp: 50 } })).cached).toBe(true);
    expect((await processImage({ ...base, widths: [100, 200] })).cached).toBe(false);
    expect((await processImage({ ...base, widths: [100, 200], fallback: 'jpg' })).cached).toBe(false);
    expect((await processImage({ ...base, widths: [100, 200], fallback: 'jpg' })).cached).toBe(true);
    expect((await processImage({ ...base, widths: [100, 200], fallback: 'jpg', background: '#000' })).cached).toBe(false);
    expect((await processImage({ ...base, widths: [100, 200], fallback: 'jpg', background: '#000' })).cached).toBe(true);

    await solid(input, { width: 400, height: 300, background: { r: 1, g: 2, b: 3 } });
    expect((await processImage({ ...base, widths: [100, 200], fallback: 'jpg', background: '#000' })).cached).toBe(false);
  });

  it('regenerates when cached outputs are missing or the cache is from an older version', async () => {
    const tmp = scratch();
    const input = join(tmp, 'photo.png');
    await solid(input, { width: 400, height: 300 });
    const outDir = join(tmp, 'out');
    const opts = { input, outDir, widths: [100] };
    await processImage(opts);

    unlinkSync(join(outDir, 'photo-100.avif'));
    const r1 = await processImage(opts);
    expect(r1.cached).toBe(false);
    expect(existsSync(join(outDir, 'photo-100.avif'))).toBe(true);

    unlinkSync(join(outDir, 'photo-lqip.txt'));
    const r2 = await processImage(opts);
    expect(r2.cached).toBe(false);
    expect(r2.lqip.startsWith('data:image/')).toBe(true);

    writeFileSync(join(outDir, 'photo-lqip.txt'), 'garbage');
    expect((await processImage(opts)).cached).toBe(false);

    // Pre-1.0 caches were a bare sha256 hex string.
    writeFileSync(join(outDir, 'photo.cache'), 'a'.repeat(64));
    expect((await processImage(opts)).cached).toBe(false);
    expect((await processImage(opts)).cached).toBe(true);
    const manifest = JSON.parse(readFileSync(join(outDir, 'photo.cache'), 'utf8'));
    expect(manifest.source).toBe('../photo.png');
  });

  it('refuses to let two sources with the same stem overwrite each other', async () => {
    const tmp = scratch();
    const a = join(tmp, 'I1', 'hero.png');
    const b = join(tmp, 'I2', 'hero.jpg');
    await solid(a, { width: 300, height: 200, background: { r: 255, g: 0, b: 0 } });
    await solid(b, { width: 300, height: 200, background: { r: 0, g: 0, b: 255 }, format: 'jpeg' });
    const outDir = join(tmp, 'out');

    await processImage({ input: a, outDir, widths: [100] });
    await expect(processImage({ input: b, outDir, widths: [100] })).rejects.toThrow(/already belongs to .*hero\.png/);
    const [r] = await pixel(readFileSync(join(outDir, 'hero-100.webp')), 5, 5);
    expect(r).toBeGreaterThan(200); // still the red source

    const named = await processImage({ input: b, outDir, widths: [100], name: 'hero-alt' });
    expect(named.basename).toBe('hero-alt');
    expect(existsSync(join(outDir, 'hero-alt-100.webp'))).toBe(true);

    // Reprocessing the owner is fine, and a moved-away owner releases the name.
    expect((await processImage({ input: a, outDir, widths: [100] })).cached).toBe(true);
    rmSync(a);
    expect((await processImage({ input: b, outDir, widths: [100] })).cached).toBe(false);
  });

  it('keeps LQIP transparency and flattens JPEG output onto white, not black', async () => {
    const tmp = scratch();
    const outDir = join(tmp, 'out');
    const clear = join(tmp, 'clear.png');
    await solid(clear, { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } });

    const r = await processImage({ input: clear, outDir, widths: [100], fallback: 'jpg' });
    expect(r.source.transparent).toBe(true);
    expect(r.lqip.startsWith('data:image/webp;base64,')).toBe(true);
    const lq = await pixel(dataUrlBuffer(r.lqip), 3, 3);
    expect(lq[3]).toBe(0);
    const jpgPx = await pixel(readFileSync(join(outDir, 'clear-100.jpg')), 10, 10);
    expect(jpgPx.slice(0, 3).every((c) => c > 245)).toBe(true);

    // auto picks png for transparent sources, and an opaque RGBA image gets a JPEG LQIP.
    const auto = await processImage({ input: clear, outDir: join(tmp, 'auto'), widths: [100] });
    expect(auto.fallbackFormat).toBe('png');
    const opaque = join(tmp, 'opaque.png');
    await solid(opaque, { width: 200, height: 200, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } });
    const o = await processImage({ input: opaque, outDir, widths: [100] });
    expect(o.source.transparent).toBe(false);
    expect(o.lqip.startsWith('data:image/jpeg;base64,')).toBe(true);

    // background is configurable.
    const g = await processImage({ input: clear, outDir: join(tmp, 'g'), widths: [100], fallback: 'jpg', background: '#00ff00' });
    const gp = await pixel(readFileSync(g.fallback), 10, 10);
    expect(gp[1]).toBeGreaterThan(200);
    expect(gp[0]).toBeLessThan(60);
  });

  it('validates options and names the file in read errors', async () => {
    const tmp = scratch();
    const input = join(tmp, 'p.png');
    await solid(input, { width: 50, height: 50 });
    const outDir = join(tmp, 'out');

    await expect(processImage({ input: join(tmp, 'nope.png'), outDir })).rejects.toThrow(/Cannot read .*nope\.png: file not found/);
    const txt = join(tmp, 'notes.png');
    writeFileSync(txt, 'not an image');
    await expect(processImage({ input: txt, outDir })).rejects.toThrow(/Cannot decode .*notes\.png/);
    await expect(processImage({ input, outDir, name: '../escape' })).rejects.toThrow(/name/);
    await expect(processImage({ input, outDir, name: 'a\\b' })).rejects.toThrow(/name/);
    await expect(processImage({ input, outDir, widths: [0] })).rejects.toThrow(/widths/);
    await expect(processImage({ input, outDir, formats: ['gif'] })).rejects.toThrow(/formats/);
    await expect(processImage({ input, outDir, fallback: 'bmp' })).rejects.toThrow(/fallback/);
    await expect(processImage({ input, outDir, quality: { avif: 0 } })).rejects.toThrow(/quality/);
    await expect(processImage({ input, outDir, quality: { heic: 50 } })).rejects.toThrow(/quality/);
    await expect(processImage({ input, outDir, quality: 5 })).rejects.toThrow(/quality/);
    await expect(processImage({ input, outDir, lqipWidth: -1 })).rejects.toThrow(/lqipWidth/);
    await expect(processImage({ input, outDir, background: 'notacolor' })).rejects.toThrow(/color/);
    await expect(processImage({ input, outDir, background: 5 })).rejects.toThrow(/background/);
    await expect(processImage({ input })).rejects.toThrow(/outDir/);
    await expect(processImage({ outDir })).rejects.toThrow(/input/);
    expect(existsSync(outDir)).toBe(false); // nothing written on failure

    // file: URLs are accepted as input.
    const viaUrl = await processImage({ input: pathToFileURL(input).href, outDir, widths: [50] });
    expect(viaUrl.basename).toBe('p');
    const viaUrlObj = await processImage({ input: pathToFileURL(input), outDir, widths: [50] });
    expect(viaUrlObj.cached).toBe(true);
  });

  it('never overwrites the source image with an output', async () => {
    const tmp = scratch();
    const input = join(tmp, 'x-40.webp');
    await solid(input, { width: 40, height: 40, format: 'webp' });
    const before = readFileSync(input);
    await expect(processImage({ input, outDir: tmp, widths: [40], formats: ['webp'], name: 'x' })).rejects.toThrow(/overwrite the source/);
    expect(readFileSync(input).equals(before)).toBe(true);
  });
});

afterAll(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, afterEach } from 'vitest';
import {
  BRAND_SCHEMA_URL,
  brandFilePath,
  loadBrand,
  saveBrand,
  getPath,
  setPath,
  initBrand,
  auditBrand,
  validateBrand,
} from '../plugins/atelier/skills/brand-memory/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', 'plugins', 'atelier');
const SKILL_DIR = join(PLUGIN_ROOT, 'skills', 'brand-memory');

const POLLUTION_KEYS = ['polluted', 'isAdmin', 'deep', 'x'];

let tmp;

function newTmp() {
  tmp = mkdtempSync(join(tmpdir(), 'atelier-test-'));
  return tmp;
}

function writeRaw(root, content) {
  mkdirSync(join(root, '.atelier'), { recursive: true });
  writeFileSync(brandFilePath(root), content);
}

const minimal = () => ({
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b' },
  typography: { body: 'Silkscreen, monospace' },
});

afterEach(() => {
  // A failed pollution test must not cascade into the rest of the worker.
  for (const k of POLLUTION_KEYS) delete Object.prototype[k];
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------
describe('load/save', () => {
  it('saveBrand writes and loadBrand reads roundtrip', () => {
    newTmp();
    const cfg = minimal();
    saveBrand(tmp, cfg);
    const loaded = loadBrand(tmp);
    expect(loaded).toEqual(cfg);
  });

  it('saveBrand writes 2-space JSON with a trailing newline', () => {
    newTmp();
    const cfg = { ...minimal(), deploy: { target: 'netlify' } };
    saveBrand(tmp, cfg);
    expect(readFileSync(brandFilePath(tmp), 'utf8')).toBe(JSON.stringify(cfg, null, 2) + '\n');
  });

  it('saveBrand throws on invalid config (missing brand.studio) and writes nothing', () => {
    newTmp();
    const bad = { brand: {}, palette: { bg: '#110f1b' }, typography: { body: 'Silkscreen' } };
    expect(() => saveBrand(tmp, bad)).toThrow('invalid brand config');
    expect(existsSync(brandFilePath(tmp))).toBe(false);
  });

  it('loadBrand throws helpful error when file is missing', () => {
    newTmp();
    expect(() => loadBrand(tmp)).toThrow(/brand\.json not found.*run \/brand-init/);
    try {
      loadBrand(tmp);
    } catch (err) {
      expect(err.code).toBe('BRAND_NOT_FOUND');
    }
  });

  it('loadBrand throws on a brand.json that fails schema validation', () => {
    newTmp();
    // Missing required brand.studio. saveBrand would refuse this; without
    // load-side validation, downstream emitters would silently consume it.
    writeRaw(tmp, JSON.stringify({ brand: {}, palette: { bg: '#110f1b' }, typography: { body: 'Arial' } }));
    expect(() => loadBrand(tmp)).toThrow(/invalid brand\.json/);
  });

  it('loadBrand accepts a UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding utf8)', () => {
    newTmp();
    writeRaw(tmp, '\uFEFF' + JSON.stringify(minimal()));
    expect(loadBrand(tmp)).toEqual(minimal());
  });

  it('loadBrand accepts UTF-16LE with a BOM (PowerShell 5.1 Out-File)', () => {
    newTmp();
    writeRaw(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(minimal()), 'utf16le')]));
    expect(loadBrand(tmp)).toEqual(minimal());
  });

  it('loadBrand names the file when the JSON is malformed', () => {
    newTmp();
    writeRaw(tmp, '{"brand": {"studio": "x",}}');
    let err;
    try {
      loadBrand(tmp);
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/invalid brand\.json at .*\.atelier.*brand\.json: not valid JSON/);
    expect(err.code).toBe('BRAND_INVALID');
    expect(err.errors[0]).toMatch(/not valid JSON/);
  });

  it('loadBrand names the file when the JSON is empty', () => {
    newTmp();
    writeRaw(tmp, '');
    expect(() => loadBrand(tmp)).toThrow(/brand\.json at .*\.atelier/);
  });

  it('loadBrand names the file when brand.json is a directory', () => {
    newTmp();
    mkdirSync(brandFilePath(tmp), { recursive: true });
    let err;
    try {
      loadBrand(tmp);
    } catch (e) {
      err = e;
    }
    expect(err.message).toMatch(/cannot read brand\.json at .*\.atelier.*directory/);
    expect(err.code).toBe('BRAND_UNREADABLE');
  });

  it('loadBrand rejects a top level that is not an object', () => {
    newTmp();
    writeRaw(tmp, '[]');
    expect(() => loadBrand(tmp)).toThrow(/must be a JSON object \(got array\)/);
  });

  it('saveBrand names the file when it cannot write', () => {
    newTmp();
    mkdirSync(brandFilePath(tmp), { recursive: true }); // a directory where the file should go
    expect(() => saveBrand(tmp, minimal())).toThrow(/cannot write brand\.json at .*\.atelier/);
  });

  it('loadBrand, saveBrand and initBrand are synchronous (no Promises)', () => {
    newTmp();
    const saved = saveBrand(tmp, minimal());
    expect(saved).toBeUndefined();
    const loaded = loadBrand(tmp);
    expect(loaded).not.toBeInstanceOf(Promise);
    expect(typeof loaded.then).toBe('undefined');
    const inited = initBrand(tmp, { studio: 'S', bodyFont: 'Inter', primaryColor: '#000' });
    expect(inited).not.toBeInstanceOf(Promise);
  });
});

// ---------------------------------------------------------------------------
// validation messages
// ---------------------------------------------------------------------------
describe('validation messages', () => {
  it('names an unknown property and lists the allowed ones', () => {
    const { valid, errors } = validateBrand(setPath(minimal(), 'brand.tagline', 'hi'));
    expect(valid).toBe(false);
    expect(errors).toEqual(['brand.tagline: unknown property (allowed in brand: studio, product, voice)']);
  });

  it('lists the allowed values of an enum', () => {
    const { errors } = validateBrand(setPath(minimal(), 'deploy.target', 'cloudflare'));
    expect(errors[0]).toBe(
      'deploy.target: "cloudflare" is not allowed (allowed: cloudflare-pages, netlify, github-pages, vercel, custom)',
    );
  });

  it('names a bad palette key and explains the key format', () => {
    const { errors } = validateBrand(setPath(minimal(), 'palette.2x', '#fff'));
    expect(errors[0]).toMatch(/^palette\.2x: invalid key \(keys start with a letter/);
  });

  it('explains a bad hex, an array/string mix-up, a missing field and an empty palette', () => {
    expect(validateBrand(setPath(minimal(), 'palette.bg', 'blue')).errors[0]).toBe(
      'palette.bg: must be a hex color: #rgb, #rrggbb or #rrggbbaa (got "blue")',
    );
    expect(validateBrand(setPath(minimal(), 'brand.voice', 'calm, precise')).errors[0]).toBe(
      'brand.voice: must be an array (got string)',
    );
    expect(validateBrand({ brand: {}, palette: { bg: '#000' }, typography: { body: 'X' } }).errors[0]).toBe(
      'brand.studio: required property is missing',
    );
    expect(validateBrand({ ...minimal(), palette: {} }).errors[0]).toBe('palette: needs at least 1 entry');
    expect(validateBrand(setPath(minimal(), 'typography.body', '')).errors[0]).toBe('typography.body: must not be empty');
    expect(validateBrand(setPath(minimal(), 'targets.minTapPx', 0)).errors[0]).toMatch(/^targets\.minTapPx: must be >= 1 \(got 0\)$/);
    expect(validateBrand(null).errors[0]).toBe('(root): must be an object (got null)');
    expect(validateBrand(setPath(minimal(), 'motion.duration.fast', 'fast')).errors[0]).toBe(
      'motion.duration.fast: must be a duration like 200ms or 0.25s (got "fast")',
    );
    expect(validateBrand(setPath(minimal(), 'surfaces.radius.sm', '4')).errors[0]).toBe(
      'surfaces.radius.sm: must be a length like 8px, 0.5rem, 1em or 50% (got "4")',
    );
  });

  it('attaches the messages to the thrown error', () => {
    newTmp();
    let err;
    try {
      saveBrand(tmp, setPath(minimal(), 'deploy.target', 'firebase'));
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('BRAND_INVALID');
    expect(err.errors).toHaveLength(1);
    expect(err.message).toContain('allowed: cloudflare-pages');
  });
});

// ---------------------------------------------------------------------------
// typography injection (defense in depth for og-card and tokens.css sinks)
// ---------------------------------------------------------------------------
describe('typography hardening', () => {
  const payloads = [
    'Inter}</style><img src="http://127.0.0.1:9/ssrf"><style>x{',
    'x";} body{background:url(http://evil/)} :root{--y:"',
    'Inter; color: red',
    'Font\\',
    'A\nB',
  ];

  for (const p of payloads) {
    it(`saveBrand rejects ${JSON.stringify(p).slice(0, 40)}`, () => {
      newTmp();
      expect(() => saveBrand(tmp, setPath(minimal(), 'typography.body', p))).toThrow(
        /typography\.body: must be a CSS font stack without/,
      );
      expect(existsSync(brandFilePath(tmp))).toBe(false);
    });
  }

  it('loadBrand rejects a hand-edited file carrying a </style> payload', () => {
    newTmp();
    writeRaw(tmp, JSON.stringify(setPath(minimal(), 'typography.display', '</style><script>alert(1)</script>')));
    expect(() => loadBrand(tmp)).toThrow(/typography\.display: must be a CSS font stack/);
  });

  it('rejects a font stack longer than 300 characters', () => {
    const { errors } = validateBrand(setPath(minimal(), 'typography.mono', 'a'.repeat(301)));
    expect(errors[0]).toBe('typography.mono: must be at most 300 characters (got 301)');
  });

  it('keeps real font stacks valid', () => {
    for (const stack of [
      "Silkscreen, 'Courier New', monospace",
      '"Space Grotesk", system-ui, -apple-system, sans-serif',
      'Source Sans 3',
    ]) {
      expect(validateBrand(setPath(minimal(), 'typography.body', stack)).valid).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------
describe('get/set', () => {
  it('getPath returns nested values (brand.studio, palette.bg)', () => {
    const cfg = minimal();
    expect(getPath(cfg, 'brand.studio')).toBe('goneIdle');
    expect(getPath(cfg, 'palette.bg')).toBe('#110f1b');
    expect(getPath({ brand: { voice: ['a', 'b'] } }, 'brand.voice.1')).toBe('b');
  });

  it('getPath returns undefined for missing paths', () => {
    const cfg = { brand: { studio: 'goneIdle' } };
    expect(getPath(cfg, 'logos.mark')).toBeUndefined();
    expect(getPath(cfg, 'deploy.target')).toBeUndefined();
  });

  it('getPath ignores inherited members', () => {
    const cfg = { ...minimal(), social: { twitter: '@x' } };
    expect(getPath(cfg, 'constructor')).toBeUndefined();
    expect(getPath(cfg, '__proto__')).toBeUndefined();
    expect(getPath(cfg, 'brand.toString')).toBeUndefined();
    expect(getPath(cfg, 'palette.hasOwnProperty')).toBeUndefined();
    expect(getPath(cfg, 'social.toString')).toBeUndefined();
    expect(getPath(cfg, 'brand.studio.length')).toBeUndefined();
  });

  it('setPath sets value without mutating input', () => {
    const original = minimal();
    const updated = setPath(original, 'brand.product', 'TideWane');
    expect(updated.brand.product).toBe('TideWane');
    expect(original.brand.product).toBeUndefined(); // original unchanged
  });

  it('setPath creates intermediate objects (social.twitter on config lacking social)', () => {
    const cfg = minimal();
    const updated = setPath(cfg, 'social.twitter', '@EthanY33');
    expect(updated.social).toBeDefined();
    expect(updated.social.twitter).toBe('@EthanY33');
    expect(cfg.social).toBeUndefined(); // original unchanged
  });

  for (const path of ['__proto__.polluted', 'palette.__proto__.isAdmin', 'x.__proto__.deep', 'constructor.prototype.x', '__proto__']) {
    it(`setPath rejects ${path} and leaves Object.prototype clean`, () => {
      expect(() => setPath(minimal(), path, 'yes')).toThrow(/is not allowed as a path segment/);
      expect({}.polluted).toBeUndefined();
      expect({}.isAdmin).toBeUndefined();
      expect({}.deep).toBeUndefined();
      expect({}.x).toBeUndefined();
    });
  }

  it('a rejected pollution attempt does not break later loads and saves', () => {
    newTmp();
    saveBrand(tmp, minimal());
    expect(() => setPath(minimal(), '__proto__.polluted', 'yes')).toThrow();
    expect(loadBrand(tmp)).toEqual(minimal());
    expect(() => saveBrand(tmp, minimal())).not.toThrow();
  });

  it('setPath rejects empty paths and empty segments', () => {
    expect(() => setPath(minimal(), '', 1)).toThrow(/non-empty dotted string/);
    expect(() => setPath(minimal(), 'brand..studio', 1)).toThrow(/empty segment/);
    expect(() => setPath(minimal(), 'brand.', 1)).toThrow(/empty segment/);
  });

  it('setPath rejects a non-index key inside an array instead of silently dropping it', () => {
    const cfg = setPath(minimal(), 'brand.voice', ['a']);
    expect(() => setPath(cfg, 'brand.voice.tone', 'calm')).toThrow(/brand\.voice is an array, so "tone" must be a numeric index/);
    expect(() => setPath(cfg, 'brand.voice.tone.x', 'calm')).toThrow(/numeric index/);
    expect(() => setPath(cfg, 'brand.voice.01', 'calm')).toThrow(/numeric index/);
    expect(() => setPath(cfg, 'brand.voice.5', 'calm')).toThrow(/would leave a gap in brand\.voice \(length 1\)/);
    expect(setPath(cfg, 'brand.voice.1', 'calm').brand.voice).toEqual(['a', 'calm']);
    expect(setPath(cfg, 'brand.voice.0', 'z').brand.voice).toEqual(['z']);
  });

  it('setPath replaces a primitive on the way with an object', () => {
    expect(setPath({ a: 'str' }, 'a.b', 1)).toEqual({ a: { b: 1 } });
  });
});

// ---------------------------------------------------------------------------
// init / audit
// ---------------------------------------------------------------------------
describe('init/audit', () => {
  it('initBrand creates a minimal valid file', () => {
    newTmp();
    const cfg = initBrand(tmp, {
      studio: 'goneIdle',
      bodyFont: 'Silkscreen, monospace',
      primaryColor: '#110f1b',
    });
    expect(cfg).toEqual({
      brand: { studio: 'goneIdle' },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen, monospace' },
    });

    // File should be loadable
    const loaded = loadBrand(tmp);
    expect(loaded).toEqual(cfg);
  });

  it('initBrand saves all eight /brand-init values to disk', () => {
    newTmp();
    initBrand(tmp, {
      studio: 'goneIdle',
      product: 'TideWane',
      voice: 'atmospheric, mysterious , deep-sea',
      primaryColor: '#110f1b',
      accent: '#67e8f9',
      bodyFont: "Silkscreen, 'Courier New', monospace",
      displayFont: 'Space Grotesk, sans-serif',
      monoFont: 'JetBrains Mono',
      deployTarget: 'cloudflare-pages',
    });
    const loaded = loadBrand(tmp);
    expect(loaded).toEqual({
      brand: { studio: 'goneIdle', product: 'TideWane', voice: ['atmospheric', 'mysterious', 'deep-sea'] },
      palette: { bg: '#110f1b', accent: '#67e8f9' },
      typography: {
        body: "Silkscreen, 'Courier New', monospace",
        display: 'Space Grotesk, sans-serif',
        mono: 'JetBrains Mono',
      },
      deploy: { target: 'cloudflare-pages' },
    });
    expect(auditBrand(loaded).missing).toEqual(['logos.mark', 'logos.wordmark', 'social']);
  });

  it('initBrand accepts voice as an array and skips blank optional values', () => {
    newTmp();
    const cfg = initBrand(tmp, {
      studio: ' S ', bodyFont: 'Inter', primaryColor: '#000', voice: [' calm ', ''], displayFont: '  ', product: '',
    });
    expect(cfg).toEqual({ brand: { studio: 'S', voice: ['calm'] }, palette: { bg: '#000' }, typography: { body: 'Inter' } });
  });

  it('initBrand validates everything before writing (no half-initialized file)', () => {
    newTmp();
    expect(() => initBrand(tmp, { studio: 'S', bodyFont: 'Inter', primaryColor: '#000', accent: 'teal' })).toThrow(
      /palette\.accent: must be a hex color/,
    );
    expect(existsSync(brandFilePath(tmp))).toBe(false);
    expect(() => initBrand(tmp, { bodyFont: 'Inter', primaryColor: '#000' })).toThrow(/brand\.studio: required property is missing/);
  });

  it('initBrand withSchema writes the public schema URL, which matches the schema $id', () => {
    newTmp();
    const cfg = initBrand(tmp, { studio: 'S', bodyFont: 'Inter', primaryColor: '#000', withSchema: true });
    expect(Object.keys(cfg)[0]).toBe('$schema');
    expect(cfg.$schema).toBe(BRAND_SCHEMA_URL);
    const schema = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'schemas', 'brand.schema.json'), 'utf8'));
    expect(BRAND_SCHEMA_URL).toBe(schema.$id);
    expect(loadBrand(tmp)).toEqual(cfg);
  });

  it('initBrand overwrite:false refuses to replace an existing file', () => {
    newTmp();
    initBrand(tmp, { studio: 'First', bodyFont: 'Inter', primaryColor: '#000' });
    let err;
    try {
      initBrand(tmp, { studio: 'Second', bodyFont: 'Inter', primaryColor: '#000', overwrite: false });
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('BRAND_EXISTS');
    expect(loadBrand(tmp).brand.studio).toBe('First');
    // Default stays backward compatible: overwrite.
    initBrand(tmp, { studio: 'Third', bodyFont: 'Inter', primaryColor: '#000' });
    expect(loadBrand(tmp).brand.studio).toBe('Third');
  });

  it('auditBrand flags missing recommended fields (logos.mark, typography.display)', () => {
    const cfg = minimal();
    const { missing } = auditBrand(cfg);
    expect(missing).toContain('logos.mark');
    expect(missing).toContain('typography.display');
    expect(missing).toContain('brand.product');
    expect(missing).toContain('brand.voice');
    expect(missing).toContain('social');
    expect(missing).toContain('deploy.target');
  });

  it('auditBrand treats empty strings, arrays and objects as missing', () => {
    const cfg = { ...minimal(), brand: { studio: 'S', product: ' ', voice: [] }, social: {} };
    const { missing } = auditBrand(cfg);
    expect(missing).toEqual(expect.arrayContaining(['brand.product', 'brand.voice', 'social']));
  });

  it('auditBrand returns empty missing for a fully populated config', () => {
    const cfg = {
      brand: { studio: 'goneIdle', product: 'TideWane', voice: ['atmospheric', 'mysterious'] },
      palette: { bg: '#110f1b' },
      typography: { body: 'Silkscreen, monospace', display: 'Space Grotesk, sans-serif' },
      logos: { mark: 'brand/mark.svg', wordmark: 'brand/wordmark.svg' },
      social: { twitter: '@EthanY33' },
      deploy: { target: 'netlify' },
    };
    const { missing } = auditBrand(cfg);
    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// install layout: nothing outside the plugin root
// ---------------------------------------------------------------------------
describe('install layout', () => {
  it('index.mjs imports and reads only files inside plugins/atelier', () => {
    const src = readFileSync(join(SKILL_DIR, 'index.mjs'), 'utf8');
    const relImports = [...src.matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => resolve(SKILL_DIR, m[1]));
    const joins = [...src.matchAll(/join\(HERE, ([^)]+)\)/g)].map((m) =>
      resolve(SKILL_DIR, ...m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))),
    );
    expect(relImports.length).toBeGreaterThan(0);
    expect(joins.length).toBeGreaterThan(0);
    for (const p of [...relImports, ...joins]) {
      expect(p.startsWith(PLUGIN_ROOT)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
  });

  it('SKILL.md uses plugin variables, not repo-relative paths, and plain ASCII', () => {
    const md = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    expect(md).not.toMatch(/plugins\/atelier|(^|[\s'"(])scripts\//m);
    expect(md).toContain('${CLAUDE_PLUGIN_ROOT}/bin/atelier');
    expect(md).toContain('${CLAUDE_SKILL_DIR}');
    expect(md).not.toMatch(/Promise</);
    expect([...md].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    const desc = md.match(/^description: (.+)$/m)[1];
    expect(desc.length).toBeLessThanOrEqual(400);
  });
});

import { describe, it, expect } from 'vitest';
import {
  cssColor,
  cssIdent,
  cssString,
  exportNames,
  fontEntries,
  hexToRgba,
  isCssGeneric,
  isSafeIdentifier,
  jsString,
  parseFontFamilies,
  propKey,
} from '../../plugins/atelier/skills/design-token-sync/emitters/shared.mjs';

describe('parseFontFamilies', () => {
  it('splits on top-level commas only', () => {
    expect(parseFontFamilies(`"A, B", 'C', D E, serif`)).toEqual([
      { name: 'A, B', generic: false },
      { name: 'C', generic: false },
      { name: 'D E', generic: false },
      { name: 'serif', generic: true },
    ]);
  });

  it('recognizes generics case-insensitively, only when unquoted', () => {
    expect(parseFontFamilies('Monospace, "monospace", -apple-system, BlinkMacSystemFont, ui-rounded')).toEqual([
      { name: 'Monospace', generic: true },
      { name: 'monospace', generic: false },
      { name: '-apple-system', generic: true },
      { name: 'BlinkMacSystemFont', generic: true },
      { name: 'ui-rounded', generic: true },
    ]);
  });

  it('collapses whitespace in unquoted names and keeps quoted names verbatim', () => {
    expect(parseFontFamilies('  Courier \t  New ,"  Spaced  " ')).toEqual([
      { name: 'Courier New', generic: false },
      { name: '  Spaced  ', generic: false },
    ]);
  });

  it('decodes CSS escapes inside quoted names', () => {
    expect(parseFontFamilies(String.raw`"A\"B", 'C\'D', "\41 x", "line\
break", "\0"`).map((f) => f.name)).toEqual(['A"B', "C'D", 'Ax', 'linebreak', '\uFFFD']);
  });

  it('closes a quote left open at the end, and treats stray quotes literally', () => {
    expect(parseFontFamilies('"Geist').map((f) => f.name)).toEqual(['Geist']);
    expect(parseFontFamilies('Foo "Bar"').map((f) => f.name)).toEqual(['Foo "Bar"']);
  });

  it('isCssGeneric is true for bare CSS generics, not vendor keywords or quoted names', () => {
    const flags = parseFontFamilies('serif, Monospace, system-ui, ui-rounded, -apple-system, BlinkMacSystemFont, "sans-serif", Inter')
      .map((f) => [f.name, isCssGeneric(f)]);
    expect(flags).toEqual([
      ['serif', true],
      ['Monospace', true],
      ['system-ui', true],
      ['ui-rounded', true],
      ['-apple-system', false],
      ['BlinkMacSystemFont', false],
      ['sans-serif', false],
      ['Inter', false],
    ]);
  });

  it('drops empty entries and empty quoted names', () => {
    expect(parseFontFamilies(', "", X,,')).toEqual([{ name: 'X', generic: false }]);
    expect(parseFontFamilies(undefined)).toEqual([]);
  });
});

describe('fontEntries', () => {
  it('orders display, body, mono first, then other keys', () => {
    const entries = fontEntries({ typography: { heading: 'H', mono: 'M', body: 'B' } });
    expect(entries.map((e) => e.key)).toEqual(['body', 'mono', 'heading']);
    expect(entries[0].css).toBe('"B"');
  });
});

describe('string and identifier serializers', () => {
  it('cssString escapes quotes, backslashes, controls and <', () => {
    expect(cssString('a"b\\c\n<\u0000')).toBe('"a\\"b\\\\c\\a \\3c \uFFFD"');
  });

  it('cssIdent escapes non-identifier characters', () => {
    expect(cssIdent('ok-_9\u00E9')).toBe('ok-_9\u00E9');
    expect(cssIdent('a:b\u0000')).toBe('a\\3a b\uFFFD');
  });

  it('jsString round-trips through eval for hostile input', () => {
    for (const s of [`'`, `"`, `\\`, `\\"`, `\\'`, `</script>`, '\u2028\n\r\t', '\ud800', 'plain']) {
      // eslint-disable-next-line no-eval
      expect((0, eval)(jsString(s))).toBe(s);
    }
    expect(jsString('</script>')).not.toContain('<');
  });

  it('propKey quotes non-identifiers and guards __proto__', () => {
    expect(propKey('bg')).toBe('bg');
    expect(propKey('default')).toBe('default');
    expect(propKey('brand-500')).toBe("'brand-500'");
    expect(propKey('__proto__')).toBe("['__proto__']");
    expect(propKey('__proto__', { ts: true })).toBe("'__proto__'");
  });

  it('isSafeIdentifier rejects reserved words and strict-mode bindings', () => {
    for (const bad of ['default', 'class', 'let', 'yield', 'await', 'eval', 'arguments', 'enum', 'brand-500', '9a', '']) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
    expect(isSafeIdentifier('bg')).toBe(true);
    expect(isSafeIdentifier('$x_1')).toBe(true);
  });

  it('exportNames prefers exact names, then derives unique camelCase names', () => {
    const names = exportNames(['brand-primary', 'brandPrimary', 'x--y', '---', 'delete', 'colors'], ['colors']);
    expect([...names.entries()]).toEqual([
      ['brand-primary', 'brandPrimary_'],
      ['brandPrimary', 'brandPrimary'],
      ['x--y', 'xY'],
      ['---', '_'],
      ['delete', 'delete_'],
      ['colors', 'colors_'],
    ]);
  });
});

describe('cssColor and hexToRgba', () => {
  it('cssColor trims and accepts balanced color functions', () => {
    expect(cssColor(' #fff ', 'p')).toBe('#fff');
    expect(cssColor('color-mix(in srgb, red 50%, var(--x))', 'p')).toBe('color-mix(in srgb, red 50%, var(--x))');
    expect(() => cssColor('a)b(', 'p')).toThrow(TypeError);
    expect(() => cssColor('#fff;', 'p')).toThrow(/p must be a CSS color/);
  });

  it('hexToRgba returns null for non-hex input', () => {
    expect(hexToRgba('red')).toBeNull();
    expect(hexToRgba('#12345')).toBeNull();
    expect(hexToRgba('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeText, readJsonFile, readTextFile } from '../../plugins/atelier/lib/io.mjs';
import { makeTmp } from './helpers.mjs';

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('io')); });
afterEach(() => cleanup());

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const utf16be = (s) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return b;
};
// Non-ASCII on purpose: a wrong decoder garbles it.
const SAMPLE = '{"studio": "Caf\u00e9 \u00dcber \u65e5\u672c", "n": 1}';

describe('decodeText', () => {
  it('reads plain UTF-8', () => {
    expect(decodeText(Buffer.from(SAMPLE, 'utf8'))).toBe(SAMPLE);
  });

  it('strips a UTF-8 BOM', () => {
    expect(decodeText(Buffer.concat([UTF8_BOM, Buffer.from(SAMPLE, 'utf8')]))).toBe(SAMPLE);
  });

  it('decodes UTF-16LE with a BOM', () => {
    expect(decodeText(Buffer.concat([UTF16LE_BOM, Buffer.from(SAMPLE, 'utf16le')]))).toBe(SAMPLE);
  });

  it('decodes UTF-16BE with a BOM', () => {
    expect(decodeText(Buffer.concat([UTF16BE_BOM, utf16be(SAMPLE)]))).toBe(SAMPLE);
  });

  it('does not mutate the input buffer when decoding UTF-16BE', () => {
    const input = Buffer.concat([UTF16BE_BOM, utf16be('ab')]);
    const copy = Buffer.from(input);
    decodeText(input);
    expect(input.equals(copy)).toBe(true);
  });

  // Regression: an odd byte count made Buffer#swap16 throw a RangeError.
  it('tolerates a truncated UTF-16BE file with an odd byte count', () => {
    const odd = Buffer.concat([UTF16BE_BOM, utf16be('ab'), Buffer.from([0x00])]);
    expect(decodeText(odd)).toBe('ab');
  });

  it('handles empty input and a lone BOM', () => {
    expect(decodeText(Buffer.alloc(0))).toBe('');
    expect(decodeText(UTF8_BOM)).toBe('');
    expect(decodeText(UTF16LE_BOM)).toBe('');
    expect(decodeText(UTF16BE_BOM)).toBe('');
  });

  it('reads short buffers that only look like the start of a BOM as UTF-8', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb]))).toBe('\ufffd');
    expect(decodeText(Buffer.from('x'))).toBe('x');
  });

  // Regression: Uint8Array#toString ignores the encoding argument and
  // returned comma-separated byte values.
  it('accepts a Uint8Array, a view into a larger buffer, and an ArrayBuffer', () => {
    const bytes = Buffer.concat([UTF8_BOM, Buffer.from('hello', 'utf8')]);
    expect(decodeText(new Uint8Array(bytes))).toBe('hello');
    const big = Buffer.concat([Buffer.from('xx'), bytes, Buffer.from('yy')]);
    expect(decodeText(new Uint8Array(big.buffer, big.byteOffset + 2, bytes.length))).toBe('hello');
    expect(decodeText(new Uint8Array(bytes).buffer)).toBe('hello');
  });

  it('returns a string as is, minus a leading BOM character', () => {
    expect(decodeText('plain')).toBe('plain');
    expect(decodeText('\ufeff{"a":1}')).toBe('{"a":1}');
  });

  it('rejects other input types with a TypeError', () => {
    expect(() => decodeText(42)).toThrow(TypeError);
    expect(() => decodeText(null)).toThrow(TypeError);
  });
});

describe('readTextFile', () => {
  it('reads a file with a UTF-8 BOM', () => {
    const p = join(tmp, 'a.txt');
    writeFileSync(p, Buffer.concat([UTF8_BOM, Buffer.from('line 1\nline 2', 'utf8')]));
    expect(readTextFile(p)).toBe('line 1\nline 2');
  });

  it('names the file when it is missing', () => {
    const p = join(tmp, 'missing.txt');
    let err;
    try {
      readTextFile(p);
    } catch (e) {
      err = e;
    }
    expect(err.message).toBe(`Cannot read ${p}: file not found`);
    expect(err.cause.code).toBe('ENOENT');
  });

  it('names the path when it is a directory', () => {
    const p = join(tmp, 'dir');
    mkdirSync(p);
    expect(() => readTextFile(p)).toThrow(`Cannot read ${p}: it is a directory`);
  });
});

describe('readJsonFile', () => {
  it('parses UTF-8 with and without a BOM', () => {
    const plain = join(tmp, 'plain.json');
    const bom = join(tmp, 'bom.json');
    writeFileSync(plain, SAMPLE, 'utf8');
    writeFileSync(bom, Buffer.concat([UTF8_BOM, Buffer.from(SAMPLE, 'utf8')]));
    const expected = JSON.parse(SAMPLE);
    expect(readJsonFile(plain)).toEqual(expected);
    expect(readJsonFile(bom)).toEqual(expected);
  });

  it('parses UTF-16LE and UTF-16BE files with a BOM (PowerShell 5.1 "Unicode" output)', () => {
    const le = join(tmp, 'le.json');
    const be = join(tmp, 'be.json');
    writeFileSync(le, Buffer.concat([UTF16LE_BOM, Buffer.from(SAMPLE, 'utf16le')]));
    writeFileSync(be, Buffer.concat([UTF16BE_BOM, utf16be(SAMPLE)]));
    expect(readJsonFile(le)).toEqual(JSON.parse(SAMPLE));
    expect(readJsonFile(be)).toEqual(JSON.parse(SAMPLE));
  });

  it('names the file when the JSON is invalid', () => {
    const p = join(tmp, 'broken.json');
    writeFileSync(p, '{"a": 1,}');
    let err;
    try {
      readJsonFile(p);
    } catch (e) {
      err = e;
    }
    expect(err.message.startsWith(`${p} is not valid JSON: `)).toBe(true);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('names the file when it is empty', () => {
    const p = join(tmp, 'empty.json');
    writeFileSync(p, '');
    expect(() => readJsonFile(p)).toThrow(`${p} is not valid JSON`);
  });

  it('names the file when it is missing', () => {
    const p = join(tmp, 'nope.json');
    expect(() => readJsonFile(p)).toThrow(`Cannot read ${p}: file not found`);
  });
});

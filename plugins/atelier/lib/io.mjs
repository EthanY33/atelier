/**
 * File reading that survives Windows editors: strips a UTF-8 byte order mark
 * (PowerShell 5.1 and Notepad write one) and decodes UTF-16 files that carry a
 * BOM, and names the file in every error.
 */
import { readFileSync } from 'node:fs';

/**
 * Decode a buffer as text, honoring UTF-8 / UTF-16LE / UTF-16BE byte order marks.
 * @param {Buffer} buf
 * @returns {string}
 */
export function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

/**
 * Read a text file, BOM-tolerant.
 * @param {string} path
 * @returns {string}
 */
export function readTextFile(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err.code === 'ENOENT' ? 'file not found' : err.message}`, { cause: err });
  }
  return decodeText(buf);
}

/**
 * Read and parse a JSON file, BOM-tolerant, naming the file on failure.
 * @param {string} path
 * @returns {any}
 */
export function readJsonFile(path) {
  const text = readTextFile(path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`, { cause: err });
  }
}

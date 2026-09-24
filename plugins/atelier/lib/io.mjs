/**
 * File reading that survives Windows editors: strips a UTF-8 byte order mark
 * (PowerShell 5.1 and Notepad write one) and decodes UTF-16 files that carry a
 * BOM, and names the file in every error. Also resolves file paths written in
 * brand.json without letting repository content reach outside the project.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('decodeText expects a Buffer, Uint8Array, ArrayBuffer or string');
}

/**
 * Decode bytes as text, honoring UTF-8 / UTF-16LE / UTF-16BE byte order marks.
 * Without a BOM the bytes are read as UTF-8. A string is returned as is,
 * minus a leading BOM character.
 * @param {Buffer|Uint8Array|ArrayBuffer|string} buf
 * @returns {string}
 */
export function decodeText(buf) {
  if (typeof buf === 'string') return buf.charCodeAt(0) === 0xfeff ? buf.slice(1) : buf;
  buf = toBuffer(buf);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // A truncated file can leave an odd byte; drop it, as the LE branch does.
    const body = buf.subarray(2, buf.length - (buf.length % 2));
    const swapped = Buffer.from(body);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8');
}

const READ_ERRORS = {
  ENOENT: 'file not found',
  EISDIR: 'it is a directory',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
};

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
    throw new Error(`Cannot read ${path}: ${READ_ERRORS[err.code] ?? err.message}`, { cause: err });
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

/**
 * True for \\host\share, //host/share and the \\?\ and \\.\ device namespaces.
 * On Windows, opening one of these (even a stat) connects over SMB and sends
 * the user's credentials to that host.
 * @param {string} p
 * @returns {boolean}
 */
export function isNetworkPath(p) {
  return /^[\\/]{2}/.test(p);
}

/**
 * Resolve a file path written in brand.json inside the project root. brand.json
 * is repository content, so an absolute, drive, network or ../ path is refused
 * before anything is opened; a file elsewhere can still be passed explicitly.
 * @param {string} value - the path as written in brand.json
 * @param {string} root - the project root
 * @param {string} field - the brand.json field, for the error (e.g. 'logos.mark')
 * @returns {string} the absolute path
 */
export function resolveBrandPath(value, root, field) {
  const base = resolve(root);
  const refuse = () =>
    new Error(
      `brand.json ${field} ${JSON.stringify(value)} must be a relative path to a file inside the project root ${base}. Pass the file explicitly to use one elsewhere.`,
    );
  // /^[a-z]:/ also catches the drive-relative "C:mark.svg", which isAbsolute misses.
  if (isAbsolute(value) || /^[\\/]/.test(value) || /^[a-z]:/i.test(value)) throw refuse();
  const target = resolve(base, value);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw refuse();
  return target;
}

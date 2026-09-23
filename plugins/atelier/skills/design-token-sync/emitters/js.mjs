/**
 * Runtime token module emitter (tokens.js) for design-token-sync.
 * Pure function, no I/O. tokens.d.ts (emitters/dts.mjs) describes this module.
 */
import { GENERATED_BY, exportNames, fontEntries, jsString, paletteEntries, propKey } from './shared.mjs';

/**
 * Names a palette export cannot take, so a key with one of them gets a
 * trailing `_`: the object exports, and `Object`, the global the module body
 * calls (`Object.freeze`). An `export const Object` would shadow that global
 * while still uninitialized, and importing tokens.js would throw.
 */
export const OBJECT_EXPORTS = ['colors', 'fonts', 'Object'];

/**
 * The values tokens.js exports and tokens.d.ts declares, computed once so the
 * two files always agree.
 * @param {object} cfg - Brand config.
 * @returns {{
 *   colors: [string, string][],
 *   fonts: [string, string][],
 *   named: { key: string, id: string, value: string }[],
 * }}
 */
export function tokenModule(cfg) {
  const colors = paletteEntries(cfg);
  const fonts = fontEntries(cfg).map((f) => [f.key, f.css]);
  const ids = exportNames(colors.map(([key]) => key), OBJECT_EXPORTS);
  const named = colors.map(([key, value]) => ({ key, id: ids.get(key), value }));
  return { colors, fonts, named };
}

/**
 * Emit tokens.js: an ES module with
 * - `colors`: frozen object of every palette entry, keyed exactly as in brand.json
 * - `fonts`: frozen object of CSS font-family lists, keyed by typography slot
 * - one `export const` per palette entry, named by exportNames()
 *   (`bg`, `brand-500` -> `brand500`, `default` -> `default_`, `Object` -> `Object_`).
 *
 * @param {object} cfg - Brand config (palette, typography).
 * @returns {string} JavaScript file content.
 */
export function emitJs(cfg) {
  const { colors, fonts, named } = tokenModule(cfg);
  const object = (entries) => (entries.length === 0
    ? ['{}']
    : ['{', ...entries.map(([k, v]) => `  ${propKey(k)}: ${jsString(v)},`), '}']);
  const frozen = (name, entries) => {
    const body = object(entries);
    body[0] = `export const ${name} = Object.freeze(${body[0]}`;
    body[body.length - 1] += ');';
    return body;
  };

  return [
    `// ${GENERATED_BY}`,
    ...frozen('colors', colors),
    ...frozen('fonts', fonts),
    ...named.map(({ id, value }) => `export const ${id} = ${jsString(value)};`),
    '',
  ].join('\n');
}

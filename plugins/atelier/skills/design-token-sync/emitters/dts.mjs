/**
 * TypeScript declarations emitter (tokens.d.ts) for design-token-sync.
 * Pure function, no I/O.
 */
import { GENERATED_BY, jsString, propKey } from './shared.mjs';
import { tokenModule } from './js.mjs';

/**
 * Emit tokens.d.ts: the types of tokens.js (emitters/js.mjs), which
 * syncTokens writes next to it, so every declared value exists at runtime.
 *
 * - `ColorName` / `FontName`: unions of the palette and typography keys
 * - `colors` / `fonts`: readonly objects with literal value types
 * - `export declare const <id>` per palette entry, with the same names as
 *   tokens.js (keys that are not identifiers or are reserved words are
 *   renamed, and a JSDoc comment names the original key).
 *
 * @param {object} cfg - Brand config (palette, typography).
 * @returns {string} TypeScript declarations file content.
 */
export function emitDts(cfg) {
  const { colors, fonts, named } = tokenModule(cfg);
  const union = (keys) => (keys.length === 0 ? 'never' : keys.map(jsString).join(' | '));
  const objectType = (entries) => (entries.length === 0
    ? ['{};']
    : ['{', ...entries.map(([k, v]) => `  readonly ${propKey(k, { ts: true })}: ${jsString(v)};`), '};']);
  const declare = (name, entries) => {
    const body = objectType(entries);
    body[0] = `export declare const ${name}: ${body[0]}`;
    return body;
  };

  const lines = [
    `// ${GENERATED_BY}`,
    '// Types for tokens.js in the same directory.',
    `export type ColorName = ${union(colors.map(([k]) => k))};`,
    `export type FontName = ${union(fonts.map(([k]) => k))};`,
    ...declare('colors', colors),
    ...declare('fonts', fonts),
  ];
  for (const { key, id, value } of named) {
    if (id !== key) lines.push(`/** colors[${jsString(key).replace(/\*\//g, '*\\/')}] */`);
    lines.push(`export declare const ${id}: ${jsString(value)};`);
  }
  lines.push('');
  return lines.join('\n');
}

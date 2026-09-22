/**
 * Tailwind config emitter for design-token-sync.
 * Pure function, no I/O.
 */
import { GENERATED_BY, SLOT_GENERIC, fontEntries, formatFamily, jsString, paletteEntries, propKey } from './shared.mjs';

/**
 * Emit an ESM Tailwind config (`export default { theme: { extend: ... } }`)
 * with `colors` from the palette and `fontFamily` from typography.
 *
 * Keys that are not JavaScript identifiers (`brand-500`) are quoted. Each
 * fontFamily entry is one CSS family, already quoted for CSS when it is a
 * name (`'"Press Start 2P"'`), because Tailwind joins the array with ", "
 * without quoting. A generic family is appended when the stack has none
 * (sans-serif, or monospace for the mono slot). All strings go through
 * jsString (JSON.stringify based), so no value can break out of its literal.
 *
 * @param {object} cfg - Brand config (palette, typography).
 * @returns {string} JavaScript file content.
 */
export function emitTailwind(cfg) {
  const colorLines = paletteEntries(cfg).map(([key, value]) => `        ${propKey(key)}: ${jsString(value)},`);

  const fontLines = fontEntries(cfg).map(({ key, families }) => {
    const list = families.map(formatFamily);
    if (!families.some((f) => f.generic)) list.push(SLOT_GENERIC[key] ?? 'sans-serif');
    return `        ${propKey(key)}: [${list.map(jsString).join(', ')}],`;
  });

  return [
    `// ${GENERATED_BY}`,
    'export default {',
    '  theme: {',
    '    extend: {',
    '      colors: {',
    ...colorLines,
    '      },',
    '      fontFamily: {',
    ...fontLines,
    '      },',
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

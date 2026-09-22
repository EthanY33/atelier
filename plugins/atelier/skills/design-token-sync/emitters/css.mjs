/**
 * CSS custom-properties emitter for design-token-sync.
 * Pure function, no I/O.
 */
import { GENERATED_BY, cssIdent, fontEntries, paletteEntries } from './shared.mjs';

/**
 * Emit a stylesheet with one `:root` rule of custom properties:
 * `--color-<key>` per palette entry and `--font-<key>` per typography entry.
 *
 * Font values are emitted as CSS font-family lists: family names are quoted
 * and escaped, generic families (serif, monospace, system-ui, ...) stay bare,
 * so `Silkscreen, 'Courier New', monospace` becomes
 * `"Silkscreen", "Courier New", monospace`. Palette values must be CSS colors;
 * anything that could end the declaration throws.
 *
 * @param {object} cfg - Brand config (palette, typography).
 * @returns {string} CSS file content.
 */
export function emitCss(cfg) {
  const lines = [`/* ${GENERATED_BY} */`, ':root {'];

  for (const [key, value] of paletteEntries(cfg)) {
    lines.push(`  --color-${cssIdent(key)}: ${value};`);
  }
  for (const font of fontEntries(cfg)) {
    lines.push(`  --font-${cssIdent(font.key)}: ${font.css};`);
  }

  lines.push('}', '');
  return lines.join('\n');
}

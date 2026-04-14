/**
 * Figma variables bridge emitter for design-token-sync.
 * Pure function — no I/O, no side effects.
 */

/**
 * Emits a Figma variables JSON string from a brand config.
 * @param {object} cfg - Brand config (palette, typography, …)
 * @returns {string} JSON file content (pretty-printed, trailing newline)
 */
export function emitFigmaVariables(cfg) {
  const palette = cfg.palette ?? {};
  const typography = cfg.typography ?? {};

  // Palette collection
  const paletteVariables = Object.entries(palette).map(([name, value]) => ({
    name,
    type: 'COLOR',
    valuesByMode: { default: value },
  }));

  // Typography collection — filter out falsy values
  const typographyVariables = Object.entries(typography)
    .filter(([, value]) => value)
    .map(([name, value]) => ({
      name,
      type: 'STRING',
      valuesByMode: { default: value },
    }));

  const collections = [
    {
      name: 'palette',
      modes: [{ name: 'default' }],
      variables: paletteVariables,
    },
    {
      name: 'typography',
      modes: [{ name: 'default' }],
      variables: typographyVariables,
    },
  ];

  return JSON.stringify({ collections }, null, 2) + '\n';
}

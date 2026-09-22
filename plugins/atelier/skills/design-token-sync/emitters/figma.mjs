/**
 * Figma Variables emitter for design-token-sync.
 * Pure function, no I/O. Nothing is sent to Figma.
 */
import { fontEntries, hexToRgba } from './shared.mjs';

/** Characters Figma rejects in variable names. */
const FIGMA_NAME_FORBIDDEN = /[.{}]/;

function checkName(name, where) {
  if (!name || FIGMA_NAME_FORBIDDEN.test(name)) {
    throw new TypeError(`${where}: Figma variable names cannot be empty or contain . { or }, got ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Emit a request body for Figma's `POST /v1/files/:file_key/variables`
 * (the Variables REST API). It creates:
 * - a `palette` collection with one COLOR variable per palette entry, value
 *   `{ r, g, b, a }` in the range 0 to 1 (hex #rgb, #rgba, #rrggbb, #rrggbbaa);
 * - a `typography` collection with one STRING variable per font slot, value
 *   the first family of the stack (Figma binds a single family name).
 * Each collection's initial mode is renamed to `default`. Objects reference
 * each other through temporary ids (`c_palette`, `m_palette`,
 * `v_palette_<key>`, ...). A collection with no variables is left out.
 *
 * Every change is a CREATE, so posting twice to the same file creates
 * duplicate collections.
 *
 * @param {object} cfg - Brand config (palette, typography).
 * @returns {string} JSON file content (pretty-printed, trailing newline).
 */
export function emitFigmaVariables(cfg) {
  const body = { variableCollections: [], variableModes: [], variables: [], variableModeValues: [] };

  const addCollection = (name, resolvedType, entries) => {
    if (entries.length === 0) return;
    const collectionId = `c_${name}`;
    const modeId = `m_${name}`;
    body.variableCollections.push({ action: 'CREATE', id: collectionId, name, initialModeId: modeId });
    body.variableModes.push({ action: 'UPDATE', id: modeId, name: 'default', variableCollectionId: collectionId });
    for (const [key, value] of entries) {
      const variableId = `v_${name}_${key}`;
      body.variables.push({
        action: 'CREATE',
        id: variableId,
        name: checkName(key, `${name}.${key}`),
        variableCollectionId: collectionId,
        resolvedType,
      });
      body.variableModeValues.push({ variableId, modeId, value });
    }
  };

  const colors = Object.entries(cfg?.palette ?? {}).map(([key, hex]) => {
    const rgba = hexToRgba(hex);
    if (!rgba) {
      throw new TypeError(`palette.${key}: Figma COLOR variables need a hex color (#rgb, #rgba, #rrggbb or #rrggbbaa), got ${JSON.stringify(hex)}`);
    }
    return [key, rgba];
  });
  addCollection('palette', 'COLOR', colors);
  addCollection('typography', 'STRING', fontEntries(cfg).map((f) => [f.key, f.families[0].name]));

  return `${JSON.stringify(body, null, 2)}\n`;
}

import { describe, it, expect } from 'vitest';
import { emitFigmaVariables } from '../../plugins/atelier/skills/design-token-sync/emitters/figma.mjs';

const fixture = {
  palette: { bg: '#110f1b', terra: '#e07a5f' },
  typography: { display: 'Silkscreen', body: "Inter, 'Helvetica Neue', sans-serif", mono: 'Geist Mono' },
};

/**
 * Check a body against the shape Figma documents for
 * POST /v1/files/:file_key/variables: four change arrays, CREATE entries with
 * their required fields, temporary ids unique across the body, and every
 * cross-reference pointing at an object created or updated in the same body.
 */
function assertRestBody(body) {
  expect(Object.keys(body).sort()).toEqual(['variableCollections', 'variableModeValues', 'variableModes', 'variables']);
  const ids = [
    ...body.variableCollections.map((c) => c.id),
    ...body.variableCollections.map((c) => c.initialModeId),
    ...body.variables.map((v) => v.id),
  ];
  expect(new Set(ids).size).toBe(ids.length);

  const collections = new Map(body.variableCollections.map((c) => [c.id, c]));
  for (const c of body.variableCollections) {
    expect(c).toEqual({ action: 'CREATE', id: expect.any(String), name: expect.any(String), initialModeId: expect.any(String) });
  }
  const modeIds = new Set(body.variableCollections.map((c) => c.initialModeId));
  for (const m of body.variableModes) {
    expect(m.action).toBe('UPDATE');
    expect(modeIds.has(m.id)).toBe(true);
    expect(collections.get(m.variableCollectionId).initialModeId).toBe(m.id);
  }
  const variables = new Map();
  for (const v of body.variables) {
    expect(v).toEqual({
      action: 'CREATE',
      id: expect.any(String),
      name: expect.stringMatching(/^[^.{}]+$/),
      variableCollectionId: expect.any(String),
      resolvedType: expect.stringMatching(/^(COLOR|STRING|FLOAT|BOOLEAN)$/),
    });
    expect(collections.has(v.variableCollectionId)).toBe(true);
    variables.set(v.id, v);
  }
  expect(body.variableModeValues).toHaveLength(body.variables.length);
  for (const mv of body.variableModeValues) {
    const v = variables.get(mv.variableId);
    expect(v).toBeDefined();
    expect(mv.modeId).toBe(collections.get(v.variableCollectionId).initialModeId);
    if (v.resolvedType === 'COLOR') {
      expect(Object.keys(mv.value).sort()).toEqual(['a', 'b', 'g', 'r']);
      for (const n of Object.values(mv.value)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    } else {
      expect(typeof mv.value).toBe('string');
    }
  }
}

describe('emitFigmaVariables', () => {
  it('returns parseable, pretty-printed JSON with a trailing newline', () => {
    const out = emitFigmaVariables(fixture);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toMatch(/^\{\n {2}"variableCollections"/);
    expect(out).toMatch(/\n$/);
  });

  it('is a valid Variables REST API POST body', () => {
    assertRestBody(JSON.parse(emitFigmaVariables(fixture)));
  });

  it('creates palette and typography collections with a mode named default', () => {
    const body = JSON.parse(emitFigmaVariables(fixture));
    expect(body.variableCollections.map((c) => c.name)).toEqual(['palette', 'typography']);
    expect(body.variableModes.map((m) => m.name)).toEqual(['default', 'default']);
  });

  it('converts hex colors to 0-1 RGBA floats', () => {
    const body = JSON.parse(emitFigmaVariables({ palette: { bg: '#110f1b', short: '#fff', alpha: '#11223380', tiny: '#0008' } }));
    const values = Object.fromEntries(body.variableModeValues.map((mv) => [mv.variableId, mv.value]));
    expect(values.v_palette_bg).toEqual({ r: 0.066667, g: 0.058824, b: 0.105882, a: 1 });
    expect(values.v_palette_short).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(values.v_palette_alpha.a).toBeCloseTo(128 / 255, 5);
    expect(values.v_palette_tiny).toEqual({ r: 0, g: 0, b: 0, a: 0.533333 });
  });

  it('uses the first family of a stack as the STRING value', () => {
    const body = JSON.parse(emitFigmaVariables(fixture));
    const byName = Object.fromEntries(body.variables.map((v) => [v.name, v]));
    expect(byName.body.resolvedType).toBe('STRING');
    const value = body.variableModeValues.find((mv) => mv.variableId === byName.body.id).value;
    expect(value).toBe('Inter');
  });

  it('typography variables only include keys with truthy values', () => {
    const body = JSON.parse(emitFigmaVariables({ typography: { display: 'X', body: '', mono: 'Y' } }));
    const names = body.variables.map((v) => v.name);
    expect(names).toContain('display');
    expect(names).toContain('mono');
    expect(names).not.toContain('body');
  });

  it('leaves out a collection with no variables', () => {
    const body = JSON.parse(emitFigmaVariables({ palette: { bg: '#000' }, typography: {} }));
    expect(body.variableCollections.map((c) => c.name)).toEqual(['palette']);
    assertRestBody(body);
    expect(JSON.parse(emitFigmaVariables({}))).toEqual({ variableCollections: [], variableModes: [], variables: [], variableModeValues: [] });
  });

  it('keeps schema-valid hyphenated and reserved keys as variable names', () => {
    const body = JSON.parse(emitFigmaVariables({ palette: { 'brand-500': '#e07a5f', default: '#fff' }, typography: { body: 'X' } }));
    expect(body.variables.map((v) => v.name)).toEqual(['brand-500', 'default', 'body']);
    assertRestBody(body);
  });

  it('rejects non-hex colors and names Figma forbids', () => {
    expect(() => emitFigmaVariables({ palette: { bg: 'red' } })).toThrow(/palette\.bg: Figma COLOR variables need a hex color/);
    expect(() => emitFigmaVariables({ palette: { 'a.b': '#fff' } })).toThrow(/cannot be empty or contain/);
  });
});

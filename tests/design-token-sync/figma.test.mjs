import { describe, it, expect } from 'vitest';
import { emitFigmaVariables } from '../../plugins/atelier/skills/design-token-sync/emitters/figma.mjs';

const fixture = {
  palette: { bg: '#110f1b', terra: '#e07a5f' },
  typography: { display: 'Silkscreen', body: 'Geist', mono: 'Geist Mono' },
};

describe('emitFigmaVariables', () => {
  it('returns a parseable JSON string', () => {
    const out = emitFigmaVariables(fixture);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('parsed output has collections array with palette and typography', () => {
    const out = emitFigmaVariables(fixture);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed.collections)).toBe(true);
    expect(parsed.collections).toHaveLength(2);
    const names = parsed.collections.map((c) => c.name);
    expect(names).toContain('palette');
    expect(names).toContain('typography');
  });

  it('typography variables only include keys with truthy values', () => {
    const out = emitFigmaVariables({
      typography: { display: 'X', body: '', mono: 'Y' },
    });
    const parsed = JSON.parse(out);
    const typo = parsed.collections.find((c) => c.name === 'typography');
    const varNames = typo.variables.map((v) => v.name);
    expect(varNames).toContain('display');
    expect(varNames).toContain('mono');
    expect(varNames).not.toContain('body');
  });
});

import { describe, it, expect } from 'vitest';
import { emitDts } from '../../plugins/atelier/skills/design-token-sync/emitters/dts.mjs';

const fixture = {
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b', terra: '#e07a5f' },
  typography: { display: 'Silkscreen', body: 'Geist', mono: 'Geist Mono' },
};

describe('emitDts', () => {
  it('exports ColorName union with all palette keys', () => {
    const out = emitDts(fixture);
    expect(out).toContain("export type ColorName = 'bg' | 'terra';");
  });

  it('exports FontName union with present typography keys', () => {
    const out = emitDts(fixture);
    expect(out).toContain("export type FontName = 'display' | 'body' | 'mono';");
  });

  it('emits named export const per palette entry', () => {
    const out = emitDts(fixture);
    expect(out).toContain("export const bg = '#110f1b';");
    expect(out).toContain("export const terra = '#e07a5f';");
  });

  it('handles empty palette with ColorName = never', () => {
    const out = emitDts({ palette: {}, typography: {} });
    expect(out).toContain('export type ColorName = never;');
  });
});

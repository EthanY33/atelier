import { describe, it, expect } from 'vitest';
import { emitTailwind } from '../../plugins/atelier/skills/design-token-sync/emitters/tailwind.mjs';

const fixture = {
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b', terra: '#e07a5f' },
  typography: { display: 'Silkscreen', body: 'Geist', mono: 'Geist Mono' },
};

describe('emitTailwind', () => {
  it('returns an export default string', () => {
    const out = emitTailwind(fixture);
    expect(typeof out).toBe('string');
    expect(out).toContain('export default');
  });

  it('contains palette colors', () => {
    const out = emitTailwind(fixture);
    expect(out).toContain("bg: '#110f1b'");
    expect(out).toContain("terra: '#e07a5f'");
  });

  it('contains fontFamily entries for display and body', () => {
    const out = emitTailwind(fixture);
    expect(out).toContain("display: ['Silkscreen'");
    expect(out).toContain("body: ['Geist'");
  });

  it('is valid JavaScript with correct theme structure', async () => {
    const out = emitTailwind(fixture);
    const encoded = encodeURIComponent(out);
    const mod = await import(`data:text/javascript,${encoded}`);
    expect(mod.default.theme.extend.colors.bg).toBe('#110f1b');
  });
});

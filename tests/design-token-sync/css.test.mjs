import { describe, it, expect } from 'vitest';
import { emitCss } from '../../plugins/atelier/skills/design-token-sync/emitters/css.mjs';

const fixture = {
  brand: { studio: 'goneIdle' },
  palette: { bg: '#110f1b', terra: '#e07a5f' },
  typography: { display: 'Silkscreen', body: 'Geist', mono: 'Geist Mono' },
};

describe('emitCss', () => {
  it('emits :root { with palette custom props', () => {
    const out = emitCss(fixture);
    expect(out).toContain(':root {');
    expect(out).toContain('  --color-bg: #110f1b;');
    expect(out).toContain('  --color-terra: #e07a5f;');
  });

  it('emits typography --font-* props', () => {
    const out = emitCss(fixture);
    expect(out).toContain('  --font-display: "Silkscreen";');
    expect(out).toContain('  --font-body: "Geist";');
    expect(out).toContain('  --font-mono: "Geist Mono";');
  });

  it('ends with closing brace and newline', () => {
    const out = emitCss(fixture);
    expect(out.trimEnd()).toMatch(/\}$/);
    expect(out).toMatch(/\n$/);
  });

  it('includes generated-by comment', () => {
    const out = emitCss(fixture);
    expect(out).toMatch(/\/\*.*atelier.*\*\//);
  });

  it('is deterministic: same input yields identical output', () => {
    expect(emitCss(fixture)).toBe(emitCss(fixture));
  });
});

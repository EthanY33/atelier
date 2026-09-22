import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Ajv2020, addFormats } from '../helpers/plugin-deps.mjs';
import { GOLDEN_DIR, REPO_ROOT } from './helpers.mjs';

const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins', 'atelier', 'schemas', 'ux-audit.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const goldens = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.raw.json')).sort();

describe('ux-audit.schema.json', () => {
  it('has the published $id and draft 2020-12', () => {
    expect(schema.$id).toBe('https://raw.githubusercontent.com/EthanY33/atelier/main/plugins/atelier/schemas/ux-audit.schema.json');
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(goldens).toContain('core.raw.json');
  });

  it.each(goldens)('validates __golden__/%s', (name) => {
    const data = JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8'));
    const ok = validate(data);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts a dynamic run with engine, INP and bfcache metrics', () => {
    const core = JSON.parse(readFileSync(join(GOLDEN_DIR, 'core.raw.json'), 'utf8'));
    const dynamic = {
      ...core,
      mode: { dynamic: true, areas: ['inp'], engine: { name: 'chromium', version: '153.0.7000.0', device: 'Pixel 7', cpuThrottle: 4 } },
      metrics: {
        inpP75Ms: 284,
        inp: { estimateMs: 284, p75InteractionMs: 120, maxMs: 300, count: 14, belowThreshold: false, worst: { name: 'click', target: 'button.buy', inputDelayMs: 12, processingMs: 250, presentationMs: 22 } },
        bfcache: { restored: false, reasons: ['masked'] },
        highlights: { inp: { 'long scripts': 1 } },
      },
      errors: [{ phase: 'dynamic', message: 'bfcache: timeout' }],
    };
    expect(validate(dynamic), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects malformed reports', () => {
    const core = JSON.parse(readFileSync(join(GOLDEN_DIR, 'core.raw.json'), 'utf8'));
    const bad = [
      { ...core, schemaVersion: '2.0' },
      { ...core, extra: 1 },
      { ...core, timestamp: 'yesterday' },
      { ...core, violations: [{ ...core.violations[0], ruleId: 'Bad Id' }] },
      { ...core, violations: [{ ...core.violations[0], nodes: [] }] },
      { ...core, rules: [{ id: 'atelier/runtime-ux/x', area: 'inp', severity: 'minor', status: 'weird' }] },
      { ...core, resources: [{ kind: 'font', url: 'x', status: 'parsed' }] },
      { ...core, budgets: { ...core.budgets, minTapPxSource: 'guess' } },
    ];
    for (const b of bad) expect(validate(b)).toBe(false);
  });
});

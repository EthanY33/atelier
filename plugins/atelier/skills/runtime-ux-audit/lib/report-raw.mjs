/**
 * ux-raw.json: a pure function of the audit result. No durations, hostnames
 * of the machine, absolute local paths or tool versions.
 */
import { AREAS } from './options.mjs';

const zero = () => ({ critical: 0, serious: 0, moderate: 0, minor: 0 });
const instancesOf = (v) => v.nodes.length + (v.nodesTruncated ?? 0);

/**
 * @param {{ violations: object[] }} run
 * @param {string[]} areas
 */
export function summarize(run, areas) {
  const rules = zero();
  const instances = zero();
  const byArea = {};
  for (const a of AREAS) if (areas.includes(a)) byArea[a] = { ...zero(), instances: 0 };
  for (const v of run.violations) {
    rules[v.severity]++;
    instances[v.severity] += instancesOf(v);
    if (byArea[v.area]) {
      byArea[v.area][v.severity]++;
      byArea[v.area].instances += instancesOf(v);
    }
  }
  return { pass: rules.critical + rules.serious === 0, rules, instances, byArea };
}

function cleanNode(n) {
  const out = { selector: n.selector, snippet: n.snippet, location: n.location };
  if (n.message !== undefined) out.message = n.message;
  if (n.confidence !== undefined) out.confidence = n.confidence;
  if (n.data !== undefined) out.data = n.data;
  return out;
}

function cleanEntry(v) {
  const out = {
    ruleId: v.ruleId, severity: v.severity, area: v.area, confidence: v.confidence, methods: [...v.methods],
    description: v.description, helpUrl: v.helpUrl, nodes: v.nodes.map(cleanNode),
  };
  if (v.nodesTruncated) out.nodesTruncated = v.nodesTruncated;
  return out;
}

/**
 * Build the ux-raw.json object.
 * @param {object} result - see index.mjs (url, timestamp, mode, budgets, run, resources, errors, metrics, summary)
 */
export function buildRaw(result) {
  const b = result.budgets;
  return {
    schemaVersion: '1.0',
    tool: 'atelier/runtime-ux-audit',
    url: result.url,
    timestamp: result.timestamp,
    mode: { dynamic: result.mode.dynamic, areas: [...result.mode.areas], engine: result.mode.engine ?? null },
    budgets: {
      minTapPx: b.minTapPx, minTapPxSource: b.minTapPxSource, inpBudgetMs: b.inpBudgetMs, lcpBudgetMs: b.lcpBudgetMs,
      clsBudget: b.clsBudget, zIndexMax: b.zIndexMax, longScriptMs: b.longScriptMs,
      motionDurationsMs: b.motionDurationsMs ? { ...b.motionDurationsMs } : null,
    },
    summary: result.summary,
    metrics: result.metrics,
    violations: result.run.violations.map(cleanEntry),
    incomplete: result.run.incomplete.map(cleanEntry),
    rules: result.run.rules.map((r) => {
      const out = { id: r.id, area: r.area, severity: r.severity, status: r.status };
      if (r.reason) out.reason = r.reason;
      if (r.suppressed) out.suppressed = r.suppressed;
      return out;
    }),
    resources: result.resources.map((r) => {
      const out = { kind: r.kind, url: r.displayPath, status: r.status };
      if (r.reason) out.reason = r.reason;
      return out;
    }),
    errors: result.errors.map((e) => {
      const out = { phase: e.phase };
      if (e.ruleId) out.ruleId = e.ruleId;
      out.message = e.message;
      return out;
    }),
  };
}

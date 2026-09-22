/**
 * runRules(): runs each rule in isolation and turns findings into violations,
 * incomplete entries and per-rule statuses. Deterministic: rules run in id
 * order and every sort uses code-unit comparison.
 */
import { ORDER_RUNTIME, isNodeRef } from './context.mjs';
import { AREAS } from './options.mjs';
import { createSuppressor } from './suppress.mjs';

export const SEVERITIES = Object.freeze(['critical', 'serious', 'moderate', 'minor']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const METHODS = Object.freeze(['html', 'css', 'js', 'dom', 'trace', 'headers']);
export const RULE_ID_RE = /^atelier\/runtime-ux\/[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NODES = 50;
export const MAX_MESSAGE = 200;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Problems with a rule definition ([] when valid).
 * @param {object} rule
 * @returns {string[]}
 */
export function validateRule(rule) {
  const p = [];
  if (!rule || typeof rule !== 'object') return ['rule must be an object'];
  if (typeof rule.id !== 'string' || !RULE_ID_RE.test(rule.id)) p.push(`id must match ${RULE_ID_RE}`);
  if (!AREAS.includes(rule.area)) p.push(`area must be one of ${AREAS.join(', ')}`);
  if (!SEVERITIES.includes(rule.severity)) p.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!CONFIDENCES.includes(rule.confidence)) p.push(`confidence must be one of ${CONFIDENCES.join(', ')}`);
  if (!Array.isArray(rule.methods) || rule.methods.length === 0 || rule.methods.some((m) => !METHODS.includes(m))) p.push(`methods must be a non-empty array of ${METHODS.join(', ')}`);
  if (rule.phase !== 'static' && rule.phase !== 'dynamic') p.push("phase must be 'static' or 'dynamic'");
  if (rule.requires !== undefined && (!Array.isArray(rule.requires) || rule.requires.some((r) => r !== 'http'))) p.push("requires must be ['http'] when present");
  if (typeof rule.description !== 'string' || !rule.description.trim()) p.push('description is required');
  if (typeof rule.helpUrl !== 'string' || !/^https:\/\//.test(rule.helpUrl)) p.push('helpUrl must be an https URL');
  if (typeof rule.check !== 'function') p.push('check must be a function');
  return p;
}

function round(n) {
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n : Math.round(n * 1000) / 1000;
}

function sanitizeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const out = {};
  for (const key of Object.keys(data).sort(cmp)) {
    const v = data[key];
    if (v === null || typeof v === 'string' || typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number') out[key] = round(v);
    else if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => (typeof x === 'number' ? round(x) : x));
  }
  return Object.keys(out).length ? out : undefined;
}

function toNode(finding, rule, seq) {
  const node = { selector: finding.node.selector, snippet: finding.node.snippet, location: finding.node.location };
  if (typeof finding.message === 'string' && finding.message.trim()) {
    const m = finding.message.replace(/\s+/g, ' ').trim();
    node.message = m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE - 3)}...` : m;
  }
  if (finding.confidence && finding.confidence !== rule.confidence && CONFIDENCES.includes(finding.confidence)) node.confidence = finding.confidence;
  const data = sanitizeData(finding.data);
  if (data) node.data = data;
  Object.defineProperties(node, {
    order: { value: finding.node.order, enumerable: false },
    line: { value: finding.node.line, enumerable: false },
    column: { value: finding.node.column, enumerable: false },
    seq: { value: seq, enumerable: false },
  });
  return node;
}

// Runtime nodes (ctx.ref.dynamic) have no source position; they keep the order
// the rule emitted them in (e.g. longest script first), which is deterministic.
function compareNodes(a, b) {
  if (a.order === ORDER_RUNTIME && b.order === ORDER_RUNTIME && a.seq !== b.seq) return a.seq - b.seq;
  return (a.order - b.order) || (a.line - b.line) || (a.column - b.column)
    || cmp(a.selector, b.selector) || cmp(a.message ?? '', b.message ?? '') || cmp(a.location, b.location) || cmp(a.snippet, b.snippet);
}

function dedupeSortCap(nodes) {
  const seen = new Set();
  const unique = [];
  for (const n of nodes) {
    const key = `${n.selector}\u0000${n.location}\u0000${n.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(n);
  }
  unique.sort(compareNodes);
  return { nodes: unique.slice(0, MAX_NODES), total: unique.length };
}

function entryFor(rule, nodes, total) {
  const e = {
    ruleId: rule.id,
    severity: rule.severity,
    area: rule.area,
    confidence: rule.confidence,
    methods: [...rule.methods],
    description: rule.description,
    helpUrl: rule.helpUrl,
    nodes,
  };
  if (total > nodes.length) e.nodesTruncated = total - nodes.length;
  return e;
}

export function compareViolations(a, b) {
  return (SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))
    || (AREAS.indexOf(a.area) - AREAS.indexOf(b.area))
    || cmp(a.ruleId, b.ruleId);
}

function invoke(rule, ctx) {
  const out = rule.check(ctx);
  if (out && !Array.isArray(out) && typeof out === 'object' && typeof out.notApplicable === 'string') return { notApplicable: out.notApplicable };
  if (!Array.isArray(out)) throw new TypeError('check() must return an array of findings or { notApplicable: reason }');
  for (const f of out) {
    if (!f || typeof f !== 'object' || !isNodeRef(f.node)) throw new TypeError('each finding needs a node built with ctx.ref.*');
  }
  return { findings: out };
}

/**
 * Run rules against a context.
 * @param {object} ctx
 * @param {object[]} rules
 * @param {{ ignore?: string[] }} [opts] - full rule ids to skip
 * @returns {{ violations: object[], incomplete: object[], rules: object[], errors: object[], suppressed: number }}
 */
export function runRules(ctx, rules, opts = {}) {
  const ignore = new Set(opts.ignore ?? []);
  const isSuppressed = createSuppressor(ctx);
  const areas = ctx.options.areas;
  const violations = [];
  const incomplete = [];
  const statuses = [];
  const errors = [];
  let suppressedTotal = 0;
  const seenIds = new Set();

  const sorted = [...rules].sort((a, b) => cmp(String(a?.id), String(b?.id)));
  for (const rule of sorted) {
    const problems = validateRule(rule);
    const id = typeof rule?.id === 'string' ? rule.id : '(invalid rule)';
    if (problems.length || seenIds.has(id)) {
      const message = problems.length ? `invalid rule: ${problems.join('; ')}` : 'duplicate rule id';
      errors.push({ phase: 'rule', ruleId: id, message });
      if (RULE_ID_RE.test(id) && AREAS.includes(rule?.area) && SEVERITIES.includes(rule?.severity)) {
        statuses.push({ id, area: rule.area, severity: rule.severity, status: 'error', reason: message });
      }
      continue;
    }
    seenIds.add(id);
    if (!areas.includes(rule.area)) continue;
    const status = { id, area: rule.area, severity: rule.severity };
    if (ignore.has(id)) { statuses.push({ ...status, status: 'skipped', reason: 'ignored' }); continue; }
    if (rule.phase === 'dynamic' && ctx.dynamic === null) { statuses.push({ ...status, status: 'skipped', reason: 'dynamic-only' }); continue; }
    if (rule.requires?.includes('http') && ctx.page.kind !== 'http') { statuses.push({ ...status, status: 'notApplicable', reason: 'requires-http' }); continue; }

    let result;
    try {
      result = invoke(rule, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ phase: 'rule', ruleId: id, message });
      statuses.push({ ...status, status: 'error', reason: message });
      continue;
    }

    let findings = result.findings ?? [];
    let notApplicable = result.notApplicable ?? null;
    if (rule.rendered === true && ctx.rendered) {
      try {
        const rctx = Object.freeze({ ...ctx, html: ctx.rendered });
        const r2 = invoke(rule, rctx);
        const extra = r2.findings ?? [];
        const seenSel = new Set(findings.map((f) => f.node.selector));
        const seenSnip = new Set(findings.map((f) => f.node.snippet));
        const fresh = extra.filter((f) => !seenSel.has(f.node.selector) && !seenSnip.has(f.node.snippet));
        findings = [...findings, ...fresh];
        // The rendered DOM can make a rule applicable (e.g. a script-built <dialog>).
        if (notApplicable !== null && r2.notApplicable === undefined) notApplicable = null;
      } catch (err) {
        errors.push({ phase: 'rule', ruleId: id, message: `rendered re-run: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    if (notApplicable !== null && findings.length === 0) {
      statuses.push({ ...status, status: 'notApplicable', reason: notApplicable });
      continue;
    }

    let suppressed = 0;
    const vNodes = [];
    const iNodes = [];
    findings.forEach((f, seq) => {
      if (isSuppressed(id, f.node)) { suppressed++; return; }
      (f.incomplete === true ? iNodes : vNodes).push(toNode(f, rule, seq));
    });
    suppressedTotal += suppressed;
    const v = dedupeSortCap(vNodes);
    const inc = dedupeSortCap(iNodes);
    if (v.total) violations.push(entryFor(rule, v.nodes, v.total));
    if (inc.total) incomplete.push(entryFor(rule, inc.nodes, inc.total));
    const final = v.total ? 'failed' : inc.total ? 'incomplete' : 'passed';
    const entry = { ...status, status: final };
    if (suppressed) entry.suppressed = suppressed;
    statuses.push(entry);
  }

  violations.sort(compareViolations);
  incomplete.sort(compareViolations);
  statuses.sort((a, b) => cmp(a.id, b.id));
  errors.sort((a, b) => cmp(a.ruleId ?? '', b.ruleId ?? '') || cmp(a.message, b.message));
  return { violations, incomplete, rules: statuses, errors, suppressed: suppressedTotal };
}

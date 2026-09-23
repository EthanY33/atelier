/**
 * ux-report.md: a pure function of the audit result.
 *
 * Selectors, locations, file names, URLs and messages come from the audited
 * page, and the report is appended to GitHub step summaries, so every
 * page-derived string is rendered on one line and either inside a code span
 * or with Markdown and HTML metacharacters escaped. A page cannot add
 * headings, links, images or HTML to the report.
 */
import { AREAS } from './options.mjs';
import { SEVERITIES } from './runner.mjs';
import { COMPLETE_SKIP_REASONS } from './collect.mjs';

const AREA_TITLES = Object.freeze({ transitions: 'Transitions', inp: 'INP', panels: 'Panels', mobile: 'Mobile' });
const SEVERITY_TITLES = Object.freeze({ critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' });
const SHOWN_NODES = 5;

/**
 * Inline code with a fence longer than any backtick run inside. Whitespace,
 * newlines included, collapses to single spaces: a blank line would end the
 * list item and let the rest render as Markdown blocks.
 */
export function code(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '``';
  let longest = 0;
  for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// A line start that would open a block: ATX heading, block quote, bullet
// list, thematic break, setext underline or ~~~ fence.
const BLOCK_START_RE = /^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|[-*_](?:\s*[-*_]){2,}\s*$|=+\s*$|~{3})/;

/**
 * Page-derived prose on one line, safe to render as Markdown: backslashes,
 * backticks, '<' (raw HTML) and '[' ']' (links and images) are escaped, and so
 * is a leading character that would start a block (heading, quote, list,
 * fence, setext underline).
 */
export function inline(text) {
  const s = oneLine(text).replace(/[\\`<[\]]/g, '\\$&');
  if (BLOCK_START_RE.test(s)) return `\\${s}`;
  return s.replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
}

function inpHighlight(result) {
  const budget = result.budgets.inpBudgetMs;
  if (!result.mode.dynamic) return 'INP est. n/a (static)';
  const inp = result.metrics.inp;
  if (!inp) return 'INP est. n/a';
  if (inp.estimateMs === null) return inp.belowThreshold ? `INP est. < 16 ms (budget ${budget} ms)` : 'INP est. n/a';
  return `INP est. ${inp.estimateMs} ms (budget ${budget} ms)`;
}

function modeLine(result) {
  if (!result.mode.dynamic) return 'static';
  const e = result.mode.engine;
  if (!e) return 'static + dynamic';
  const parts = [];
  if (e.version) parts.push(`Chromium ${String(e.version).split('.')[0]}`);
  else parts.push('Chromium');
  if (e.device) parts.push(e.device);
  if (e.cpuThrottle) parts.push(`${e.cpuThrottle}x CPU`);
  return `static + dynamic (${parts.join(', ')})`;
}

function renderEntry(lines, v) {
  const total = v.nodes.length + (v.nodesTruncated ?? 0);
  lines.push(`#### ${v.ruleId}`);
  lines.push(`- Description: ${oneLine(v.description)}`);
  lines.push(`- Confidence: ${v.confidence}`);
  lines.push(`- Help: ${v.helpUrl}`);
  lines.push(`- Instances (${total}):`);
  for (const n of v.nodes.slice(0, SHOWN_NODES)) {
    lines.push(`  - ${code(n.selector)} at ${inline(n.location)}${n.snippet ? `: ${code(n.snippet)}` : ''}`);
    if (n.message) lines.push(`    ${inline(n.message)}`);
    if (n.confidence) lines.push(`    Confidence: ${n.confidence}`);
  }
  if (total > SHOWN_NODES) lines.push(`  - ... and ${total - SHOWN_NODES} more`);
}

function missingInputs(resources) {
  const firstParty = resources.filter((r) => r.kind !== 'document' && !(r.status === 'skipped' && COMPLETE_SKIP_REASONS.has(r.reason)) && r.reason !== 'duplicate' && r.status !== 'parsed');
  const count = (kinds, pred) => firstParty.filter((r) => kinds.includes(r.kind) && pred(r)).length;
  const parts = [];
  const cssParse = count(['stylesheet'], (r) => r.status === 'parse-error');
  const cssMissing = count(['stylesheet'], (r) => r.status !== 'parse-error');
  const jsParse = count(['script', 'module'], (r) => r.status === 'parse-error');
  const jsMissing = count(['script', 'module'], (r) => r.status !== 'parse-error');
  if (cssParse) parts.push(`${plural(cssParse, 'same-origin stylesheet')} failed to parse`);
  if (cssMissing) parts.push(`${plural(cssMissing, 'same-origin stylesheet')} could not be loaded`);
  if (jsParse) parts.push(`${plural(jsParse, 'same-origin script')} failed to parse`);
  if (jsMissing) parts.push(`${plural(jsMissing, 'same-origin script')} could not be loaded`);
  return parts;
}

function resourceLine(resources) {
  const parsed = resources.filter((r) => r.status === 'parsed');
  const n = (kinds) => parsed.filter((r) => kinds.includes(r.kind)).length;
  const counts = [plural(n(['document']), 'document')];
  counts.push(plural(n(['stylesheet']), 'stylesheet'));
  counts.push(plural(n(['script', 'module']), 'script'));
  if (n(['speculation-rules'])) counts.push(plural(n(['speculation-rules']), 'speculation rules block'));
  if (n(['manifest'])) counts.push(plural(n(['manifest']), 'manifest'));
  if (n(['image'])) counts.push(plural(n(['image']), 'image'));
  const list = (items) => {
    if (!items.length) return 'none';
    const shown = items.slice(0, 20).map((r) => `${inline(r.displayPath)} (${inline(r.reason ?? r.status)})`);
    if (items.length > 20) shown.push(`... and ${items.length - 20} more`);
    return shown.join(', ');
  };
  const skipped = resources.filter((r) => r.status === 'skipped');
  const failed = resources.filter((r) => r.status === 'failed' || r.status === 'too-large' || r.status === 'parse-error');
  return `- Resources: ${counts.join(', ')} parsed; skipped: ${list(skipped)}; failed: ${list(failed)}`;
}

/**
 * Build ux-report.md.
 * @param {object} result - see index.mjs
 * @returns {string}
 */
export function buildMarkdownReport(result) {
  const { summary, run } = result;
  const lines = [];
  const areas = AREAS.filter((a) => result.mode.areas.includes(a));
  const totalRules = SEVERITIES.reduce((n, s) => n + summary.rules[s], 0);
  const totalInstances = SEVERITIES.reduce((n, s) => n + summary.instances[s], 0);

  lines.push('# Runtime UX audit', '');
  lines.push(`URL: ${inline(result.url)}`);
  lines.push(`Timestamp: ${result.timestamp}`);
  lines.push(`Mode: ${modeLine(result)}`);
  lines.push(`Total violations: ${plural(totalRules, 'rule')}, ${plural(totalInstances, 'instance')} (${SEVERITIES.map((s) => `${s}: ${summary.rules[s]}`).join(', ')})`);
  lines.push(summary.pass ? 'Pass: yes' : `Pass: no (${summary.rules.critical} critical, ${summary.rules.serious} serious)`);
  lines.push('');

  lines.push('| Area | Critical | Serious | Moderate | Minor | Highlights |');
  lines.push('|---|---|---|---|---|---|');
  for (const area of areas) {
    const row = summary.byArea[area];
    const hl = Object.entries(result.metrics.highlights[area] ?? {}).map(([label, count]) => `${label} ${count}`);
    if (area === 'inp') hl.push(inpHighlight(result));
    lines.push(`| ${AREA_TITLES[area]} | ${row.critical} | ${row.serious} | ${row.moderate} | ${row.minor} | ${cell(hl.join(', '))} |`);
  }
  lines.push('');

  areas.forEach((area, i) => {
    lines.push(`## ${i + 1}. ${AREA_TITLES[area]}`, '');
    const inArea = run.violations.filter((v) => v.area === area);
    if (!inArea.length) {
      lines.push('No violations.', '');
      return;
    }
    for (const sev of SEVERITIES) {
      const list = inArea.filter((v) => v.severity === sev);
      if (!list.length) continue;
      lines.push(`### ${SEVERITY_TITLES[sev]} (${list.length})`, '');
      for (const v of list) {
        renderEntry(lines, v);
        lines.push('');
      }
    }
  });

  lines.push('## Needs review', '');
  if (!run.incomplete.length) {
    lines.push('None.', '');
  } else {
    const missing = missingInputs(result.resources);
    lines.push(`These findings rest on something being absent, but some inputs were missing${missing.length ? ` (${missing.join('; ')})` : ''}. Check them by hand.`, '');
    for (const v of run.incomplete) {
      renderEntry(lines, v);
      lines.push('');
    }
  }

  const statuses = run.rules;
  const count = (pred) => statuses.filter(pred).length;
  lines.push('## Coverage', '');
  lines.push(resourceLine(result.resources));
  lines.push(`- Rules: ${statuses.length} total; ${count((r) => r.status === 'failed')} failed, ${count((r) => r.status === 'incomplete')} incomplete, ${count((r) => r.status === 'passed')} passed, ${count((r) => r.status === 'notApplicable')} not applicable, ${count((r) => r.status === 'skipped' && r.reason === 'dynamic-only')} skipped (dynamic only), ${count((r) => r.status === 'skipped' && r.reason === 'ignored')} ignored, ${plural(count((r) => r.status === 'error'), 'error')}`);
  lines.push(`- Suppressed instances: ${run.suppressed}`);
  for (const e of result.errors.filter((x) => x.phase === 'rule')) lines.push(`- Rule error: ${inline(e.ruleId)}: ${inline(e.message)}`);
  if (result.mode.dynamic) {
    lines.push('- Dynamic findings reflect Chromium-only APIs.');
    const probe = result.errors.filter((x) => x.phase === 'dynamic');
    lines.push(`- Probe errors: ${probe.length ? probe.map((e) => inline(e.message)).join('; ') : 'none'}`);
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

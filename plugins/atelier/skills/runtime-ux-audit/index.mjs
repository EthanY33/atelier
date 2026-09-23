/**
 * runtime-ux-audit: audit a page for runtime UX problems (page transitions,
 * INP-adjacent main-thread behavior, panels and dialogs, mobile viewport).
 *
 * Static pass: parses HTML, CSS and JS, never executes page code, never loads
 * Playwright. --dynamic adds a Chromium pass (INP estimate, bfcache, dialog
 * focus, tap targets).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../lib/cli.mjs';
import { formatError, PreflightError } from '../../lib/preflight.mjs';
import { collect, normalizeText } from './lib/collect.mjs';
import { buildContext } from './lib/context.mjs';
import { buildHtmlModel } from './lib/html-model.mjs';
import { loadBrand, resolveBudgets } from './lib/budgets.mjs';
import { normalizeOptions, parseCliArgs, USAGE } from './lib/options.mjs';
import { runRules } from './lib/runner.mjs';
import { computeHighlights } from './lib/headline.mjs';
import { buildRaw, summarize } from './lib/report-raw.mjs';
import { buildMarkdownReport } from './lib/report-md.mjs';
import { UxAuditError, fromPreflight } from './lib/errors.mjs';
import { RULES } from './rules/index.mjs';

export { UxAuditError } from './lib/errors.mjs';
export { RULES } from './rules/index.mjs';

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);

function buildMetrics(facts, highlights) {
  const inp = facts?.interactions?.inp ?? null;
  const bf = facts?.bfcache ?? null;
  return {
    inpP75Ms: inp ? round(inp.estimateMs) : null,
    inp: inp ? {
      estimateMs: round(inp.estimateMs),
      p75InteractionMs: round(inp.p75InteractionMs),
      maxMs: round(inp.maxMs),
      count: Number.isInteger(inp.count) ? inp.count : 0,
      belowThreshold: inp.belowThreshold === true,
      worst: inp.worst ? {
        name: String(inp.worst.name ?? ''),
        target: inp.worst.target ?? null,
        inputDelayMs: round(inp.worst.inputDelayMs),
        processingMs: round(inp.worst.processingMs),
        presentationMs: round(inp.worst.presentationMs),
      } : null,
    } : null,
    bfcache: bf ? { restored: typeof bf.restored === 'boolean' ? bf.restored : null, reasons: [...(bf.reasons ?? [])].map(String) } : null,
    highlights,
  };
}

async function runDynamic(options, collected, budgets) {
  const { ensureChromium, launchUxChromium } = await import('./lib/browser.mjs');
  let runDynamicPass = options.dynamicImpl;
  if (!runDynamicPass) {
    await ensureChromium();
    ({ runDynamicPass } = await import('./dynamic/index.mjs'));
  }
  const page = collected.page;
  try {
    return await runDynamicPass({
      page: {
        kind: page.kind,
        url: page.docUrl,
        filePath: page.kind === 'file' ? fileURLToPath(page.docUrl) : null,
        root: page.root,
      },
      toDisplay: (absUrl) => collected.urls.toDisplay(absUrl),
      budgets,
      limits: options.dynamicLimits,
      launch: launchUxChromium,
      allowOrigins: options.allowOrigins,
    });
  } catch (err) {
    const mapped = fromPreflight(err);
    if (mapped instanceof UxAuditError) throw mapped;
    throw new UxAuditError('DYNAMIC_FAILED', `The dynamic pass failed: ${err instanceof Error ? err.message : String(err)}`, {
      hint: 'Run without --dynamic for the static audit, or report the page that fails.',
      cause: err,
    });
  }
}

/**
 * Audit a page.
 * @param {{
 *   url: string, outDir?: string, dynamic?: boolean, brand?: string|object|null, root?: string,
 *   areas?: Array<'transitions'|'inp'|'panels'|'mobile'>, ignore?: string[], allowOrigins?: string[],
 *   timestamp?: string, write?: boolean, limits?: object, dynamicLimits?: object,
 *   rules?: object[], fetchImpl?: typeof fetch, dynamicImpl?: (input: object) => Promise<object>
 * }} opts - rules, fetchImpl and dynamicImpl are test hooks (dynamicImpl replaces
 *   dynamic/index.mjs runDynamicPass and skips the Chromium check).
 */
export async function auditRuntimeUx(opts) {
  const options = normalizeOptions(opts);
  const brand = loadBrand(options.brand, { cwd: options.cwd });
  const budgets = resolveBudgets(brand);
  const collected = await collect(options.url, {
    root: options.root, allowOrigins: options.allowOrigins, limits: options.limits, fetchImpl: options.fetchImpl, cwd: options.cwd,
  });

  let facts = null;
  let rendered = null;
  if (options.dynamic) {
    facts = await runDynamic(options, collected, budgets);
    if (typeof facts?.rendered?.html === 'string') {
      rendered = buildHtmlModel(normalizeText(facts.rendered.html), {
        source: 'rendered', displayPath: '(rendered DOM)', resolve: (href) => collected.urls.resolve(href),
      });
    }
  }

  const ctx = buildContext(collected, { options, budgets, brand, dynamic: facts, rendered });
  const run = runRules(ctx, options.rules ?? RULES, { ignore: options.ignore });
  const highlights = computeHighlights(run.violations, budgets, options.areas);
  const metrics = buildMetrics(facts, highlights);
  const errors = [
    ...run.errors,
    ...(facts?.errors ?? []).map((e) => ({ phase: 'dynamic', message: `${e.probe}: ${String(e.message ?? '').replace(/\s+/g, ' ').trim()}` })),
  ];
  const result = {
    url: ctx.page.displayUrl,
    timestamp: options.timestamp ?? new Date().toISOString(),
    mode: {
      dynamic: options.dynamic,
      areas: options.areas,
      engine: facts?.engine ? {
        name: String(facts.engine.name ?? 'chromium'),
        version: facts.engine.version ?? null,
        device: facts.profile?.device ?? null,
        cpuThrottle: facts.profile?.cpuThrottle ?? null,
      } : null,
    },
    budgets,
    run,
    resources: ctx.resources,
    errors,
    metrics,
    summary: summarize(run, options.areas),
  };
  const raw = buildRaw(result);
  const markdown = buildMarkdownReport(result);

  let reportPath = null;
  let rawPath = null;
  if (options.write) {
    const outDir = resolve(options.cwd, options.outDir);
    mkdirSync(outDir, { recursive: true });
    reportPath = join(outDir, 'ux-report.md');
    rawPath = join(outDir, 'ux-raw.json');
    writeFileSync(reportPath, markdown, 'utf8');
    writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }

  const bySeverity = (s) => raw.violations.filter((v) => v.severity === s);
  return {
    violations: { critical: bySeverity('critical'), serious: bySeverity('serious'), moderate: bySeverity('moderate'), minor: bySeverity('minor'), all: raw.violations },
    incomplete: raw.incomplete,
    metrics: raw.metrics,
    summary: raw.summary,
    pass: raw.summary.pass,
    raw,
    markdown,
    reportPath,
    rawPath,
  };
}

/**
 * CLI entry. Returns the exit code.
 * @param {string[]} argv
 */
export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const res = await auditRuntimeUx(parsed.options);
    const s = res.summary.rules;
    process.stdout.write(`Report written to: ${res.reportPath}\n`);
    process.stdout.write(`Violations: critical ${s.critical}, serious ${s.serious}, moderate ${s.moderate}, minor ${s.minor}\n`);
    if (parsed.options.dynamic) {
      const inp = res.metrics.inp;
      const budget = res.raw.budgets.inpBudgetMs;
      const est = inp?.estimateMs ?? null;
      const shown = est !== null ? `${est} ms` : inp?.belowThreshold ? '< 16 ms' : 'n/a';
      process.stdout.write(`INP est.: ${shown} (budget ${budget} ms)\n`);
    }
    return res.pass ? 0 : 1;
  } catch (err) {
    if (err instanceof UxAuditError && err.code === 'USAGE') {
      process.stderr.write(`${formatError(err)}\n\n${USAGE}\n`);
      return 2;
    }
    process.stderr.write(`${formatError(err)}\n`);
    if (!(err instanceof PreflightError) && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
    // Idle keep-alive sockets from fetch() must not hold the process open.
    setTimeout(() => process.exit(code), 50).unref();
  });
}

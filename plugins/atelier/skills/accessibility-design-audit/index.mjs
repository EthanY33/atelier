import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Groups axe violations by impact level.
 * @param {Array} violations
 * @returns {{ critical: Array, serious: Array, moderate: Array, minor: Array, all: Array }}
 */
function groupByImpact(violations) {
  const grouped = { critical: [], serious: [], moderate: [], minor: [], all: violations };
  for (const v of violations) {
    const key = v.impact;
    if (key && key in grouped) {
      grouped[key].push(v);
    }
  }
  return grouped;
}

/**
 * Renders a grouped violations object as a markdown report.
 * @param {string} url
 * @param {string} timestamp
 * @param {{ critical: Array, serious: Array, moderate: Array, minor: Array, all: Array }} grouped
 * @returns {string}
 */
function buildMarkdownReport(url, timestamp, grouped) {
  const lines = [
    '# Accessibility audit',
    '',
    `**URL:** ${url}`,
    `**Timestamp:** ${timestamp}`,
    `**Total violations:** ${grouped.all.length}`,
    '',
  ];

  if (grouped.all.length === 0) {
    lines.push('No violations found.');
    return lines.join('\n');
  }

  const impactOrder = ['critical', 'serious', 'moderate', 'minor'];
  for (const impact of impactOrder) {
    const items = grouped[impact];
    if (items.length === 0) continue;

    lines.push(`## ${impact.charAt(0).toUpperCase() + impact.slice(1)} Violations (${items.length})`);
    lines.push('');

    for (const v of items) {
      lines.push(`### ${v.id}`);
      lines.push('');
      lines.push(`- **Impact:** ${v.impact}`);
      lines.push(`- **Description:** ${v.description}`);
      lines.push(`- **Help URL:** ${v.helpUrl}`);

      const selectors = v.nodes
        .slice(0, 5)
        .map((n) => n.target?.join(' ') || '(unknown)');

      if (selectors.length > 0) {
        lines.push('- **Affected elements (up to 5):**');
        for (const sel of selectors) {
          lines.push(`  - \`${sel}\``);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs a WCAG 2.1 AA audit on a URL using axe-core via Playwright.
 *
 * @param {{ url: string, outDir: string }} opts
 * @returns {Promise<{ violations: { critical: Array, serious: Array, moderate: Array, minor: Array, all: Array }, reportPath: string }>}
 */
export async function auditPage({ url, outDir }) {
  mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();

    const violations = result.violations;
    const grouped = groupByImpact(violations);
    const timestamp = new Date().toISOString();
    const markdown = buildMarkdownReport(url, timestamp, grouped);

    const reportPath = join(outDir, 'a11y-report.md');
    writeFileSync(reportPath, markdown, 'utf8');
    writeFileSync(join(outDir, 'a11y-raw.json'), JSON.stringify(result, null, 2), 'utf8');

    return { violations: grouped, reportPath };
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const [, , url, outDir = 'a11y-report'] = process.argv;
  if (!url) {
    console.error('Usage: node index.mjs <url> [outDir]');
    process.exit(1);
  }

  const { violations, reportPath } = await auditPage({ url, outDir });
  console.log(`Report written to: ${reportPath}`);
  console.log(
    `Violations — critical: ${violations.critical.length}, serious: ${violations.serious.length}, moderate: ${violations.moderate.length}, minor: ${violations.minor.length}`,
  );

  const exitCode = violations.critical.length + violations.serious.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

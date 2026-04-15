import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { auditPage } from '../plugins/atelier/skills/accessibility-design-audit/index.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'a11y-test-'));
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeHtml(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return pathToFileURL(p).href;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('accessibility-design-audit', () => {
  it(
    'clean HTML page has no critical violations and report file is created',
    async () => {
      const url = writeHtml(
        tmp,
        'clean.html',
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Clean Page</title>
</head>
<body>
  <main>
    <h1>Hello world</h1>
    <p>This is a clean accessible page.</p>
    <button type="button">Click me</button>
  </main>
</body>
</html>`,
      );

      const outDir = join(tmp, 'out-clean');
      const { violations, reportPath } = await auditPage({ url, outDir });

      expect(violations.critical.length).toBe(0);
      expect(existsSync(reportPath)).toBe(true);
      expect(reportPath.endsWith('a11y-report.md')).toBe(true);
    },
    60_000,
  );

  it(
    'image missing alt attribute triggers image-alt violation',
    async () => {
      const url = writeHtml(
        tmp,
        'missing-alt.html',
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Missing Alt</title>
</head>
<body>
  <main>
    <h1>Page with inaccessible image</h1>
    <img src="fake-image.png">
  </main>
</body>
</html>`,
      );

      const outDir = join(tmp, 'out-alt');
      const { violations } = await auditPage({ url, outDir });

      const allIds = violations.all.map((v) => v.id);
      expect(allIds).toContain('image-alt');
    },
    60_000,
  );

  it(
    'markdown report contains accessibility audit heading and violation status',
    async () => {
      const url = writeHtml(
        tmp,
        'no-lang.html',
        `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>No Lang</title>
</head>
<body>
  <main>
    <h1>Page without lang attribute</h1>
    <p>This page is missing the lang attribute on the html element.</p>
  </main>
</body>
</html>`,
      );

      const outDir = join(tmp, 'out-lang');
      const { reportPath } = await auditPage({ url, outDir });

      const { readFileSync } = await import('fs');
      const content = readFileSync(reportPath, 'utf8');

      expect(content).toMatch(/# Accessibility audit/);
      expect(content).toMatch(/Violations|No violations/);
    },
    60_000,
  );
});

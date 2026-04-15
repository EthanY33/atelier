import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { loadBrand } from '../brand-memory/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reads template.html and injects brand CSS vars + page content script.
 * Returns the final HTML string ready for Playwright.
 * @param {object} brand
 * @param {{ slug?: string, title?: string, subtitle?: string }} page
 * @returns {string}
 */
function buildHtml(brand, page) {
  const templatePath = join(__dirname, 'template.html');
  let html = readFileSync(templatePath, 'utf8');

  // Derive CSS custom-property values from brand
  const bg = brand.palette?.bg || '#111';
  const fg = brand.palette?.fg || '#fff';
  const fontDisplay = brand.typography?.display || brand.typography?.body || 'system-ui';
  const fontBody = brand.typography?.body || 'system-ui';

  // Inject :root block with CSS vars before </head>
  const styleBlock = `<style>:root{--bg:${bg};--fg:${fg};--font-display:${fontDisplay};--font-body:${fontBody};}</style>`;
  html = html.replace('</head>', `${styleBlock}\n</head>`);

  // Derive text values
  const studio = brand.brand?.studio || '';
  const studioText = studio ? `${studio} /` : '';
  const slugText = page.slug ? `/${page.slug}` : '/';
  const titleText = page.title || '';
  const subtitleText = page.subtitle || '';

  // Inject content script before </body> using JSON.stringify for XSS-safe interpolation
  const scriptBlock = `<script>
(function(){
  document.getElementById('title').textContent = ${JSON.stringify(titleText)};
  document.getElementById('subtitle').textContent = ${JSON.stringify(subtitleText)};
  document.getElementById('studio').textContent = ${JSON.stringify(studioText)};
  document.getElementById('slug').textContent = ${JSON.stringify(slugText)};
})();
</script>`;
  html = html.replace('</body>', `${scriptBlock}\n</body>`);

  return html;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a single OG card PNG for the given brand + page config.
 * @param {{ brand: object, page: { slug?: string, title?: string, subtitle?: string }, outPath: string }} opts
 * @returns {Promise<string>} resolves with outPath
 */
export async function generateCard({ brand, page, outPath }) {
  const html = buildHtml(brand, page);

  mkdirSync(dirname(outPath), { recursive: true });

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 630 } });
    const browserPage = await context.newPage();
    await browserPage.setContent(html, { waitUntil: 'domcontentloaded' });
    const buf = await browserPage.screenshot({
      clip: { x: 0, y: 0, width: 1200, height: 630 },
    });
    await sharp(buf).png({ compressionLevel: 9 }).toFile(outPath);
  } finally {
    if (browser) await browser.close();
  }

  return outPath;
}

/**
 * Batch-renders OG card PNGs for all pages in the manifest.
 * @param {{ brand: object, pages: Array<{ slug?: string, title?: string, subtitle?: string }>, outDir: string }} opts
 * @returns {Promise<string[]>} resolves with array of output paths
 */
export async function generateCards({ brand, pages, outDir }) {
  const results = [];
  for (const page of pages) {
    const slug = page.slug || 'index';
    const outPath = join(outDir, `${slug}.png`);
    await generateCard({ brand, page, outPath });
    results.push(outPath);
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [, , manifestPath, outDir = 'og-cards'] = process.argv;
  if (!manifestPath) {
    console.error('Usage: node index.mjs <manifest.json> [outDir]');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const brand = await loadBrand(process.cwd());
  const paths = await generateCards({ brand, pages: manifest.pages, outDir });
  console.log(`Generated ${paths.length} OG card(s):`);
  paths.forEach((p) => console.log(`  ${p}`));
}

/**
 * design-token-sync — CLI entry + syncTokens() API.
 *
 * Usage (API):
 *   import { syncTokens } from '.../design-token-sync/index.mjs';
 *   const written = await syncTokens({ projectRoot: '/path/to/project' });
 *
 * Usage (CLI):
 *   node plugins/atelier/skills/design-token-sync/index.mjs [projectRoot]
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { loadBrand } from '../brand-memory/index.mjs';
import { emitCss } from './emitters/css.mjs';
import { emitTailwind } from './emitters/tailwind.mjs';
import { emitDts } from './emitters/dts.mjs';
import { emitFigmaVariables } from './emitters/figma.mjs';

/**
 * Loads brand config from projectRoot, generates all 4 token artifacts,
 * writes them to `<projectRoot>/<outDir>/`, and returns the absolute paths.
 *
 * @param {{ projectRoot: string, outDir?: string }} options
 * @returns {Promise<string[]>} Absolute paths of written files
 */
export async function syncTokens({ projectRoot, outDir = 'dist/tokens' }) {
  const root = resolve(projectRoot);
  const cfg = await loadBrand(root);

  const outPath = join(root, outDir);
  mkdirSync(outPath, { recursive: true });

  const artifacts = [
    { name: 'tokens.css', content: emitCss(cfg) },
    { name: 'tailwind.config.js', content: emitTailwind(cfg) },
    { name: 'tokens.d.ts', content: emitDts(cfg) },
    { name: 'figma-variables.json', content: emitFigmaVariables(cfg) },
  ];

  const written = [];
  for (const { name, content } of artifacts) {
    const filePath = join(outPath, name);
    writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
  }

  return written;
}

// ---------------------------------------------------------------------------
// CLI entry — detect if this file is the direct entrypoint
// ---------------------------------------------------------------------------

// Normalize both sides to forward slashes for cross-platform comparison
function normalizeUrl(u) {
  return u.replace(/\\/g, '/');
}

const isMain =
  normalizeUrl(import.meta.url) ===
  normalizeUrl(pathToFileURL(process.argv[1]).href);

if (isMain) {
  const projectRoot = process.argv[2] ?? process.cwd();
  console.log(`design-token-sync: syncing tokens for ${projectRoot}`);
  syncTokens({ projectRoot })
    .then((written) => {
      console.log('Written:');
      for (const f of written) console.log(' ', f);
    })
    .catch((err) => {
      console.error('design-token-sync error:', err.message);
      process.exit(1);
    });
}

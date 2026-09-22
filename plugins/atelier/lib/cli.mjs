/**
 * CLI plumbing shared by atelier skills.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script Node was started with.
 *
 * Compares real paths, so it holds when the script is reached through a
 * symlink, a Windows junction, a differently cased drive letter, or (via the
 * native resolver) an 8.3 short name or a mapped drive. Returns false under
 * `node -e`, the REPL, or stdin, where there is no argv[1].
 *
 * @param {string} metaUrl - `import.meta.url` of the calling module.
 * @param {string|undefined} [argv1=process.argv[1]]
 * @returns {boolean}
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl) return false;
  let self;
  try {
    self = fileURLToPath(metaUrl);
  } catch {
    return false;
  }
  const same = process.platform === 'win32'
    ? (a, b) => a.toLowerCase() === b.toLowerCase()
    : (a, b) => a === b;
  // The JS resolver matches how Node resolved the entry point; the native one
  // also expands short names and substituted drives.
  for (const real of [realpathSync, realpathSync.native]) {
    try {
      if (same(real(argv1), real(self))) return true;
    } catch {
      // Missing path: try the next resolver, then give up.
    }
  }
  return false;
}

/**
 * CLI plumbing shared by atelier skills.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script Node was started with.
 *
 * Compares real paths, so it holds when the script is reached through a
 * symlink, a Windows junction, or a differently cased drive letter. Returns
 * false under `node -e`, the REPL, or stdin, where there is no argv[1].
 *
 * @param {string} metaUrl - `import.meta.url` of the calling module.
 * @param {string|undefined} [argv1=process.argv[1]]
 * @returns {boolean}
 */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const a = realpathSync(argv1);
    const b = realpathSync(fileURLToPath(metaUrl));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

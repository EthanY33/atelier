/**
 * workflow-pins.mjs: find third-party GitHub Actions that are not pinned to a
 * full commit SHA.
 *
 * A pinned line looks like
 *   - uses: actions/checkout@<40 hex characters> # v7.0.1
 * Local actions (`uses: ./` or `uses: ./path`) are exempt. Used by
 * check-versions.mjs and covered by tests/workflow-pins.test.mjs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const USES_LINE = /^\s*(?:-\s*)?uses:\s*(.*?)\s*$/;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;

/**
 * @param {string} text Contents of one workflow file.
 * @param {string} [file] Name used in the messages.
 * @returns {string[]} One message per unpinned third-party `uses:` line.
 */
export function findUnpinnedActions(text, file = 'workflow') {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = USES_LINE.exec(line);
    if (!m) return;
    const hash = m[1].indexOf(' #');
    const value = (hash === -1 ? m[1] : m[1].slice(0, hash)).trim().replace(/^(['"])(.*)\1$/, '$2');
    const comment = hash === -1 ? '' : m[1].slice(hash + 2).trim();
    if (value.startsWith('./')) return;
    if (!PINNED.test(value)) {
      problems.push(`${file}:${i + 1}: "${value}" is not pinned to a 40-character commit SHA`);
    } else if (comment === '') {
      problems.push(`${file}:${i + 1}: "${value}" needs a trailing "# <version>" comment`);
    }
  });
  return problems;
}

/**
 * @param {string} root Repository root.
 * @returns {string[]} Problems across every file in .github/workflows.
 */
export function checkWorkflowPins(root) {
  const dir = join(root, '.github', 'workflows');
  const problems = [];
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    problems.push(...findUnpinnedActions(readFileSync(join(dir, name), 'utf8'), `.github/workflows/${name}`));
  }
  return problems;
}

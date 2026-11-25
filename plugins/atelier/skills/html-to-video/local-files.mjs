/**
 * Which files a page opened from disk may load. Shared by html-to-video and
 * accessibility-design-audit.
 *
 * Chromium lets a file: page frame, embed or link any file the user can read,
 * and both skills copy what the page renders into their output (video frames,
 * node HTML in a11y-raw.json). The page is repository content, so it only
 * gets the files under one root: the folder of the HTML file, or `root` when
 * given. The checks are the ones runtime-ux-audit's loopback server makes
 * (dynamic/serve.mjs): the real path must be a regular file inside the root,
 * and dot-named files and folders (.env, .git/, .npmrc) are refused, with
 * .well-known/ as the one exception. A file: URL that names another host is
 * refused without being opened. The page stays on file:, so its scripts still
 * cannot read local files. http(s) and data: pages need no gate: Chromium
 * itself refuses to load a file: URL for them.
 */
import { lstatSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNetworkPath } from '../../lib/io.mjs';
import { hasHiddenSegment } from '../runtime-ux-audit/dynamic/serve.mjs';
import { isInside, safeRealpath } from '../runtime-ux-audit/lib/url.mjs';

/** Blocked files reported per page; one last line says when there were more. */
const MAX_REPORTED = 5;
/** Longest blocked URL printed in full: the page chooses it. */
const MAX_URL_SHOWN = 300;

function scopeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function statOrNull(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** True when the last component of `p` is a symbolic link (or cannot be read). */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return true;
  }
}

/**
 * The files a page may load, or null when `pageUrl` is not a file: URL.
 * @param {string} pageUrl - the URL page.goto will open
 * @param {string} [root] - folder to allow instead of the page's own (relative to the working directory)
 * @returns {{ root: string, lexicalRoot: string, doc: string } | null} `root` and `doc`
 *   (the page) are real paths; `lexicalRoot` is the root as written.
 * @throws {Error} with `code` PAGE_NOT_FOUND, PAGE_IS_DIRECTORY, ROOT_NOT_FOUND or OUTSIDE_ROOT
 */
export function localFileScope(pageUrl, root) {
  if (!/^file:/i.test(pageUrl)) return null;
  let path;
  try {
    path = fileURLToPath(pageUrl);
  } catch {
    throw scopeError('PAGE_NOT_FOUND', `could not open ${pageUrl}: not the URL of a local file`);
  }
  const doc = safeRealpath(path);
  if (!doc) throw scopeError('PAGE_NOT_FOUND', `could not open ${pageUrl}: no such file`);
  if (!statOrNull(doc)?.isFile()) throw scopeError('PAGE_IS_DIRECTORY', `${doc} is not a file; pass the HTML file itself`);
  const lexicalRoot = resolve(root ?? dirname(path));
  const realRoot = safeRealpath(lexicalRoot);
  if (!realRoot || !statOrNull(realRoot)?.isDirectory()) throw scopeError('ROOT_NOT_FOUND', `root directory not found: ${lexicalRoot}`);
  if (!isInside(realRoot, doc)) {
    throw scopeError('OUTSIDE_ROOT', `the page ${doc} is outside the root directory ${realRoot}; pass --root <dir> with a folder that contains it`);
  }
  // The caller named the page, so it may sit in a dot-named folder. A page
  // that is a link is repository content again: where it leads is checked
  // like any other file the page asks for.
  if (isLink(path) && hasHiddenSegment(relative(realRoot, doc))) {
    throw scopeError('OUTSIDE_ROOT', `the page ${path} is a link to ${doc}, a dot-named file or folder, which a local page may not load`);
  }
  return { root: realRoot, lexicalRoot, doc };
}

/**
 * Decide one file: request of the page.
 * @param {{ root: string, lexicalRoot: string, doc: string }} scope - from localFileScope
 * @param {string} requestUrl
 * @returns {'allow'|'missing'|'refuse'} `missing`: Node finds nothing at that
 *   path. The request is still dropped, because Windows opens some names Node
 *   does not (`secret.txt.` with a trailing dot is `secret.txt`), but without
 *   a warning.
 */
export function localFileVerdict(scope, requestUrl) {
  let path;
  try {
    path = resolve(fileURLToPath(requestUrl));
  } catch {
    return 'refuse'; // a host (POSIX), an encoded path separator, or not a file: URL
  }
  // Opening a network path, even to stat it, sends the user's credentials to
  // that host, so one is only looked at when it sits under a root on that share.
  if (isNetworkPath(path) && !isInside(scope.lexicalRoot, path)) return 'refuse';
  const real = safeRealpath(path);
  if (!real) return 'missing';
  if (real === scope.doc) return 'allow';
  // The real path decides: a link inside the root that leads out of it, or to
  // a dot-named file, is refused like its destination.
  if (!isInside(scope.root, real) || hasHiddenSegment(relative(scope.root, real))) return 'refuse';
  return statOrNull(real)?.isFile() ? 'allow' : 'refuse';
}

/**
 * Abort every file: request in `context` that the scope does not allow. Each
 * refused file is passed to `warn` once, up to a small cap.
 * @param {import('playwright').BrowserContext} context
 * @param {{ root: string, lexicalRoot: string, doc: string }} scope - from localFileScope
 * @param {(message: string) => void} warn
 * @returns {Promise<void>}
 */
export async function restrictLocalFiles(context, scope, warn) {
  const reported = new Set();
  const report = (requestUrl) => {
    // As Chromium serialized it: percent-encoded, so page-chosen bytes stay inert in a terminal.
    const path = requestUrl.split(/[?#]/)[0];
    const shown = path.length > MAX_URL_SHOWN ? `${path.slice(0, MAX_URL_SHOWN)}...` : path;
    if (reported.has(shown) || reported.size > MAX_REPORTED) return;
    reported.add(shown);
    try {
      if (reported.size > MAX_REPORTED) warn('more local files were blocked; they are not listed');
      else warn(`blocked local file ${shown}: a local page only loads files under ${scope.root}, dot-named ones excluded (pass --root <dir>, or the root option, to allow another folder)`);
    } catch {
      // A throwing warning sink must not leave the request pending.
    }
  };
  await context.route(/^file:/i, (route) => {
    const requestUrl = route.request().url();
    const verdict = localFileVerdict(scope, requestUrl);
    if (verdict === 'allow') return route.continue().catch(() => {});
    if (verdict === 'refuse') report(requestUrl);
    return route.abort('blockedbyclient').catch(() => {});
  });
}

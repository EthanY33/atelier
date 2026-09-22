import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMain } from '../../plugins/atelier/lib/cli.mjs';
import { isWin, libUrl, makeTmp, runModule, runNode } from './helpers.mjs';

let tmp;
let cleanup;
beforeEach(() => { ({ dir: tmp, cleanup } = makeTmp('ismain')); });
afterEach(() => cleanup());

const cliUrl = JSON.stringify(libUrl('cli.mjs'));

/** A script that prints whether it is main, and imports a helper that does the same. */
function writeScripts(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'helper.mjs'), `import { isMain } from ${cliUrl};\nexport const helperIsMain = isMain(import.meta.url);\n`);
  writeFileSync(join(dir, 'main.mjs'), `import { isMain } from ${cliUrl};\nimport { helperIsMain } from './helper.mjs';\nconsole.log(JSON.stringify({ main: isMain(import.meta.url), helper: helperIsMain }));\n`);
  return join(dir, 'main.mjs');
}

describe('isMain in a child process', () => {
  it('is true for the script node was started with and false for what it imports', () => {
    const r = runNode([writeScripts(join(tmp, 'real'))]);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ main: true, helper: false });
  });

  it('is true when started through a relative path', () => {
    writeScripts(join(tmp, 'real'));
    const r = runNode([join('real', 'main.mjs')], { cwd: tmp });
    expect(JSON.parse(r.stdout)).toEqual({ main: true, helper: false });
  });

  // A junction on Windows (no admin needed); a directory symlink elsewhere.
  it('is true when started through a junction or directory symlink', () => {
    writeScripts(join(tmp, 'real'));
    const link = join(tmp, 'link');
    symlinkSync(join(tmp, 'real'), link, 'junction');
    const r = runNode([join(link, 'main.mjs')]);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ main: true, helper: false });
  });

  it('is true through a file symlink (skipped where symlinks need admin rights)', (ctx) => {
    const target = writeScripts(join(tmp, 'real'));
    const link = join(tmp, 'real', 'alias.mjs');
    try {
      symlinkSync(target, link, 'file');
    } catch {
      ctx.skip();
    }
    const r = runNode([link]);
    expect(JSON.parse(r.stdout)).toEqual({ main: true, helper: false });
  });

  it.skipIf(!isWin)('ignores drive letter and path casing on Windows', () => {
    writeScripts(join(tmp, 'real'));
    // Keep the extension lowercase: Node picks the module format by it.
    const dir = join(tmp, 'real');
    const recased = `${dir[0].toLowerCase()}${dir.slice(1).toUpperCase()}\\main.mjs`;
    const r = runNode([recased]);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).main).toBe(true);
    const main = join(dir, 'main.mjs');
    expect(isMain(pathToFileURL(main).href, recased)).toBe(true);
  });

  it('is false under node -e, where there is no script path', () => {
    const r = runModule(`import { isMain } from ${cliUrl}; console.log(JSON.stringify([isMain(import.meta.url), isMain(${cliUrl})]));`);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual([false, false]);
  });
});

describe('isMain in process', () => {
  it('is false inside the test runner', () => {
    expect(isMain(import.meta.url)).toBe(false);
  });

  it('compares against an explicit argv1', () => {
    const main = writeScripts(join(tmp, 'real'));
    expect(isMain(pathToFileURL(main).href, main)).toBe(true);
    expect(isMain(pathToFileURL(main).href, join(tmp, 'real', 'helper.mjs'))).toBe(false);
  });

  it('resolves a junction passed as argv1', () => {
    const main = writeScripts(join(tmp, 'real'));
    symlinkSync(join(tmp, 'real'), join(tmp, 'link'), 'junction');
    expect(isMain(pathToFileURL(main).href, join(tmp, 'link', 'main.mjs'))).toBe(true);
  });

  it('is false for a missing argv1 or a path that does not exist', () => {
    const url = pathToFileURL(join(tmp, 'x.mjs')).href;
    expect(isMain(url, undefined)).toBe(false);
    expect(isMain(url, '')).toBe(false);
    expect(isMain(url, join(tmp, 'x.mjs'))).toBe(false);
  });

  it('is false for a metaUrl that is not a file URL', () => {
    const main = writeScripts(join(tmp, 'real'));
    expect(isMain('data:text/javascript,1', main)).toBe(false);
    expect(isMain('not a url', main)).toBe(false);
    expect(isMain('', main)).toBe(false);
    expect(isMain(undefined, main)).toBe(false);
  });
});

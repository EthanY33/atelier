/**
 * How accessibility-design-audit tells a URL from a file path, checked on
 * every platform with a simulated file at the path a URL collapses to.
 *
 * path.resolve() turns "https://staging.example.com" into
 * <cwd>/https:/staging.example.com. POSIX can hold a real file there (see the
 * real-file test in accessibility-design-audit.test.mjs); Windows cannot,
 * because ':' is not allowed in file names, so the lookup is faked here.
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Faked paths: absolute path -> true for a directory, false for a file. */
const shadow = vi.hoisted(() => new Map());

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal();
  const fake = {
    ...real,
    existsSync: (p) => shadow.has(String(p)) || real.existsSync(p),
    statSync: (p, options) => {
      if (!shadow.has(String(p))) return real.statSync(p, options);
      const isDir = shadow.get(String(p));
      return { isDirectory: () => isDir, isFile: () => !isDir };
    },
  };
  return { ...fake, default: fake };
});

const { auditPage } = await import('../plugins/atelier/skills/accessibility-design-audit/index.mjs');

/** A browser stand-in that records what page.goto is asked to open, then fails the navigation. */
function recordingBrowser(opened) {
  const page = {
    setDefaultTimeout() {},
    goto: async (url) => {
      opened.push(url);
      throw new Error('stub browser: navigation refused');
    },
  };
  const context = { newPage: async () => page, route: async () => {}, close: async () => {} };
  return { newContext: async () => context };
}

async function openedBy(url) {
  const opened = [];
  const err = await auditPage({ url, outDir: 'unused-a11y-out', browser: recordingBrowser(opened) }).catch((e) => e);
  return { opened, err };
}

afterEach(() => shadow.clear());

describe('auditPage target resolution', () => {
  it('opens a URL as a URL when a file with the same name exists under the working directory', async () => {
    for (const url of ['https://staging.example.com', 'http://localhost:4173']) {
      shadow.set(resolve(url), false);
      const { opened, err } = await openedBy(url);
      expect(opened).toEqual([url]);
      expect(err).toMatchObject({ code: 'NAVIGATION_FAILED' });
    }
  });

  it('opens a URL as a URL when a folder with the same name exists (no INPUT_IS_DIRECTORY)', async () => {
    const url = 'https://staging.example.com';
    shadow.set(resolve(url), true);
    const { opened, err } = await openedBy(url);
    expect(opened).toEqual([url]);
    expect(err).toMatchObject({ code: 'NAVIGATION_FAILED' });
  });

  it('an unsupported scheme is refused even when a file with that name exists, with a hint for the file', async () => {
    shadow.set(resolve('notes:draft.html'), false);
    const { opened, err } = await openedBy('notes:draft.html');
    expect(opened).toEqual([]);
    expect(err).toMatchObject({ code: 'UNSUPPORTED_SCHEME' });
    expect(err.message).toContain('./notes:draft.html');
  });
});

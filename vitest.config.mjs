import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // Most test files launch their own Chromium (and some run sharp or
    // ffmpeg), so every worker costs hundreds of MB. Vitest's default of
    // one worker per core minus one starts 11 browsers on a 12-core laptop
    // and crashes workers with out-of-memory errors; four is what a CI
    // runner gets anyway. Pass --maxWorkers to override.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Gate the code that ships in the plugin. The demo runner and the
      // repo-level asset-build scripts are exercised end to end, not unit
      // tested, so they stay out of the denominator.
      include: [
        'plugins/atelier/skills/**/*.mjs',
        'plugins/atelier/lib/**/*.mjs',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70
      }
    },
    testTimeout: 120_000,
    // Hooks that launch or close Chromium can take several seconds when the
    // whole suite runs in parallel. Vitest's 10 s default flakes on CI runners.
    hookTimeout: 60_000
  }
});

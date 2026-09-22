import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
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
    testTimeout: 120_000
  }
});

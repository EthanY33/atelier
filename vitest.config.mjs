import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'plugins/atelier/skills/**/*.mjs',
        'scripts/**/*.mjs'
      ],
      exclude: ['scripts/run-demo.mjs'],
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

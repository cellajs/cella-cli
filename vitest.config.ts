import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'cella',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['src/infra/**', 'tests/release-smoke.test.ts'],
          testTimeout: 30000,
          fileParallelism: true,
        },
      },
      {
        test: {
          name: 'infra',
          environment: 'node',
          include: ['src/infra/**/*.test.ts'],
          setupFiles: ['src/infra/tests/setup.ts'],
          testTimeout: 5000,
        },
      },
    ],
  },
});

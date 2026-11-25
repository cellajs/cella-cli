import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'cella',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/release-smoke.test.ts'],
          testTimeout: 30000,
          fileParallelism: true,
        },
      },
      {
        // The fixture app imports the engine's helpers as an app does, from the package's `infra` export
        resolve: { alias: { '@cellajs/cli/infra': fileURLToPath(new URL('./src/infra/exports.ts', import.meta.url)) } },
        test: {
          name: 'infra',
          environment: 'node',
          include: ['src/infra/**/*.test.ts'],
          testTimeout: 5000,
        },
      },
    ],
  },
});

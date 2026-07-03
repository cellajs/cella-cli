import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Dedicated config for the release smoke test. It packs the tarball, installs it into a
// temp app, and verifies the published executable plus config export.
export default defineConfig({
  resolve: {
    alias: {
      '#': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/release-smoke.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 300000,
    onConsoleLog: () => false,
  },
});

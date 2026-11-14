import { defineConfig } from 'vitest/config';

// The release smoke test alone: it packs the package, installs it into a throwaway app and runs the installed files
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/release-smoke.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 300000, // 5 minutes: pack and install
    onConsoleLog: () => false,
  },
});

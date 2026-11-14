import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cella',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/release-smoke.test.ts'],
    testTimeout: 30000,
    fileParallelism: true,
  },
});

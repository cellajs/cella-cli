/**
 * `node:child_process` with `spawnSync` stubbed for full `runSyncCommand` runs: `pnpm`
 * (install + check) succeeds without running, `gh` is reported missing.
 *
 * This module must not import `node:child_process` (not even via test-env): the `vi.mock`
 * factory below runs while that mock is being built, and a circular resolve deadlocks vitest.
 * Use it from a factory, importing it dynamically inside:
 *
 *   vi.mock('node:child_process', async (importOriginal) => {
 *     const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
 *     return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
 *   });
 */
export function mockPnpmAndGh(actual: typeof import('node:child_process')): typeof import('node:child_process') {
  const spawnSync = ((command: string, ...rest: unknown[]) => {
    if (command === 'pnpm') return { status: 0, stdout: '', stderr: '' };
    if (command === 'gh') return { status: 1, stdout: '', stderr: '' };
    return (actual.spawnSync as (...args: unknown[]) => unknown)(command, ...rest);
  }) as typeof import('node:child_process')['spawnSync'];
  return { ...actual, spawnSync };
}

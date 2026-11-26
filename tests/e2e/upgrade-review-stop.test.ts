/**
 * A clean upgrade merge stops for review before anything it brought runs. The run that merges starts
 * no `pnpm` and names what decides what runs; the rerun recognises the finished merge, installs,
 * checks and commits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpgradeCommand } from '../../src/upstream/upgrade';
import { buildRuntimeConfig, createTestEnv, exec, makeCommit, type TestEnv } from '../helpers/test-env';

const pnpmRuns = vi.hoisted((): string[][] => []);

vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  const mocked = mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
  const spawnSync = ((command: string, args: string[], ...rest: unknown[]) => {
    if (command === 'pnpm') pnpmRuns.push(args);
    return (mocked.spawnSync as (...args: unknown[]) => unknown)(command, args, ...rest);
  }) as typeof mocked.spawnSync;
  return { ...mocked, spawnSync };
});

describe('upgrade review stop', () => {
  let env: TestEnv;
  let lines: string[];

  beforeEach(() => {
    env = createTestEnv();
    // The test app is a clone of upstream: without this its trunk tracks upstream and fast-forwards to it
    exec('git branch --unset-upstream main', env.repoRoot);
    pnpmRuns.length = 0;
    lines = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  it('starts no pnpm in the run that makes a clean merge, and names what decides what runs', async () => {
    makeCommit(env.upstreamPath, {
      files: {
        'package.json': '{"name": "test-upstream", "dependencies": {"left-pad": "github:attacker/left-pad"}}\n',
        '.github/workflows/ci.yml': 'on: push\n',
      },
      message: 'feat: ci',
    });
    const config = buildRuntimeConfig(env);

    expect(await runUpgradeCommand(config)).toBe(0);
    expect(pnpmRuns).toEqual([]);
    expect(lines.join('\n')).toMatch(
      /→ \.github\/workflows\/ci\.yml\n.*→ package\.json .*dependencies\.left-pad github:attacker\/left-pad/,
    );

    expect(await runUpgradeCommand(config)).toBe(0);
    expect(pnpmRuns).toEqual([['install', '--no-frozen-lockfile'], ['check']]);
    expect(exec('git log -1 --format=%s', env.repoRoot)).toMatch(/^chore: upgrade cella to/);
  });
});

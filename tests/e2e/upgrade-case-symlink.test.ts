/**
 * Upstream adds, under a folder the app ignores, a symlink to a folder outside the app and a folder that differs from
 * it only in letter case. A case-insensitive disk resolves that folder through the symlink. Removing the arriving file
 * in it once deleted the file outside the app.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runUpgradeCommand } from '../../src/upstream/upgrade';
import { removeFilesFully } from '../../src/utils/git';
import { buildRuntimeConfig, createTestEnv, exec, type TestEnv } from '../helpers/test-env';

vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
});

let env: TestEnv;
let victim: string;

beforeEach(() => {
  env = createTestEnv();
  exec('git branch --unset-upstream main', env.repoRoot);
  victim = path.join(env.testDir, 'victim', 'target.txt');
  fs.mkdirSync(path.dirname(victim));
  fs.writeFileSync(victim, 'outside the app\n');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  env.cleanup();
});

it('refuses an arriving symlink beside a folder that differs from it in case', async () => {
  // Both paths in one tree: the disk cannot hold them side by side
  const blob = (content: string) =>
    execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: env.upstreamPath, input: content }).toString().trim();
  exec(`git update-index --add --cacheinfo 120000,${blob(path.dirname(victim))},own/link`, env.upstreamPath);
  exec(`git update-index --add --cacheinfo 100644,${blob('x\n')},own/Link/target.txt`, env.upstreamPath);
  exec('git commit -q -m "feat: own"', env.upstreamPath);

  await expect(runUpgradeCommand(buildRuntimeConfig(env, { ignored: ['own'] }))).rejects.toThrow(/differ only in letter case/);
  expect(fs.existsSync(victim)).toBe(true);
});

it('refuses to remove a file whose folder resolves through a symlink', async () => {
  fs.mkdirSync(path.join(env.repoRoot, 'own'));
  fs.symlinkSync(path.dirname(victim), path.join(env.repoRoot, 'own/link'));

  await expect(removeFilesFully(env.repoRoot, ['own/link/target.txt'])).rejects.toThrow(/refused to change/);
  expect(fs.existsSync(victim)).toBe(true);
});

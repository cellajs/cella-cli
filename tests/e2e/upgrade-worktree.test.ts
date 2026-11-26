/**
 * Tests for running `cella upgrade` from a linked git worktree.
 *
 * Git refuses to switch to a branch another worktree has checked out, so the upgrade never checks
 * the trunk out: it compares refs to bring the trunk up to date, cuts the upgrade branch from where
 * the run started, and detaches at the trunk after shipping when the main checkout holds it.
 * Covers the worktree-aware git helpers and full `runUpgradeCommand` runs, with `pnpm` (install +
 * check) stubbed and `gh` reported missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/config/types';
import { runUpgradeCommand } from '../../src/upstream/upgrade';
import { fastForwardBranch, getBranchWorktree, getTrackingStatus, merge, mergeInProgress } from '../../src/utils/git';
import { buildRuntimeConfig, createTestEnv, exec, makeCommit, type TestEnv } from '../helpers/test-env';

vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
});

/**
 * App with an `origin` (bare clone) that `main` tracks, plus a linked worktree at `<testDir>/wt`.
 * `worktreeArgs` picks what the worktree checks out (default: a new `work` branch off main).
 */
function setupAppWithWorktree(env: TestEnv, worktreeArgs = '-b work'): string {
  const originPath = path.join(env.testDir, 'origin.git');
  exec(`git clone -q --bare ${env.repoRoot} ${originPath}`, env.testDir);
  exec(`git remote add origin ${originPath}`, env.repoRoot);
  exec('git fetch -q origin && git branch -q -u origin/main main', env.repoRoot);

  const worktreePath = path.join(env.testDir, 'wt');
  exec(`git worktree add -q ${worktreeArgs} ${worktreePath} main`, env.repoRoot);
  return worktreePath;
}

/**
 * Move `origin/main` one commit past the app's local `main` (a teammate pushed), a merge commit
 * when `merge` is set. Returns the new tip.
 */
function pushTeammateCommit(env: TestEnv, { merge = false } = {}): string {
  if (merge) exec('git switch -q -c topic', env.repoRoot);
  makeCommit(env.repoRoot, { files: { 'team.ts': 'export const t = 1;\n' }, message: 'feat: team' });
  if (merge) exec('git switch -q main && git merge -q --no-ff topic -m "Merge topic"', env.repoRoot);
  const pushed = exec('git rev-parse HEAD', env.repoRoot);
  exec('git push -q origin main && git reset -q --hard HEAD~1', env.repoRoot);
  return pushed;
}

function upgradeConfig(env: TestEnv, repoRoot: string): RuntimeConfig {
  return { ...buildRuntimeConfig(env), repoRoot };
}

/** Merge upstream in `repoRoot` and commit it: the merge run stops for review, the rerun commits. */
async function upgradeAndCommit(env: TestEnv, repoRoot: string): Promise<void> {
  await runUpgradeCommand(upgradeConfig(env, repoRoot));
  await runUpgradeCommand(upgradeConfig(env, repoRoot));
}

describe('upgrade from a linked worktree', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.cleanup();
  });

  describe('worktree-aware git helpers', () => {
    it('finds the worktree that has a branch checked out', async () => {
      const worktreePath = setupAppWithWorktree(env);

      expect(fs.realpathSync(String(await getBranchWorktree(worktreePath, 'main')))).toBe(
        fs.realpathSync(env.repoRoot),
      );
      expect(fs.realpathSync(String(await getBranchWorktree(env.repoRoot, 'work')))).toBe(
        fs.realpathSync(worktreePath),
      );
      exec('git branch idle', env.repoRoot);
      expect(await getBranchWorktree(env.repoRoot, 'idle')).toBeNull();
    });

    it('compares a branch with its upstream without checking it out', async () => {
      const worktreePath = setupAppWithWorktree(env);
      pushTeammateCommit(env);

      expect(await getTrackingStatus(worktreePath, 'main')).toEqual({ tracking: 'origin/main', ahead: 0, behind: 1 });
      expect(await getTrackingStatus(worktreePath)).toEqual({ tracking: null, ahead: 0, behind: 0 });
    });

    it('fast-forwards a branch by ref only when no worktree has it checked out', async () => {
      const worktreePath = setupAppWithWorktree(env);
      const pushed = pushTeammateCommit(env);

      await expect(fastForwardBranch(worktreePath, 'main', 'origin/main')).rejects.toThrow();

      exec('git switch -q -c parked', env.repoRoot);
      await fastForwardBranch(worktreePath, 'main', 'origin/main');
      expect(exec('git rev-parse main', env.repoRoot)).toBe(pushed);
    });

    it('sees a merge in progress in a linked worktree', async () => {
      const worktreePath = setupAppWithWorktree(env);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });
      exec('git fetch -q cella-upstream', worktreePath);

      expect(await mergeInProgress(worktreePath)).toBe(false);
      await merge(worktreePath, 'cella-upstream/main');
      expect(await mergeInProgress(worktreePath)).toBe(true);
      expect(await mergeInProgress(env.repoRoot)).toBe(false);
    });
  });

  describe('runUpgradeCommand', () => {
    it('cuts the upgrade branch from origin when the main checkout holds a stale trunk', async () => {
      const worktreePath = setupAppWithWorktree(env);
      const pushed = pushTeammateCommit(env);
      const localMain = exec('git rev-parse main', env.repoRoot);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });

      await upgradeAndCommit(env, worktreePath);

      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toMatch(/^cella\/upgrade\//);
      expect(fs.existsSync(path.join(worktreePath, 'upstream.ts'))).toBe(true);
      // One single-parent commit on top of origin's trunk (the merge state is gone in the worktree too)
      expect(exec('git log -1 --format=%P', worktreePath)).toBe(pushed);
      expect(exec('git log -1 --format=%s', worktreePath)).toMatch(/^chore: upgrade cella to/);
      expect(exec('git status --porcelain', worktreePath)).toBe('');
      // The main checkout and its trunk are left alone
      expect(exec('git rev-parse --abbrev-ref HEAD', env.repoRoot)).toBe('main');
      expect(exec('git rev-parse main', env.repoRoot)).toBe(localMain);
      expect(exec('git status --porcelain', env.repoRoot)).toBe('');
    });

    it('ships from the worktree and detaches at the trunk the main checkout holds', async () => {
      const worktreePath = setupAppWithWorktree(env);
      // A merge commit between the stale trunk and origin's must not read as part of the upgrade branch
      const pushed = pushTeammateCommit(env, { merge: true });
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });
      await upgradeAndCommit(env, worktreePath);
      const branch = exec('git rev-parse --abbrev-ref HEAD', worktreePath);
      const committed = exec('git rev-parse HEAD', worktreePath);

      await runUpgradeCommand(upgradeConfig(env, worktreePath));

      // Pushed as committed: one upgrade commit on top of origin's trunk, nothing flattened into it
      expect(exec(`git ls-remote --heads origin ${branch}`, worktreePath).split(/\s+/)[0]).toBe(committed);
      expect(exec(`git log -1 --format=%P ${committed}`, worktreePath)).toBe(pushed);
      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toBe('HEAD');
      expect(exec('git rev-parse HEAD', worktreePath)).toBe(exec('git rev-parse main', env.repoRoot));
      expect(exec('git rev-parse --abbrev-ref HEAD', env.repoRoot)).toBe('main');
    });

    it('titles the PR after the upgrade commit when drift-triage commits sit on top', async () => {
      const worktreePath = setupAppWithWorktree(env);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });
      await upgradeAndCommit(env, worktreePath);
      const upgradeSubject = exec('git log -1 --format=%s', worktreePath);
      makeCommit(worktreePath, { files: { 'triage.ts': 'export const t = 1;\n' }, message: 'fix: drift triage' });

      await runUpgradeCommand(upgradeConfig(env, worktreePath));

      expect(upgradeSubject).toMatch(/^chore: upgrade cella to \S+/);
      const printed = vi.mocked(console.info).mock.calls.map((args) => args.join(' '));
      expect(printed.some((line) => line.includes(`--title "${upgradeSubject}"`))).toBe(true);
    });

    it('returns a detached worktree to its start commit when there is nothing to upgrade', async () => {
      const worktreePath = setupAppWithWorktree(env, '--detach');
      const start = exec('git rev-parse HEAD', worktreePath);

      await runUpgradeCommand(upgradeConfig(env, worktreePath));

      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toBe('HEAD');
      expect(exec('git rev-parse HEAD', worktreePath)).toBe(start);
      expect(exec('git branch --list "cella/upgrade/*"', worktreePath)).toBe('');
    });

    it('fast-forwards a trunk no worktree holds and cuts from it, in a single checkout', async () => {
      setupAppWithWorktree(env);
      exec(`git worktree remove ${path.join(env.testDir, 'wt')}`, env.repoRoot);
      const pushed = pushTeammateCommit(env);
      exec('git switch -q work', env.repoRoot);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });

      await upgradeAndCommit(env, env.repoRoot);

      expect(exec('git rev-parse main', env.repoRoot)).toBe(pushed);
      expect(exec('git log -1 --format=%P', env.repoRoot)).toBe(pushed);
      expect(exec('git rev-parse --abbrev-ref HEAD', env.repoRoot)).toMatch(/^cella\/upgrade\//);
    });
  });
});

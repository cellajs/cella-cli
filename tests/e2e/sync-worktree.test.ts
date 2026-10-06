/**
 * Tests for running `cella sync` from a linked git worktree.
 *
 * Git refuses to switch to a branch another worktree has checked out, so the sync never checks
 * the trunk out: it compares refs to bring the trunk up to date, cuts the sync branch from where
 * the run started, and detaches at the trunk after shipping when the main checkout holds it.
 * Covers the worktree-aware git helpers and full `runSyncCommand` runs, with `pnpm` (install +
 * check) stubbed and `gh` reported missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/config/types';
import { runSyncCommand } from '../../src/services/sync';
import { fastForwardBranch, getBranchWorktree, getUpstreamStatus, merge, mergeInProgress } from '../../src/utils/git';
import { buildRuntimeConfig, createTestEnv, exec, makeCommit, type TestEnv } from '../helpers/test-env';

vi.mock('node:child_process', async (importOriginal) => {
  const { mockPnpmAndGh } = await import('../helpers/mock-pnpm-gh');
  return mockPnpmAndGh(await importOriginal<typeof import('node:child_process')>());
});

/**
 * Fork with an `origin` (bare clone) that `main` tracks, plus a linked worktree at `<testDir>/wt`.
 * `worktreeArgs` picks what the worktree checks out (default: a new `work` branch off main).
 */
function setupForkWithWorktree(env: TestEnv, worktreeArgs = '-b work'): string {
  const originPath = path.join(env.testDir, 'origin.git');
  exec(`git clone -q --bare ${env.forkPath} ${originPath}`, env.testDir);
  exec(`git remote add origin ${originPath}`, env.forkPath);
  exec('git fetch -q origin && git branch -q -u origin/main main', env.forkPath);

  const worktreePath = path.join(env.testDir, 'wt');
  exec(`git worktree add -q ${worktreeArgs} ${worktreePath} main`, env.forkPath);
  return worktreePath;
}

/**
 * Move `origin/main` one commit past the fork's local `main` (a teammate pushed), a merge commit
 * when `merge` is set. Returns the new tip.
 */
function pushTeammateCommit(env: TestEnv, { merge = false } = {}): string {
  if (merge) exec('git switch -q -c topic', env.forkPath);
  makeCommit(env.forkPath, { files: { 'team.ts': 'export const t = 1;\n' }, message: 'feat: team' });
  if (merge) exec('git switch -q main && git merge -q --no-ff topic -m "Merge topic"', env.forkPath);
  const pushed = exec('git rev-parse HEAD', env.forkPath);
  exec('git push -q origin main && git reset -q --hard HEAD~1', env.forkPath);
  return pushed;
}

function syncConfig(env: TestEnv, forkPath: string): RuntimeConfig {
  return { ...buildRuntimeConfig(env, { service: 'sync' }), forkPath };
}

describe('sync from a linked worktree', () => {
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
      const worktreePath = setupForkWithWorktree(env);

      expect(fs.realpathSync(String(await getBranchWorktree(worktreePath, 'main')))).toBe(
        fs.realpathSync(env.forkPath),
      );
      expect(fs.realpathSync(String(await getBranchWorktree(env.forkPath, 'work')))).toBe(
        fs.realpathSync(worktreePath),
      );
      exec('git branch idle', env.forkPath);
      expect(await getBranchWorktree(env.forkPath, 'idle')).toBeNull();
    });

    it('compares a branch with its upstream without checking it out', async () => {
      const worktreePath = setupForkWithWorktree(env);
      pushTeammateCommit(env);

      expect(await getUpstreamStatus(worktreePath, 'main')).toEqual({ upstream: 'origin/main', ahead: 0, behind: 1 });
      expect(await getUpstreamStatus(worktreePath)).toEqual({ upstream: null, ahead: 0, behind: 0 });
    });

    it('fast-forwards a branch by ref only when no worktree has it checked out', async () => {
      const worktreePath = setupForkWithWorktree(env);
      const pushed = pushTeammateCommit(env);

      await expect(fastForwardBranch(worktreePath, 'main', 'origin/main')).rejects.toThrow();

      exec('git switch -q -c parked', env.forkPath);
      await fastForwardBranch(worktreePath, 'main', 'origin/main');
      expect(exec('git rev-parse main', env.forkPath)).toBe(pushed);
    });

    it('sees a merge in progress in a linked worktree', async () => {
      const worktreePath = setupForkWithWorktree(env);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });
      exec('git fetch -q cella-upstream', worktreePath);

      expect(await mergeInProgress(worktreePath)).toBe(false);
      await merge(worktreePath, 'cella-upstream/main');
      expect(await mergeInProgress(worktreePath)).toBe(true);
      expect(await mergeInProgress(env.forkPath)).toBe(false);
    });
  });

  describe('runSyncCommand', () => {
    it('cuts the sync branch from origin when the main checkout holds a stale trunk', async () => {
      const worktreePath = setupForkWithWorktree(env);
      const pushed = pushTeammateCommit(env);
      const localMain = exec('git rev-parse main', env.forkPath);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });

      await runSyncCommand(syncConfig(env, worktreePath));

      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toMatch(/^cella\/sync\//);
      expect(fs.existsSync(path.join(worktreePath, 'upstream.ts'))).toBe(true);
      // One single-parent commit on top of origin's trunk (the merge state is gone in the worktree too)
      expect(exec('git log -1 --format=%P', worktreePath)).toBe(pushed);
      expect(exec('git log -1 --format=%s', worktreePath)).toMatch(/^chore: sync upstream cella/);
      expect(exec('git status --porcelain', worktreePath)).toBe('');
      // The main checkout and its trunk are left alone
      expect(exec('git rev-parse --abbrev-ref HEAD', env.forkPath)).toBe('main');
      expect(exec('git rev-parse main', env.forkPath)).toBe(localMain);
      expect(exec('git status --porcelain', env.forkPath)).toBe('');
    });

    it('ships from the worktree and detaches at the trunk the main checkout holds', async () => {
      const worktreePath = setupForkWithWorktree(env);
      // A merge commit between the stale trunk and origin's must not read as part of the sync branch
      const pushed = pushTeammateCommit(env, { merge: true });
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });
      await runSyncCommand(syncConfig(env, worktreePath));
      const branch = exec('git rev-parse --abbrev-ref HEAD', worktreePath);
      const committed = exec('git rev-parse HEAD', worktreePath);

      await runSyncCommand(syncConfig(env, worktreePath));

      // Pushed as committed: one sync commit on top of origin's trunk, nothing flattened into it
      expect(exec(`git ls-remote --heads origin ${branch}`, worktreePath).split(/\s+/)[0]).toBe(committed);
      expect(exec(`git log -1 --format=%P ${committed}`, worktreePath)).toBe(pushed);
      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toBe('HEAD');
      expect(exec('git rev-parse HEAD', worktreePath)).toBe(exec('git rev-parse main', env.forkPath));
      expect(exec('git rev-parse --abbrev-ref HEAD', env.forkPath)).toBe('main');
    });

    it('returns a detached worktree to its start commit when there is nothing to sync', async () => {
      const worktreePath = setupForkWithWorktree(env, '--detach');
      const start = exec('git rev-parse HEAD', worktreePath);

      await runSyncCommand(syncConfig(env, worktreePath));

      expect(exec('git rev-parse --abbrev-ref HEAD', worktreePath)).toBe('HEAD');
      expect(exec('git rev-parse HEAD', worktreePath)).toBe(start);
      expect(exec('git branch --list "cella/sync/*"', worktreePath)).toBe('');
    });

    it('fast-forwards a trunk no worktree holds and cuts from it, in a single checkout', async () => {
      setupForkWithWorktree(env);
      exec(`git worktree remove ${path.join(env.testDir, 'wt')}`, env.forkPath);
      const pushed = pushTeammateCommit(env);
      exec('git switch -q work', env.forkPath);
      makeCommit(env.upstreamPath, { files: { 'upstream.ts': 'export const u = 1;\n' }, message: 'feat: upstream' });

      await runSyncCommand(syncConfig(env, env.forkPath));

      expect(exec('git rev-parse main', env.forkPath)).toBe(pushed);
      expect(exec('git log -1 --format=%P', env.forkPath)).toBe(pushed);
      expect(exec('git rev-parse --abbrev-ref HEAD', env.forkPath)).toMatch(/^cella\/sync\//);
    });
  });
});

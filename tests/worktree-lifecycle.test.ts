/**
 * Tests for leftover-worktree cleanup.
 *
 * Covers `cleanupLeftoverWorktrees`: removing interrupted sync worktrees,
 * removing legacy upstream-view worktrees created by older CLI versions
 * (before browser diffs replaced the view worktree), and pruning orphaned
 * git worktree registrations for both prefixes.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupLeftoverWorktrees, getWorktreePath } from '../src/utils/cleanup';
import { createWorktree, listWorktrees, removeWorktree } from '../src/utils/git';

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function createRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cella-worktree-test-'));
  exec('git init -b main', dir);
  exec('git config user.email "test@test.com" && git config user.name "Test"', dir);
  fs.writeFileSync(path.join(dir, 'initial.txt'), 'initial\n');
  exec('git add -A && git commit -m "initial"', dir);
  return dir;
}

/** Path older CLI versions used for the persistent upstream-view worktree. */
function legacyViewWorktreePath(repoPath: string): string {
  return path.join(os.tmpdir(), `cella-view-${path.basename(repoPath)}`);
}

describe('cleanupLeftoverWorktrees', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createRepo();
  });

  afterEach(async () => {
    for (const wtPath of [legacyViewWorktreePath(repoPath), getWorktreePath(repoPath)]) {
      await removeWorktree(repoPath, wtPath);
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('removes a leftover sync worktree from an interrupted run', async () => {
    const syncPath = getWorktreePath(repoPath);
    await createWorktree(repoPath, syncPath, 'HEAD');

    await cleanupLeftoverWorktrees(repoPath);

    expect(fs.existsSync(syncPath)).toBe(false);
    expect(await listWorktrees(repoPath)).not.toContain(syncPath);
  });

  it('removes a legacy upstream-view worktree from an older CLI version', async () => {
    const viewPath = legacyViewWorktreePath(repoPath);
    await createWorktree(repoPath, viewPath, 'HEAD');

    await cleanupLeftoverWorktrees(repoPath);

    expect(fs.existsSync(viewPath)).toBe(false);
    expect(await listWorktrees(repoPath)).not.toContain(viewPath);
  });

  it('prunes orphaned refs for both sync and view prefixes', async () => {
    const syncPath = getWorktreePath(repoPath);
    const viewPath = legacyViewWorktreePath(repoPath);
    await createWorktree(repoPath, syncPath, 'HEAD');
    await createWorktree(repoPath, viewPath, 'HEAD');

    // Orphan both by deleting their directories (registrations remain in git).
    fs.rmSync(syncPath, { recursive: true, force: true });
    fs.rmSync(viewPath, { recursive: true, force: true });

    await cleanupLeftoverWorktrees(repoPath);

    const worktrees = await listWorktrees(repoPath);
    expect(worktrees).not.toContain(syncPath);
    expect(worktrees).not.toContain(viewPath);
  });

  it('is a no-op when nothing is left over', async () => {
    await cleanupLeftoverWorktrees(repoPath);

    expect(await listWorktrees(repoPath)).toHaveLength(1); // just the main worktree
  });
});

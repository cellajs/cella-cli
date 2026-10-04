/**
 * E2E tests for sync CLI services.
 *
 * These tests create real git repos and run the actual sync services
 * to verify end-to-end behavior.
 */
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalyze } from '../../src/services/analyze';
import { UpstreamConfigChangedError } from '../../src/services/merge-engine';
import { runSync } from '../../src/services/sync';
import { commitSquash, fetchUpstreamTags, resolveUpstreamCommit, stageAll } from '../../src/utils/git';
import {
  buildRuntimeConfig,
  createTestEnv,
  deleteFileAndCommit,
  fetchUpstream,
  fileExists,
  makeCommit,
  readRepoFile,
  renameFileAndCommit,
  resetFork,
  type TestEnv,
  tagUpstream,
} from './helpers/test-env';

describe('sync e2e', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    resetFork(env.forkPath);
    env.cleanup();
  });

  describe('analyze service', () => {
    it('should detect fork is identical to upstream', async () => {
      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      expect(result.summary.identical).toBeGreaterThan(0);
      expect(result.summary.behind).toBe(0);
      expect(result.summary.diverged).toBe(0);
    });

    it('should detect fork is behind when upstream has new commits', async () => {
      // Add new file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'new-feature.ts': '// New feature\nexport const feature = true;\n' },
        message: 'feat: add new feature',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      expect(result.summary.behind).toBeGreaterThan(0);

      const behindFile = result.files.find((f) => f.path === 'new-feature.ts');
      expect(behindFile).toBeDefined();
      expect(behindFile?.status).toBe('behind');
    });

    it('should detect diverged files when both sides modify', async () => {
      // Add file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'shared.ts': '// Upstream version\nexport const source = "upstream";\n' },
        message: 'chore: add shared file',
      });

      // Add same file to fork with different content
      makeCommit(env.forkPath, {
        files: { 'shared.ts': '// Fork version\nexport const source = "fork";\n' },
        message: 'chore: add shared file',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      const divergedFile = result.files.find((f) => f.path === 'shared.ts');
      expect(divergedFile).toBeDefined();
      expect(divergedFile?.status).toBe('diverged');
    });

    it('should mark pinned files as ahead', async () => {
      // Modify file in upstream
      makeCommit(env.upstreamPath, {
        files: { 'backend/src/index.ts': '// Updated backend\nexport const backend = "v2";\n' },
        message: 'chore: update backend',
      });

      // Modify same file in fork (will be pinned)
      makeCommit(env.forkPath, {
        files: { 'backend/src/index.ts': '// Fork custom backend\nexport const backend = "fork";\n' },
        message: 'chore: customize backend',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'analyze',
        pinned: ['backend/src/index.ts'],
      });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      const pinnedFile = result.files.find((f) => f.path === 'backend/src/index.ts');
      expect(pinnedFile).toBeDefined();
      expect(pinnedFile?.isPinned).toBe(true);
      // Pinned diverged files show as 'pinned' status
      expect(pinnedFile?.status).toBe('pinned');
    });

    it('should summarize changed managed files separately from protected files', async () => {
      makeCommit(env.forkPath, {
        files: {
          'package.json': '{"name": "test-fork", "dependencies": {"fork-only": "1.0.0"}}\n',
          'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n\npackages:\n  fork-only: {}\n',
          'cella/cella.config.ts': 'export default { settings: { upstreamUrl: "fork" } };\n',
          'backend/src/index.ts': '// Fork custom backend\nexport const backend = "fork";\n',
        },
        message: 'chore: customize managed files and backend',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'analyze',
        pinned: ['backend/src/index.ts'],
      });

      const result = await runAnalyze(config);

      expect(result.summary.managed).toBe(3);
      expect(result.summary.ahead).toBe(1);
      expect(result.files.find((f) => f.path === 'package.json')?.status).toBe('ahead');
      expect(result.files.find((f) => f.path === 'pnpm-lock.yaml')?.status).toBe('local');
      expect(result.files.find((f) => f.path === 'cella/cella.config.ts')?.status).toBe('local');
    });

    it('should mark ignored files correctly', async () => {
      // Add file in ignored path to upstream
      makeCommit(env.upstreamPath, {
        files: { 'docs/guide.md': '# Guide\nThis is ignored.\n' },
        message: 'docs: add guide',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'analyze',
        ignored: ['docs'],
      });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      const ignoredFile = result.files.find((f) => f.path === 'docs/guide.md');
      expect(ignoredFile).toBeDefined();
      expect(ignoredFile?.isIgnored).toBe(true);
      expect(ignoredFile?.status).toBe('ignored');
    });
  });

  describe('sync service', () => {
    it('should sync new files from upstream', async () => {
      // Add new file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'new-feature.ts': '// New feature\nexport const feature = true;\n' },
        message: 'feat: add new feature',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'sync' });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(fileExists(env.forkPath, 'new-feature.ts')).toBe(true);
      expect(readRepoFile(env.forkPath, 'new-feature.ts')).toContain('New feature');
    });

    it('should preserve pinned files during sync', async () => {
      const forkContent = '// Fork custom\nexport const custom = "fork";\n';

      // Add file to fork first (pinned)
      makeCommit(env.forkPath, {
        files: { 'custom.ts': forkContent },
        message: 'chore: add custom file',
      });

      // Add same file to upstream with different content
      makeCommit(env.upstreamPath, {
        files: { 'custom.ts': '// Upstream version\nexport const custom = "upstream";\n' },
        message: 'chore: add custom file',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'sync',
        pinned: ['custom.ts'],
      });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      // Fork version should be preserved
      expect(readRepoFile(env.forkPath, 'custom.ts')).toBe(forkContent);
    });

    it('should skip ignored files during sync', async () => {
      // Add file in ignored path to upstream
      makeCommit(env.upstreamPath, {
        files: { 'docs/internal.md': '# Internal\nThis should be ignored.\n' },
        message: 'docs: add internal doc',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'sync',
        ignored: ['docs'],
      });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      // File should NOT be added to fork
      expect(fileExists(env.forkPath, 'docs/internal.md')).toBe(false);
    });

    it('should update modified files from upstream', async () => {
      // Modify existing file in upstream
      makeCommit(env.upstreamPath, {
        files: { 'README.md': '# Updated Readme\nThis is the new version.\n' },
        message: 'docs: update readme',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'sync' });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(readRepoFile(env.forkPath, 'README.md')).toContain('Updated Readme');
    });

    it('should handle file deletions from upstream', async () => {
      // Add a file to upstream first
      makeCommit(env.upstreamPath, {
        files: { 'temp.ts': '// Temporary file\n' },
        message: 'chore: add temp file',
      });

      // Sync to get the file
      fetchUpstream(env.forkPath);
      let config = buildRuntimeConfig(env, { service: 'sync' });
      await runSync(config);

      expect(fileExists(env.forkPath, 'temp.ts')).toBe(true);

      // Complete the merge commit (runSync leaves merge in progress)
      const { execSync } = await import('node:child_process');
      try {
        execSync('git commit -m "sync: merge upstream"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Commit may fail if nothing to commit (merge already complete)
        // Check if we need to add and commit
        try {
          execSync('git add -A && git commit --allow-empty -m "sync: merge upstream"', {
            cwd: env.forkPath,
            encoding: 'utf-8',
          });
        } catch {
          // Ignore if still fails
        }
      }

      // Now delete it in upstream
      deleteFileAndCommit(env.upstreamPath, 'temp.ts', 'chore: remove temp file');

      fetchUpstream(env.forkPath);
      config = buildRuntimeConfig(env, { service: 'sync' });
      const result = await runSync(config);

      expect(result.success).toBe(true);
      // File should be deleted from fork
      expect(fileExists(env.forkPath, 'temp.ts')).toBe(false);
    });

    it('should keep fork-deleted files deleted when upstream leaves them unchanged', async () => {
      // README.md exists in the shared base. The fork deliberately removes it.
      deleteFileAndCommit(env.forkPath, 'README.md', 'chore: remove readme in fork');
      expect(fileExists(env.forkPath, 'README.md')).toBe(false);

      // Upstream leaves README.md untouched, so its absence in the fork is a fork-owned deletion.
      fetchUpstream(env.forkPath);

      // Analyze: the fork's deletion must be classified as 'deleted', not 'behind' — otherwise it
      // would be re-added as if upstream introduced a new file, resurfacing on every sync.
      const analyzeConfig = buildRuntimeConfig(env, { service: 'analyze' });
      const analysis = await runAnalyze(analyzeConfig);
      const deletedFile = analysis.files.find((f) => f.path === 'README.md');
      expect(deletedFile).toBeDefined();
      expect(deletedFile?.status).toBe('deleted');

      // Sync: the deletion is respected — README.md stays gone.
      const syncConfig = buildRuntimeConfig(env, { service: 'sync' });
      const result = await runSync(syncConfig);
      expect(result.success).toBe(true);
      expect(fileExists(env.forkPath, 'README.md')).toBe(false);
    });

    it('should handle file renames from upstream with git mv', async () => {
      // Add a file in a subdirectory to upstream first
      makeCommit(env.upstreamPath, {
        files: { 'old-dir/moved-file.ts': '// File to be moved\nexport const value = 1;\n' },
        message: 'chore: add file in old-dir',
      });

      // Sync to get the file
      fetchUpstream(env.forkPath);
      let config = buildRuntimeConfig(env, { service: 'sync' });
      await runSync(config);

      expect(fileExists(env.forkPath, 'old-dir/moved-file.ts')).toBe(true);

      // Complete the merge commit
      const { execSync } = await import('node:child_process');
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: merge upstream"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Ignore
      }

      // Now rename the file in upstream using git mv (single commit, detected as rename)
      renameFileAndCommit(
        env.upstreamPath,
        'old-dir/moved-file.ts',
        'new-dir/moved-file.ts',
        'refactor: move file to new location',
      );

      fetchUpstream(env.forkPath);
      config = buildRuntimeConfig(env, { service: 'sync' });
      const result = await runSync(config);

      expect(result.success).toBe(true);
      // Old file should be deleted, new file should exist
      expect(fileExists(env.forkPath, 'old-dir/moved-file.ts')).toBe(false);
      expect(fileExists(env.forkPath, 'new-dir/moved-file.ts')).toBe(true);

      // Check that the rename was detected in analysis
      const renamedFile = result.files.find((f) => f.path === 'new-dir/moved-file.ts');
      expect(renamedFile).toBeDefined();
      expect(renamedFile?.status).toBe('renamed');
      expect(renamedFile?.renamedFrom).toBe('old-dir/moved-file.ts');
    });

    it('should handle file renames with squashed (single-parent) history', async () => {
      const fs = await import('node:fs');
      const { getFileChanges, getMergeBase, git } = await import('../../src/utils/git');
      const { execSync } = await import('node:child_process');

      // Add a file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'src/old-name.ts': '// File to rename\nexport const x = 1;\n' },
        message: 'chore: add file',
      });

      // Sync to get the file
      fetchUpstream(env.forkPath);
      let config = buildRuntimeConfig(env, { service: 'sync' });
      await runSync(config);

      expect(fileExists(env.forkPath, 'src/old-name.ts')).toBe(true);

      // Simulate a squashed (single-parent) history: drop MERGE_HEAD before committing so
      // git's native merge-base becomes stale and recovery relies on refs/cella/last-sync.
      fs.rmSync(`${env.forkPath}/.git/MERGE_HEAD`, { force: true });

      // Complete the (single-parent) commit
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: squash upstream"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Ignore
      }

      // Rename the file in upstream
      renameFileAndCommit(env.upstreamPath, 'src/old-name.ts', 'src/new-name.ts', 'refactor: rename file');

      fetchUpstream(env.forkPath);

      // Debug: Check what getFileChanges returns
      const upstreamRef = 'cella-upstream/main';
      const mergeBase = await getMergeBase(env.forkPath, 'HEAD', upstreamRef);

      // Raw diff-tree output
      const rawDiff = await git(['diff-tree', '-r', '-M90%', '--no-commit-id', mergeBase, upstreamRef], env.forkPath);

      const upstreamChanges = await getFileChanges(env.forkPath, mergeBase, upstreamRef);

      const debugInfo1 = {
        mergeBase,
        upstreamRef,
        rawDiff,
        upstreamChanges: Array.from(upstreamChanges.entries()).map(([k, v]) => ({ path: k, ...v })),
      };
      fs.writeFileSync('/tmp/cella-test-debug1.json', JSON.stringify(debugInfo1, null, 2));

      config = buildRuntimeConfig(env, { service: 'sync' });
      const result = await runSync(config);

      // Debug: Check what status was detected for the files
      const newFile = result.files.find((f) => f.path === 'src/new-name.ts');
      const oldFile = result.files.find((f) => f.path === 'src/old-name.ts');
      const debugInfo = {
        newFileStatus: newFile?.status,
        newFileRenamedFrom: newFile?.renamedFrom,
        oldFileStatus: oldFile?.status,
        summary: result.summary,
        allFiles: result.files.map((f) => ({ path: f.path, status: f.status, renamedFrom: f.renamedFrom })),
      };
      fs.writeFileSync('/tmp/cella-test-debug.json', JSON.stringify(debugInfo, null, 2));

      expect(result.success).toBe(true);
      expect(fileExists(env.forkPath, 'src/old-name.ts')).toBe(false);
      expect(fileExists(env.forkPath, 'src/new-name.ts')).toBe(true);
    });
  });

  describe('drifted and local detection', () => {
    it('should detect drifted files (fork-only modification)', async () => {
      // Modify an existing file only in fork (not pinned, not ignored)
      makeCommit(env.forkPath, {
        files: { 'README.md': '# Fork Customized Readme\n' },
        message: 'chore: customize readme in fork',
      });

      // Add an unrelated upstream change so there's something to analyze
      makeCommit(env.upstreamPath, {
        files: { 'new-util.ts': '// New util\n' },
        message: 'chore: add util',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      const driftedFile = result.files.find((f) => f.path === 'README.md');
      expect(driftedFile).toBeDefined();
      expect(driftedFile?.status).toBe('drifted');
    });

    it('should detect local files (fork-only, never in upstream)', async () => {
      // Add a file only in fork that never existed in upstream
      makeCommit(env.forkPath, {
        files: { 'fork-only-feature.ts': '// Fork exclusive feature\nexport const local = true;\n' },
        message: 'feat: add fork-only feature',
      });

      // Add an unrelated upstream change so there's something to fetch
      makeCommit(env.upstreamPath, {
        files: { 'upstream-util.ts': '// Upstream util\n' },
        message: 'chore: add upstream util',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.success).toBe(true);
      const localFile = result.files.find((f) => f.path === 'fork-only-feature.ts');
      expect(localFile).toBeDefined();
      expect(localFile?.status).toBe('local');
      expect(result.summary.local).toBeGreaterThanOrEqual(1);
    });
  });

  describe('merge conflicts', () => {
    it('should report conflicts when both sides edit same file differently', async () => {
      // Both sides modify the same existing file with conflicting content
      makeCommit(env.upstreamPath, {
        files: { 'README.md': '# Upstream Version\nLine from upstream\n' },
        message: 'docs: upstream readme update',
      });

      makeCommit(env.forkPath, {
        files: { 'README.md': '# Fork Version\nLine from fork\n' },
        message: 'docs: fork readme update',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'sync' });

      const result = await runSync(config);

      // Sync should report not successful when there are real conflicts
      // (diverged files with same-line edits produce git merge conflicts)
      expect(result.conflicts.length).toBeGreaterThan(0);

      // The conflicted file should have conflict markers in worktree
      const content = readRepoFile(env.forkPath, 'README.md');
      expect(content).not.toBeNull();
      expect(content).toContain('<<<<<<<');
      expect(content).toContain('>>>>>>>');
    });

    it('emits file links for auto-merged files without materializing a view worktree', async () => {
      const fs = await import('node:fs');
      const { execSync } = await import('node:child_process');

      // Shared multi-line file present at the merge base in BOTH repos.
      const baseLines = `${Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
      makeCommit(env.upstreamPath, { files: { 'shared.ts': baseLines }, message: 'chore: add shared' });

      // Sync shared.ts into the fork and finalize so it becomes part of the merge base.
      fetchUpstream(env.forkPath);
      await runSync(buildRuntimeConfig(env, { service: 'sync' }));
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: shared"', { cwd: env.forkPath });
      } catch {
        // Ignore if nothing to commit
      }

      // Upstream: conflicting README edit + non-overlapping edit at the TOP of shared.ts.
      makeCommit(env.upstreamPath, {
        files: {
          'README.md': '# Upstream Version\nupstream conflict line\n',
          'shared.ts': baseLines.replace('line 1', 'line 1 (upstream)'),
        },
        message: 'feat: upstream changes',
      });

      // Fork: conflicting README edit + non-overlapping edit at the BOTTOM of shared.ts.
      makeCommit(env.forkPath, {
        files: {
          'README.md': '# Fork Version\nfork conflict line\n',
          'shared.ts': baseLines.replace('line 9', 'line 9 (fork)'),
        },
        message: 'feat: fork changes',
      });

      fetchUpstream(env.forkPath);

      // Clear any leftover legacy view worktree so we can assert sync does not
      // create one (browser diffs replaced the view worktree entirely).
      const os = await import('node:os');
      const path = await import('node:path');
      const viewPath = path.join(os.tmpdir(), `cella-view-${path.basename(env.forkPath)}`);
      fs.rmSync(viewPath, { recursive: true, force: true });

      // Capture human-facing output to assert the diff link is rendered.
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      });

      let result: Awaited<ReturnType<typeof runSync>>;
      try {
        result = await runSync(buildRuntimeConfig(env, { service: 'sync' }));
      } finally {
        spy.mockRestore();
      }

      // README conflicts; shared.ts auto-merges cleanly.
      expect(result.conflicts).toContain('README.md');
      expect(result.autoMergedFiles).toContain('shared.ts');

      // The merge-in-progress detail emitted a clickable VS Code file link (into the fork).
      expect(logs.join('\n')).toContain('vscode://file');

      // No code path materializes the upstream view worktree anymore.
      expect(fs.existsSync(viewPath)).toBe(false);
    });
  });

  describe('multi-cycle sync', () => {
    it('should handle multiple sync cycles with merge strategy', async () => {
      const { execSync } = await import('node:child_process');

      // ── Cycle 1: upstream adds a file ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 1\nexport const v = 1;\n' },
        message: 'feat: cycle 1',
      });

      fetchUpstream(env.forkPath);
      let config = buildRuntimeConfig(env, { service: 'sync' });
      let result = await runSync(config);

      expect(result.success).toBe(true);
      expect(fileExists(env.forkPath, 'cycle-file.ts')).toBe(true);

      // Complete the merge commit
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: cycle 1"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Ignore
      }

      // ── Cycle 2: upstream modifies the file ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 2\nexport const v = 2;\n' },
        message: 'feat: cycle 2',
      });

      fetchUpstream(env.forkPath);
      config = buildRuntimeConfig(env, { service: 'sync' });
      result = await runSync(config);

      expect(result.success).toBe(true);
      expect(readRepoFile(env.forkPath, 'cycle-file.ts')).toContain('Cycle 2');

      // Complete the merge commit
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: cycle 2"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Ignore
      }

      // ── Cycle 3: verify analyze sees everything up to date ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 3\nexport const v = 3;\n' },
        message: 'feat: cycle 3',
      });

      fetchUpstream(env.forkPath);
      config = buildRuntimeConfig(env, { service: 'analyze' });
      const analysis = await runAnalyze(config);

      expect(analysis.success).toBe(true);
      const cycleFile = analysis.files.find((f) => f.path === 'cycle-file.ts');
      expect(cycleFile).toBeDefined();
      expect(cycleFile?.status).toBe('behind');
    });

    it('should recover from stale merge-base after squash sync', async () => {
      const { execSync } = await import('node:child_process');
      const fs = await import('node:fs');

      // ── Cycle 1: squash sync ──
      makeCommit(env.upstreamPath, {
        files: { 'squash-file.ts': '// Squash v1\nexport const s = 1;\n' },
        message: 'feat: squash cycle 1',
      });

      fetchUpstream(env.forkPath);
      let config = buildRuntimeConfig(env, { service: 'sync' });
      let result = await runSync(config);

      expect(result.success).toBe(true);

      // Simulate a squashed (single-parent) history: drop MERGE_HEAD before committing so
      // git's native merge-base becomes stale and recovery relies on refs/cella/last-sync.
      fs.rmSync(`${env.forkPath}/.git/MERGE_HEAD`, { force: true });

      // Complete the single-parent commit
      try {
        execSync('git add -A && git commit --allow-empty -m "sync: squash cycle 1"', {
          cwd: env.forkPath,
          encoding: 'utf-8',
        });
      } catch {
        // Ignore
      }

      // Verify stored ref was saved
      const { getStoredSyncRef } = await import('../../src/utils/git');
      const storedRef = await getStoredSyncRef(env.forkPath);
      expect(storedRef).not.toBeNull();

      // ── Cycle 2: upstream modifies the file ──
      makeCommit(env.upstreamPath, {
        files: { 'squash-file.ts': '// Squash v2\nexport const s = 2;\n' },
        message: 'feat: squash cycle 2',
      });

      fetchUpstream(env.forkPath);

      // The effective merge-base should use stored ref (not git's stale one)
      const { getEffectiveMergeBase } = await import('../../src/utils/git');
      const effectiveBase = await getEffectiveMergeBase(env.forkPath, 'HEAD', 'cella-upstream/main');

      // After squash, git's merge-base is stale, so stored ref should be used
      expect(effectiveBase.storedRef).not.toBeNull();

      // Sync should work correctly despite squash history
      config = buildRuntimeConfig(env, { service: 'sync' });
      result = await runSync(config);

      expect(result.success).toBe(true);
      expect(readRepoFile(env.forkPath, 'squash-file.ts')).toContain('Squash v2');

      // File should be detected as 'behind' (not 'diverged' which was the old bug)
      const behindFile = result.files.find((f) => f.path === 'squash-file.ts');
      expect(behindFile).toBeDefined();
      expect(behindFile?.status).toBe('behind');
    });
  });

  describe('release tracking', () => {
    it('should sync to the latest release tag, not the untagged branch tip', async () => {
      // Released change (tagged) followed by an unreleased change (no tag).
      makeCommit(env.upstreamPath, {
        files: { 'released.ts': '// released\nexport const r = 1;\n' },
        message: 'feat: released change',
      });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, {
        files: { 'unreleased.ts': '// unreleased\nexport const u = 1;\n' },
        message: 'feat: unreleased change',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'sync', track: 'release' });
      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(result.upstreamTag).toBe('v0.1.0');
      // Released file is synced; the untagged commit is not pulled in.
      expect(fileExists(env.forkPath, 'released.ts')).toBe(true);
      expect(fileExists(env.forkPath, 'unreleased.ts')).toBe(false);
      // The diff hint range ends at the released commit, not the annotated tag object.
      const tagged = result.upstreamCommit?.hash ?? '';
      expect(result.upstreamDiffRange).toMatch(/^[0-9a-f]+\.\.[0-9a-f]+$/);
      expect(tagged.startsWith(result.upstreamDiffRange?.split('..')[1] ?? '-')).toBe(true);
    });

    it('should error when release tracking finds no release tags', async () => {
      makeCommit(env.upstreamPath, {
        files: { 'untagged.ts': '// untagged\nexport const x = 1;\n' },
        message: 'feat: untagged change',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, { service: 'sync', track: 'release' });

      await expect(runSync(config)).rejects.toThrow(/no upstream releases/);
    });

    it('should let --track branch override release config to follow the untagged tip', async () => {
      // Release-track config, but no release tags exist yet.
      makeCommit(env.upstreamPath, {
        files: { 'tip.ts': '// tip\nexport const t = 1;\n' },
        message: 'feat: untagged tip change',
      });

      fetchUpstream(env.forkPath);
      const config = buildRuntimeConfig(env, {
        service: 'sync',
        track: 'release',
        trackOverride: 'branch',
      });
      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(result.upstreamTag).toBeUndefined();
      expect(fileExists(env.forkPath, 'tip.ts')).toBe(true);
    });
  });

  describe('pinned upstream ref (--ref)', () => {
    /** Commit the staged sync single-parent, the way the finishing `cella sync` rerun does. */
    async function commitSync(): Promise<void> {
      await stageAll(env.forkPath);
      await commitSquash(env.forkPath, 'chore: sync upstream cella');
    }

    it('analyzes and syncs to a pinned commit, not the tip, recorded like branch tracking', async () => {
      const pinned = makeCommit(env.upstreamPath, {
        files: { 'pinned.ts': 'export const p = 1;\n' },
        message: 'feat: pinned change',
      });
      makeCommit(env.upstreamPath, { files: { 'later.ts': 'export const l = 1;\n' }, message: 'feat: later change' });
      fetchUpstream(env.forkPath);

      // Release tracking without any release: --ref wins, so no "no upstream releases" error
      const ref = pinned.slice(0, 7);
      const analysis = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze', track: 'release', ref }));
      expect(analysis.files.find((f) => f.path === 'pinned.ts')?.status).toBe('behind');
      expect(analysis.files.find((f) => f.path === 'later.ts')).toBeUndefined();

      const result = await runSync(buildRuntimeConfig(env, { service: 'sync', track: 'release', ref }));

      expect(result.success).toBe(true);
      expect(result.upstreamTag).toBeUndefined();
      expect(result.upstreamCommit?.hash).toBe(pinned);
      expect(fileExists(env.forkPath, 'pinned.ts')).toBe(true);
      expect(fileExists(env.forkPath, 'later.ts')).toBe(false);
      const manifest = JSON.parse(readRepoFile(env.forkPath, 'cella/cella.manifest.json') ?? '{}');
      expect(manifest.upstream).toMatchObject({ track: 'branch', commit: pinned, release: null });
    });

    it('syncs a pinned release tag as that release', async () => {
      makeCommit(env.upstreamPath, { files: { 'one.ts': 'export const o = 1;\n' }, message: 'feat: one' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'two.ts': 'export const t = 2;\n' }, message: 'feat: two' });
      tagUpstream(env.upstreamPath, 'v0.2.0');
      fetchUpstream(env.forkPath);

      const result = await runSync(buildRuntimeConfig(env, { service: 'sync', ref: 'v0.1.0' }));

      expect(result.upstreamTag).toBe('v0.1.0');
      expect(fileExists(env.forkPath, 'one.ts')).toBe(true);
      expect(fileExists(env.forkPath, 'two.ts')).toBe(false);
    });

    it("resolves upstream's tag before the fork's own and reports only a plain tag name as a release", async () => {
      makeCommit(env.upstreamPath, { files: { 'one.ts': 'export const o = 1;\n' }, message: 'feat: one' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      // The fork runs its own release-please: same tag name, its own commit
      makeCommit(env.forkPath, { files: { 'fork.ts': 'export const f = 1;\n' }, message: 'feat: fork change' });
      execSync('git tag v0.1.0 && git fetch -q --no-tags cella-upstream', { cwd: env.forkPath });
      await fetchUpstreamTags(env.forkPath, 'cella-upstream');
      const tagged = execSync('git rev-parse v0.1.0^{commit}', { cwd: env.upstreamPath }).toString().trim();

      expect(await resolveUpstreamCommit(env.forkPath, 'cella-upstream', 'v0.1.0')).toEqual({
        sha: tagged,
        release: { tag: 'v0.1.0', ref: 'refs/cella-upstream/tags/v0.1.0' },
      });
      expect(await resolveUpstreamCommit(env.forkPath, 'cella-upstream', 'v0.1.0~1')).toMatchObject({
        release: undefined,
      });
      expect(await resolveUpstreamCommit(env.forkPath, 'cella-upstream', '--output=x')).toBeNull();
    });

    it("resolves a branch name to upstream's branch, not the fork's own", async () => {
      makeCommit(env.forkPath, { files: { 'fork.ts': 'export const f = 1;\n' }, message: 'feat: fork change' });
      makeCommit(env.upstreamPath, { files: { 'tip.ts': 'export const t = 1;\n' }, message: 'feat: tip' });
      fetchUpstream(env.forkPath);

      const result = await runSync(buildRuntimeConfig(env, { service: 'sync', ref: 'main' }));

      expect(result.upstreamCommit?.hash).toBe(
        execSync('git rev-parse main', { cwd: env.upstreamPath }).toString().trim(),
      );
      expect(fileExists(env.forkPath, 'tip.ts')).toBe(true);
    });

    it('refuses a ref that does not resolve, or one upstream never published on its branch or in a release', async () => {
      execSync('git checkout -q -b feature', { cwd: env.upstreamPath });
      makeCommit(env.upstreamPath, { files: { 'wip.ts': 'export const w = 1;\n' }, message: 'feat: wip' });
      execSync('git checkout -q main', { cwd: env.upstreamPath });
      const forkCommit = makeCommit(env.forkPath, {
        files: { 'fork.ts': 'export const f = 1;\n' },
        message: 'feat: fork change',
      });
      fetchUpstream(env.forkPath);
      const sync = (ref: string) => runSync(buildRuntimeConfig(env, { service: 'sync', ref }));

      await expect(sync('no-such-ref')).rejects.toThrow(/--ref 'no-such-ref' does not resolve to a commit/);
      await expect(sync('feature')).rejects.toThrow(/is not on cella-upstream\/main or in an upstream release/);
      await expect(sync(forkCommit)).rejects.toThrow(/is not on cella-upstream\/main or in an upstream release/);
      expect(fileExists(env.forkPath, 'wip.ts')).toBe(false);
    });

    it('refuses an upstream ref behind the last sync point instead of staging a revert', async () => {
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v1\n' }, message: 'feat: v1' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v2\n' }, message: 'feat: v2' });
      fetchUpstream(env.forkPath);

      // A branch-tracking sync moves the sync point past the latest release
      await runSync(buildRuntimeConfig(env, { service: 'sync', track: 'branch' }));
      await commitSync();

      await expect(runSync(buildRuntimeConfig(env, { service: 'sync', track: 'release' }))).rejects.toThrow(
        /upstream v0\.1\.0 \([0-9a-f]+\) is behind the last sync point[\s\S]*Nothing to sync until a release past/,
      );
      await expect(runSync(buildRuntimeConfig(env, { service: 'sync', ref: 'v0.1.0' }))).rejects.toThrow(
        /Pick a newer --ref/,
      );
      expect(readRepoFile(env.forkPath, 'version.ts')).toBe('v2\n');
      expect(execSync('git status --porcelain', { cwd: env.forkPath }).toString()).toBe('');
    });
  });

  describe('upstream changes the sync never brings in', () => {
    /** Upstream sync config with the given pinned entries (a comment inside the array on purpose). */
    const upstreamConfig = (pinned: string[]) =>
      `export default defineConfig({\n  settings: { upstreamUrl: 'x' },\n  overrides: {\n` +
      `    ignored: ['shared/config'],\n    pinned: [\n      // app-owned seams\n` +
      `${pinned.map((entry) => `      '${entry}',\n`).join('')}    ],\n  },\n});\n`;

    /** Base both sides share: upstream config + an ignored config folder, fast-forwarded into the fork. */
    async function setupBase(): Promise<void> {
      const { execSync } = await import('node:child_process');
      makeCommit(env.upstreamPath, {
        files: {
          'cella/cella.config.ts': upstreamConfig(['a.ts']),
          'shared/config/default.ts': 'export const config = { a: 1 };\n',
        },
        message: 'chore: add sync config',
      });
      fetchUpstream(env.forkPath);
      execSync('git merge -q --ff-only cella-upstream/main', { cwd: env.forkPath });

      makeCommit(env.upstreamPath, {
        files: {
          'cella/cella.config.ts': upstreamConfig(['a.ts', 'backend/src/bundle-config.ts']),
          'shared/config/default.ts': 'export const config = { a: 1, newKey: true };\n',
          'shared/config/staging.ts': 'export const staging = {};\n',
        },
        message: 'feat: new config key and pin',
      });
      fetchUpstream(env.forkPath);
    }

    it('analyze reports new upstream override entries and ignored paths only upstream changed', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, { service: 'analyze', pinned: ['a.ts'], ignored: ['shared/config'] });

      const result = await runAnalyze(config);

      expect(result.upstreamOverrides).toEqual({
        kind: 'changes',
        pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
        ignored: { added: [], removed: [] },
        packageJsonSync: { added: [], removed: [] },
      });
      expect(result.ignoredUpstreamChanges).toEqual([
        {
          entry: 'shared/config',
          paths: ['shared/config/default.ts', 'shared/config/staging.ts'],
          added: 1,
          deleted: 0,
        },
      ]);
      expect(result.upstreamDiffRange).toMatch(/^[0-9a-f]{7,}\.\.[0-9a-f]{7,}$/);
    });

    it('analyze --json flags the files and carries the override changes on the sync config', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, { service: 'analyze', pinned: ['a.ts'], ignored: ['shared/config'] });
      config.json = true;

      const chunks: string[] = [];
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        await runAnalyze(config);
      } finally {
        write.mockRestore();
        info.mockRestore();
      }

      const out = JSON.parse(chunks.join('')) as Array<Record<string, unknown>>;
      const byPath = new Map(out.map((entry) => [entry.path, entry]));
      expect(byPath.get('shared/config/staging.ts')).toMatchObject({ status: 'ignored', upstreamOnly: true });
      expect(byPath.get('shared/config/default.ts')).toMatchObject({ upstreamOnly: true, upstreamOverrides: null });
      expect(byPath.get('cella/cella.config.ts')?.upstreamOverrides).toEqual({
        pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
        ignored: { added: [], removed: [] },
        packageJsonSync: { added: [], removed: [] },
      });
    });

    it('sync stops before the merge while the fork config does not follow, and changes nothing', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, { service: 'sync', pinned: ['a.ts'], ignored: ['shared/config'] });
      const head = execSync('git rev-parse HEAD', { cwd: env.forkPath }).toString();

      const stop = await runSync(config).catch((error: unknown) => error);

      expect(stop).toBeInstanceOf(UpstreamConfigChangedError);
      expect((stop as UpstreamConfigChangedError).report).toMatchObject({
        kind: 'changes',
        pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
      });
      expect((stop as Error).message).toContain('stopped before the merge, nothing changed');
      expect((stop as Error).message).toContain('rerun with --keep-config');
      // No merge was started and nothing was written
      expect(execSync('git rev-parse HEAD', { cwd: env.forkPath }).toString()).toBe(head);
      expect(execSync('git status --porcelain', { cwd: env.forkPath }).toString()).toBe('');
      expect(fileExists(env.forkPath, '.git/MERGE_HEAD')).toBe(false);
    });

    it('sync merges once the fork config follows upstream', async () => {
      await setupBase();
      const pinned = ['a.ts', 'backend/src/bundle-config.ts'];
      const config = buildRuntimeConfig(env, { service: 'sync', pinned, ignored: ['shared/config'] });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(result.upstreamOverrides).toBeUndefined();
      expect(fileExists(env.forkPath, '.git/MERGE_HEAD')).toBe(true);
    });

    it('sync --keep-config merges, reports the same and leaves the fork config and ignored files alone', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, {
        service: 'sync',
        pinned: ['a.ts'],
        ignored: ['shared/config'],
        keepConfig: true,
      });

      const result = await runSync(config);

      expect(result.success).toBe(true);
      expect(result.upstreamOverrides?.kind).toBe('changes');
      expect(result.ignoredUpstreamChanges?.map((group) => group.entry)).toEqual(['shared/config']);
      expect(readRepoFile(env.forkPath, 'cella/cella.config.ts')).not.toContain('bundle-config');
      expect(readRepoFile(env.forkPath, 'shared/config/default.ts')).not.toContain('newKey');
      expect(fileExists(env.forkPath, 'shared/config/staging.ts')).toBe(false);
    });

    it('groups protected files both sides changed by entry, with a range that shows only upstream changes', async () => {
      await setupBase();
      // The fork changed an ignored config file and a pinned file that upstream changes too
      makeCommit(env.upstreamPath, {
        files: { 'backend/src/index.ts': '// Backend entry\nexport const backend = "upstream";\n' },
        message: 'feat: upstream backend',
      });
      makeCommit(env.forkPath, {
        files: {
          'shared/config/default.ts': 'export const config = { a: 1, forkKey: true };\n',
          'backend/src/index.ts': '// Backend entry\nexport const backend = "fork";\n',
        },
        message: 'feat: fork config and backend',
      });
      fetchUpstream(env.forkPath);
      const options = { pinned: ['a.ts', 'backend/src'], ignored: ['shared/config'], keepConfig: true };
      const groups = [
        { entry: 'backend/src', paths: ['backend/src/index.ts'] },
        { entry: 'shared/config', paths: ['shared/config/default.ts'] },
      ];

      const analysis = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze', ...options }));
      expect(analysis.protectedUpstreamChanges).toEqual(groups);

      const result = await runSync(buildRuntimeConfig(env, { service: 'sync', ...options }));
      expect(result.protectedUpstreamChanges).toEqual(groups);

      // The printed command: upstream's side of the entry since the last sync, without the fork's own changes
      const diff = execSync(`git diff ${result.upstreamDiffRange} -- shared/config`, { cwd: env.forkPath }).toString();
      expect(diff).toContain('+export const config = { a: 1, newKey: true };');
      expect(diff).not.toContain('forkKey');
    });
  });
});

/**
 * E2E tests for upgrade CLI services.
 *
 * These tests create real git repos and run the actual upgrade services
 * to verify end-to-end behavior.
 */
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalyze } from '../../src/upstream/analyze';
import { gitDiffFile } from '../../src/upstream/diff-page';
import { reviewSections } from '../../src/upstream/review-page';
import { runUpgrade } from '../../src/upstream/upgrade';
import {
  commitSquash,
  fetchUpstreamTags,
  getEffectiveMergeBase,
  readStoredUpgradePoint,
  resolveUpstreamCommit,
  stageAll,
} from '../../src/utils/git';
import {
  buildRuntimeConfig,
  createTestEnv,
  deleteFileAndCommit,
  fetchUpstream,
  fileExists,
  makeCommit,
  readRepoFile,
  renameFileAndCommit,
  resetApp,
  type TestEnv,
  tagUpstream,
  upstreamRemote,
} from '../helpers/test-env';

describe('upgrade e2e', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(() => {
    resetApp(env.repoRoot);
    env.cleanup();
  });

  /** The release the upgrade recorded in the manifest it staged; null when it followed a branch or a commit. */
  const recordedRelease = () =>
    JSON.parse(readRepoFile(env.repoRoot, 'cella/cella.manifest.json') ?? '{}').upstream?.release;

  /**
   * Commit the staged upgrade. With `squash`, single-parent the way the finishing `cella upgrade` rerun
   * does, so git's native merge-base goes stale; else as a two-parent merge commit.
   */
  async function commitMerge(message: string, { squash = false } = {}): Promise<void> {
    if (squash) {
      await stageAll(env.repoRoot);
      await commitSquash(env.repoRoot, message);
    } else {
      execSync(`git add -A && git commit -q --allow-empty -m "${message}"`, { cwd: env.repoRoot });
    }
  }

  describe('analyze service', () => {
    it('detects app is identical to upstream', async () => {
      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.summary.identical).toBeGreaterThan(0);
      expect(result.summary.behind).toBe(0);
      expect(result.summary.diverged).toBe(0);
    });

    it('detects app is behind when upstream has new commits', async () => {
      // Add new file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'new-feature.ts': '// New feature\nexport const feature = true;\n' },
        message: 'feat: add new feature',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      expect(result.summary.behind).toBeGreaterThan(0);

      const behindFile = result.files.find((f) => f.path === 'new-feature.ts');
      expect(behindFile).toBeDefined();
      expect(behindFile?.status).toBe('behind');
    });

    it('detects diverged files when both sides modify', async () => {
      // Add file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'shared.ts': '// Upstream version\nexport const source = "upstream";\n' },
        message: 'chore: add shared file',
      });

      // Add same file to app with different content
      makeCommit(env.repoRoot, {
        files: { 'shared.ts': '// App version\nexport const source = "app";\n' },
        message: 'chore: add shared file',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      const divergedFile = result.files.find((f) => f.path === 'shared.ts');
      expect(divergedFile).toBeDefined();
      expect(divergedFile?.status).toBe('diverged');
    });

    it('marks pinned files as ahead', async () => {
      // Modify file in upstream
      makeCommit(env.upstreamPath, {
        files: { 'backend/src/index.ts': '// Updated backend\nexport const backend = "v2";\n' },
        message: 'chore: update backend',
      });

      // Modify same file in app (will be pinned)
      makeCommit(env.repoRoot, {
        files: { 'backend/src/index.ts': '// App custom backend\nexport const backend = "app";\n' },
        message: 'chore: customize backend',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, {
        service: 'analyze',
        pinned: ['backend/src/index.ts'],
      });

      const result = await runAnalyze(config);

      const pinnedFile = result.files.find((f) => f.path === 'backend/src/index.ts');
      expect(pinnedFile).toBeDefined();
      expect(pinnedFile?.isPinned).toBe(true);
      // Pinned diverged files show as 'pinned' status
      expect(pinnedFile?.status).toBe('pinned');
    });

    it('summarizes changed managed files separately from protected files', async () => {
      makeCommit(env.repoRoot, {
        files: {
          'package.json': '{"name": "test-app", "dependencies": {"app-only": "1.0.0"}}\n',
          'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n\npackages:\n  app-only: {}\n',
          'cella/cella.config.ts': 'export default { settings: { upstreamUrl: "app" } };\n',
          'backend/src/index.ts': '// App custom backend\nexport const backend = "app";\n',
        },
        message: 'chore: customize managed files and backend',
      });

      fetchUpstream(env.repoRoot);
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

    it('marks ignored files correctly', async () => {
      // Add file in ignored path to upstream
      makeCommit(env.upstreamPath, {
        files: { 'docs/guide.md': '# Guide\nThis is ignored.\n' },
        message: 'docs: add guide',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, {
        service: 'analyze',
        ignored: ['docs'],
      });

      const result = await runAnalyze(config);

      const ignoredFile = result.files.find((f) => f.path === 'docs/guide.md');
      expect(ignoredFile).toBeDefined();
      expect(ignoredFile?.isIgnored).toBe(true);
      expect(ignoredFile?.status).toBe('ignored');
    });
  });

  describe('upgrade service', () => {
    it('upgrades new files from upstream', async () => {
      // Add new file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'new-feature.ts': '// New feature\nexport const feature = true;\n' },
        message: 'feat: add new feature',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'upgrade' });

      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(fileExists(env.repoRoot, 'new-feature.ts')).toBe(true);
      expect(readRepoFile(env.repoRoot, 'new-feature.ts')).toContain('New feature');
    });

    it('preserves pinned files during upgrade', async () => {
      const appContent = '// App custom\nexport const custom = "app";\n';

      // Add file to app first (pinned)
      makeCommit(env.repoRoot, {
        files: { 'custom.ts': appContent },
        message: 'chore: add custom file',
      });

      // Add same file to upstream with different content
      makeCommit(env.upstreamPath, {
        files: { 'custom.ts': '// Upstream version\nexport const custom = "upstream";\n' },
        message: 'chore: add custom file',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, {
        service: 'upgrade',
        pinned: ['custom.ts'],
      });

      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      // App version should be preserved
      expect(readRepoFile(env.repoRoot, 'custom.ts')).toBe(appContent);
    });

    it('--unpinned merges upstream into a pinned file, including a change an earlier upgrade dropped', async () => {
      const styles = (first: string, third: string, fifth: string) => `${first}\nb\n${third}\nd\n${fifth}\n`;
      const pinned = ['styles.css'];

      // Both sides start from the same file.
      makeCommit(env.upstreamPath, { files: { 'styles.css': styles('a', 'c', 'e') }, message: 'feat: styles' });
      fetchUpstream(env.repoRoot);
      execSync(`git merge -q --ff-only ${upstreamRemote}/main`, { cwd: env.repoRoot });

      // The app changes line 1, upstream line 5; a normal upgrade keeps the pinned app file whole.
      makeCommit(env.repoRoot, { files: { 'styles.css': styles('a-app', 'c', 'e') }, message: 'feat: app styles' });
      makeCommit(env.upstreamPath, { files: { 'styles.css': styles('a', 'c', 'e-up') }, message: 'feat: styles 1' });
      fetchUpstream(env.repoRoot);
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', pinned }));
      await commitMerge('chore: upgrade upstream cella', { squash: true });
      expect(readRepoFile(env.repoRoot, 'styles.css')).toBe(styles('a-app', 'c', 'e'));

      // Upstream changes line 3. Analyze shows the file as an ordinary both-changed file under the flag.
      makeCommit(env.upstreamPath, { files: { 'styles.css': styles('a', 'c-up', 'e-up') }, message: 'feat: styles 2' });
      fetchUpstream(env.repoRoot);
      const preview = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze', pinned, unpinned: true }));
      expect(preview.files.find((f) => f.path === 'styles.css')).toMatchObject({ isPinned: false, status: 'diverged' });

      // The merge brings in line 3 and the line 5 change that the first upgrade dropped.
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', pinned, unpinned: true }));
      expect(readRepoFile(env.repoRoot, 'styles.css')).toBe(styles('a-app', 'c-up', 'e-up'));
    });

    it('skips ignored files during upgrade', async () => {
      // Add file in ignored path to upstream
      makeCommit(env.upstreamPath, {
        files: { 'docs/internal.md': '# Internal\nThis should be ignored.\n' },
        message: 'docs: add internal doc',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, {
        service: 'upgrade',
        ignored: ['docs'],
      });

      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      // File should NOT be added to app
      expect(fileExists(env.repoRoot, 'docs/internal.md')).toBe(false);
    });

    it('updates modified files from upstream', async () => {
      // Modify existing file in upstream
      makeCommit(env.upstreamPath, {
        files: { 'README.md': '# Updated Readme\nThis is the new version.\n' },
        message: 'docs: update readme',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'upgrade' });

      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(readRepoFile(env.repoRoot, 'README.md')).toContain('Updated Readme');
    });

    it('handles file deletions from upstream', async () => {
      // Add a file to upstream first
      makeCommit(env.upstreamPath, {
        files: { 'temp.ts': '// Temporary file\n' },
        message: 'chore: add temp file',
      });

      // Upgrade to get the file
      fetchUpstream(env.repoRoot);
      let config = buildRuntimeConfig(env, { service: 'upgrade' });
      await runUpgrade(config);

      expect(fileExists(env.repoRoot, 'temp.ts')).toBe(true);

      // Complete the merge commit (runUpgrade leaves merge in progress)
      await commitMerge('upgrade: merge upstream');

      // Now delete it in upstream
      deleteFileAndCommit(env.upstreamPath, 'temp.ts', 'chore: remove temp file');

      fetchUpstream(env.repoRoot);
      config = buildRuntimeConfig(env, { service: 'upgrade' });
      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      // File should be deleted from app
      expect(fileExists(env.repoRoot, 'temp.ts')).toBe(false);
    });

    // raak lost an app-marked file this way: the deletion applied over its own edit, with no conflict
    it('keeps a file the app changed as a conflict when upstream deletes it', async () => {
      makeCommit(env.upstreamPath, { files: { 'temp.ts': '// Temporary file\n' }, message: 'chore: add temp file' });
      fetchUpstream(env.repoRoot);
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade' }));
      await commitMerge('upgrade: merge upstream');

      makeCommit(env.repoRoot, { files: { 'temp.ts': '// fork: kept by the app\n' }, message: 'feat: own temp' });
      deleteFileAndCommit(env.upstreamPath, 'temp.ts', 'chore: remove temp file');
      fetchUpstream(env.repoRoot);

      const analysis = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze' }));
      expect(analysis.files.find((file) => file.path === 'temp.ts')?.status).toBe('diverged');

      const result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade' }));
      expect(result.conflicts).toContain('temp.ts');
      expect(readRepoFile(env.repoRoot, 'temp.ts')).toBe('// fork: kept by the app\n');
    });

    it('keeps app-deleted files deleted when upstream leaves them unchanged', async () => {
      // README.md exists in the shared base. The app deliberately removes it.
      deleteFileAndCommit(env.repoRoot, 'README.md', 'chore: remove readme in app');
      expect(fileExists(env.repoRoot, 'README.md')).toBe(false);

      // Upstream leaves README.md untouched, so its absence in the app is an app-owned deletion.
      fetchUpstream(env.repoRoot);

      // Analyze: the app's deletion must be classified as 'deleted', not 'behind': otherwise it
      // would be re-added as if upstream introduced a new file, resurfacing on every upgrade.
      const analyzeConfig = buildRuntimeConfig(env, { service: 'analyze' });
      const analysis = await runAnalyze(analyzeConfig);
      const deletedFile = analysis.files.find((f) => f.path === 'README.md');
      expect(deletedFile).toBeDefined();
      expect(deletedFile?.status).toBe('deleted');

      // Upgrade: the deletion is respected: README.md stays gone.
      const upgradeConfig = buildRuntimeConfig(env, { service: 'upgrade' });
      const result = await runUpgrade(upgradeConfig);
      expect(result.conflicts).toEqual([]);
      expect(fileExists(env.repoRoot, 'README.md')).toBe(false);
    });

    it('handles file renames from upstream with git mv', async () => {
      // Add a file in a subdirectory to upstream first
      makeCommit(env.upstreamPath, {
        files: { 'old-dir/moved-file.ts': '// File to be moved\nexport const value = 1;\n' },
        message: 'chore: add file in old-dir',
      });

      // Upgrade to get the file
      fetchUpstream(env.repoRoot);
      let config = buildRuntimeConfig(env, { service: 'upgrade' });
      await runUpgrade(config);

      expect(fileExists(env.repoRoot, 'old-dir/moved-file.ts')).toBe(true);

      await commitMerge('upgrade: merge upstream');

      // Now rename the file in upstream using git mv (single commit, detected as rename)
      renameFileAndCommit(
        env.upstreamPath,
        'old-dir/moved-file.ts',
        'new-dir/moved-file.ts',
        'refactor: move file to new location',
      );

      fetchUpstream(env.repoRoot);
      config = buildRuntimeConfig(env, { service: 'upgrade' });
      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      // Old file should be deleted, new file should exist
      expect(fileExists(env.repoRoot, 'old-dir/moved-file.ts')).toBe(false);
      expect(fileExists(env.repoRoot, 'new-dir/moved-file.ts')).toBe(true);

      // Check that the rename was detected in analysis
      const renamedFile = result.files.find((f) => f.path === 'new-dir/moved-file.ts');
      expect(renamedFile).toBeDefined();
      expect(renamedFile?.status).toBe('renamed');
      expect(renamedFile?.renamedFrom).toBe('old-dir/moved-file.ts');
    });

    it.each([
      ['the new path', 'new-dir/texts.json'],
      ['the old path', 'old-dir/texts.json'],
    ])('moves the app copy of an ignored file upstream moves, the config naming %s', async (_, entry) => {
      makeCommit(env.upstreamPath, {
        files: { 'old-dir/texts.json': '{ "a": "template" }\n' },
        message: 'chore: texts',
      });
      fetchUpstream(env.repoRoot);
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade' }));
      await commitMerge('upgrade: merge upstream');
      makeCommit(env.repoRoot, { files: { 'old-dir/texts.json': '{ "a": "app" }\n' }, message: 'feat: app texts' });

      renameFileAndCommit(env.upstreamPath, 'old-dir/texts.json', 'new-dir/texts.json', 'refactor: move texts');
      fetchUpstream(env.repoRoot);
      const result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ignored: [entry] }));

      expect(result.conflicts).toEqual([]);
      expect(fileExists(env.repoRoot, 'old-dir/texts.json')).toBe(false);
      expect(readRepoFile(env.repoRoot, 'new-dir/texts.json')).toBe('{ "a": "app" }\n');
    });

    it('handles file renames with squashed (single-parent) history', async () => {
      // Add a file to upstream
      makeCommit(env.upstreamPath, {
        files: { 'src/old-name.ts': '// File to rename\nexport const x = 1;\n' },
        message: 'chore: add file',
      });

      // Upgrade to get the file
      fetchUpstream(env.repoRoot);
      let config = buildRuntimeConfig(env, { service: 'upgrade' });
      await runUpgrade(config);

      expect(fileExists(env.repoRoot, 'src/old-name.ts')).toBe(true);

      await commitMerge('upgrade: squash upstream', { squash: true });

      // Rename the file in upstream
      renameFileAndCommit(env.upstreamPath, 'src/old-name.ts', 'src/new-name.ts', 'refactor: rename file');

      fetchUpstream(env.repoRoot);
      config = buildRuntimeConfig(env, { service: 'upgrade' });
      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(fileExists(env.repoRoot, 'src/old-name.ts')).toBe(false);
      expect(fileExists(env.repoRoot, 'src/new-name.ts')).toBe(true);
    });
  });

  describe('drifted and local detection', () => {
    it('detects drifted files (app-only modification)', async () => {
      // Modify an existing file only in app (not pinned, not ignored)
      makeCommit(env.repoRoot, {
        files: { 'README.md': '# App Customized Readme\n' },
        message: 'chore: customize readme in app',
      });

      // Add an unrelated upstream change so there's something to analyze
      makeCommit(env.upstreamPath, {
        files: { 'new-util.ts': '// New util\n' },
        message: 'chore: add util',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      const driftedFile = result.files.find((f) => f.path === 'README.md');
      expect(driftedFile).toBeDefined();
      expect(driftedFile?.status).toBe('drifted');
    });

    it('detects local files (app-only, never in upstream)', async () => {
      // Add a file only in app that never existed in upstream
      makeCommit(env.repoRoot, {
        files: { 'app-only-feature.ts': '// App exclusive feature\nexport const local = true;\n' },
        message: 'feat: add app-only feature',
      });

      // Add an unrelated upstream change so there's something to fetch
      makeCommit(env.upstreamPath, {
        files: { 'upstream-util.ts': '// Upstream util\n' },
        message: 'chore: add upstream util',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'analyze' });

      const result = await runAnalyze(config);

      const localFile = result.files.find((f) => f.path === 'app-only-feature.ts');
      expect(localFile).toBeDefined();
      expect(localFile?.status).toBe('local');
      expect(result.summary.local).toBeGreaterThanOrEqual(1);
    });
  });

  describe('merge conflicts', () => {
    it('reports conflicts when both sides edit same file differently', async () => {
      // Both sides modify the same existing file with conflicting content
      makeCommit(env.upstreamPath, {
        files: { 'README.md': '# Upstream Version\nLine from upstream\n' },
        message: 'docs: upstream readme update',
      });

      makeCommit(env.repoRoot, {
        files: { 'README.md': '# App Version\nLine from app\n' },
        message: 'docs: app readme update',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'upgrade' });

      const result = await runUpgrade(config);

      // Upgrade should report not successful when there are real conflicts
      // (diverged files with same-line edits produce git merge conflicts)
      expect(result.conflicts.length).toBeGreaterThan(0);

      // The conflicted file should have conflict markers in worktree
      const content = readRepoFile(env.repoRoot, 'README.md');
      expect(content).not.toBeNull();
      expect(content).toContain('<<<<<<<');
      expect(content).toContain('>>>>>>>');
    });

    it('emits file links for auto-merged files', async () => {
      // Shared multi-line file present at the merge base in BOTH repos.
      const baseLines = `${Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
      makeCommit(env.upstreamPath, { files: { 'shared.ts': baseLines }, message: 'chore: add shared' });

      // Upgrade shared.ts into the app and finalize so it becomes part of the merge base.
      fetchUpstream(env.repoRoot);
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade' }));
      await commitMerge('upgrade: shared');

      // Upstream: conflicting README edit + non-overlapping edit at the TOP of shared.ts.
      makeCommit(env.upstreamPath, {
        files: {
          'README.md': '# Upstream Version\nupstream conflict line\n',
          'shared.ts': baseLines.replace('line 1', 'line 1 (upstream)'),
        },
        message: 'feat: upstream changes',
      });

      // App: conflicting README edit + non-overlapping edit at the BOTTOM of shared.ts.
      makeCommit(env.repoRoot, {
        files: {
          'README.md': '# App Version\nfork conflict line\n',
          'shared.ts': baseLines.replace('line 9', 'line 9 (app)'),
        },
        message: 'feat: app changes',
      });

      fetchUpstream(env.repoRoot);

      // Capture human-facing output to assert the diff link is rendered.
      const logs: string[] = [];
      const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
      });

      let result: Awaited<ReturnType<typeof runUpgrade>>;
      try {
        result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade' }));
      } finally {
        spy.mockRestore();
      }

      // README conflicts; shared.ts auto-merges cleanly.
      expect(result.conflicts).toContain('README.md');
      expect(result.autoMergedFiles).toContain('shared.ts');

      // The merge-in-progress detail emitted a clickable VS Code file link (into the app).
      expect(logs.join('\n')).toContain('vscode://file');
    });
  });

  describe('multi-cycle upgrade', () => {
    it('handles multiple upgrade cycles with merge strategy', async () => {
      // ── Cycle 1: upstream adds a file ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 1\nexport const v = 1;\n' },
        message: 'feat: cycle 1',
      });

      fetchUpstream(env.repoRoot);
      let config = buildRuntimeConfig(env, { service: 'upgrade' });
      let result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(fileExists(env.repoRoot, 'cycle-file.ts')).toBe(true);

      await commitMerge('upgrade: cycle 1');

      // ── Cycle 2: upstream modifies the file ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 2\nexport const v = 2;\n' },
        message: 'feat: cycle 2',
      });

      fetchUpstream(env.repoRoot);
      config = buildRuntimeConfig(env, { service: 'upgrade' });
      result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(readRepoFile(env.repoRoot, 'cycle-file.ts')).toContain('Cycle 2');

      await commitMerge('upgrade: cycle 2');

      // ── Cycle 3: verify analyze sees everything up to date ──
      makeCommit(env.upstreamPath, {
        files: { 'cycle-file.ts': '// Cycle 3\nexport const v = 3;\n' },
        message: 'feat: cycle 3',
      });

      fetchUpstream(env.repoRoot);
      config = buildRuntimeConfig(env, { service: 'analyze' });
      const analysis = await runAnalyze(config);

      const cycleFile = analysis.files.find((f) => f.path === 'cycle-file.ts');
      expect(cycleFile).toBeDefined();
      expect(cycleFile?.status).toBe('behind');
    });

    it('recovers from stale merge-base after squash upgrade', async () => {
      // ── Cycle 1: squash upgrade ──
      makeCommit(env.upstreamPath, {
        files: { 'squash-file.ts': '// Squash v1\nexport const s = 1;\n' },
        message: 'feat: squash cycle 1',
      });

      fetchUpstream(env.repoRoot);
      let config = buildRuntimeConfig(env, { service: 'upgrade' });
      let result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);

      await commitMerge('upgrade: squash cycle 1', { squash: true });

      // Verify stored ref was saved
      const storedRef = await readStoredUpgradePoint(env.repoRoot);
      expect(storedRef).not.toBeNull();

      // ── Cycle 2: upstream modifies the file ──
      makeCommit(env.upstreamPath, {
        files: { 'squash-file.ts': '// Squash v2\nexport const s = 2;\n' },
        message: 'feat: squash cycle 2',
      });

      fetchUpstream(env.repoRoot);

      // The effective merge-base should use stored ref (not git's stale one)
      const effectiveBase = await getEffectiveMergeBase(env.repoRoot, 'HEAD', 'cella-upstream/main');

      // After squash, git's merge-base is stale, so the recorded upgrade point should be used
      expect(effectiveBase).toBe(storedRef);

      // Upgrade should work correctly despite squash history
      config = buildRuntimeConfig(env, { service: 'upgrade' });
      result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(readRepoFile(env.repoRoot, 'squash-file.ts')).toContain('Squash v2');

      // File should be detected as 'behind' (not 'diverged' which was the old bug)
      const behindFile = result.files.find((f) => f.path === 'squash-file.ts');
      expect(behindFile).toBeDefined();
      expect(behindFile?.status).toBe('behind');
    });
  });

  describe('release tracking', () => {
    it('upgrades to the latest release tag, not the untagged branch tip', async () => {
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

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'upgrade', track: 'release' });
      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(recordedRelease()).toBe('v0.1.0');
      // Released file is merged; the untagged commit is not pulled in.
      expect(fileExists(env.repoRoot, 'released.ts')).toBe(true);
      expect(fileExists(env.repoRoot, 'unreleased.ts')).toBe(false);
      // The diff hint range ends at the released commit, not the annotated tag object.
      const tagged = result.upstreamCommit?.hash ?? '';
      expect(result.upstreamDiffRange).toMatch(/^[0-9a-f]+\.\.[0-9a-f]+$/);
      expect(tagged.startsWith(result.upstreamDiffRange?.split('..')[1] ?? '-')).toBe(true);
    });

    it('errors when release tracking finds no release tags', async () => {
      makeCommit(env.upstreamPath, {
        files: { 'untagged.ts': '// untagged\nexport const x = 1;\n' },
        message: 'feat: untagged change',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, { service: 'upgrade', track: 'release' });

      await expect(runUpgrade(config)).rejects.toThrow(/no upstream release tags found/);
    });

    it('lets --track branch override release config to follow the untagged tip', async () => {
      // Release-track config, but no release tags exist yet.
      makeCommit(env.upstreamPath, {
        files: { 'tip.ts': '// tip\nexport const t = 1;\n' },
        message: 'feat: untagged tip change',
      });

      fetchUpstream(env.repoRoot);
      const config = buildRuntimeConfig(env, {
        service: 'upgrade',
        track: 'release',
        trackOverride: 'branch',
      });
      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(recordedRelease()).toBeNull();
      expect(fileExists(env.repoRoot, 'tip.ts')).toBe(true);
    });
  });

  describe('pinned upstream ref (--ref)', () => {
    it('analyzes and upgrades to a pinned commit, not the tip, recorded like branch tracking', async () => {
      const pinned = makeCommit(env.upstreamPath, {
        files: { 'pinned.ts': 'export const p = 1;\n' },
        message: 'feat: pinned change',
      });
      makeCommit(env.upstreamPath, { files: { 'later.ts': 'export const l = 1;\n' }, message: 'feat: later change' });
      fetchUpstream(env.repoRoot);

      // Release tracking without any release: --ref wins, so no "no upstream releases" error
      const ref = pinned.slice(0, 7);
      const analysis = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze', track: 'release', ref }));
      expect(analysis.files.find((f) => f.path === 'pinned.ts')?.status).toBe('behind');
      expect(analysis.files.find((f) => f.path === 'later.ts')).toBeUndefined();

      const result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', track: 'release', ref }));

      expect(result.conflicts).toEqual([]);
      expect(recordedRelease()).toBeNull();
      expect(result.upstreamCommit?.hash).toBe(pinned);
      expect(fileExists(env.repoRoot, 'pinned.ts')).toBe(true);
      expect(fileExists(env.repoRoot, 'later.ts')).toBe(false);
      const manifest = JSON.parse(readRepoFile(env.repoRoot, 'cella/cella.manifest.json') ?? '{}');
      expect(manifest.upstream).toMatchObject({ track: 'branch', commit: pinned, release: null });
    });

    it('upgrades a pinned release tag as that release', async () => {
      makeCommit(env.upstreamPath, { files: { 'one.ts': 'export const o = 1;\n' }, message: 'feat: one' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'two.ts': 'export const t = 2;\n' }, message: 'feat: two' });
      tagUpstream(env.upstreamPath, 'v0.2.0');
      fetchUpstream(env.repoRoot);

      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ref: 'v0.1.0' }));

      expect(recordedRelease()).toBe('v0.1.0');
      expect(fileExists(env.repoRoot, 'one.ts')).toBe(true);
      expect(fileExists(env.repoRoot, 'two.ts')).toBe(false);
    });

    it('finds a release tag without the v prefix, past tags that are no template release', async () => {
      makeCommit(env.upstreamPath, { files: { 'released.ts': 'export const r = 1;\n' }, message: 'feat: released' });
      tagUpstream(env.upstreamPath, '0.18.1');
      makeCommit(env.upstreamPath, { files: { 'later.ts': 'export const l = 1;\n' }, message: 'feat: later' });
      // git sorts both above every version tag
      tagUpstream(env.upstreamPath, 'create-cella-0.2.3');
      tagUpstream(env.upstreamPath, 'archive/pre-release');
      fetchUpstream(env.repoRoot);

      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', track: 'release' }));

      expect(recordedRelease()).toBe('0.18.1');
      expect(fileExists(env.repoRoot, 'released.ts')).toBe(true);
      expect(fileExists(env.repoRoot, 'later.ts')).toBe(false);
    });

    it('upgrades a pinned release tag without the v prefix, published by the tag alone', async () => {
      // A release cut from a branch that never reached main: only the tag publishes its commit
      execSync('git checkout -q -b release', { cwd: env.upstreamPath });
      makeCommit(env.upstreamPath, { files: { 'one.ts': 'export const o = 1;\n' }, message: 'feat: one' });
      tagUpstream(env.upstreamPath, '0.3.0');
      execSync('git checkout -q main', { cwd: env.upstreamPath });
      fetchUpstream(env.repoRoot);

      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ref: '0.3.0' }));

      expect(recordedRelease()).toBe('0.3.0');
      expect(fileExists(env.repoRoot, 'one.ts')).toBe(true);
    });

    it("resolves upstream's tag before the app's own and reports only a plain tag name as a release", async () => {
      makeCommit(env.upstreamPath, { files: { 'one.ts': 'export const o = 1;\n' }, message: 'feat: one' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      // The app runs its own release-please: same tag name, its own commit
      makeCommit(env.repoRoot, { files: { 'app.ts': 'export const f = 1;\n' }, message: 'feat: app change' });
      execSync('git tag v0.1.0 && git fetch -q --no-tags cella-upstream', { cwd: env.repoRoot });
      await fetchUpstreamTags(env.repoRoot, 'cella-upstream');
      const tagged = execSync('git rev-parse v0.1.0^{commit}', { cwd: env.upstreamPath }).toString().trim();

      expect(await resolveUpstreamCommit(env.repoRoot, 'cella-upstream', 'v0.1.0')).toEqual({
        sha: tagged,
        release: { tag: 'v0.1.0', ref: 'refs/cella-upstream/tags/v0.1.0' },
      });
      expect(await resolveUpstreamCommit(env.repoRoot, 'cella-upstream', 'v0.1.0~1')).toMatchObject({
        release: undefined,
      });
      expect(await resolveUpstreamCommit(env.repoRoot, 'cella-upstream', '--output=x')).toBeNull();
    });

    it("resolves a branch name to upstream's branch, not the app's own", async () => {
      makeCommit(env.repoRoot, { files: { 'app.ts': 'export const f = 1;\n' }, message: 'feat: app change' });
      makeCommit(env.upstreamPath, { files: { 'tip.ts': 'export const t = 1;\n' }, message: 'feat: tip' });
      fetchUpstream(env.repoRoot);

      const result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ref: 'main' }));

      expect(result.upstreamCommit?.hash).toBe(
        execSync('git rev-parse main', { cwd: env.upstreamPath }).toString().trim(),
      );
      expect(fileExists(env.repoRoot, 'tip.ts')).toBe(true);
    });

    it('refuses a ref that does not resolve, or one upstream never published on its branch or in a release', async () => {
      execSync('git checkout -q -b feature', { cwd: env.upstreamPath });
      makeCommit(env.upstreamPath, { files: { 'wip.ts': 'export const w = 1;\n' }, message: 'feat: wip' });
      execSync('git checkout -q main', { cwd: env.upstreamPath });
      const appCommit = makeCommit(env.repoRoot, {
        files: { 'app.ts': 'export const f = 1;\n' },
        message: 'feat: app change',
      });
      fetchUpstream(env.repoRoot);
      const upgrade = (ref: string) => runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ref }));

      await expect(upgrade('no-such-ref')).rejects.toThrow(/--ref 'no-such-ref' does not resolve to a commit/);
      await expect(upgrade('feature')).rejects.toThrow(/is not on cella-upstream\/main or in an upstream release/);
      await expect(upgrade(appCommit)).rejects.toThrow(/is not on cella-upstream\/main or in an upstream release/);
      expect(fileExists(env.repoRoot, 'wip.ts')).toBe(false);
    });

    it('refuses an upstream ref behind the last upgrade point instead of staging a revert', async () => {
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v1\n' }, message: 'feat: v1' });
      tagUpstream(env.upstreamPath, 'v0.1.0');
      makeCommit(env.upstreamPath, { files: { 'version.ts': 'v2\n' }, message: 'feat: v2' });
      fetchUpstream(env.repoRoot);

      // A branch-tracking upgrade moves the upgrade point past the latest release
      await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', track: 'branch' }));
      await commitMerge('chore: upgrade upstream cella', { squash: true });

      await expect(runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ref: 'v0.1.0' }))).rejects.toThrow(
        /Pick a newer --ref/,
      );
      expect(readRepoFile(env.repoRoot, 'version.ts')).toBe('v2\n');
      expect(execSync('git status --porcelain', { cwd: env.repoRoot }).toString()).toBe('');
    });
  });

  describe('upstream changes the upgrade never brings in', () => {
    /** Upstream upgrade config with the given pinned entries (a comment inside the array on purpose). */
    const upstreamConfig = (pinned: string[]) =>
      `export default defineConfig({\n  settings: { upstreamUrl: 'x' },\n  overrides: {\n` +
      `    ignored: ['shared/config'],\n    pinned: [\n      // app-owned seams\n` +
      `${pinned.map((entry) => `      '${entry}',\n`).join('')}    ],\n  },\n});\n`;

    /** Base both sides share: upstream config + an ignored config folder, fast-forwarded into the app. */
    async function setupBase(): Promise<void> {
      makeCommit(env.upstreamPath, {
        files: {
          'cella/cella.config.ts': upstreamConfig(['a.ts']),
          'shared/config/default.ts': 'export const config = { a: 1 };\n',
        },
        message: 'chore: add upgrade config',
      });
      fetchUpstream(env.repoRoot);
      execSync('git merge -q --ff-only cella-upstream/main', { cwd: env.repoRoot });

      makeCommit(env.upstreamPath, {
        files: {
          'cella/cella.config.ts': upstreamConfig(['a.ts', 'backend/src/bundle-config.ts']),
          'shared/config/default.ts': 'export const config = { a: 1, newKey: true };\n',
          'shared/config/staging.ts': 'export const staging = {};\n',
        },
        message: 'feat: new config key and pin',
      });
      fetchUpstream(env.repoRoot);
    }

    it('analyze reports new upstream override entries and ignored paths only upstream changed', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, { service: 'analyze', pinned: ['a.ts'], ignored: ['shared/config'] });

      const result = await runAnalyze(config);

      expect(result.upstreamOverrides).toEqual({
        type: 'changes',
        pinned: { added: ['backend/src/bundle-config.ts'], removed: [] },
        ignored: { added: [], removed: [] },
        packageJsonKeys: { added: [], removed: [] },
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

    it('analyze --json flags the files and carries the override changes on the upgrade config', async () => {
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
        packageJsonKeys: { added: [], removed: [] },
      });
    });

    it('upgrade --keep-config merges, reports the same and leaves the app config and ignored files alone', async () => {
      await setupBase();
      const config = buildRuntimeConfig(env, {
        service: 'upgrade',
        pinned: ['a.ts'],
        ignored: ['shared/config'],
        keepConfig: true,
      });

      const result = await runUpgrade(config);

      expect(result.conflicts).toEqual([]);
      expect(result.upstreamOverrides?.type).toBe('changes');
      expect(result.ignoredUpstreamChanges?.map((group) => group.entry)).toEqual(['shared/config']);
      expect(readRepoFile(env.repoRoot, 'cella/cella.config.ts')).not.toContain('bundle-config');
      expect(readRepoFile(env.repoRoot, 'shared/config/default.ts')).not.toContain('newKey');
      expect(fileExists(env.repoRoot, 'shared/config/staging.ts')).toBe(false);
    });

    it('lists protected files both sides changed, diffed over a range that shows only upstream changes', async () => {
      await setupBase();
      // The app changed an ignored config file and a pinned file that upstream changes too
      makeCommit(env.upstreamPath, {
        files: { 'backend/src/index.ts': '// Backend entry\nexport const backend = "upstream";\n' },
        message: 'feat: upstream backend',
      });
      makeCommit(env.repoRoot, {
        files: {
          'shared/config/default.ts': 'export const config = { a: 1, forkKey: true };\n',
          'backend/src/index.ts': '// Backend entry\nexport const backend = "app";\n',
        },
        message: 'feat: app config and backend',
      });
      fetchUpstream(env.repoRoot);
      const options = { pinned: ['a.ts', 'backend/src'], ignored: ['shared/config'], keepConfig: true };
      const dropped = ['backend/src/index.ts', 'shared/config/default.ts'];

      const analysis = await runAnalyze(buildRuntimeConfig(env, { service: 'analyze', ...options }));
      expect(analysis.protectedConflicts?.sort()).toEqual(dropped);

      const result = await runUpgrade(buildRuntimeConfig(env, { service: 'upgrade', ...options }));
      const [section] = reviewSections(result, 'upgrade');
      expect(section.paths.sort()).toEqual(dropped);

      // The review page's diff: upstream's side since the last upgrade, without the app's own changes
      const diff = gitDiffFile(env.repoRoot, section.range, 'shared/config/default.ts').toString();
      expect(diff).toContain('+export const config = { a: 1, newKey: true };');
      expect(diff).not.toContain('forkKey');
    });
  });
});

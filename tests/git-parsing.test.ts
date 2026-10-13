/**
 * Unit tests for the git helpers in src/utils/git.ts, against real temp repos: the ls-tree and
 * diff-tree parsers, commit listing, sync ref storage, ancestry, the effective merge-base, and
 * merge-commit flattening.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flattenBranch,
  getEffectiveMergeBase,
  getFileChanges,
  getFileHashesAtRef,
  getStoredSyncRef,
  isAncestor,
  listBranchMergeCommits,
  listCommitsBetween,
  storeLastSyncRef,
} from '../src/utils/git';
import { createManifestRepo, exec, makeCommit, write } from './helpers/test-env';

describe('git parsing', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createManifestRepo();
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  describe('getFileHashesAtRef (ls-tree)', () => {
    it('returns hashes for all files at HEAD', async () => {
      const hashes = await getFileHashesAtRef(repoPath, 'HEAD');
      expect(hashes.size).toBe(1);
      expect(hashes.has('initial.txt')).toBe(true);
      // Hash should be a valid git object hash
      const hash = hashes.get('initial.txt')!;
      expect(hash).toMatch(/^[a-f0-9]{40}$/);
    });

    it('tracks newly added files', async () => {
      fs.writeFileSync(path.join(repoPath, 'added.ts'), 'export const x = 1;\n');
      exec('git add -A && git commit -m "add file"', repoPath);

      const hashes = await getFileHashesAtRef(repoPath, 'HEAD');
      expect(hashes.size).toBe(2);
      expect(hashes.has('added.ts')).toBe(true);
      expect(hashes.has('initial.txt')).toBe(true);
    });

    it('handles nested directory files', async () => {
      fs.mkdirSync(path.join(repoPath, 'src', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(repoPath, 'src', 'deep', 'file.ts'), 'nested\n');
      exec('git add -A && git commit -m "add nested"', repoPath);

      const hashes = await getFileHashesAtRef(repoPath, 'HEAD');
      expect(hashes.has('src/deep/file.ts')).toBe(true);
    });

    it('does not include deleted files', async () => {
      fs.unlinkSync(path.join(repoPath, 'initial.txt'));
      exec('git add -A && git commit -m "delete initial"', repoPath);

      const hashes = await getFileHashesAtRef(repoPath, 'HEAD');
      expect(hashes.has('initial.txt')).toBe(false);
    });
  });

  describe('getFileChanges (diff-tree)', () => {
    it('detects deleted files', async () => {
      const baseRef = exec('git rev-parse HEAD', repoPath);

      fs.unlinkSync(path.join(repoPath, 'initial.txt'));
      exec('git add -A && git commit -m "delete"', repoPath);

      const changes = await getFileChanges(repoPath, baseRef, 'HEAD');
      expect(changes.has('initial.txt')).toBe(true);
      expect(changes.get('initial.txt')!.status).toBe('D');
    });

    it('detects renamed files with similarity', async () => {
      const baseRef = exec('git rev-parse HEAD', repoPath);

      // Rename with git mv to ensure detection
      exec('git mv initial.txt renamed.txt', repoPath);
      exec('git commit -m "rename"', repoPath);

      const changes = await getFileChanges(repoPath, baseRef, 'HEAD');
      // Renamed files are keyed by the NEW path
      expect(changes.has('renamed.txt')).toBe(true);
      const change = changes.get('renamed.txt')!;
      expect(change.status).toBe('R');
      expect(change.oldPath).toBe('initial.txt');
    });

    it('returns empty map for identical refs', async () => {
      const ref = exec('git rev-parse HEAD', repoPath);
      const changes = await getFileChanges(repoPath, ref, ref);
      expect(changes.size).toBe(0);
    });

    it('detects multiple changes in one diff', async () => {
      const baseRef = exec('git rev-parse HEAD', repoPath);

      // Add, modify in one commit
      fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'modified\n');
      fs.writeFileSync(path.join(repoPath, 'brand-new.ts'), 'new\n');
      exec('git add -A && git commit -m "multiple changes"', repoPath);

      const changes = await getFileChanges(repoPath, baseRef, 'HEAD');
      expect(changes.has('initial.txt')).toBe(true);
      expect(changes.has('brand-new.ts')).toBe(true);
      expect(changes.get('initial.txt')!.status).toBe('M');
      expect(changes.get('brand-new.ts')!.status).toBe('A');
    });
  });

  describe('listCommitsBetween', () => {
    it('returns commits oldest-first by default', async () => {
      const baseRef = exec('git rev-parse HEAD', repoPath);

      fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
      exec('git add -A && git commit -m "commit A"', repoPath);

      fs.writeFileSync(path.join(repoPath, 'b.txt'), 'b\n');
      exec('git add -A && git commit -m "commit B"', repoPath);

      fs.writeFileSync(path.join(repoPath, 'c.txt'), 'c\n');
      exec('git add -A && git commit -m "commit C"', repoPath);

      const commits = await listCommitsBetween(repoPath, baseRef, 'HEAD');

      expect(commits).toHaveLength(3);
      expect(commits.map((c) => c.message)).toEqual(['commit A', 'commit B', 'commit C']);
    });

    it('limits the list to the newest commits, still oldest-first', async () => {
      const baseRef = exec('git rev-parse HEAD', repoPath);

      for (const n of [1, 2, 3, 4, 5]) {
        fs.writeFileSync(path.join(repoPath, `n${n}.txt`), `${n}\n`);
        exec(`git add -A && git commit -m "commit ${n}"`, repoPath);
      }

      const commits = await listCommitsBetween(repoPath, baseRef, 'HEAD', 3);

      expect(commits.map((c) => c.message)).toEqual(['commit 3', 'commit 4', 'commit 5']);
    });
  });

  describe('sync ref tracking', () => {
    it('returns null when no sync ref is stored', async () => {
      const stored = await getStoredSyncRef(repoPath);
      expect(stored).toBeNull();
    });

    it('updates stored ref on subsequent stores', async () => {
      const hash1 = exec('git rev-parse HEAD', repoPath);

      fs.writeFileSync(path.join(repoPath, 'second.txt'), 'second\n');
      exec('git add -A && git commit -m "second"', repoPath);
      const hash2 = exec('git rev-parse HEAD', repoPath);

      await storeLastSyncRef(repoPath, hash1);
      expect(await getStoredSyncRef(repoPath)).toBe(hash1);

      await storeLastSyncRef(repoPath, hash2);
      expect(await getStoredSyncRef(repoPath)).toBe(hash2);
    });
  });

  describe('isAncestor', () => {
    it('is true from parent to child and false the other way', async () => {
      const parent = exec('git rev-parse HEAD', repoPath);
      const child = makeCommit(repoPath, { files: { 'child.txt': 'child\n' }, message: 'child' });

      expect(await isAncestor(repoPath, parent, child)).toBe(true);
      expect(await isAncestor(repoPath, child, parent)).toBe(false);
    });

    it('returns true when both refs are the same', async () => {
      const ref = exec('git rev-parse HEAD', repoPath);
      expect(await isAncestor(repoPath, ref, ref)).toBe(true);
    });
  });

  describe('getEffectiveMergeBase', () => {
    /** Commit feature.txt on a new `feature` branch and return to main. Returns the feature tip. */
    function createFeatureBranch(): string {
      exec('git checkout -b feature', repoPath);
      const featureHash = makeCommit(repoPath, { files: { 'feature.txt': 'feature\n' }, message: 'feature' });
      exec('git checkout main', repoPath);
      return featureHash;
    }

    /** Write a working-tree sync manifest that records `sha` as the synced upstream commit. */
    function writeManifest(sha: string): void {
      write(repoPath, { 'cella/cella.manifest.json': `${JSON.stringify({ upstream: { commit: sha } })}\n` });
    }

    it('uses git merge-base when no stored ref exists', async () => {
      createFeatureBranch();

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      expect(result.isStale).toBe(false);
      expect(result.storedRef).toBeNull();
      expect(result.base).toBeTruthy();
    });

    it('prefers stored ref when it is newer than git merge-base', async () => {
      const featureHash = createFeatureBranch();

      // Store a ref that's the feature branch tip (newer than merge-base)
      await storeLastSyncRef(repoPath, featureHash);

      // Simulate a completed (squash) sync: the user commits, advancing HEAD past
      // the HEAD recorded by storeLastSyncRef. This is what marks the sync as done.
      makeCommit(repoPath, { files: { 'synced.txt': 'synced\n' }, message: 'squash sync' });

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      // Stored ref (feature tip) is a descendant of merge-base (branch point)
      expect(result.storedRef).toBe(featureHash);
      expect(result.isStale).toBe(true);
      expect(result.base).toBe(featureHash);
    });

    it('ignores stored ref left behind by an aborted merge (HEAD unchanged)', async () => {
      const featureHash = createFeatureBranch();
      const gitBase = exec('git merge-base main feature', repoPath);

      // Store the ref but do NOT advance HEAD — this mirrors a `git merge --abort`
      // where the staged sync ref persists but no merge commit was created.
      await storeLastSyncRef(repoPath, featureHash);

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      // Guard must discard the stale ref and fall back to git's natural merge-base.
      expect(result.storedRef).toBeNull();
      expect(result.isStale).toBe(false);
      expect(result.base).toBe(gitBase);
    });

    it('trusts stored ref when current HEAD committed the matching sync manifest', async () => {
      const featureHash = createFeatureBranch();

      // Simulate a squash-merged sync on main. The upstream commit is not in main's ancestry,
      // but the committed manifest records it as integrated.
      writeManifest(featureHash);
      exec('git add -A && git commit -m "sync manifest"', repoPath);

      // A later aborted rerun can record the current HEAD as last-sync-head. The committed
      // manifest proves this is still a valid squash-sync base, not an unintegrated stale ref.
      await storeLastSyncRef(repoPath, featureHash);

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      expect(result.storedRef).toBe(featureHash);
      expect(result.isStale).toBe(true);
      expect(result.base).toBe(featureHash);
    });

    it('recovers the squash-sync base from the committed manifest alone (fresh clone, no local refs)', async () => {
      const featureHash = createFeatureBranch();

      // Commit a manifest recording the squash-synced upstream commit, without storing any
      // local refs — the state of a fresh clone or a second maintainer's machine.
      writeManifest(featureHash);
      exec('git add -A && git commit -m "sync manifest"', repoPath);

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      expect(result.storedRef).toBe(featureHash);
      expect(result.isStale).toBe(true);
      expect(result.base).toBe(featureHash);
    });

    it('does not trust a manifest that only exists in the working tree (aborted sync)', async () => {
      const featureHash = createFeatureBranch();
      const gitBase = exec('git merge-base main feature', repoPath);

      // An aborted sync can leave the manifest in the working tree and the refs recorded at an
      // unadvanced HEAD. Nothing was committed, so nothing was integrated.
      writeManifest(featureHash);
      await storeLastSyncRef(repoPath, featureHash);

      const result = await getEffectiveMergeBase(repoPath, 'main', 'feature');
      expect(result.storedRef).toBeNull();
      expect(result.isStale).toBe(false);
      expect(result.base).toBe(gitBase);
    });
  });

  describe('listBranchMergeCommits / flattenBranch', () => {
    /**
     * Build the shape of a manually-committed sync merge: an "upstream" branch whose history
     * contains its own internal merge commit, merged into a sync branch cut from main.
     */
    function setupMergedSyncBranch(): void {
      // Upstream history with an internal merge (fa merges fb).
      exec('git checkout -b fa main', repoPath);
      fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
      exec('git add -A && git commit -m "upstream a"', repoPath);
      exec('git checkout -b fb main', repoPath);
      fs.writeFileSync(path.join(repoPath, 'b.txt'), 'b\n');
      exec('git add -A && git commit -m "upstream b"', repoPath);
      exec('git checkout fa', repoPath);
      exec('git merge fb --no-ff -m "upstream internal merge"', repoPath);

      // Sync branch from main: one normal commit, then a manual merge of the upstream branch.
      exec('git checkout -b cella/sync/test main', repoPath);
      fs.writeFileSync(path.join(repoPath, 'own.txt'), 'own\n');
      exec('git add -A && git commit -m "own commit"', repoPath);
      exec('git merge fa --no-ff -m "manual merge of upstream"', repoPath);
    }

    it('returns no merge commits for a branch of plain commits', async () => {
      exec('git checkout -b cella/sync/plain main', repoPath);
      fs.writeFileSync(path.join(repoPath, 'own.txt'), 'own\n');
      exec('git add -A && git commit -m "own commit"', repoPath);

      expect(await listBranchMergeCommits(repoPath, 'main')).toEqual([]);
    });

    it("lists the branch's own merge commits but not merges inside merged-in history", async () => {
      setupMergedSyncBranch();

      const merges = await listBranchMergeCommits(repoPath, 'main');
      expect(merges).toHaveLength(1);
      expect(exec(`git log -1 --format=%s ${merges[0]}`, repoPath)).toBe('manual merge of upstream');
    });

    it('flattens a merged branch to one commit with identical content', async () => {
      setupMergedSyncBranch();
      const treeBefore = exec('git rev-parse HEAD^{tree}', repoPath);

      await flattenBranch(repoPath, 'main', 'chore: sync upstream cella abc1234');

      // One single-parent commit on top of main, same tree, upstream history unreachable.
      expect(exec('git rev-list --count main..HEAD', repoPath)).toBe('1');
      expect(exec('git rev-parse HEAD^{tree}', repoPath)).toBe(treeBefore);
      expect(exec('git rev-parse HEAD^', repoPath)).toBe(exec('git rev-parse main', repoPath));
      expect(exec('git log -1 --format=%s', repoPath)).toBe('chore: sync upstream cella abc1234');
      expect(await listBranchMergeCommits(repoPath, 'main')).toEqual([]);
      // Content from both upstream sides and the branch's own commit is intact.
      expect(fs.existsSync(path.join(repoPath, 'a.txt'))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, 'b.txt'))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, 'own.txt'))).toBe(true);
    });
  });
});

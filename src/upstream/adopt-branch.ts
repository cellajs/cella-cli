import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CellaCliConfig } from '../config/types';
import { git } from '../utils/git';
import { analyzeRefs, enrichChangeInfo } from './classify';
import type { AnalyzedFile } from './model';
import { isIgnored, isPinned, isUnderAnyFolder } from './protection';

/** A single contributable file with classification and metadata. */
export interface ContribFile {
  /** File path relative to repo root */
  path: string;
  /** How adopting this file changes cella */
  kind: 'modified' | 'created' | 'deleted';
  /** `behind`: only the fork changed it since the merge-base; `diverged`: cella changed it too. */
  status: 'behind' | 'diverged';
  /** Relative date of the fork's change (e.g. '3 days ago') */
  changedAt?: string;
  /** Unix epoch seconds of the fork's change, for sorting */
  changedTs?: number;
}

/**
 * One analyzed file in adopt's terms, or null when the fork offers nothing in it. The analyzer
 * names its sides for an app pulling from upstream: its local side is cella here, and its incoming
 * side the fork. A file the fork created is offered only where its directory exists in cella, so
 * fork-specific modules do not flood the list (the fork's `ignored` folders keep out the rest).
 */
function toContribution(file: AnalyzedFile, cellaDirs: Set<string>): ContribFile | null {
  const { path, status, existsInApp: inCella, existsInUpstream: inFork } = file;
  if ((status !== 'behind' && status !== 'diverged') || file.isIgnored || file.isPinned) return null;
  if (!inCella && !cellaDirs.has(dirname(path))) return null;
  const kind = !inFork ? 'deleted' : inCella ? 'modified' : 'created';
  // The fork's change date: a `behind` file carries it as its only date, a `diverged` one beside cella's
  const changedAt = status === 'diverged' ? file.upstreamChangedAt : file.changedAt;
  const changedTs = status === 'diverged' ? file.upstreamChangedTs : file.changedTs;
  return { path, kind, status, changedAt, changedTs };
}

/**
 * Detect the files a fork contributes relative to cella's base branch, from a merge-base 3-way
 * analysis that tells the fork's changes from cella's own drift. `forkTerritory` (the fork's own
 * `ignored` list) keeps fork-specific modules out.
 */
export async function detectContributableFiles(
  repoPath: string,
  baseRef: string,
  forkRef: string,
  config: CellaCliConfig,
  forkTerritory: string[] = [],
): Promise<ContribFile[]> {
  // Common ancestor for 3-way comparison; fall back to baseRef if histories are unrelated
  const mergeBase = (await git(['merge-base', baseRef, forkRef], repoPath, { ignoreErrors: true })).trim() || baseRef;

  const predicates = {
    isIgnored: (path: string) => isIgnored(path, config) || isUnderAnyFolder(path, forkTerritory),
    isPinned: (path: string) => isPinned(path, config),
  };
  const analyzed = await analyzeRefs(repoPath, baseRef, forkRef, mergeBase, predicates);
  await enrichChangeInfo(repoPath, analyzed, mergeBase, baseRef, forkRef);

  // Seeded with '.': the repo root always exists in cella, so new fork files at the root are offered.
  const cellaDirs = new Set<string>(['.']);
  for (const path of (await git(['ls-tree', '-r', '--name-only', baseRef], repoPath)).split('\n').filter(Boolean)) {
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) cellaDirs.add(dir);
  }
  return analyzed.flatMap((file) => toContribution(file, cellaDirs) ?? []);
}

/**
 * Read mode and blob hash for a file at a ref.
 * Returns null if the path is not a regular blob at the ref.
 */
async function readBlobInfo(repoPath: string, ref: string, filePath: string): Promise<{ mode: string; hash: string } | null> {
  const line = await git(['ls-tree', ref, '--', filePath], repoPath, { ignoreErrors: true });
  if (!line) return null;
  // Format: "<mode> <type> <hash>\t<path>"
  const match = line.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t/);
  if (!match) return null;
  const [, mode, type, hash] = match;
  if (type !== 'blob') return null;
  // Only allow regular (100644) and executable (100755) file modes; skip symlinks/gitlinks
  if (mode !== '100644' && mode !== '100755') return null;
  return { mode, hash };
}

/**
 * Build a clean local `contrib/<fork>` branch from a fork's contributed files, where the changes
 * can be reviewed and adopted without a working-tree checkout.
 *
 * The branch is created on top of `baseRef` with only the fork's file overlays
 * applied via a temporary index; the working tree is never touched. Their blobs are
 * read from the fetched ref (already in cella's object store), never from the filesystem.
 *
 * @returns The branch name and number of files applied.
 */
export async function buildContribBranch(
  repoPath: string,
  baseRef: string,
  forkRef: string,
  files: ContribFile[],
  forkName: string,
): Promise<{ branch: string; appliedFiles: string[] }> {
  const branch = `contrib/${forkName}`;
  // Resolve the actual git dir: in a linked worktree `.git` is a pointer file, and the
  // worktree's git dir lives under the main checkout's `.git/worktrees/<name>`.
  const gitDir = resolve(repoPath, await git(['rev-parse', '--git-dir'], repoPath));
  const tmpIndex = join(gitDir, `tmp-contrib-index-${forkName.replace(/[^\w.-]/g, '_')}`);
  const indexEnv = { GIT_INDEX_FILE: tmpIndex };

  try {
    // Seed the temp index with cella's base tree
    await git(['read-tree', baseRef], repoPath, { env: indexEnv });

    const appliedFiles: string[] = [];

    // Overlay the fork's files (blobs already in the object store via fetch) and remove its deletions
    for (const { path, kind } of files) {
      if (kind === 'deleted') {
        await git(['update-index', '--remove', path], repoPath, { env: indexEnv, ignoreErrors: true });
        appliedFiles.push(`(deleted) ${path}`);
        continue;
      }
      const blob = await readBlobInfo(repoPath, forkRef, path);
      if (!blob) continue;
      const cacheinfo = `${blob.mode},${blob.hash},${path}`;
      await git(['update-index', '--add', '--replace', '--cacheinfo', cacheinfo], repoPath, { env: indexEnv });
      appliedFiles.push(path);
    }

    if (appliedFiles.length === 0) {
      return { branch, appliedFiles };
    }

    // Write tree and commit on top of base
    const treeHash = await git(['write-tree'], repoPath, { env: indexEnv });
    const parentHash = await git(['rev-parse', baseRef], repoPath);
    const commitBody = appliedFiles.map((f) => `- ${f}`).join('\n');
    const commitMessage = `contrib(${forkName}): ${appliedFiles.length} files\n\n${commitBody}`;
    const commitHash = await git(['commit-tree', treeHash, '-p', parentHash, '-m', commitMessage], repoPath);

    // Create/update the local branch ref without checkout
    await git(['update-ref', `refs/heads/${branch}`, commitHash], repoPath);

    return { branch, appliedFiles };
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

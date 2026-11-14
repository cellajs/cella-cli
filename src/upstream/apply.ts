import type { RuntimeConfig } from '../config/types';
import { printProgressStep } from '../utils/display';
import {
  checkoutFromRef,
  fileExistsAtRef,
  fileExistsInWorktree,
  getConflictedFiles,
  gitMv,
  gitRm,
  merge,
  mergeAbort,
  mergeInProgress,
  moveFromRef,
  removeFileFromWorktree,
  removeFileFully,
} from '../utils/git';
import { upgradePredicates } from './classify';
import type { AnalyzedFile, FileStatus } from './model';
import { isIgnored } from './protection';
import { formatMergeInProgressDetail } from './report';
import { withUpgradePointGraft } from './upgrade-point';

type ProgressCallback = (message: string) => void;

/** What {@link applyDirectMerge} left in the app. */
interface AppliedMerge {
  remainingConflicts: string[];
  autoMergedFiles: string[];
  protectedConflicts: string[];
}

/** Statuses the upgrade applies changes for: a staged upgrade holds at least one file with one of these. */
const upgradeAppliedStatuses: readonly FileStatus[] = ['behind', 'diverged', 'renamed', 'ignored', 'pinned'];

/** Protected whole-file resolution: the app side wins outright (ignored or pinned). */
function isProtectedFile(file: AnalyzedFile): boolean {
  return file.isIgnored || file.isPinned;
}

/**
 * A pinned path the app lacks that is new in upstream (`behind`, not a local deletion): upstream's
 * copy arrives once as the app's first one, as when an alignment pins a path before the merge
 * that creates it. Protection applies from the next upgrade on.
 */
function isPinnedFirstArrival(file: AnalyzedFile): boolean {
  return file.isPinned && !file.isIgnored && !file.existsInApp && file.existsInUpstream && file.status === 'behind';
}

/**
 * Apply the merge directly in the app (`git merge --no-commit`), with no worktree so conflicts
 * surface in the IDE. Files are classified from git refs before the merge starts, so pinned and
 * ignored files go back to the app side in one batch right after it, and the merge is left staged
 * for IDE 3-way conflict resolution, conflicts keeping their markers.
 */
export async function applyDirectMerge(
  repoRoot: string,
  upstreamRef: string,
  mergeBaseRef: string,
  config: RuntimeConfig,
  analyzedFiles: AnalyzedFile[],
  onProgress?: ProgressCallback,
): Promise<AppliedMerge> {
  // Protected files go back to the app side right after the merge: restored where the app has
  // them, removed where it does not, so an app deletion stands. One upstream moved goes to its new
  // path as the app has it at the old one.
  const batchRestorePaths: string[] = [];
  const batchRemovePaths: string[] = [];
  const movedProtected: { from: string; to: string }[] = [];
  for (const file of analyzedFiles) {
    if (file.status === 'identical' || file.status === 'ahead' || isPinnedFirstArrival(file)) continue;
    if (file.status === 'pinned' && file.renamedFrom) movedProtected.push({ from: file.renamedFrom, to: file.path });
    else if (file.isIgnored || file.isPinned) {
      (file.existsInApp ? batchRestorePaths : batchRemovePaths).push(file.path);
    }
  }

  // The temporary graft makes the merge 3-way against the recorded upgrade point, not git's own
  // (squash-stale) merge-base; without it, upstream hunks earlier upgrades integrated re-apply or
  // re-conflict on every run.
  onProgress?.('starting merge in the app...');
  await withUpgradePointGraft(repoRoot, 'HEAD', mergeBaseRef, () => merge(repoRoot, upstreamRef));

  if (batchRestorePaths.length > 0) {
    onProgress?.(`batch restoring ${batchRestorePaths.length} pinned/ignored files...`);
    await checkoutFromRef(repoRoot, 'HEAD', batchRestorePaths);
  }
  if (batchRemovePaths.length > 0) {
    onProgress?.(`batch removing ${batchRemovePaths.length} ignored files...`);
    await gitRm(repoRoot, batchRemovePaths);
    for (const filePath of batchRemovePaths) {
      await removeFileFromWorktree(repoRoot, filePath);
    }
  }
  for (const { from, to } of movedProtected) {
    onProgress?.(`→ ${from} → ${to}: keeping your copy (moved in upstream)`);
    await moveFromRef(repoRoot, 'HEAD', from, to);
  }

  // The remaining files, one by one; protected ones went with the batch above.
  for (const file of analyzedFiles) {
    const { path: filePath, status, existsInApp } = file;
    if (status === 'identical' || status === 'ahead' || (isProtectedFile(file) && !isPinnedFirstArrival(file)))
      continue;

    if (status === 'diverged') {
      // git's merge result stands for diverged files.
      onProgress?.(`→ ${filePath}: using git merge result (diverged)`);
      continue;
    }

    if (status === 'behind') {
      if (!existsInApp) {
        onProgress?.(
          `→ ${filePath}: adding from upstream (${isPinnedFirstArrival(file) ? "pinned, upstream's copy is your first" : 'new file'})`,
        );
        await checkoutFromRef(repoRoot, upstreamRef, [filePath]);
      } else if (!file.existsInUpstream) {
        // Upstream deleted the file: removed from the app, including leftovers after a squash merge.
        onProgress?.(`→ ${filePath}: removing (deleted in upstream)`);
        await removeFileFully(repoRoot, filePath);
      } else {
        // Both exist and only upstream changed: upstream's version is taken explicitly,
        // which resolves false conflicts from a stale merge-base (previous squash upgrades).
        onProgress?.(`→ ${filePath}: accepting upstream (behind)`);
        await checkoutFromRef(repoRoot, upstreamRef, [filePath]);
      }
      continue;
    }

    if (status === 'deleted') {
      await removeFileFully(repoRoot, filePath);
      continue;
    }

    if (status === 'renamed' && file.renamedFrom) {
      // Upstream renames apply as git mv to preserve history.
      const oldPath = file.renamedFrom;
      const oldPathExists = await fileExistsInWorktree(repoRoot, oldPath);
      const newPathExists = await fileExistsInWorktree(repoRoot, filePath);

      if (oldPathExists && !newPathExists) {
        onProgress?.(`→ ${oldPath} → ${filePath}: moving (renamed in upstream)`);
        try {
          await gitMv(repoRoot, oldPath, filePath);
        } catch {
          // git mv can fail mid-merge: fall back to remove plus checkout.
          await removeFileFully(repoRoot, oldPath);
          await checkoutFromRef(repoRoot, upstreamRef, [filePath]);
        }
      } else if (oldPathExists && newPathExists) {
        // Both exist (merge already staged the new file, but the old one is still in the worktree).
        onProgress?.(`→ ${oldPath} → ${filePath}: completing rename (removing old)`);
        await removeFileFully(repoRoot, oldPath);
        await checkoutFromRef(repoRoot, upstreamRef, [filePath]);
      } else {
        // Rename already applied (or neither path exists): the new path gets upstream's content.
        onProgress?.(`→ ${filePath}: updating from upstream (renamed)`);
        await checkoutFromRef(repoRoot, upstreamRef, [filePath]);
      }
    }
  }

  // Protected files whose upstream changes the app-wins resolution dropped, for the upgrade summary
  // (a Set keeps insertion order, so the report order stays).
  const protectedConflicts = new Set(analyzedFiles.filter((file) => file.upstreamChanged).map((file) => file.path));

  // Remaining git conflicts: only ignored/pinned resolve to the app; the rest keep their markers.
  for (const filePath of await getConflictedFiles(repoRoot)) {
    if (!isIgnored(filePath, config) && !upgradePredicates(config).isPinned(filePath)) continue;

    if (await fileExistsAtRef(repoRoot, 'HEAD', filePath)) {
      onProgress?.(`→ ${filePath}: keeping the app side (protected conflict)`);
      await checkoutFromRef(repoRoot, 'HEAD', [filePath]);
      protectedConflicts.add(filePath);
    } else {
      onProgress?.(`→ ${filePath}: removing (protected conflict, not in the app)`);
      await removeFileFully(repoRoot, filePath);
    }
  }

  const remainingConflicts = await getConflictedFiles(repoRoot);
  const remainingConflictSet = new Set(remainingConflicts);
  const autoMergedFiles = analyzedFiles
    .filter((file) => file.status === 'diverged' && !remainingConflictSet.has(file.path))
    .map((file) => file.path);

  return { remainingConflicts, autoMergedFiles, protectedConflicts: [...protectedConflicts] };
}

/**
 * Settle the merge {@link applyDirectMerge} left, and print its step: it stays staged while it holds
 * conflicts or upstream changes, with MERGE_HEAD in place so the IDE shows a 3-way merge, `git merge
 * --abort` works, and the finishing rerun tells a staged upgrade from a dirty tree, then commits it
 * single-parent. A merge that brings nothing is aborted; upstream already in HEAD starts none,
 * whatever the app changed in ignored files. Returns whether the merge stays staged.
 */
export async function settleMerge(repoRoot: string, files: AnalyzedFile[], applied: AppliedMerge): Promise<boolean> {
  const conflicts = applied.remainingConflicts.length;
  if (conflicts > 0) {
    printProgressStep('merged', formatMergeInProgressDetail(conflicts, applied.autoMergedFiles, { repoRoot }, 100));
    return true;
  }
  const merging = await mergeInProgress(repoRoot);
  if (merging && files.some((file) => upgradeAppliedStatuses.includes(file.status))) {
    const fromUpstream = files.filter((file) => ['behind', 'diverged', 'renamed'].includes(file.status)).length;
    printProgressStep(
      'upgraded',
      `${fromUpstream > 0 ? `${fromUpstream} files from upstream` : 'upstream changes'} (staged, commit to finish)`,
    );
    return true;
  }
  if (merging) await mergeAbort(repoRoot);
  printProgressStep('up to date', 'no upstream changes to merge');
  return false;
}

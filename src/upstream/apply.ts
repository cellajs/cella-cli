import { printProgressStep } from '../utils/display';
import {
  checkoutFromRef,
  getConflictedFiles,
  merge,
  mergeAbort,
  mergeInProgress,
  moveFromRef,
  removeFilesFully,
} from '../utils/git';
import { changedFromUpstream } from './classify';
import type { AnalyzedFile } from './model';
import { formatMergeInProgressDetail } from './report';
import { withUpgradePointGraft } from './upgrade-point';

type ProgressCallback = (message: string) => void;

/** What {@link applyDirectMerge} left in the app. */
interface AppliedMerge {
  remainingConflicts: string[];
  autoMergedFiles: string[];
}

/**
 * Apply the merge directly in the app (`git merge --no-commit`), with no worktree so conflicts
 * surface in the IDE, and leave it staged for IDE 3-way conflict resolution, conflicts keeping their
 * markers. git's result stands for every file but the protected ones: files are classified from git
 * refs before the merge starts, so those go back to the app side in one batch right after it.
 */
export async function applyDirectMerge(
  repoRoot: string,
  upstreamRef: string,
  mergeBaseRef: string,
  files: AnalyzedFile[],
  onProgress?: ProgressCallback,
): Promise<AppliedMerge> {
  const restored: string[] = [];
  const removed: string[] = [];
  const moved: { from: string; to: string }[] = [];
  for (const file of files) {
    if (file.resolution === 'keep') (file.existsInApp ? restored : removed).push(file.path);
    else if (file.resolution === 'move' && file.renamedFrom) moved.push({ from: file.renamedFrom, to: file.path });
  }

  // The temporary graft makes the merge 3-way against the recorded upgrade point, not git's own
  // (squash-stale) merge-base; without it, upstream hunks earlier upgrades integrated re-apply or
  // re-conflict on every run.
  onProgress?.('starting merge in the app...');
  await withUpgradePointGraft(repoRoot, 'HEAD', mergeBaseRef, () => merge(repoRoot, upstreamRef));

  if (restored.length > 0) {
    onProgress?.(`restoring ${restored.length} protected files...`);
    await checkoutFromRef(repoRoot, 'HEAD', restored);
  }
  if (removed.length > 0) {
    onProgress?.(`removing ${removed.length} protected files the app lacks...`);
    await removeFilesFully(repoRoot, removed);
  }
  for (const { from, to } of moved) {
    onProgress?.(`→ ${from} → ${to}: keeping your copy (moved in upstream)`);
    await moveFromRef(repoRoot, 'HEAD', from, to);
  }

  const remainingConflicts = await getConflictedFiles(repoRoot);
  const conflicted = new Set(remainingConflicts);
  const autoMergedFiles = files
    .filter((file) => file.resolution === 'merge' && !conflicted.has(file.path))
    .map((file) => file.path);
  return { remainingConflicts, autoMergedFiles };
}

/**
 * Settle the merge {@link applyDirectMerge} left, and print its step: it stays staged while it holds
 * conflicts or upstream changes, with MERGE_HEAD in place so the IDE shows a 3-way merge, `git merge
 * --abort` works, and the finishing rerun tells a staged upgrade from a dirty tree, then commits it
 * single-parent. A merge whose files all resolve to `none` brings nothing and is aborted; upstream
 * already in HEAD starts none. Returns whether the merge stays staged.
 */
export async function settleMerge(repoRoot: string, files: AnalyzedFile[], applied: AppliedMerge): Promise<boolean> {
  const conflicts = applied.remainingConflicts.length;
  if (conflicts > 0) {
    printProgressStep('merged', formatMergeInProgressDetail(conflicts, applied.autoMergedFiles, { repoRoot }, 100));
    return true;
  }
  const merging = await mergeInProgress(repoRoot);
  if (merging && files.some((file) => file.resolution !== 'none')) {
    const fromUpstream = changedFromUpstream(files).length;
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

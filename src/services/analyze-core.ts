/**
 * Direction-agnostic ref analyzer: compares a "local" ref against an "incoming" ref from a shared
 * merge-base and classifies every changed file, with git plumbing on refs only, never the working
 * tree. Sync runs it with local = fork HEAD and incoming = upstream, contributions with local =
 * cella branch and incoming = fork branch; `existsInFork`/`existsInUpstream` map to local/incoming.
 */

import type { AnalyzedFile, FileStatus } from '../config/types';
import { type FileChangeInfo, getDiffStat, getFileChangeInfo, getFileChanges, getFileHashesAtRef } from '../utils/git';
import { isGeneratedFile, isManagedFile } from '../utils/managed-files';

/** Predicates that steer classification (direction-specific). */
export interface AnalyzePredicates {
  /** True if the file is inside owned/ignored territory (never synced). */
  isIgnored: (path: string) => boolean;
  /** True if the file is pinned (local wins on conflict). */
  isPinned: (path: string) => boolean;
}

/** Whether an ignored path can carry `upstreamOnly`: not managed and not generated output. */
function isReportableIgnored(filePath: string): boolean {
  return !isManagedFile(filePath) && !isGeneratedFile(filePath);
}

type ProgressCallback = (message: string) => void;

/** Analyze files between a local and an incoming ref using a merge-base, in a repo that reaches all three. */
export async function analyzeRefs(
  repoPath: string,
  localRef: string,
  incomingRef: string,
  mergeBaseRef: string,
  predicates: AnalyzePredicates,
  onProgress?: ProgressCallback,
): Promise<AnalyzedFile[]> {
  onProgress?.('collecting file hashes (batch)...');

  const [forkHashes, upstreamHashes, baseHashes] = await Promise.all([
    getFileHashesAtRef(repoPath, localRef),
    getFileHashesAtRef(repoPath, incomingRef),
    getFileHashesAtRef(repoPath, mergeBaseRef),
  ]);

  // Changes between base and each tip; rename detection runs at -M90%.
  const upstreamChanges = await getFileChanges(repoPath, mergeBaseRef, incomingRef);
  const forkChanges = await getFileChanges(repoPath, mergeBaseRef, localRef);

  // oldPath -> newPath for renames in incoming.
  const upstreamRenames = new Map<string, string>();
  for (const [newPath, change] of upstreamChanges) {
    if (change.status === 'R' && change.oldPath) {
      upstreamRenames.set(change.oldPath, newPath);
    }
  }

  const allFiles = new Set([...forkHashes.keys(), ...upstreamHashes.keys(), ...upstreamRenames.keys()]);

  const changedFiles = new Set([...upstreamChanges.keys(), ...forkChanges.keys(), ...upstreamRenames.keys()]);

  // Content hashes present anywhere in incoming, for O(1) rename-source lookups below.
  const upstreamHashSet = new Set(upstreamHashes.values());

  onProgress?.(
    `analyzing ${changedFiles.size} changed files (${allFiles.size - changedFiles.size} identical skipped)...`,
  );

  const analyzedFiles: AnalyzedFile[] = [];
  const handledOldPaths = new Set<string>();
  // Protected files flagged `upstreamChanged` via a rename: their numstat at the new path
  // would count the whole file as added, so they get no line count.
  const renamedProtected = new Set<string>();
  let processed = 0;

  for (const filePath of allFiles) {
    if (handledOldPaths.has(filePath)) continue;

    const inFork = forkHashes.has(filePath);
    const inUpstream = upstreamHashes.has(filePath);

    const fileIsIgnored = predicates.isIgnored(filePath);
    const fileIsPinned = predicates.isPinned(filePath);

    const upstreamChange = upstreamChanges.get(filePath);
    const isUpstreamRename = upstreamChange?.status === 'R' && upstreamChange.oldPath;

    const renamedToPath = upstreamRenames.get(filePath);

    const push = (status: FileStatus, extra: Partial<AnalyzedFile> = {}) =>
      analyzedFiles.push({
        path: filePath,
        status,
        isIgnored: fileIsIgnored,
        isPinned: fileIsPinned,
        existsInFork: inFork,
        existsInUpstream: inUpstream,
        ...extra,
      });

    if (!changedFiles.has(filePath) && inFork && inUpstream) {
      push('identical');
      continue;
    }

    processed++;
    if (processed % 100 === 0) {
      onProgress?.(`analyzing ${processed}/${changedFiles.size} changed files...`);
    }

    const forkHash = forkHashes.get(filePath) ?? null;
    const upstreamHash = upstreamHashes.get(filePath) ?? null;
    const baseHash = baseHashes.get(filePath) ?? null;

    let status: FileStatus;
    let renamedFrom: string | undefined;

    if (isUpstreamRename && upstreamChange.oldPath) {
      const oldPath = upstreamChange.oldPath;
      const oldPathInFork = forkHashes.has(oldPath);
      const forkOldHash = forkHashes.get(oldPath) ?? null;
      const baseOldHash = baseHashes.get(oldPath) ?? null;

      handledOldPaths.add(oldPath);

      const forkModifiedOld = forkOldHash !== baseOldHash;

      // A renamed directory (e.g. config/ → shared/) can leave the local pinned
      // list referencing the old path, so both paths count for pinned/ignored.
      const oldPathPinned = predicates.isPinned(oldPath);

      let upstreamChanged: boolean | undefined;
      if (fileIsPinned || oldPathPinned || predicates.isIgnored(oldPath)) {
        // Protected: local's version is kept at the new path.
        status = 'pinned';
        // Local edited the old file and incoming changed its content beyond the rename.
        if (forkModifiedOld && upstreamHash !== baseOldHash) {
          upstreamChanged = true;
          renamedProtected.add(filePath);
        }
      } else if (!oldPathInFork) {
        // Old path absent locally (deleted or moved): plain behind, git's merge handles it.
        status = 'behind';
      } else if (forkModifiedOld) {
        // Local modified the old file: diverged, git's merge surfaces the conflict.
        status = 'diverged';
        renamedFrom = oldPath;
      } else {
        // Unmodified old file locally: a clean rename to apply.
        status = 'renamed';
        renamedFrom = oldPath;
      }

      // Incoming moved a file into (or within) ignored territory and the local side never
      // touched the source: an upstream-only change at the new path.
      const upstreamOnly = fileIsIgnored && !forkModifiedOld && isReportableIgnored(filePath);

      push(status, { existsInUpstream: true, renamedFrom, upstreamChanged, upstreamOnly: upstreamOnly || undefined });
      continue;
    }

    // Old paths of incoming renames are handled at the new path.
    if (renamedToPath) {
      handledOldPaths.add(filePath);
      continue;
    }

    if (fileIsIgnored) {
      status = 'ignored';
    } else if (!inFork && inUpstream) {
      // Missing locally: a pinned path, or one at base that incoming left untouched, is a local
      // deletion that stays deleted (re-adding it would resurface it every sync). A path new in
      // incoming, or one incoming modified after the local side deleted it, comes from incoming.
      const locallyDeleted = baseHash !== null && upstreamHash === baseHash;
      status = fileIsPinned || locallyDeleted ? 'deleted' : 'behind';
    } else if (inFork && !inUpstream) {
      if (baseHash !== null) {
        // In base, deleted by incoming: sync the deletion unless pinned.
        status = fileIsPinned ? 'ahead' : 'behind';
      } else {
        // Local file (never existed in merge-base). If its exact content exists at a
        // different path in incoming, it is likely the source of a rename we couldn't
        // detect due to a squash merge-base: treated as behind so the rename applies.
        // (This file is absent from incoming, so any hash match is at another path.)
        status = forkHash && upstreamHashSet.has(forkHash) ? 'behind' : 'local';
      }
    } else if (forkHash === upstreamHash) {
      status = 'identical';
    } else {
      const forkChanged = forkHash !== baseHash;
      const upstreamChanged = upstreamHash !== baseHash;

      if (forkChanged && upstreamChanged) {
        status = fileIsPinned ? 'pinned' : 'diverged';
      } else if (forkChanged && !upstreamChanged) {
        status = fileIsPinned ? 'ahead' : 'drifted';
      } else {
        status = 'behind';
      }
    }

    // Protected file where BOTH sides changed since the merge-base (a local edit or deletion,
    // and incoming content that differs from base). Local wins whole-file, so incoming's
    // hunks are dropped; the flag lets analyze/sync surface the loss. A protected file
    // that only changed locally is plain `ahead`; one that only changed incoming (`behind`
    // with the local copy still equal to base) is reported separately as a masking pin.
    const upstreamChanged =
      (fileIsPinned || fileIsIgnored) && inUpstream && upstreamHash !== baseHash && forkHash !== baseHash;

    // Ignored file only incoming changed, added or deleted since the merge-base (the local copy,
    // or its absence, still equals base). Nothing local is dropped, but ignored paths never sync,
    // so the change would stay unseen. The pinned counterpart is the masking pin (`behind`).
    const upstreamOnly =
      fileIsIgnored && isReportableIgnored(filePath) && upstreamHash !== baseHash && forkHash === baseHash;

    push(status, { upstreamChanged: upstreamChanged || undefined, upstreamOnly: upstreamOnly || undefined });
  }

  // Size the incoming changes the sync leaves out: one numstat call limited to the flagged paths.
  const flagged = analyzedFiles.filter(
    (file) => (file.upstreamChanged && !renamedProtected.has(file.path)) || file.upstreamOnly,
  );
  if (flagged.length > 0) {
    const stat = await getDiffStat(
      repoPath,
      mergeBaseRef,
      incomingRef,
      flagged.map((file) => file.path),
    );
    for (const file of flagged) {
      const entry = stat.get(file.path);
      if (entry && entry.additions !== null && entry.deletions !== null) {
        file.upstreamChangedLines = entry.additions + entry.deletions;
      }
    }
  }

  // Retroactive signal for pinned `ahead` files (incoming untouched since the merge-base, so
  // the check above cannot fire): count lines incoming has that local lacks, relative to
  // the tips, not the sync point. Pinned only; ignored territory is noise by design.
  const stale = analyzedFiles.filter(
    (file) =>
      file.status === 'ahead' &&
      file.isPinned &&
      !file.isIgnored &&
      file.existsInFork &&
      file.existsInUpstream &&
      forkHashes.get(file.path) !== upstreamHashes.get(file.path),
  );
  if (stale.length > 0) {
    // from = incoming, to = local: numstat deletions are incoming lines absent locally
    const stat = await getDiffStat(
      repoPath,
      incomingRef,
      localRef,
      stale.map((file) => file.path),
    );
    for (const file of stale) {
      const deletions = stat.get(file.path)?.deletions;
      if (deletions !== null && deletions !== undefined) file.upstreamLinesAbsent = deletions;
    }
  }

  return analyzedFiles;
}

/**
 * Enrich analyzed files in place with change dates and commit hashes: local-side dates for
 * ahead/drifted, incoming-side dates for behind, and both sides for diverged/pinned.
 */
export async function enrichChangeInfo(
  repoPath: string,
  files: AnalyzedFile[],
  mergeBaseRef: string,
  localRef: string,
  incomingRef: string,
): Promise<void> {
  const forkInfo = await getFileChangeInfo(repoPath, mergeBaseRef, localRef);
  const upstreamInfo = await getFileChangeInfo(repoPath, mergeBaseRef, incomingRef);
  const setChanged = (file: AnalyzedFile, info: FileChangeInfo | undefined) => {
    if (!info) return;
    file.changedAt = info.date;
    file.changedTs = info.timestamp;
    file.changedCommit = info.hash;
  };

  for (const file of files) {
    if (file.status === 'identical') continue;

    if (file.status === 'ahead' || file.status === 'drifted') {
      setChanged(file, forkInfo.get(file.path));
    } else if (file.status === 'behind') {
      setChanged(file, upstreamInfo.get(file.path));
    } else if (file.status === 'diverged' || file.status === 'pinned' || file.upstreamChanged || file.upstreamOnly) {
      // Diverged/pinned (and protected files incoming changed) carry both sides.
      setChanged(file, forkInfo.get(file.path));
      const info = upstreamInfo.get(file.path);
      if (info) {
        file.upstreamChangedAt = info.date;
        file.upstreamChangedTs = info.timestamp;
        file.upstreamCommit = info.hash;
      }
    }
  }
}

/**
 * Direction-agnostic ref analyzer for sync CLI.
 *
 * Compares a "local" ref against an "incoming" ref using a shared merge-base,
 * classifying every changed file (identical / ahead / local / drifted / behind /
 * diverged / pinned / ignored / deleted / renamed). It works purely on git
 * plumbing (ls-tree, diff-tree, log) against refs, never the working tree.
 *
 * Both directions reuse it:
 * - sync (merge-engine): local = fork HEAD, incoming = upstream
 * - contributions: local = cella branch, incoming = fork branch
 *
 * The result fields `existsInFork`/`existsInUpstream` map to local/incoming
 * respectively (named for the sync direction, reused as-is for contributions).
 *
 * Protected files (pinned/ignored) additionally get `upstreamChanged` when both sides
 * changed since the merge-base: the local side wins whole-file there, so incoming's hunks
 * are dropped silently unless surfaced. Ignored files only incoming changed get
 * `upstreamOnly`: nothing local is at stake, but the change never syncs. Managed files and
 * generated output (regenerated locally, never adopted) are left out of that flag.
 */

import type { AnalyzedFile, FileStatus } from '../config/types';
import { getDiffStat, getFileChangeInfo, getFileChanges, getFileHashesAtRef } from '../utils/git';
import { isGeneratedFile, isManagedFile } from '../utils/managed-files';

/** Predicates and options that steer classification (direction-specific). */
export interface AnalyzePredicates {
  /** True if the file is inside owned/ignored territory (never synced). */
  isIgnored: (path: string) => boolean;
  /** True if the file is pinned (local wins on conflict). */
  isPinned: (path: string) => boolean;
  /** Treat drifted files as behind (overwrite local with incoming). */
  hard?: boolean;
}

/** Whether an ignored path can carry `upstreamOnly`: not managed and not generated output. */
function isReportableIgnored(filePath: string): boolean {
  return !isManagedFile(filePath) && !isGeneratedFile(filePath);
}

type ProgressCallback = (message: string) => void;

/**
 * Analyze files between a local and an incoming ref using a merge-base.
 *
 * @param repoPath - Repo where all refs are reachable (git ops run here)
 * @param localRef - The "ours" ref (e.g. fork HEAD, or cella branch)
 * @param incomingRef - The "theirs" ref (e.g. upstream, or fork branch)
 * @param mergeBaseRef - Common ancestor ref used for 3-way comparison
 * @param predicates - Direction-specific ignore/pin/hard behavior
 */
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

    if (!changedFiles.has(filePath) && inFork && inUpstream) {
      analyzedFiles.push({
        path: filePath,
        status: 'identical',
        isIgnored: fileIsIgnored,
        isPinned: fileIsPinned,
        existsInFork: true,
        existsInUpstream: true,
      });
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

      analyzedFiles.push({
        path: filePath,
        status,
        isIgnored: fileIsIgnored,
        isPinned: fileIsPinned,
        existsInFork: inFork,
        existsInUpstream: true,
        renamedFrom,
        upstreamChanged,
        upstreamOnly: upstreamOnly || undefined,
      });
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
      // File is missing locally but present in incoming. Distinguish a genuinely new
      // incoming file from a file the local side deliberately deleted, by consulting
      // the merge-base (the symmetric `inFork && !inUpstream` branch does the same):
      // - pinned: local owns the path, keep it removed.
      // - existed at base and incoming hasn't touched it since (upstreamHash === baseHash):
      //   the absence is a deliberate local deletion that stays deleted; re-adding it
      //   as if incoming introduced a new file would resurface it every sync.
      // - otherwise (never in base = truly new, or incoming modified a file the local side
      //   deleted = delete/modify): surface incoming's version.
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
        // --hard treats drifted as behind (incoming overwrites).
        status = fileIsPinned ? 'ahead' : predicates.hard ? 'behind' : 'drifted';
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

    analyzedFiles.push({
      path: filePath,
      status,
      isIgnored: fileIsIgnored,
      isPinned: fileIsPinned,
      existsInFork: inFork,
      existsInUpstream: inUpstream,
      upstreamChanged: upstreamChanged || undefined,
      upstreamOnly: upstreamOnly || undefined,
    });
  }

  // Size the dropped incoming changes: one numstat call limited to the flagged paths.
  const flagged = analyzedFiles.filter((file) => file.upstreamChanged && !renamedProtected.has(file.path));
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
 * Enrich analyzed files with change dates and commit hashes.
 *
 * Mutates each non-identical file in place: local-side dates for ahead/drifted,
 * incoming-side dates for behind, and both sides for diverged/pinned.
 *
 * @param repoPath - Repo where the refs are reachable
 * @param files - Files to enrich (mutated in place)
 * @param mergeBaseRef - Common ancestor ref
 * @param localRef - The "ours" ref
 * @param incomingRef - The "theirs" ref
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

  for (const file of files) {
    if (file.status === 'identical') continue;

    if (file.status === 'ahead' || file.status === 'drifted') {
      const info = forkInfo.get(file.path);
      if (info) {
        file.changedAt = info.date;
        file.changedTs = info.timestamp;
        file.changedCommit = info.hash;
      }
    } else if (file.status === 'behind') {
      const info = upstreamInfo.get(file.path);
      if (info) {
        file.changedAt = info.date;
        file.changedTs = info.timestamp;
        file.changedCommit = info.hash;
      }
    } else if (file.status === 'diverged' || file.status === 'pinned' || file.upstreamChanged) {
      // Diverged/pinned (and protected files incoming also changed) carry both sides.
      const forkFileInfo = forkInfo.get(file.path);
      const upstreamFileInfo = upstreamInfo.get(file.path);
      if (forkFileInfo) {
        file.changedAt = forkFileInfo.date;
        file.changedTs = forkFileInfo.timestamp;
        file.changedCommit = forkFileInfo.hash;
      }
      if (upstreamFileInfo) {
        file.upstreamChangedAt = upstreamFileInfo.date;
        file.upstreamChangedTs = upstreamFileInfo.timestamp;
        file.upstreamCommit = upstreamFileInfo.hash;
      }
    }
  }
}

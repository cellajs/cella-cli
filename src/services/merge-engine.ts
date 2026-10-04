/**
 * Merge Engine for sync CLI v2.
 *
 * Two modes:
 * - Analyze (dry run): Uses worktree to preview changes without affecting fork
 * - Sync: Performs real merge directly in fork for full IDE support
 *
 * Sync mode approach:
 * 1. Start real merge in fork (git merge --no-commit)
 * 2. Apply resolutions directly (pinned→ours, ignored→rm, diverged→git's merge)
 * 3. Leave fork in merge state - conflicts have markers for IDE 3-way merge
 *
 * Key principle: Fork stays in real merge state for IDE conflict resolution.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AnalysisSummary,
  AnalyzedFile,
  MergeResult,
  RuntimeConfig,
  UpstreamOverridesReport,
} from '../config/types';
import { cleanupLeftoverWorktrees, cleanupWorktree, getWorktreePath, registerWorktree } from '../utils/cleanup';
import { cliVersionMismatch, readUpstreamCliRange } from '../utils/cli-version';
import { DEFAULT_UPSTREAM_REMOTE, resolveUpstream } from '../utils/config';
import { formatFetchedUpstreamDetail, formatMergeInProgressDetail, VERSION } from '../utils/display';
import {
  batchGitRm,
  batchRestoreToHead,
  batchUnstageFiles,
  type CommitRangeEntry,
  checkoutFromRef,
  countCommitsBetween,
  createWorktree,
  ensureRemote,
  ensureSyncBase,
  fetch,
  fetchUpstreamTags,
  fileExistsAtRef,
  fileExistsInWorktree,
  getCommitInfo,
  getConflictedFiles,
  getCurrentBranch,
  getEffectiveMergeBase,
  getMergeBase,
  getShortSha,
  getStagedNewFiles,
  getUpstreamStatus,
  getWorkingTreeChangeCount,
  git,
  gitMv,
  isAncestor,
  isPublishedUpstream,
  listCommitsBetween,
  merge,
  mergeAbort,
  removeFileFromWorktree,
  removeFileFully,
  resolveLatestReleaseTag,
  resolveUpstreamCommit,
  restoreToHead,
  stagePath,
  storeLastSyncRef,
  withTemporarySyncBaseGraft,
} from '../utils/git';
import { CONFIG_FILE, isManagedFile } from '../utils/managed-files';
import { MANIFEST_FILE, type SyncManifest, writeSyncManifest } from '../utils/manifest';
import {
  arrivedNoteIds,
  listNoteIds,
  NOTES_DIR,
  PENDING_FILE,
  readPending,
  writePending,
} from '../utils/migration-notes';
import {
  groupIgnoredUpstreamChanges,
  groupProtectedUpstreamChanges,
  isIgnored,
  isPinnedForSync,
} from '../utils/overrides';
import { compareUpstreamOverrides } from '../utils/upstream-overrides';
import { type AnalyzePredicates, analyzeRefs, enrichChangeInfo } from './analyze-core';

/** Progress callback type - receives message and optional detail for sub-line */
type ProgressCallback = (message: string, detail?: string) => void;

/** Step completion callback - marks a step as done with optional detail */
type StepCallback = (label: string, detail?: string) => void;

/**
 * Thrown when the upstream commit is behind the fork's last sync point: the fork already has it,
 * and merging it would stage a revert. `cella sync` ends as a no-op on it, unless the run pinned
 * the ref itself (`--ref`).
 */
export class BehindSyncPointError extends Error {}

/**
 * Thrown before a new merge starts when upstream changed its sync config in ways the fork config
 * does not follow. Carries the report so the caller can print it.
 */
export class UpstreamConfigChangedError extends Error {
  readonly report: UpstreamOverridesReport;

  constructor(report: UpstreamOverridesReport) {
    super(
      [
        'upstream changed its sync config and yours does not follow it: stopped before the merge, nothing changed.',
        `  add or drop the entries that fit your app in ${CONFIG_FILE}, commit, then rerun.`,
        '  to merge with your config as it stands, rerun with --keep-config.',
      ].join('\n'),
    );
    this.report = report;
  }
}

/**
 * Convert a git remote URL to a GitHub base URL.
 * Supports both SSH (git@github.com:org/repo.git) and HTTPS formats.
 */
export function getGitHubBaseUrl(remoteUrl: string): string | null {
  // SSH format: git@github.com:cellajs/cella.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^.]+)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS format: https://github.com/cellajs/cella.git
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}

/** Build analyzer predicates for the sync direction (local = fork, incoming = upstream). */
function syncPredicates(config: RuntimeConfig): AnalyzePredicates {
  return {
    isIgnored: (path) => isIgnored(path, config),
    isPinned: (path) => isPinnedForSync(path, config, config.unpinned),
    hard: config.hard,
  };
}

/**
 * Apply merge directly to fork with pre-analysis.
 *
 * Strategy: analyze BEFORE merge (uses git refs only, invisible to IDE),
 * then merge + immediate batch resolution to minimize working tree flickering.
 *
 * 1. Pre-analyze using git refs (no working tree changes)
 * 2. Collect batch resolution plan (which files to restore/remove)
 * 3. Start real merge in fork (git merge --no-commit)
 * 4. Immediately batch-restore pinned/ignored files (single git command)
 * 5. Apply remaining individual resolutions
 * 6. Leave fork in merge state for IDE 3-way conflict resolution
 */
async function applyDirectMerge(
  forkPath: string,
  upstreamRef: string,
  mergeBaseRef: string,
  config: RuntimeConfig,
  onProgress?: ProgressCallback,
): Promise<{
  remainingConflicts: string[];
  analyzedFiles: AnalyzedFile[];
  autoMergedFiles: string[];
  protectedConflicts: string[];
}> {
  // Phase 1: Pre-analyze using git refs (invisible to IDE).
  // analyzeRefs only uses git plumbing (ls-tree, diff-tree) on refs,
  // not the working tree, so results are identical before or after merge.
  onProgress?.('analyzing files...');
  const analyzedFiles = await analyzeRefs(
    forkPath,
    'HEAD',
    upstreamRef,
    mergeBaseRef,
    syncPredicates(config),
    onProgress,
  );

  // Phase 2: Collect batch resolution plan for immediate post-merge application.
  // These files will be restored to HEAD in a single git command right after merge,
  // preventing the IDE from seeing upstream changes to pinned/ignored files.
  const batchRestorePaths: string[] = [];
  const batchRemovePaths: string[] = [];

  for (const file of analyzedFiles) {
    const { path: filePath, status, isPinned: pinned, isIgnored: ignored, existsInFork } = file;
    if (status === 'identical' || status === 'ahead') continue;

    if (ignored && existsInFork) {
      batchRestorePaths.push(filePath);
    } else if (ignored && !existsInFork) {
      batchRemovePaths.push(filePath);
    } else if (pinned && !file.renamedFrom && existsInFork) {
      batchRestorePaths.push(filePath);
    } else if (pinned && !file.renamedFrom && !existsInFork) {
      // Pinned file doesn't exist in fork — remove from merge to keep fork's state (deleted)
      batchRemovePaths.push(filePath);
    }
  }

  // Phase 3: Start real merge in fork. Left staged with MERGE_HEAD intact so git and the IDE
  // treat it as a real in-progress merge (3-way conflict view, `git merge --abort` works).
  // The finishing rerun squashes the commit to a single parent (`commitSquash`) — upstream
  // ancestry is tracked via the manifest, never via a pushed two-parent merge commit.
  // The temporary graft makes the merge 3-way against the recorded sync point instead of
  // git's own (squash-stale) merge-base — without it, upstream hunks already integrated by
  // previous syncs re-apply or re-conflict on every run.
  onProgress?.('starting merge in fork...');
  await withTemporarySyncBaseGraft(forkPath, 'HEAD', mergeBaseRef, () =>
    merge(forkPath, upstreamRef, { noCommit: true, noEdit: true }),
  );

  // Phase 4: Immediately batch-restore pinned/ignored files.
  // Single git command restores all files at once, minimizing the window
  // where the IDE sees upstream changes to protected files.
  if (batchRestorePaths.length > 0) {
    onProgress?.(`batch restoring ${batchRestorePaths.length} pinned/ignored files...`);
    await batchRestoreToHead(forkPath, batchRestorePaths);
  }
  if (batchRemovePaths.length > 0) {
    onProgress?.(`batch removing ${batchRemovePaths.length} ignored files...`);
    await batchGitRm(forkPath, batchRemovePaths);
    for (const filePath of batchRemovePaths) {
      await removeFileFromWorktree(forkPath, filePath);
    }
  }

  // Phase 5: Apply remaining individual resolutions.
  // Pinned/ignored already handled in batch above — skip them here.
  for (const file of analyzedFiles) {
    const { path: filePath, status, isPinned: pinned, isIgnored: ignored, existsInFork } = file;

    if (status === 'identical' || status === 'ahead') {
      continue;
    }

    // Skip files already handled in batch
    if (ignored) continue;
    if (pinned && !file.renamedFrom) continue;

    if (pinned && file.renamedFrom) {
      // Renamed file where old path was pinned — accept the rename (new path)
      // but keep fork's content from the old path
      const oldPathExists = await fileExistsInWorktree(forkPath, file.renamedFrom);
      if (oldPathExists) {
        onProgress?.(`→ ${file.renamedFrom} → ${filePath}: moving fork content (pinned rename)`);
        try {
          await gitMv(forkPath, file.renamedFrom, filePath);
        } catch {
          // git mv failed — copy content manually
          await removeFileFully(forkPath, file.renamedFrom);
          // Checkout upstream's new path first, then restore fork content
          await checkoutFromRef(forkPath, 'HEAD', file.renamedFrom).catch(() => {});
        }
      } else {
        // Old path already gone — restore from HEAD at old path via git show
        onProgress?.(`→ ${filePath}: keeping fork content (pinned rename, old path removed)`);
        await restoreToHead(forkPath, filePath);
      }
      continue;
    }

    if (status === 'diverged') {
      // Let git's merge result stand - trust the merge
      onProgress?.(`→ ${filePath}: using git merge result (diverged)`);
      continue;
    }

    if (status === 'behind') {
      // File only in upstream or upstream has newer version
      if (!existsInFork) {
        // Upstream added new file
        onProgress?.(`→ ${filePath}: adding from upstream (new file)`);
        await checkoutFromRef(forkPath, upstreamRef, filePath);
      } else if (!file.existsInUpstream) {
        // Upstream deleted file - remove from fork (including leftovers after squash merge)
        onProgress?.(`→ ${filePath}: removing (deleted in upstream)`);
        await removeFileFully(forkPath, filePath);
      } else {
        // Both exist, only upstream changed - accept upstream version explicitly.
        // This resolves false conflicts from stale merge-base (previous squash syncs).
        onProgress?.(`→ ${filePath}: accepting upstream (behind)`);
        await checkoutFromRef(forkPath, upstreamRef, filePath);
      }
      continue;
    }

    if (status === 'deleted') {
      await removeFileFully(forkPath, filePath);
      continue;
    }

    if (status === 'renamed' && file.renamedFrom) {
      // Upstream renamed a file - apply as git mv to preserve history
      const oldPath = file.renamedFrom;
      const oldPathExists = await fileExistsInWorktree(forkPath, oldPath);
      const newPathExists = await fileExistsInWorktree(forkPath, filePath);

      if (oldPathExists && !newPathExists) {
        // Old exists, new doesn't - use git mv to move the file, preserving history
        onProgress?.(`→ ${oldPath} → ${filePath}: moving (renamed in upstream)`);
        try {
          await gitMv(forkPath, oldPath, filePath);
        } catch {
          // git mv failed (possibly due to merge state) - fall back to manual approach
          await removeFileFully(forkPath, oldPath);
          await checkoutFromRef(forkPath, upstreamRef, filePath);
        }
      } else if (oldPathExists && newPathExists) {
        // Both exist (merge already staged the new file, but old still in worktree)
        // Remove old and ensure new has correct content
        onProgress?.(`→ ${oldPath} → ${filePath}: completing rename (removing old)`);
        await removeFileFully(forkPath, oldPath);
        await checkoutFromRef(forkPath, upstreamRef, filePath);
      } else {
        // Rename already applied (or neither path exists) - ensure new path has upstream content
        onProgress?.(`→ ${filePath}: updating from upstream (renamed)`);
        await checkoutFromRef(forkPath, upstreamRef, filePath);
      }
    }
  }

  // Protected files where upstream's changes were dropped by the fork-wins resolution above:
  // the batch-restored pinned/ignored files that upstream also changed since the merge-base.
  // Surfaced in the sync summary so the loss is visible right when it happens.
  const protectedConflicts = analyzedFiles.filter((file) => file.upstreamChanged).map((file) => file.path);

  // Handle remaining git conflicts: auto-resolve only ignored/pinned (fork wins);
  // everything else keeps its markers for IDE 3-way resolution.
  const gitConflicts = await getConflictedFiles(forkPath);
  for (const filePath of gitConflicts) {
    const isProtected = isIgnored(filePath, config) || isPinnedForSync(filePath, config, config.unpinned);
    if (!isProtected) continue;

    if (await fileExistsAtRef(forkPath, 'HEAD', filePath)) {
      onProgress?.(`→ ${filePath}: keeping fork (protected conflict)`);
      await restoreToHead(forkPath, filePath);
      if (!protectedConflicts.includes(filePath)) protectedConflicts.push(filePath);
    } else {
      onProgress?.(`→ ${filePath}: removing (protected conflict, not in fork)`);
      await removeFileFully(forkPath, filePath);
    }
  }

  // Get remaining conflicts (these have markers for IDE)
  const remainingConflicts = await getConflictedFiles(forkPath);
  const remainingConflictSet = new Set(remainingConflicts);
  const autoMergedFiles = analyzedFiles
    .filter((file) => file.status === 'diverged' && !remainingConflictSet.has(file.path))
    .map((file) => file.path);

  // Phase 6: Safety net — clean up any ignored files still staged after merge.
  // During a merge, batchGitRm can silently fail on newly-added files, leaving
  // them as "Added in index, Deleted from working tree" (AD status). This catches
  // any ignored files that slipped through the earlier resolution phases.
  const stagedNewFiles = await getStagedNewFiles(forkPath);
  const staleIgnoredFiles = stagedNewFiles.filter((f) => isIgnored(f, config));
  if (staleIgnoredFiles.length > 0) {
    onProgress?.(`cleaning up ${staleIgnoredFiles.length} ignored files still in index...`);
    await batchUnstageFiles(forkPath, staleIgnoredFiles);
    for (const filePath of staleIgnoredFiles) {
      await removeFileFromWorktree(forkPath, filePath);
    }
  }

  return { remainingConflicts, analyzedFiles, autoMergedFiles, protectedConflicts };
}

/**
 * Calculate summary from analyzed files.
 */
function calculateSummary(files: AnalyzedFile[]): AnalysisSummary {
  const summary: AnalysisSummary = {
    managed: 0,
    identical: 0,
    ahead: 0,
    local: 0,
    drifted: 0,
    behind: 0,
    diverged: 0,
    pinned: 0,
    ignored: 0,
    deleted: 0,
    renamed: 0,
    total: files.length,
  };

  for (const file of files) {
    if (file.status !== 'identical' && isManagedFile(file.path)) {
      summary.managed++;
      continue;
    }

    summary[file.status]++;
  }

  return summary;
}

/**
 * Upstream context resolved once per run and shared by both engine modes.
 */
interface UpstreamContext {
  /** Concrete upstream ref merged from (branch tip, release-tag ref or a --ref commit sha) */
  upstreamRef: string;
  /** Release tag when tracking releases */
  releaseTag?: string;
  /** Effective merge-base used for the 3-way analysis */
  mergeBase: string;
  /** Recorded sync point. Same as `mergeBase`, except under --hard/--unpinned, which merge from the natural base */
  syncPoint: string;
  /** Upstream GitHub URL base for commit links */
  upstreamGitHubUrl?: string;
  /** Upstream HEAD commit info */
  upstreamCommit: { hash: string; message: string; date: string };
  /** Commits included in this sync range (oldest-first) */
  upstreamCommits: CommitRangeEntry[];
}

function formatLocalCheckoutDetail(
  forkPath: string,
  branch: string,
  headSha: string,
  changeCount: number,
  upstream: { upstream: string | null; ahead: number; behind: number },
): string {
  const tracking = upstream.upstream
    ? `, tracking ${upstream.upstream} (${upstream.ahead} ahead, ${upstream.behind} behind)`
    : ', no tracking branch';
  const workingTree =
    changeCount === 0
      ? '  working tree clean'
      : `  ${changeCount} uncommitted change${changeCount === 1 ? '' : 's'} in working tree, not included in analysis`;

  return [`${forkPath}`, `  ${branch} @ ${headSha}${tracking}`, workingTree].join('\n');
}

/**
 * Resolve a `--ref` to the upstream commit this run syncs to, after the fetch: an upstream branch
 * name, a release tag or a sha (see `resolveUpstreamCommit`). Refuses a ref that does not resolve,
 * or one upstream never published on its branch or in a release (a fork commit, an upstream
 * feature branch). A release tag syncs as that release; anything else as its commit sha, recorded
 * like branch tracking.
 */
async function resolvePinnedRef(
  forkPath: string,
  config: RuntimeConfig,
  remoteName: string,
  branchRef: string,
  ref: string,
): Promise<{ ref: string; releaseTag?: string }> {
  const resolved = await resolveUpstreamCommit(forkPath, remoteName, ref);
  if (!resolved) {
    throw new Error(
      `--ref '${ref}' does not resolve to a commit. Pass a commit sha, a release tag (v*) or a branch on ` +
        `${config.settings.upstreamUrl}.`,
    );
  }
  if (!(await isPublishedUpstream(forkPath, remoteName, branchRef, resolved.sha))) {
    throw new Error(
      `--ref '${ref}' (${resolved.sha.slice(0, 7)}) is not on ${branchRef} or in an upstream release (v*). ` +
        'Sync only to commits upstream has published there.',
    );
  }
  return resolved.release ? { ref: resolved.release.ref, releaseTag: resolved.release.tag } : { ref: resolved.sha };
}

/**
 * Resolve everything both modes need from upstream: remote setup, the concrete
 * ref to merge (branch tip, latest release tag or a pinned --ref), sync ancestry bootstrap,
 * effective merge-base, and commit info for progress output.
 */
async function prepareUpstream(
  config: RuntimeConfig,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<UpstreamContext> {
  const { forkPath } = config;

  onProgress?.('checking local checkout...');
  const [branch, headSha, changeCount, upstreamStatus] = await Promise.all([
    getCurrentBranch(forkPath),
    getShortSha(forkPath, 'HEAD'),
    getWorkingTreeChangeCount(forkPath),
    getUpstreamStatus(forkPath),
  ]);
  onStep?.('local checkout', formatLocalCheckoutDetail(forkPath, branch, headSha, changeCount, upstreamStatus));

  // Setup upstream remote
  onProgress?.('setting up upstream remote...');
  const { track: configTrack, branchRef } = resolveUpstream(config.settings);
  const remoteName = DEFAULT_UPSTREAM_REMOTE;
  // A per-run --track flag (config.track) overrides the configured tracking mode.
  const track = config.track ?? configTrack;
  await ensureRemote(forkPath, remoteName, config.settings.upstreamUrl);

  // Fetch upstream (branches, plus release tags into a fork-safe namespace).
  onProgress?.(`fetching upstream (${remoteName})...`);
  await fetch(forkPath, remoteName);

  // Resolve the concrete ref to merge from. A per-run --ref pins it (and wins over --track);
  // otherwise release tracking (default) syncs to the latest published release tag and
  // branch tracking follows the upstream branch tip.
  let upstreamRef = branchRef;
  let releaseTag: string | undefined;
  if (config.ref) {
    await fetchUpstreamTags(forkPath, remoteName);
    const pinned = await resolvePinnedRef(forkPath, config, remoteName, branchRef, config.ref);
    upstreamRef = pinned.ref;
    releaseTag = pinned.releaseTag;
  } else if (track === 'release') {
    await fetchUpstreamTags(forkPath, remoteName);
    const latest = await resolveLatestReleaseTag(forkPath, remoteName);
    if (!latest) {
      throw new Error(
        `no upstream releases (v*) found on '${remoteName}'. Set upstreamTrack: 'branch' to follow ${branchRef}, ` +
          `or check that ${config.settings.upstreamUrl} publishes release tags.`,
      );
    }
    upstreamRef = latest.ref;
    releaseTag = latest.tag;
  }
  const upstreamLabel = releaseTag ?? (config.ref ? `--ref ${config.ref}` : upstreamRef);

  // Expose the resolved ref to downstream steps (packages/analyze read config.upstreamRef
  // after the engine runs). The static fallback set at CLI parse time is the branch tip.
  config.upstreamRef = upstreamRef;
  onStep?.('remote configured', `${upstreamLabel} → ${config.settings.upstreamUrl}`);

  // Stop before anything merges when upstream was built with a newer CLI than this one.
  const cliRange = await readUpstreamCliRange(forkPath, upstreamRef);
  const cliMismatch = cliRange ? cliVersionMismatch(VERSION, cliRange) : null;
  if (cliMismatch) throw new Error(cliMismatch);

  // Bootstrap sync ancestry for forks with unrelated history (create-cella scaffold or an
  // upstream history squash). No-op once a native merge-base exists. Runs after fetch so the
  // base commit object is present, and after upstreamRef is finalized so release tags resolve.
  onProgress?.('checking sync base...');
  await ensureSyncBase(forkPath, 'HEAD', upstreamRef);

  const upstreamGitHubUrl = getGitHubBaseUrl(config.settings.upstreamUrl) ?? undefined;

  // Get effective merge base (handles stale base from previous squash syncs).
  // --hard and --unpinned use the natural merge-base instead, resurfacing the
  // full upstream history so previously-hidden drift/pins reappear consistently.
  const aggressive = config.hard === true || config.unpinned === true;
  const syncPoint = (await getEffectiveMergeBase(forkPath, 'HEAD', upstreamRef)).base;
  const mergeBase = aggressive ? await getMergeBase(forkPath, 'HEAD', upstreamRef) : syncPoint;

  // Get upstream commit info and count commits since merge-base
  const upstreamCommit = await getCommitInfo(forkPath, upstreamRef);

  // An upstream commit behind the sync point (an earlier run went further with --ref or --track
  // branch) would stage a revert of everything after it as if upstream had undone it: stop.
  if (upstreamCommit.hash !== syncPoint && (await isAncestor(forkPath, upstreamCommit.hash, syncPoint))) {
    const [upstreamShort, syncShort] = await Promise.all([
      getShortSha(forkPath, upstreamCommit.hash),
      getShortSha(forkPath, syncPoint),
    ]);
    const hint = config.ref
      ? 'Pick a newer --ref.'
      : releaseTag
        ? `Nothing to sync until a release past ${syncShort}; to follow the tip instead, run with --track branch.`
        : `Nothing to sync until '${branchRef}' moves past ${syncShort}.`;
    throw new BehindSyncPointError(
      `upstream ${upstreamLabel} (${upstreamShort}) is behind the last sync point ${syncShort}: the fork already ` +
        `has it, and syncing it would revert the upstream changes after it.\n${hint}`,
    );
  }
  const commitCount = await countCommitsBetween(forkPath, mergeBase, upstreamRef);
  const commitListMax = 50;
  const commitSkip = commitCount > commitListMax ? commitCount - commitListMax : 0;
  const upstreamCommits =
    commitCount > 0
      ? await listCommitsBetween(forkPath, mergeBase, upstreamRef, {
          oldestFirst: true,
          skip: commitSkip,
          limit: commitListMax,
        })
      : [];

  onStep?.('fetched upstream', formatFetchedUpstreamDetail(commitCount, upstreamCommits, upstreamGitHubUrl));

  return { upstreamRef, releaseTag, mergeBase, syncPoint, upstreamGitHubUrl, upstreamCommit, upstreamCommits };
}

/**
 * Stop a new merge when upstream changed its sync config since the sync point in ways the fork
 * config does not follow. The merge runs on the fork's config, so a path upstream newly ignores or
 * pins would arrive as an ordinary synced file (upstream renamed an ignored folder, the fork's list
 * still names the old one). Compared from the sync point, under `--hard`/`--unpinned` too: older
 * changes were reported by the syncs they arrived with. `--keep-config` skips the gate; an
 * unreadable upstream config or a failed comparison never stops the run.
 */
async function assertSyncConfigFollowed(config: RuntimeConfig, ctx: UpstreamContext): Promise<void> {
  if (config.keepConfig) return;
  const report = await compareUpstreamOverrides(config.forkPath, ctx.syncPoint, ctx.upstreamRef, config).catch(
    () => undefined,
  );
  if (report?.kind === 'changes') throw new UpstreamConfigChangedError(report);
}

/** MergeResult fields shared by both engine modes. */
function resultMeta(config: RuntimeConfig, ctx: UpstreamContext) {
  return {
    upstreamBranch: config.settings.upstreamBranch ?? 'main',
    upstreamRef: ctx.upstreamRef,
    upstreamTag: ctx.releaseTag,
    upstreamGitHubUrl: ctx.upstreamGitHubUrl,
    upstreamCommit: ctx.upstreamCommit,
    upstreamCommits: ctx.upstreamCommits,
  };
}

/**
 * Upstream changes the fork never receives, shared by both engine modes: the upstream config's
 * `overrides` entries and `packageJsonSync` keys the fork config does not follow (the config itself
 * never syncs), ignored files only upstream changed, and the protected files upstream also changed
 * (`protectedConflicts`) grouped by entry. Report only, read from refs (the merge state is
 * irrelevant); a failure here yields no report and never fails the run.
 */
async function upstreamOnlyReports(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  files: AnalyzedFile[],
  protectedConflicts: string[],
): Promise<
  Pick<MergeResult, 'upstreamDiffRange' | 'upstreamOverrides' | 'ignoredUpstreamChanges' | 'protectedUpstreamChanges'>
> {
  const { forkPath } = config;
  try {
    const [baseSha, upstreamSha, upstreamOverrides] = await Promise.all([
      getShortSha(forkPath, ctx.mergeBase),
      // the commit, not an annotated release tag object
      getShortSha(forkPath, ctx.upstreamCommit.hash),
      compareUpstreamOverrides(forkPath, ctx.mergeBase, ctx.upstreamRef, config),
    ]);
    return {
      upstreamDiffRange: `${baseSha}..${upstreamSha}`,
      upstreamOverrides,
      ignoredUpstreamChanges: groupIgnoredUpstreamChanges(files, config.overrides?.ignored ?? []),
      protectedUpstreamChanges: groupProtectedUpstreamChanges(protectedConflicts, config),
    };
  } catch {
    return {};
  }
}

/** Upstream migration notes for this sync range, plus the fork's pending list once the arrivals are added. */
interface NotesInRange {
  total: number;
  arrived: string[];
  pending: string[];
}

/**
 * Read the migration notes for this sync range: upstream's notes at the incoming ref and the ones
 * added since the recorded sync point. `--hard`/`--unpinned` merge from the natural merge-base,
 * but notes count from the sync point either way, so notes from earlier syncs are not added again.
 * Runs before the sync point moves. A failure yields no notes and never fails the run.
 */
async function readNotesInRange(config: RuntimeConfig, ctx: UpstreamContext): Promise<NotesInRange | undefined> {
  const { forkPath } = config;
  try {
    const [total, arrived, pending] = await Promise.all([
      listNoteIds(forkPath, ctx.upstreamRef),
      arrivedNoteIds(forkPath, ctx.syncPoint, ctx.upstreamRef),
      readPending(forkPath, ctx.syncPoint),
    ]);
    return { total: total.length, arrived, pending: [...new Set([...pending, ...arrived])] };
  } catch {
    return undefined;
  }
}

/** The {@link MergeResult} view of {@link NotesInRange}. */
function notesResult(notes: NotesInRange | undefined): Pick<MergeResult, 'migrationNotes'> {
  return notes ? { migrationNotes: { total: notes.total, arrived: notes.arrived, open: notes.pending.length } } : {};
}

/**
 * Remove the fork's copy of the upstream-only notes folder (forks that synced it before it became
 * upstream-only, and new apps whose scaffold cloned it). Staged with the sync.
 */
async function removeUpstreamOnlyCopy(forkPath: string, onStep?: StepCallback): Promise<void> {
  if (!existsSync(join(forkPath, NOTES_DIR))) return;
  await git(['rm', '-r', '-q', '--ignore-unmatch', '--', NOTES_DIR], forkPath);
  await rm(join(forkPath, NOTES_DIR), { recursive: true, force: true });
  onStep?.('migration notes', `removed ${NOTES_DIR}/: notes stay upstream, list them with pnpm cella migrate`);
}

/**
 * SYNC MODE: merge, analyze, and resolve directly in the fork, then record the
 * sync point (local ref + committed manifest) and leave the merge staged.
 */
async function runSyncMerge(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<MergeResult> {
  const { forkPath } = config;
  const { upstreamRef, releaseTag, mergeBase, upstreamGitHubUrl, upstreamCommit } = ctx;

  // Last gate before anything merges (the CLI version gate runs in prepareUpstream)
  await assertSyncConfigFollowed(config, ctx);

  const notes = await readNotesInRange(config, ctx);

  const { remainingConflicts, analyzedFiles, autoMergedFiles, protectedConflicts } = await applyDirectMerge(
    forkPath,
    upstreamRef,
    mergeBase,
    config,
    onProgress,
  );

  const summary = calculateSummary(analyzedFiles);
  const synced = analyzedFiles.filter((file) => ['behind', 'diverged', 'renamed'].includes(file.status)).length;

  // Count total resolved changes (includes ignored/pinned resolutions)
  const totalResolved = analyzedFiles.filter((file) =>
    ['behind', 'diverged', 'renamed', 'ignored', 'pinned'].includes(file.status),
  ).length;

  // Record the upstream sync point in lockstep: the local `refs/cella/last-sync` ref plus
  // the committed `cella/cella.manifest.json` (staged so it rides in the sync commit and travels
  // with the repo for fresh-clone bootstrap).
  const syncManifest: SyncManifest = {
    upstream: {
      repo: upstreamGitHubUrl ? upstreamGitHubUrl.replace('https://github.com/', '') : undefined,
      track: releaseTag ? 'release' : 'branch',
      commit: upstreamCommit.hash,
      release: releaseTag ?? null,
      url: upstreamGitHubUrl
        ? releaseTag
          ? `${upstreamGitHubUrl}/releases/tag/${releaseTag}`
          : `${upstreamGitHubUrl}/commit/${upstreamCommit.hash}`
        : undefined,
      syncedAt: new Date().toISOString(),
    },
  };
  const recordSyncPoint = async () => {
    await storeLastSyncRef(forkPath, upstreamCommit.hash);
    await writeSyncManifest(forkPath, syncManifest);
    await stagePath(forkPath, MANIFEST_FILE);
    // Notes that arrived join the fork's pending list; an empty list deletes the file.
    if (notes) {
      await writePending(forkPath, notes.pending);
      await stagePath(forkPath, PENDING_FILE);
    }
    await removeUpstreamOnlyCopy(forkPath, onStep);
  };

  if (remainingConflicts.length > 0) {
    // Conflicts: leave MERGE_HEAD intact for IDE 3-way merge resolution. The finishing
    // `cella sync` rerun commits single-parent (`commitSquash`); if the user commits manually
    // instead, the resulting merge commit is flattened away before the branch is pushed
    // (`flattenSyncBranch`) so the PR never lists the whole upstream history.
    await recordSyncPoint();
    onStep?.(
      'merge in progress',
      formatMergeInProgressDetail(remainingConflicts.length, autoMergedFiles, { forkPath }, 100),
    );
  } else if (totalResolved > 0) {
    const label = synced > 0 ? `${synced} files from upstream` : 'upstream changes';
    // Keep MERGE_HEAD so the finishing rerun can tell a staged sync from a plain dirty
    // tree (`mergeInProgress`) and `git merge --abort` still works. The commit itself is
    // made single-parent at commit time (`commitSquash`).
    await recordSyncPoint();
    onStep?.('synced', `${label} (staged, commit to finish)`);
  } else {
    // Truly nothing changed - clean up merge state
    await mergeAbort(forkPath);
    onStep?.('up to date', 'no upstream changes to sync');
  }

  return {
    success: remainingConflicts.length === 0,
    files: analyzedFiles,
    summary,
    conflicts: remainingConflicts,
    autoMergedFiles,
    protectedConflicts,
    ...resultMeta(config, ctx),
    ...(await upstreamOnlyReports(config, ctx, analyzedFiles, protectedConflicts)),
    ...notesResult(notes),
  };
}

/**
 * ANALYZE MODE: preview the merge in a temp worktree (invisible to the IDE),
 * classify all files, and discard the worktree — the fork is never touched.
 */
async function runAnalyzePreview(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<MergeResult> {
  const { forkPath } = config;
  const worktreePath = getWorktreePath(forkPath);
  const notes = await readNotesInRange(config, ctx);

  // Create worktree in temp directory (invisible to VSCode)
  onProgress?.('creating worktree in temp directory...');
  await createWorktree(forkPath, worktreePath, 'HEAD');
  onStep?.('worktree created', worktreePath);

  // Perform merge in worktree (always real merge, never --squash, for correct 3-way).
  // Replace refs are shared across worktrees, so the temporary graft on the fork's HEAD
  // commit steers this worktree merge to the recorded sync point too.
  onProgress?.('performing merge in worktree...');
  await withTemporarySyncBaseGraft(worktreePath, 'HEAD', ctx.mergeBase, () =>
    merge(worktreePath, ctx.upstreamRef, { noCommit: true, noEdit: true }),
  );
  onStep?.('merge complete', 'upstream merged into worktree');

  // Analyze all files, then enrich with change dates and commit hashes
  onProgress?.('analyzing files...');
  const analyzedFiles = await analyzeRefs(
    forkPath,
    'HEAD',
    ctx.upstreamRef,
    ctx.mergeBase,
    syncPredicates(config),
    onProgress,
  );
  await enrichChangeInfo(forkPath, analyzedFiles, ctx.mergeBase, 'HEAD', ctx.upstreamRef);
  const protectedConflicts = analyzedFiles.filter((f) => f.upstreamChanged).map((f) => f.path);
  const reports = await upstreamOnlyReports(config, ctx, analyzedFiles, protectedConflicts);
  onStep?.('analysis complete', `${analyzedFiles.length} files analyzed, dry run — no changes applied`);

  onProgress?.('cleaning up worktree...');
  await cleanupWorktree(forkPath, worktreePath);

  return {
    success: true,
    files: analyzedFiles,
    summary: calculateSummary(analyzedFiles),
    // For analyze mode, count diverged files as potential conflicts
    conflicts: analyzedFiles.filter((f) => f.status === 'diverged').map((f) => f.path),
    protectedConflicts,
    ...resultMeta(config, ctx),
    ...reports,
    ...notesResult(notes),
  };
}

/**
 * Main merge engine entry point: prepare upstream once, then run the requested mode.
 */
export async function runMergeEngine(
  config: RuntimeConfig,
  options: {
    apply: boolean;
    onProgress?: ProgressCallback;
    onStep?: StepCallback;
  },
): Promise<MergeResult> {
  const { forkPath } = config;
  const worktreePath = getWorktreePath(forkPath);
  const { apply, onProgress, onStep } = options;

  // Clean up any leftover worktree from a previous interrupted run
  await cleanupLeftoverWorktrees(forkPath);

  // Register worktree for cleanup on abort
  registerWorktree(forkPath, worktreePath);

  try {
    const ctx = await prepareUpstream(config, onProgress, onStep);
    return apply
      ? await runSyncMerge(config, ctx, onProgress, onStep)
      : await runAnalyzePreview(config, ctx, onProgress, onStep);
  } catch (error) {
    // Clean up on error
    await cleanupWorktree(forkPath, worktreePath);
    throw error;
  }
}

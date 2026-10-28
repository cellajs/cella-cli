/**
 * Merge engine, shared by analyze and sync. Analyze classifies every file from git refs and never
 * touches the fork. Sync merges in the fork itself (`git merge --no-commit`), resolves pinned and
 * ignored files to the fork side and leaves the merge staged, conflicts keeping their markers for
 * IDE 3-way resolution.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnalysisSummary,
  type AnalyzedFile,
  type CommitRangeEntry,
  type MergeResult,
  type RuntimeConfig,
  SYNC_APPLIED_STATUSES,
  type UpstreamOverridesReport,
} from '../config/types';
import {
  arrivedAlignmentIds,
  listAlignmentIds,
  PENDING_FILE,
  readPending,
  UPSTREAM_ONLY_DIRS,
  writePending,
} from '../utils/alignments';
import { cliVersionMismatch, readUpstreamCliRange } from '../utils/cli-version';
import pc from '../utils/colors';
import { DEFAULT_UPSTREAM_REMOTE, resolveUpstream } from '../utils/config';
import {
  COMMIT_STEP_MAX,
  createSpinner,
  formatCheckoutStep,
  formatMergeInProgressDetail,
  formatUpstreamStep,
  plural,
  printStep,
  spinnerText,
  VERSION,
} from '../utils/display';
import {
  checkoutFromRef,
  countCommitsBetween,
  ensureRemote,
  ensureSyncBase,
  fetchRemote,
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
  gitRm,
  isAncestor,
  isPublishedUpstream,
  listCommitsBetween,
  merge,
  mergeAbort,
  removeFileFromWorktree,
  removeFileFully,
  resolveLatestReleaseTag,
  resolveUpstreamCommit,
  stagePath,
  storeLastSyncRef,
  withTemporarySyncBaseGraft,
} from '../utils/git';
import { CONFIG_FILE, isManagedFile } from '../utils/managed-files';
import { MANIFEST_FILE, type SyncManifest, writeSyncManifest } from '../utils/manifest';
import { groupIgnoredUpstreamChanges, isIgnored, isPinned } from '../utils/overrides';
import { compareUpstreamOverrides } from '../utils/upstream-overrides';
import { type AnalyzePredicates, analyzeRefs, enrichChangeInfo } from './analyze-core';

type ProgressCallback = (message: string, detail?: string) => void;

type StepCallback = (label: string, detail?: string) => void;

/**
 * Thrown when the upstream commit is behind the fork's last sync point: the fork already has it,
 * and merging it would stage a revert. `cella upgrade` ends as a no-op on it, unless the run pinned
 * the ref itself (`--ref`).
 */
export class BehindSyncPointError extends Error {}

/**
 * Thrown before a new merge starts when upstream changed its CLI config in ways the fork config
 * does not follow. Carries the report so the caller can print it.
 */
export class UpstreamConfigChangedError extends Error {
  readonly report: UpstreamOverridesReport;

  constructor(report: UpstreamOverridesReport) {
    super(
      [
        'upstream changed its CLI config and yours does not follow it: stopped before the merge, nothing changed.',
        `  add or drop the entries that fit your app in ${CONFIG_FILE}, commit, then rerun.`,
        '  to merge with your config as it stands, rerun with --keep-config.',
      ].join('\n'),
    );
    this.report = report;
  }
}

/** Convert a git remote URL (SSH `git@github.com:org/repo.git` or HTTPS) to a GitHub base URL. */
export function getGitHubBaseUrl(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/** The fork's GitHub base URL from its `origin` remote; undefined without one on GitHub. */
export async function readOriginGitHubUrl(forkPath: string): Promise<string | undefined> {
  const origin = await git(['remote', 'get-url', 'origin'], forkPath, { ignoreErrors: true });
  return getGitHubBaseUrl(origin.trim()) ?? undefined;
}

/** Protected whole-file resolution: the fork side wins outright (ignored or pinned). */
function isProtectedFile(file: AnalyzedFile): boolean {
  return file.isIgnored || file.isPinned;
}

/** Build analyzer predicates for the sync direction (local = fork, incoming = upstream). */
function syncPredicates(config: RuntimeConfig): AnalyzePredicates {
  return {
    isIgnored: (path) => isIgnored(path, config),
    isPinned: (path) => (config.unpinned ? isManagedFile(path) : isPinned(path, config)),
  };
}

/**
 * Apply the merge directly in the fork. Files are classified from git refs before the merge starts,
 * so pinned and ignored files go back to the fork side in one batch right after it, and the merge
 * is left staged for IDE 3-way conflict resolution.
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
  onProgress?.('analyzing files...');
  const analyzedFiles = await analyzeRefs(
    forkPath,
    'HEAD',
    upstreamRef,
    mergeBaseRef,
    syncPredicates(config),
    onProgress,
  );

  // Protected files go back to the fork side right after the merge: restored where the fork has
  // them, removed where it does not, so a fork deletion stands.
  const batchRestorePaths: string[] = [];
  const batchRemovePaths: string[] = [];
  for (const file of analyzedFiles) {
    if (file.status === 'identical' || file.status === 'ahead') continue;
    if (file.isIgnored || (file.isPinned && !file.renamedFrom)) {
      (file.existsInFork ? batchRestorePaths : batchRemovePaths).push(file.path);
    }
  }

  // The temporary graft makes the merge 3-way against the recorded sync point, not git's own
  // (squash-stale) merge-base; without it, upstream hunks earlier syncs integrated re-apply or
  // re-conflict on every run.
  onProgress?.('starting merge in fork...');
  await withTemporarySyncBaseGraft(forkPath, 'HEAD', mergeBaseRef, () => merge(forkPath, upstreamRef));

  if (batchRestorePaths.length > 0) {
    onProgress?.(`batch restoring ${batchRestorePaths.length} pinned/ignored files...`);
    await checkoutFromRef(forkPath, 'HEAD', batchRestorePaths);
  }
  if (batchRemovePaths.length > 0) {
    onProgress?.(`batch removing ${batchRemovePaths.length} ignored files...`);
    await gitRm(forkPath, batchRemovePaths);
    for (const filePath of batchRemovePaths) {
      await removeFileFromWorktree(forkPath, filePath);
    }
  }

  // The remaining files, one by one; protected ones went with the batch above.
  for (const file of analyzedFiles) {
    const { path: filePath, status, existsInFork } = file;
    if (status === 'identical' || status === 'ahead' || isProtectedFile(file)) continue;

    if (status === 'diverged') {
      // git's merge result stands for diverged files.
      onProgress?.(`→ ${filePath}: using git merge result (diverged)`);
      continue;
    }

    if (status === 'behind') {
      if (!existsInFork) {
        onProgress?.(`→ ${filePath}: adding from upstream (new file)`);
        await checkoutFromRef(forkPath, upstreamRef, [filePath]);
      } else if (!file.existsInUpstream) {
        // Upstream deleted the file: removed from the fork, including leftovers after a squash merge.
        onProgress?.(`→ ${filePath}: removing (deleted in upstream)`);
        await removeFileFully(forkPath, filePath);
      } else {
        // Both exist and only upstream changed: upstream's version is taken explicitly,
        // which resolves false conflicts from a stale merge-base (previous squash syncs).
        onProgress?.(`→ ${filePath}: accepting upstream (behind)`);
        await checkoutFromRef(forkPath, upstreamRef, [filePath]);
      }
      continue;
    }

    if (status === 'deleted') {
      await removeFileFully(forkPath, filePath);
      continue;
    }

    if (status === 'renamed' && file.renamedFrom) {
      // Upstream renames apply as git mv to preserve history.
      const oldPath = file.renamedFrom;
      const oldPathExists = await fileExistsInWorktree(forkPath, oldPath);
      const newPathExists = await fileExistsInWorktree(forkPath, filePath);

      if (oldPathExists && !newPathExists) {
        onProgress?.(`→ ${oldPath} → ${filePath}: moving (renamed in upstream)`);
        try {
          await gitMv(forkPath, oldPath, filePath);
        } catch {
          // git mv can fail mid-merge: fall back to remove plus checkout.
          await removeFileFully(forkPath, oldPath);
          await checkoutFromRef(forkPath, upstreamRef, [filePath]);
        }
      } else if (oldPathExists && newPathExists) {
        // Both exist (merge already staged the new file, but the old one is still in the worktree).
        onProgress?.(`→ ${oldPath} → ${filePath}: completing rename (removing old)`);
        await removeFileFully(forkPath, oldPath);
        await checkoutFromRef(forkPath, upstreamRef, [filePath]);
      } else {
        // Rename already applied (or neither path exists): the new path gets upstream's content.
        onProgress?.(`→ ${filePath}: updating from upstream (renamed)`);
        await checkoutFromRef(forkPath, upstreamRef, [filePath]);
      }
    }
  }

  // Protected files whose upstream changes the fork-wins resolution dropped, for the sync summary
  // (a Set keeps insertion order, so the report order stays).
  const protectedConflicts = new Set(analyzedFiles.filter((file) => file.upstreamChanged).map((file) => file.path));

  // Remaining git conflicts: only ignored/pinned resolve to the fork; the rest keep their markers.
  for (const filePath of await getConflictedFiles(forkPath)) {
    if (!isIgnored(filePath, config) && !syncPredicates(config).isPinned(filePath)) continue;

    if (await fileExistsAtRef(forkPath, 'HEAD', filePath)) {
      onProgress?.(`→ ${filePath}: keeping fork (protected conflict)`);
      await checkoutFromRef(forkPath, 'HEAD', [filePath]);
      protectedConflicts.add(filePath);
    } else {
      onProgress?.(`→ ${filePath}: removing (protected conflict, not in fork)`);
      await removeFileFully(forkPath, filePath);
    }
  }

  const remainingConflicts = await getConflictedFiles(forkPath);
  const remainingConflictSet = new Set(remainingConflicts);
  const autoMergedFiles = analyzedFiles
    .filter((file) => file.status === 'diverged' && !remainingConflictSet.has(file.path))
    .map((file) => file.path);

  // Safety net: during a merge, the batched `git rm` can silently fail on newly added files, leaving
  // ignored files staged as added in the index and deleted from the working tree (AD).
  const stagedNewFiles = await getStagedNewFiles(forkPath);
  const staleIgnoredFiles = stagedNewFiles.filter((f) => isIgnored(f, config));
  if (staleIgnoredFiles.length > 0) {
    onProgress?.(`cleaning up ${staleIgnoredFiles.length} ignored files still in index...`);
    await gitRm(forkPath, staleIgnoredFiles, { cached: true });
    for (const filePath of staleIgnoredFiles) {
      await removeFileFromWorktree(forkPath, filePath);
    }
  }

  return { remainingConflicts, analyzedFiles, autoMergedFiles, protectedConflicts: [...protectedConflicts] };
}

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

/** Upstream context resolved once per run and shared by both engine modes. */
interface UpstreamContext {
  /** Concrete upstream ref merged from (branch tip, release-tag ref or a --ref commit sha) */
  upstreamRef: string;
  /** Release tag when tracking releases */
  releaseTag?: string;
  /** Effective merge-base used for the 3-way analysis, which is also the last sync point */
  mergeBase: string;
  /** Base of the merge itself: the sync point, or the natural merge-base under --unpinned */
  mergeRef: string;
  /** Upstream GitHub URL base for commit links */
  upstreamGitHubUrl?: string;
  /** Upstream HEAD commit info */
  upstreamCommit: CommitRangeEntry;
  /** Upstream commits since the last sync */
  commitCount: number;
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
      `--ref '${ref}' does not resolve to a commit. Pass a commit sha, a release tag or a branch on ` +
        `${config.settings.upstreamUrl}.`,
    );
  }
  if (!(await isPublishedUpstream(forkPath, remoteName, branchRef, resolved.sha))) {
    throw new Error(
      `--ref '${ref}' (${resolved.sha.slice(0, 7)}) is not on ${branchRef} or in an upstream release. ` +
        'Upgrade only to commits upstream has published there.',
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
  onStep?.('checkout', formatCheckoutStep({ forkPath, branch, headSha, changeCount, upstream: upstreamStatus }));

  onProgress?.('setting up upstream remote...');
  const { track: configTrack, branchRef } = resolveUpstream(config.settings);
  const remoteName = DEFAULT_UPSTREAM_REMOTE;
  // A per-run --track flag (config.track) overrides the configured tracking mode.
  const track = config.track ?? configTrack;
  await ensureRemote(forkPath, remoteName, config.settings.upstreamUrl);

  onProgress?.(`fetching upstream (${remoteName})...`);
  await fetchRemote(forkPath, remoteName);

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
        `no upstream release tags found on '${remoteName}'. Set upstreamTrack: 'branch' to follow ${branchRef}, ` +
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

  // Effective merge base (handles a stale base from previous squash syncs).
  const mergeBase = (await getEffectiveMergeBase(forkPath, 'HEAD', upstreamRef)).base;
  const mergeRef = config.unpinned ? await getMergeBase(forkPath, 'HEAD', upstreamRef) : mergeBase;

  const upstreamCommit = await getCommitInfo(forkPath, upstreamRef);

  // An upstream commit behind the sync point (an earlier run went further with --ref or --track
  // branch) would stage a revert of everything after it as if upstream had undone it: stop.
  if (upstreamCommit.hash !== mergeBase && (await isAncestor(forkPath, upstreamCommit.hash, mergeBase))) {
    const [upstreamShort, syncShort] = await Promise.all([
      getShortSha(forkPath, upstreamCommit.hash),
      getShortSha(forkPath, mergeBase),
    ]);
    const hint = config.ref
      ? 'Pick a newer --ref.'
      : releaseTag
        ? `Nothing to upgrade until a release past ${syncShort}; to follow the tip instead, run with --track branch.`
        : `Nothing to upgrade until '${branchRef}' moves past ${syncShort}.`;
    throw new BehindSyncPointError(
      `upstream ${upstreamLabel} (${upstreamShort}) is behind the last upgrade at ${syncShort}: the fork already ` +
        `has it, and merging it would revert the upstream changes after it.\n${hint}`,
    );
  }
  const commitCount = await countCommitsBetween(forkPath, mergeBase, upstreamRef);
  const upstreamCommits =
    commitCount > 0 ? await listCommitsBetween(forkPath, mergeBase, upstreamRef, COMMIT_STEP_MAX) : [];

  const [upstreamShort, baseShort] = await Promise.all([
    getShortSha(forkPath, upstreamCommit.hash),
    getShortSha(forkPath, mergeBase),
  ]);
  onStep?.(
    'upstream',
    formatUpstreamStep({
      label: releaseTag ?? branchRef.replace(`${remoteName}/`, ''),
      sha: upstreamShort,
      baseSha: baseShort,
      pinned: !!config.ref,
      commitCount,
      commits: upstreamCommits,
      githubUrl: upstreamGitHubUrl,
    }),
  );

  return { upstreamRef, releaseTag, mergeBase, mergeRef, upstreamGitHubUrl, upstreamCommit, commitCount };
}

/**
 * Stop a new merge when upstream changed its CLI config since the sync point in ways the fork
 * config does not follow. The merge runs on the fork's config, so a path upstream newly ignores or
 * pins would arrive as an ordinary synced file (upstream renamed an ignored folder, the fork's list
 * still names the old one). `--keep-config` skips the gate; an unreadable upstream config or a
 * failed comparison never stops the run.
 */
async function assertSyncConfigFollowed(config: RuntimeConfig, ctx: UpstreamContext): Promise<void> {
  if (config.keepConfig) return;
  const report = await compareUpstreamOverrides(config.forkPath, ctx.mergeBase, ctx.upstreamRef, config).catch(
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
    upstreamCommitCount: ctx.commitCount,
  };
}

/**
 * Upstream changes the fork never receives, shared by both engine modes: the upstream config's
 * `overrides` entries and `packageJsonKeys` the fork config does not follow (the config itself
 * never merges), ignored files only upstream changed, and the range the review page diffs upstream's
 * changes over. Report only, read from refs (the merge state is irrelevant); a failure here yields
 * no report and never fails the run.
 */
async function upstreamOnlyReports(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  files: AnalyzedFile[],
): Promise<Pick<MergeResult, 'upstreamDiffRange' | 'upstreamOverrides' | 'ignoredUpstreamChanges'>> {
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
    };
  } catch {
    return {};
  }
}

/** Upstream alignments for this sync range, and the fork's pending list before the arrivals are added. */
interface AlignmentsInRange {
  total: number;
  arrived: string[];
  pending: string[];
}

/** The fork's pending list once a sync records the arrivals. */
function pendingAfterSync(alignments: AlignmentsInRange): string[] {
  return [...new Set([...alignments.pending, ...alignments.arrived])];
}

/**
 * Read the alignments for this sync range: upstream's alignments at the incoming ref and the ones
 * added since the recorded sync point. Runs before the sync point moves. A failure yields no
 * alignments and never fails the run.
 */
async function readAlignmentsInRange(
  config: RuntimeConfig,
  ctx: UpstreamContext,
): Promise<AlignmentsInRange | undefined> {
  const { forkPath } = config;
  try {
    const [total, arrived, pending] = await Promise.all([
      listAlignmentIds(forkPath, ctx.upstreamRef),
      arrivedAlignmentIds(forkPath, ctx.mergeBase, ctx.upstreamRef),
      readPending(forkPath),
    ]);
    return { total: total.length, arrived, pending };
  } catch {
    return undefined;
  }
}

/**
 * The {@link MergeResult} view of {@link AlignmentsInRange}. A sync records the arrivals as open; a
 * dry run leaves them arriving, since `pnpm cella align` only lists them once the sync lands.
 */
function alignmentsResult(
  alignments: AlignmentsInRange | undefined,
  options: { dryRun: boolean },
): Pick<MergeResult, 'alignments'> {
  if (!alignments) return {};
  const open = options.dryRun ? alignments.pending : pendingAfterSync(alignments);
  return { alignments: { total: alignments.total, arrived: alignments.arrived, open } };
}

/**
 * Remove the fork's copy of an upstream-only folder (forks that synced it before it became
 * upstream-only, and new apps whose scaffold cloned it). Staged with the sync.
 */
async function removeUpstreamOnlyCopy(forkPath: string, onStep?: StepCallback): Promise<void> {
  for (const dir of UPSTREAM_ONLY_DIRS) {
    if (!existsSync(join(forkPath, dir))) continue;
    await git(['rm', '-r', '-q', '--ignore-unmatch', '--', dir], forkPath);
    await rm(join(forkPath, dir), { recursive: true, force: true });
    onStep?.('alignments', `removed ${dir}/: alignments stay upstream, list them with pnpm cella align`);
  }
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
  const { upstreamRef, releaseTag, mergeRef, upstreamGitHubUrl, upstreamCommit } = ctx;

  // Last gate before anything merges (the CLI version gate runs in prepareUpstream)
  await assertSyncConfigFollowed(config, ctx);

  const alignments = await readAlignmentsInRange(config, ctx);

  const { remainingConflicts, analyzedFiles, autoMergedFiles, protectedConflicts } = await applyDirectMerge(
    forkPath,
    upstreamRef,
    mergeRef,
    config,
    onProgress,
  );

  const summary = calculateSummary(analyzedFiles);
  const synced = analyzedFiles.filter((file) => ['behind', 'diverged', 'renamed'].includes(file.status)).length;

  const totalResolved = analyzedFiles.filter((file) => SYNC_APPLIED_STATUSES.includes(file.status)).length;

  // Record the sync point in lockstep: the local `refs/cella/last-upgrade` ref plus the manifest,
  // staged so it rides in the upgrade commit.
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
      upgradedAt: new Date().toISOString(),
    },
  };
  const recordSyncPoint = async () => {
    await storeLastSyncRef(forkPath, upstreamCommit.hash);
    await writeSyncManifest(forkPath, syncManifest);
    await stagePath(forkPath, MANIFEST_FILE);
    // Alignments that arrived join the fork's pending list; an empty list deletes the file.
    if (alignments) {
      await writePending(forkPath, pendingAfterSync(alignments));
      await stagePath(forkPath, PENDING_FILE);
    }
    await removeUpstreamOnlyCopy(forkPath, onStep);
  };

  // MERGE_HEAD stays in both staged cases: the IDE shows a 3-way merge, `git merge --abort` works,
  // and the finishing rerun tells a staged sync from a dirty tree, then commits it single-parent.
  if (remainingConflicts.length > 0) {
    await recordSyncPoint();
    onStep?.('merged', formatMergeInProgressDetail(remainingConflicts.length, autoMergedFiles, { forkPath }, 100));
  } else if (totalResolved > 0) {
    const label = synced > 0 ? `${synced} files from upstream` : 'upstream changes';
    await recordSyncPoint();
    onStep?.('upgraded', `${label} (staged, commit to finish)`);
  } else {
    // Nothing changed: clean up the merge state.
    await mergeAbort(forkPath);
    onStep?.('up to date', 'no upstream changes to merge');
  }

  return {
    success: remainingConflicts.length === 0,
    files: analyzedFiles,
    summary,
    conflicts: remainingConflicts,
    autoMergedFiles,
    protectedConflicts,
    ...resultMeta(config, ctx),
    ...(await upstreamOnlyReports(config, ctx, analyzedFiles)),
    ...alignmentsResult(alignments, { dryRun: false }),
  };
}

/** ANALYZE MODE: classify every file from git refs; the fork is never touched. */
async function runAnalyzePreview(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<MergeResult> {
  const { forkPath } = config;
  const alignments = await readAlignmentsInRange(config, ctx);

  onProgress?.('analyzing files...');
  const analyzedFiles = await analyzeRefs(
    forkPath,
    'HEAD',
    ctx.upstreamRef,
    ctx.mergeRef,
    syncPredicates(config),
    onProgress,
  );
  await enrichChangeInfo(forkPath, analyzedFiles, ctx.mergeBase, 'HEAD', ctx.upstreamRef);
  const protectedConflicts = analyzedFiles.filter((f) => f.upstreamChanged).map((f) => f.path);
  const reports = await upstreamOnlyReports(config, ctx, analyzedFiles);
  onStep?.('analyzed', `${plural(analyzedFiles.length, 'file')}${pc.dim(' · dry run, nothing changed')}`);

  return {
    success: true,
    files: analyzedFiles,
    summary: calculateSummary(analyzedFiles),
    // For analyze mode, count diverged files as potential conflicts
    conflicts: analyzedFiles.filter((f) => f.status === 'diverged').map((f) => f.path),
    protectedConflicts,
    ...resultMeta(config, ctx),
    ...reports,
    ...alignmentsResult(alignments, { dryRun: true }),
  };
}

/**
 * Merge engine entry point for analyze and sync: prepare upstream once, then run the requested
 * mode. Progress updates the spinner text; each completed step prints with its detail and starts a
 * fresh spinner.
 */
export async function runEngineWithSpinner(config: RuntimeConfig, apply: boolean): Promise<MergeResult> {
  const onProgress: ProgressCallback = (message) => spinnerText(message);
  const onStep: StepCallback = (label, detail) => {
    printStep(label, detail);
    createSpinner('...');
  };
  const ctx = await prepareUpstream(config, onProgress, onStep);
  return apply ? runSyncMerge(config, ctx, onProgress, onStep) : runAnalyzePreview(config, ctx, onProgress, onStep);
}

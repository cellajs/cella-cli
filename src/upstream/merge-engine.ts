/**
 * Merge engine, shared by analyze and upgrade. Analyze classifies every file from git refs and leaves
 * the app's branches and working tree unchanged; like upgrade, it fetches upstream and may record the
 * upgrade point in local refs. Upgrade merges in the app itself (`git merge --no-commit`), resolves pinned
 * and ignored files to the app side and leaves the merge staged, conflicts keeping their markers
 * for IDE 3-way resolution.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readReleaseAgeMinutes } from '../audit/pnpm';
import { defaultBranch, defaultUpstreamRemote, resolveUpstream } from '../config/load';
import {
  type AnalysisSummary,
  type AnalyzedFile,
  type CommitRangeEntry,
  type MergeResult,
  type RuntimeConfig,
  type UpstreamOverridesReport,
  upgradeAppliedStatuses,
} from '../config/types';
import pc from '../utils/colors';
import {
  commitStepMax,
  createSpinner,
  formatCheckoutStep,
  formatMergeInProgressDetail,
  formatUpstreamStep,
  plural,
  printStep,
  spinnerText,
  version,
} from '../utils/display';
import {
  checkoutFromRef,
  countCommitsBetween,
  ensureRemote,
  ensureUpgradePoint,
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
  getTrackingStatus,
  getWorkingTreeChangeCount,
  git,
  gitMv,
  gitRm,
  isAncestor,
  isPublishedUpstream,
  listCommitsBetween,
  merge,
  mergeAbort,
  mergeInProgress,
  moveFromRef,
  removeFileFromWorktree,
  removeFileFully,
  resolveLatestReleaseTag,
  resolveUpstreamCommit,
  stagePath,
  storeUpgradePoint,
  withUpgradePointGraft,
} from '../utils/git';
import {
  alignmentsDir,
  arrivedAlignmentIds,
  listAlignmentIds,
  pendingFile,
  readPending,
  writePending,
} from './alignments';
import { type AnalyzePredicates, analyzeRefs, enrichChangeInfo } from './classify';
import { cliVersionMismatch, readUpstreamCliRange, releaseAgeExcludeHint } from './cli-version';
import { compareUpstreamOverrides, hasBlockingOverrideChanges } from './config-gate';
import { configFile, isManagedFile } from './managed-files';
import { manifestFile, type UpgradeManifest, writeManifest } from './manifest';
import { groupIgnoredUpstreamChanges, isIgnored, isPinned } from './protection';

type ProgressCallback = (message: string, detail?: string) => void;

type StepCallback = (label: string, detail?: string) => void;

/**
 * Thrown when the upstream commit is behind the app's last upgrade point: the app already has it,
 * and merging it would stage a revert. `cella upgrade` ends as a no-op on it, unless the run pinned
 * the ref itself (`--ref`).
 */
export class BehindUpgradePointError extends Error {}

/**
 * Thrown before a new merge starts when upstream changed its CLI config in ways the app config
 * does not follow. Carries the report so the caller can print it.
 */
export class UpstreamConfigChangedError extends Error {
  readonly report: UpstreamOverridesReport;

  constructor(report: UpstreamOverridesReport) {
    super(
      [
        'upstream changed its CLI config and yours does not follow it: stopped before the merge, nothing changed.',
        `  add or drop the entries that fit your app in ${configFile}, commit, then rerun.`,
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

/** The app's GitHub base URL from its `origin` remote; undefined without one on GitHub. */
export async function readOriginGitHubUrl(repoRoot: string): Promise<string | undefined> {
  const origin = await git(['remote', 'get-url', 'origin'], repoRoot, { ignoreErrors: true });
  return getGitHubBaseUrl(origin.trim()) ?? undefined;
}

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

/** Build analyzer predicates for the upgrade direction (local = app, incoming = upstream). */
function upgradePredicates(config: RuntimeConfig): AnalyzePredicates {
  return {
    isIgnored: (path) => isIgnored(path, config),
    isPinned: (path) => (config.unpinned ? isManagedFile(path) : isPinned(path, config)),
  };
}

/**
 * Apply the merge directly in the app. Files are classified from git refs before the merge starts,
 * so pinned and ignored files go back to the app side in one batch right after it, and the merge
 * is left staged for IDE 3-way conflict resolution.
 */
async function applyDirectMerge(
  repoRoot: string,
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
    repoRoot,
    'HEAD',
    upstreamRef,
    mergeBaseRef,
    upgradePredicates(config),
    onProgress,
  );

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
  /** Effective merge-base used for the 3-way analysis, which is also the last upgrade point */
  mergeBase: string;
  /** Base of the merge itself: the upgrade point, or the natural merge-base under --unpinned */
  mergeRef: string;
  /** Upstream GitHub URL base for commit links */
  upstreamGitHubUrl?: string;
  /** Upstream HEAD commit info */
  upstreamCommit: CommitRangeEntry;
  /** Upstream commits since the last upgrade */
  commitCount: number;
}

/**
 * Resolve a `--ref` to the upstream commit this run upgrades to, after the fetch: an upstream branch
 * name, a release tag or a sha (see `resolveUpstreamCommit`). Refuses a ref that does not resolve,
 * or one upstream never published on its branch or in a release (an app commit, an upstream
 * feature branch). A release tag upgrades as that release; anything else as its commit sha, recorded
 * like branch tracking.
 */
async function resolvePinnedRef(
  repoRoot: string,
  config: RuntimeConfig,
  remoteName: string,
  branchRef: string,
  ref: string,
): Promise<{ ref: string; releaseTag?: string }> {
  const resolved = await resolveUpstreamCommit(repoRoot, remoteName, ref);
  if (!resolved) {
    throw new Error(
      `--ref '${ref}' does not resolve to a commit. Pass a commit sha, a release tag or a branch on ` +
        `${config.upstreamUrl}.`,
    );
  }
  if (!(await isPublishedUpstream(repoRoot, remoteName, branchRef, resolved.sha))) {
    throw new Error(
      `--ref '${ref}' (${resolved.sha.slice(0, 7)}) is not on ${branchRef} or in an upstream release. ` +
        'Upgrade only to commits upstream has published there.',
    );
  }
  return resolved.release ? { ref: resolved.release.ref, releaseTag: resolved.release.tag } : { ref: resolved.sha };
}

/**
 * Resolve everything both modes need from upstream: remote setup, the concrete
 * ref to merge (branch tip, latest release tag or a pinned --ref), upgrade ancestry bootstrap,
 * effective merge-base, and commit info for progress output.
 */
async function prepareUpstream(
  config: RuntimeConfig,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<UpstreamContext> {
  const { repoRoot } = config;

  onProgress?.('checking local checkout...');
  const [branch, headSha, changeCount, trackingStatus] = await Promise.all([
    getCurrentBranch(repoRoot),
    getShortSha(repoRoot, 'HEAD'),
    getWorkingTreeChangeCount(repoRoot),
    getTrackingStatus(repoRoot),
  ]);
  onStep?.('checkout', formatCheckoutStep({ branch, headSha, changeCount, tracking: trackingStatus }));

  onProgress?.('setting up upstream remote...');
  const { track: configTrack, branchRef } = resolveUpstream(config);
  const remoteName = defaultUpstreamRemote;
  // A per-run --track flag (config.track) overrides the configured tracking mode.
  const track = config.track ?? configTrack;
  await ensureRemote(repoRoot, remoteName, config.upstreamUrl);

  onProgress?.(`fetching upstream (${remoteName})...`);
  await fetchRemote(repoRoot, remoteName);

  // Resolve the concrete ref to merge from. A per-run --ref pins it (and wins over --track);
  // otherwise release tracking (default) upgrades to the latest published release tag and
  // branch tracking follows the upstream branch tip.
  let upstreamRef = branchRef;
  let releaseTag: string | undefined;
  if (config.ref) {
    await fetchUpstreamTags(repoRoot, remoteName);
    const pinned = await resolvePinnedRef(repoRoot, config, remoteName, branchRef, config.ref);
    upstreamRef = pinned.ref;
    releaseTag = pinned.releaseTag;
  } else if (track === 'release') {
    await fetchUpstreamTags(repoRoot, remoteName);
    const latest = await resolveLatestReleaseTag(repoRoot, remoteName);
    if (!latest) {
      throw new Error(
        `no upstream release tags found on '${remoteName}'. Set upstreamTrack: 'branch' to follow ${branchRef}, ` +
          `or check that ${config.upstreamUrl} publishes release tags.`,
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
  const cliRange = await readUpstreamCliRange(repoRoot, upstreamRef);
  const cliMismatch = cliRange ? cliVersionMismatch(version, cliRange) : null;
  if (cliMismatch && cliRange) {
    const delayed = (await readReleaseAgeMinutes(repoRoot)) > 0;
    throw new Error(delayed ? `${cliMismatch}\n${releaseAgeExcludeHint(cliRange)}` : cliMismatch);
  }

  // Bootstrap upgrade ancestry for apps with unrelated history (create-cella scaffold or an
  // upstream history squash). No-op once a native merge-base exists. Runs after fetch so the
  // base commit object is present, and after upstreamRef is finalized so release tags resolve.
  onProgress?.('checking the upgrade point...');
  await ensureUpgradePoint(repoRoot, 'HEAD', upstreamRef);

  const upstreamGitHubUrl = getGitHubBaseUrl(config.upstreamUrl) ?? undefined;

  // Effective merge base (handles a stale base from previous squash upgrades).
  const mergeBase = await getEffectiveMergeBase(repoRoot, 'HEAD', upstreamRef);
  const mergeRef = config.unpinned ? await getMergeBase(repoRoot, 'HEAD', upstreamRef) : mergeBase;

  const upstreamCommit = await getCommitInfo(repoRoot, upstreamRef);

  // An upstream commit behind the upgrade point (an earlier run went further with --ref or --track
  // branch) would stage a revert of everything after it as if upstream had undone it: stop.
  if (upstreamCommit.hash !== mergeBase && (await isAncestor(repoRoot, upstreamCommit.hash, mergeBase))) {
    const [upstreamShort, upgradePointShort] = await Promise.all([
      getShortSha(repoRoot, upstreamCommit.hash),
      getShortSha(repoRoot, mergeBase),
    ]);
    const hint = config.ref
      ? 'Pick a newer --ref.'
      : releaseTag
        ? `Nothing to upgrade until a release past ${upgradePointShort}; to follow the tip instead, run with --track branch.`
        : `Nothing to upgrade until '${branchRef}' moves past ${upgradePointShort}.`;
    throw new BehindUpgradePointError(
      `upstream ${upstreamLabel} (${upstreamShort}) is behind the last upgrade at ${upgradePointShort}: the app already ` +
        `has it, and merging it would revert the upstream changes after it.\n${hint}`,
    );
  }
  const commitCount = await countCommitsBetween(repoRoot, mergeBase, upstreamRef);
  const upstreamCommits =
    commitCount > 0 ? await listCommitsBetween(repoRoot, mergeBase, upstreamRef, commitStepMax) : [];

  const [upstreamShort, baseShort] = await Promise.all([
    getShortSha(repoRoot, upstreamCommit.hash),
    getShortSha(repoRoot, mergeBase),
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
 * Stop a new merge when upstream changed its CLI config since the upgrade point in ways the app
 * config does not follow. The merge runs on the app's config, so a path upstream newly ignores or
 * pins would arrive as an ordinary merged file (upstream renamed an ignored folder, the app's list
 * still names the old one). `--keep-config` skips the gate; an unreadable upstream config or a
 * failed comparison never stops the run.
 */
async function assertUpstreamConfigFollowed(config: RuntimeConfig, ctx: UpstreamContext): Promise<void> {
  if (config.keepConfig) return;
  const report = await compareUpstreamOverrides(config.repoRoot, ctx.mergeBase, ctx.upstreamRef, config).catch(
    () => undefined,
  );
  // A report of moved entries alone prints with the merge result and stops nothing.
  if (report && hasBlockingOverrideChanges(report)) throw new UpstreamConfigChangedError(report);
}

/** MergeResult fields shared by both engine modes. */
function resultMeta(config: RuntimeConfig, ctx: UpstreamContext) {
  return {
    upstreamBranch: config.upstreamBranch ?? defaultBranch,
    upstreamRef: ctx.upstreamRef,
    upstreamGitHubUrl: ctx.upstreamGitHubUrl,
    upstreamCommit: ctx.upstreamCommit,
    upstreamCommitCount: ctx.commitCount,
  };
}

/**
 * Upstream changes the app never receives, shared by both engine modes: the upstream config's
 * `pinned`, `ignored` and `packageJsonKeys` entries the app config does not follow (the config itself
 * never merges), ignored files only upstream changed, and the range the review page diffs upstream's
 * changes over. Report only, read from refs (the merge state is irrelevant); a failure here yields
 * no report and never fails the run.
 */
async function upstreamOnlyReports(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  files: AnalyzedFile[],
): Promise<Pick<MergeResult, 'upstreamDiffRange' | 'upstreamOverrides' | 'ignoredUpstreamChanges'>> {
  const { repoRoot } = config;
  try {
    const [baseSha, upstreamSha, upstreamOverrides] = await Promise.all([
      getShortSha(repoRoot, ctx.mergeBase),
      // the commit, not an annotated release tag object
      getShortSha(repoRoot, ctx.upstreamCommit.hash),
      compareUpstreamOverrides(repoRoot, ctx.mergeBase, ctx.upstreamRef, config),
    ]);
    return {
      upstreamDiffRange: `${baseSha}..${upstreamSha}`,
      upstreamOverrides,
      ignoredUpstreamChanges: groupIgnoredUpstreamChanges(files, config.ignored ?? []),
    };
  } catch {
    return {};
  }
}

/** Upstream alignments for this upgrade range, and the app's pending list before the arrivals are added. */
interface AlignmentsInRange {
  total: number;
  arrived: string[];
  pending: string[];
}

/** The app's pending list once an upgrade records the arrivals. */
function pendingAfterUpgrade(alignments: AlignmentsInRange): string[] {
  return [...new Set([...alignments.pending, ...alignments.arrived])];
}

/**
 * Read the alignments for this upgrade range: upstream's alignments at the incoming ref and the ones
 * added since the recorded upgrade point. Runs before the upgrade point moves. A failure yields no
 * alignments and never fails the run.
 */
async function readAlignmentsInRange(
  config: RuntimeConfig,
  ctx: UpstreamContext,
): Promise<AlignmentsInRange | undefined> {
  const { repoRoot } = config;
  try {
    const [total, arrived, pending] = await Promise.all([
      listAlignmentIds(repoRoot, ctx.upstreamRef),
      arrivedAlignmentIds(repoRoot, ctx.mergeBase, ctx.upstreamRef),
      readPending(repoRoot),
    ]);
    return { total: total.length, arrived, pending };
  } catch {
    return undefined;
  }
}

/**
 * The {@link MergeResult} view of {@link AlignmentsInRange}. An upgrade records the arrivals as open; a
 * dry run leaves them arriving, since `pnpm cella align` only lists them once the upgrade lands.
 */
function alignmentsResult(
  alignments: AlignmentsInRange | undefined,
  options: { dryRun: boolean },
): Pick<MergeResult, 'alignments'> {
  if (!alignments) return {};
  const open = options.dryRun ? alignments.pending : pendingAfterUpgrade(alignments);
  return { alignments: { total: alignments.total, arrived: alignments.arrived, open } };
}

/**
 * Remove the app's copy of the alignments folder (apps that received it in an upgrade before it became
 * upstream-only, and new apps whose scaffold cloned it). Staged with the upgrade.
 */
async function removeUpstreamOnlyCopy(repoRoot: string, onStep?: StepCallback): Promise<void> {
  if (!existsSync(join(repoRoot, alignmentsDir))) return;
  await git(['rm', '-r', '-q', '--ignore-unmatch', '--', alignmentsDir], repoRoot);
  await rm(join(repoRoot, alignmentsDir), { recursive: true, force: true });
  onStep?.('alignments', `removed ${alignmentsDir}/: alignments stay upstream, list them with pnpm cella align`);
}

/**
 * UPGRADE MODE: merge, analyze, and resolve directly in the app, then record the
 * upgrade point (local ref + committed manifest) and leave the merge staged.
 */
async function runUpgradeMerge(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<MergeResult> {
  const { repoRoot } = config;
  const { upstreamRef, releaseTag, mergeRef, upstreamGitHubUrl, upstreamCommit } = ctx;

  // Last gate before anything merges (the CLI version gate runs in prepareUpstream)
  await assertUpstreamConfigFollowed(config, ctx);

  const alignments = await readAlignmentsInRange(config, ctx);

  const { remainingConflicts, analyzedFiles, autoMergedFiles, protectedConflicts } = await applyDirectMerge(
    repoRoot,
    upstreamRef,
    mergeRef,
    config,
    onProgress,
  );

  const summary = calculateSummary(analyzedFiles);
  const fromUpstream = analyzedFiles.filter((file) => ['behind', 'diverged', 'renamed'].includes(file.status)).length;

  const totalResolved = analyzedFiles.filter((file) => upgradeAppliedStatuses.includes(file.status)).length;

  // Record the upgrade point in lockstep: the local `refs/cella/last-upgrade` ref plus the manifest,
  // staged so it rides in the upgrade commit. The manifest is the last write: one naming MERGE_HEAD
  // tells a later run that this one finished the merge.
  const manifest: UpgradeManifest = {
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
  const recordUpgradePoint = async () => {
    // Alignments that arrived join the app's pending list; an empty list deletes the file.
    if (alignments) {
      await writePending(repoRoot, pendingAfterUpgrade(alignments));
      await stagePath(repoRoot, pendingFile);
    }
    await removeUpstreamOnlyCopy(repoRoot, onStep);
    await storeUpgradePoint(repoRoot, upstreamCommit.hash);
    await writeManifest(repoRoot, manifest);
    await stagePath(repoRoot, manifestFile);
  };

  // MERGE_HEAD stays in both staged cases: the IDE shows a 3-way merge, `git merge --abort` works,
  // and the finishing rerun tells a staged upgrade from a dirty tree, then commits it single-parent.
  // Upstream already in HEAD starts no merge, whatever the app changed in ignored files.
  const merging = await mergeInProgress(repoRoot);
  if (remainingConflicts.length > 0) {
    await recordUpgradePoint();
    onStep?.('merged', formatMergeInProgressDetail(remainingConflicts.length, autoMergedFiles, { repoRoot }, 100));
  } else if (merging && totalResolved > 0) {
    const label = fromUpstream > 0 ? `${fromUpstream} files from upstream` : 'upstream changes';
    await recordUpgradePoint();
    onStep?.('upgraded', `${label} (staged, commit to finish)`);
  } else {
    if (merging) await mergeAbort(repoRoot);
    onStep?.('up to date', 'no upstream changes to merge');
  }

  return {
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

/** ANALYZE MODE: classify every file from git refs; the app's branches and working tree stay unchanged. */
async function runAnalyzePreview(
  config: RuntimeConfig,
  ctx: UpstreamContext,
  onProgress?: ProgressCallback,
  onStep?: StepCallback,
): Promise<MergeResult> {
  const { repoRoot } = config;
  const alignments = await readAlignmentsInRange(config, ctx);

  onProgress?.('analyzing files...');
  const analyzedFiles = await analyzeRefs(
    repoRoot,
    'HEAD',
    ctx.upstreamRef,
    ctx.mergeRef,
    upgradePredicates(config),
    onProgress,
  );
  await enrichChangeInfo(repoRoot, analyzedFiles, ctx.mergeBase, 'HEAD', ctx.upstreamRef);
  const protectedConflicts = analyzedFiles.filter((f) => f.upstreamChanged).map((f) => f.path);
  const reports = await upstreamOnlyReports(config, ctx, analyzedFiles);
  onStep?.(
    'analyzed',
    `${plural(analyzedFiles.length, 'file')}${pc.dim(' · dry run, branches and working tree unchanged')}`,
  );

  return {
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
 * Merge engine entry point for analyze and upgrade: prepare upstream once, then run the requested
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
  return apply ? runUpgradeMerge(config, ctx, onProgress, onStep) : runAnalyzePreview(config, ctx, onProgress, onStep);
}

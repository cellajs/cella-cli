/**
 * Sync service for the cella CLI.
 *
 * Runs the merge engine directly in the fork (no worktree) so conflicts surface in the IDE, on
 * a fresh temporary branch cut from the trunk. The service is idempotent: if a run stops at
 * conflicts, resolve them and run `cella sync` again to finish the same merge.
 */

import { spawnSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import { type CommitRangeEntry, type MergeResult, type RuntimeConfig, SYNC_APPLIED_STATUSES } from '../config/types';
import { alignmentUrl, listAlignmentIds, readAlignment, readPending } from '../utils/alignments';
import pc from '../utils/colors';
import {
  buildTemporarySyncBranch,
  DEFAULT_SYNC_PREFIX,
  isTemporarySyncBranch,
  resolveReleaseBase,
} from '../utils/config';
import {
  COMMIT_LIST_MAX,
  checkMark,
  createSpinner,
  hyperlink,
  type NextStep,
  plural,
  printEngineReports,
  printNextSteps,
  printStep,
  printSyncComplete,
  printUpstreamOverrideChanges,
  spinnerFail,
  spinnerSuccess,
  warningMark,
} from '../utils/display';
import { errorMessage } from '../utils/errors';
import { closePr, createPr, type GhPullRequest, ghAvailable, listOpenSyncPrs, mergePrSquash } from '../utils/gh';
import {
  branchExists,
  commitSquash,
  countCommitsBetween,
  createBranchFrom,
  deleteBranch,
  fastForwardBranch,
  fetchRemote,
  flattenBranch,
  getBranchUpstream,
  getBranchWorktree,
  getCommitInfo,
  getConflictedFiles,
  getCurrentBranch,
  getMergeBase,
  getShortSha,
  getUpstreamStatus,
  isAncestor,
  isClean,
  listBranchMergeCommits,
  listCommitsBetween,
  mergeInProgress,
  pullFastForward,
  pushBranch,
  readManifestAtRef,
  readManifestBaseAtRef,
  readPackageVersionAtRef,
  stageAll,
  switchBranch,
  switchDetached,
} from '../utils/git';
import { readSyncManifest } from '../utils/manifest';
import { alignmentsStep, readOpenAlignments } from './align';
import {
  BehindSyncPointError,
  readOriginGitHubUrl,
  runEngineWithSpinner,
  UpstreamConfigChangedError,
} from './merge-engine';
import { runPackages } from './packages';
import { existingSyncReviewPage, type ReviewPageReport, reportReviewPage, reviewStep } from './review-page';

/** Context for the temporary branch a sync cycle runs on. */
interface TemporarySyncBranch {
  /** The freshly cut temporary branch, e.g. `cella/sync/20260702-1430`. */
  temporaryBranch: string;
  /** The trunk the branch was cut from and PRs land into (`releaseBase`, default `main`). */
  base: string;
  /** The branch the user was on before the cycle started, 'HEAD' when detached (for cleanup on no-op). */
  startBranch: string;
  /** The commit the user was on before the cycle started (to return to a detached start). */
  startCommit: string;
}

/**
 * Make sure the trunk is current with its remote and return the ref a sync cycle cuts its branch
 * from. Compares refs and never checks the trunk out, so this also works from a linked worktree
 * while another worktree has the trunk checked out. A trunk behind its remote is fast-forwarded
 * (or, checked out elsewhere, left alone and the remote-tracking ref used); a diverged trunk stops
 * the run, since a PR against an out-of-date base brings avoidable conflicts.
 */
async function resolveCycleStart(forkPath: string, base: string, currentBranch: string): Promise<string> {
  // No local trunk branch to compare: cut from origin's, which `git switch` would have created it from.
  if (!(await branchExists(forkPath, base))) {
    await fetchRemote(forkPath, 'origin').catch(() => {});
    console.info(pc.dim(`'${base}' has no local branch: cutting from 'origin/${base}'.`));
    return `origin/${base}`;
  }

  const { upstream, ahead, behind } = await getUpstreamStatus(forkPath, base);

  if (!upstream) {
    console.info(pc.dim(`'${base}' has no upstream: skipping the up-to-date check.`));
    return base;
  }

  if (ahead > 0 && behind > 0) {
    throw new Error(
      `'${base}' has diverged from '${upstream}' (${ahead} ahead, ${behind} behind).\n` +
        `Reconcile '${base}' with '${upstream}' first (e.g. rebase or reset it), then re-run sync.`,
    );
  }

  if (behind > 0) {
    const worktree = currentBranch === base ? null : await getBranchWorktree(forkPath, base);
    if (worktree) {
      console.info(
        pc.dim(`'${base}' is ${behind} behind '${upstream}' but checked out at ${worktree}; leaving it as it is.`),
      );
      return upstream;
    }
    console.info(pc.dim(`fast-forwarding '${base}' to '${upstream}' (${behind} behind)...`));
    if (currentBranch === base) await pullFastForward(forkPath);
    else await fastForwardBranch(forkPath, base, upstream);
    return base;
  }

  if (ahead > 0) {
    console.info(pc.dim(`'${base}' is ${ahead} commit(s) ahead of '${upstream}' (unpushed); continuing.`));
  }
  return base;
}

/** Bring the trunk up to date and cut a fresh throwaway `cella/sync/<stamp>` branch from it. */
async function setupTemporarySyncBranch(config: RuntimeConfig): Promise<TemporarySyncBranch> {
  const { forkPath, settings } = config;
  const base = resolveReleaseBase(settings);
  const startBranch = await getCurrentBranch(forkPath);
  const startCommit = (await getCommitInfo(forkPath, 'HEAD')).hash;

  console.info(pc.dim(`updating '${base}'...`));
  const startPoint = await resolveCycleStart(forkPath, base, startBranch);

  const temporaryBranch = buildTemporarySyncBranch();

  console.info(pc.dim(`creating temporary sync branch '${temporaryBranch}' from '${startPoint}'...`));
  console.info();
  await createBranchFrom(forkPath, temporaryBranch, startPoint);

  return { temporaryBranch, base, startBranch, startCommit };
}

/**
 * The trunk ref a sync branch was cut from, to read its own commits against (`<ref>..HEAD`): the
 * trunk, or its remote-tracking ref when the trunk is behind it. `resolveCycleStart` cuts from
 * `origin` when another worktree holds a stale trunk, and that stale trunk would count origin's
 * newer commits as part of the sync branch.
 */
async function resolveCutBase(forkPath: string, base: string): Promise<string> {
  if (!(await branchExists(forkPath, base))) return `origin/${base}`;
  const upstream = await getBranchUpstream(forkPath, base);
  return upstream && (await isAncestor(forkPath, base, upstream)) ? upstream : base;
}

/**
 * Leave the sync branch for the trunk, after shipping it. When another worktree has the trunk
 * checked out, git refuses to switch to it: detach at the trunk instead, so this worktree holds
 * no branch and the sync branch can be deleted once its PR lands. Returns where it left HEAD.
 */
async function returnToBase(forkPath: string, base: string): Promise<string> {
  const worktree = await getBranchWorktree(forkPath, base);
  if (worktree) {
    console.info(pc.dim(`'${base}' is checked out at ${worktree}; detaching at '${base}' here instead...`));
    await switchDetached(forkPath, base);
    return `detached at '${base}'`;
  }

  console.info(pc.dim(`switching back to '${base}'...`));
  await switchBranch(forkPath, base);
  await pullFastForward(forkPath).catch(() => {});
  return `back on '${base}'`;
}

/** A sync's merge result, with the review page the run wrote. */
export interface SyncRunResult extends MergeResult {
  reviewPage?: ReviewPageReport;
}

/** Run the merge engine against the current branch, leaving the merge staged in the fork. */
export async function runSync(
  config: RuntimeConfig,
  options?: {
    stagedBranch?: string;
  },
): Promise<SyncRunResult> {
  createSpinner('starting sync...');

  let result: MergeResult;
  try {
    result = await runEngineWithSpinner(config, true);
  } catch (error) {
    // The engine threw, usually a stop before the merge: end the spinner, and when the sync config
    // gate stopped it, show what upstream changed.
    spinnerSuccess();
    if (error instanceof UpstreamConfigChangedError) {
      printUpstreamOverrideChanges({ upstreamOverrides: error.report });
      console.info();
    }
    throw error;
  }

  if (result.success) {
    spinnerSuccess();
  } else {
    spinnerFail('sync completed with conflicts');
  }

  // Print summary (no file lists for sync) plus the shared upstream-changes reports
  printEngineReports(result, 'merge summary');
  if (config.unpinned) {
    console.info(pc.yellow('⚠ --unpinned: every pinned entry was merged from upstream; keep only what you want.'));
    console.info();
  }

  const staged = result.files.some((file) => SYNC_APPLIED_STATUSES.includes(file.status));
  const stagedBranch =
    options?.stagedBranch && result.conflicts.length === 0 && staged ? options.stagedBranch : undefined;
  printSyncComplete(result, { stagedBranch });
  const reviewPage = await reportReviewPage(config.forkPath, result, 'sync');

  return { ...result, reviewPage };
}

/** Conflicted files the `resolve` step lists before it counts the rest. */
const CONFLICTS_LISTED = 10;

/**
 * The `align` step after a sync run: from the merge result when this run merged, otherwise from
 * the fork's sync point and pending list.
 */
async function syncAlignmentsStep(config: RuntimeConfig, run?: MergeResult): Promise<NextStep | undefined> {
  if (run?.alignments && run.upstreamCommit) {
    const { open, arrived } = run.alignments;
    return alignmentsStep(config, { ref: run.upstreamCommit.hash, open, arrived });
  }
  const view = await readOpenAlignments(config);
  return view ? alignmentsStep(config, view) : undefined;
}

/** The review page of this sync: the one this run wrote, or the one the merge run left. */
function syncReviewStep(config: RuntimeConfig, run?: SyncRunResult): NextStep | undefined {
  const page = run?.reviewPage ?? existingSyncReviewPage(config.forkPath);
  return page ? reviewStep(page) : undefined;
}

/** Next steps while a sync branch holds conflicts: resolve, let a rerun commit, review, align. */
async function conflictSteps(config: RuntimeConfig, conflicts: string[], run?: SyncRunResult): Promise<NextStep[]> {
  const listed = conflicts.slice(0, CONFLICTS_LISTED).map((file) => pc.dim(file));
  if (conflicts.length > CONFLICTS_LISTED) listed.push(pc.dim(`+ ${conflicts.length - CONFLICTS_LISTED} more`));
  const steps: Array<NextStep | undefined> = [
    {
      label: 'resolve',
      line: `${plural(conflicts.length, 'conflict')} in your editor, then stage them`,
      details: listed,
    },
    {
      label: 'finish',
      line: 'pnpm cella sync',
      details: [
        pc.dim('commits the sync and stops for drift triage'),
        pc.dim('let the rerun commit: a manual `git commit` records a merge commit that bloats the PR'),
      ],
    },
    syncReviewStep(config, run),
    await syncAlignmentsStep(config, run),
  ];
  return steps.filter((step): step is NextStep => !!step);
}

/** Conventional PR title prefix required by release-please. */
const SYNC_PR_TITLE = 'chore: sync upstream cella';

/**
 * Build the sync commit subject, e.g. `chore: sync upstream cella v0.2.2 (4f7d87c)`.
 *
 * The upstream version comes from the manifest's release tag when tracking releases, else from
 * upstream's root package.json at the merged commit. Falls back to the bare title (+ short sha)
 * when a lookup fails, so committing never blocks on cosmetics.
 */
async function buildSyncCommitMessage(forkPath: string, upstreamRef: string): Promise<string> {
  const shortSha = await getShortSha(forkPath, upstreamRef).catch(() => '');
  if (!shortSha) return SYNC_PR_TITLE;

  const manifest = await readSyncManifest(forkPath);
  const version =
    manifest?.upstream.release ?? (await readPackageVersionAtRef(forkPath, upstreamRef).catch(() => null));
  return version ? `${SYNC_PR_TITLE} v${version.replace(/^v/, '')} (${shortSha})` : `${SYNC_PR_TITLE} ${shortSha}`;
}

/**
 * Qualify bare `#123` references in an upstream commit subject with the upstream repo slug.
 * Left bare, GitHub would auto-link them to the fork's own issue/PR #123 in the PR body.
 */
function qualifyPrRefs(subject: string, repoSlug?: string): string {
  if (!repoSlug) return subject;
  return subject.replace(/(^|[^\w/])#(\d+)\b/g, `$1${repoSlug}#$2`);
}

/** Inputs for {@link buildSyncPrBody}, recovered from the committed sync manifests. */
interface SyncPrBodyInput {
  /** GitHub slug of the upstream repo, e.g. 'cellajs/cella'. */
  repoSlug?: string;
  /** Upstream version or release tag at the sync point (leading `v` optional). */
  version?: string | null;
  /** Previous upstream sync point (full sha), when known. */
  fromSha?: string | null;
  /** Upstream commit this sync moved to (full sha). */
  toSha: string;
  /** Upstream commits in the range, oldest first (possibly truncated to the newest N). */
  commits: CommitRangeEntry[];
  /** Total commits in the range (may exceed `commits.length` when truncated). */
  totalCount: number;
  /** Upstream alignments at the sync point: the total, and the ones the app has not handled yet. */
  alignments?: { total: number; open: Array<{ id: string; title: string; url?: string }> };
}

/** Render the sync PR body: where the sync moved to, plus the upstream commits it brought in. */
export function buildSyncPrBody(input: SyncPrBodyInput): string {
  const { repoSlug, version, fromSha, toSha, commits, totalCount, alignments } = input;
  const githubUrl = repoSlug ? `https://github.com/${repoSlug}` : undefined;
  const short = (sha: string) => sha.slice(0, 7);
  const commitRef = (sha: string) =>
    githubUrl ? `[\`${short(sha)}\`](${githubUrl}/commit/${sha})` : `\`${short(sha)}\``;

  const upstreamName = githubUrl ? `[${repoSlug}](${githubUrl})` : 'cella';
  const versionSuffix = version ? ` (v${version.replace(/^v/, '')})` : '';
  const lines = [`Syncs upstream ${upstreamName} to ${commitRef(toSha)}${versionSuffix}.`];

  if (totalCount > 0 && fromSha) {
    const compare = githubUrl ? ` ([compare](${githubUrl}/compare/${short(fromSha)}...${short(toSha)}))` : '';
    lines.push('', `**${totalCount} upstream commit${totalCount === 1 ? '' : 's'} since last sync**${compare}:`, '');
    if (totalCount > commits.length) lines.push(`- …${totalCount - commits.length} earlier commit(s) not shown`);
    for (const commit of commits) {
      lines.push(`- ${commitRef(commit.hash)} ${qualifyPrRefs(commit.message, repoSlug)}`);
    }
  }

  if (alignments && alignments.total > 0) {
    const { total, open } = alignments;
    if (open.length === 0) lines.push('', `**Alignments**: all ${total} handled.`);
    else {
      lines.push(
        '',
        `**Alignments**: ${Math.max(0, total - open.length)} of ${total} handled, open (\`pnpm cella align\`):`,
        '',
      );
      for (const alignment of open)
        lines.push(
          `- ${alignment.url ? `[${alignment.title}](${alignment.url})` : alignment.title} (\`${alignment.id}\`)`,
        );
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Build the PR body for a finished sync branch: the upstream commits between the trunk's last
 * recorded sync point and the one this branch moves to, both read from committed manifests.
 * Undefined when the branch has no committed manifest (the caller falls back to `--fill`).
 */
async function buildSyncPrBodyForBranch(forkPath: string, base: string): Promise<string | undefined> {
  const manifest = await readManifestAtRef(forkPath, 'HEAD');
  if (!manifest) return undefined;

  const toSha = manifest.upstream.commit.toLowerCase();
  // The trunk's committed manifest is the previous sync point; merge-base covers forks whose
  // last sync predates the manifest. `refs/cella/last-sync` is no help here: the merge already
  // moved it to `toSha`.
  const fromSha =
    (await readManifestBaseAtRef(forkPath, base)) ?? (await getMergeBase(forkPath, base, toSha).catch(() => null));
  const version = manifest.upstream.release ?? (await readPackageVersionAtRef(forkPath, toSha).catch(() => null));

  const totalCount = fromSha ? await countCommitsBetween(forkPath, fromSha, toSha).catch(() => 0) : 0;
  const commits = fromSha && totalCount > 0 ? await listCommitsBetween(forkPath, fromSha, toSha, COMMIT_LIST_MAX) : [];

  const alignments = await readPrBodyAlignments(forkPath, toSha, manifest.upstream.repo).catch(() => undefined);
  return buildSyncPrBody({
    repoSlug: manifest.upstream.repo,
    version,
    fromSha,
    toSha,
    commits,
    totalCount,
    alignments,
  });
}

/** Alignments for the PR body: the total at the sync point and the app's open ones, with permalinks. */
async function readPrBodyAlignments(
  forkPath: string,
  toSha: string,
  repoSlug?: string,
): Promise<SyncPrBodyInput['alignments']> {
  const githubUrl = repoSlug ? `https://github.com/${repoSlug}` : undefined;
  const [ids, pending] = await Promise.all([listAlignmentIds(forkPath, toSha), readPending(forkPath)]);
  const open = await Promise.all(
    pending.map(async (id) => ({
      id,
      title: (await readAlignment(forkPath, toSha, id))?.title ?? id,
      url: alignmentUrl(githubUrl, toSha, id),
    })),
  );
  return { total: ids.length, open };
}

/** Print the GitHub CLI command for opening the finished sync PR. */
function printPrCreateStep(branch: string, base: string, title = SYNC_PR_TITLE): void {
  console.info(pc.dim(`  gh pr create --base ${base} --head ${branch} --title "${title}" --fill`));
}

/**
 * Safety net run before a sync branch goes public: rewrite a branch holding merge commits as one
 * commit with identical content. A manual `git commit` on the staged merge records a two-parent
 * merge commit, and since upstream's history is not on `origin`, the PR would list every upstream
 * commit ever made. Returns true if the branch was rewritten, so the caller force-pushes.
 */
async function flattenSyncBranch(forkPath: string, branch: string, base: string): Promise<boolean> {
  const mergeCommits = await listBranchMergeCommits(forkPath, base);
  if (mergeCommits.length === 0) return false;

  // The most recent merge's second parent is the upstream tip that was merged in.
  const message = await buildSyncCommitMessage(forkPath, `${mergeCommits[0]}^2`);

  console.info(
    pc.yellow(
      `'${branch}' contains ${mergeCommits.length} merge commit(s): the PR would list the entire upstream history.`,
    ),
  );
  console.info(pc.dim(`flattening '${branch}' to a single commit (same content)...`));
  await flattenBranch(forkPath, base, message);
  return true;
}

/**
 * Push the finished sync branch to `origin`, open a PR into the trunk, and switch back to the
 * trunk (see `returnToBase`). A failed push prints the manual steps and leaves you on the branch;
 * a missing or failed `gh` prints the `gh` command but still returns you to the trunk.
 */
async function shipSyncBranch(config: RuntimeConfig, branch: string): Promise<void> {
  const { forkPath, settings } = config;
  const base = resolveReleaseBase(settings);
  // The PR targets `base`; its commits and body are read against the trunk the branch was cut from.
  const cutBase = await resolveCutBase(forkPath, base);

  const flattened = await flattenSyncBranch(forkPath, branch, cutBase);
  let prUrl: string | undefined;
  let prOpened = false;

  // The PR title is the versioned sync commit subject, rebuilt from the manifest rather than read
  // from HEAD: drift-triage commits may sit on top of the sync commit (release-please only needs
  // the prefix).
  const upstreamCommit = (await readSyncManifest(forkPath))?.upstream.commit;
  const prTitle = upstreamCommit ? await buildSyncCommitMessage(forkPath, upstreamCommit) : SYNC_PR_TITLE;

  console.info(pc.dim(`pushing '${branch}' to origin...`));
  try {
    await pushBranch(forkPath, 'origin', branch, { forceWithLease: flattened });
  } catch (error) {
    console.info(pc.yellow(`push failed (${errorMessage(error).split('\n')[0]}). finish manually:`));
    console.info(pc.dim(`  git push -u origin ${branch}`));
    printPrCreateStep(branch, base, prTitle);
    return;
  }

  if (ghAvailable()) {
    console.info(pc.dim('opening a pull request...'));
    const prBody = (await buildSyncPrBodyForBranch(forkPath, cutBase)) ?? '';
    const repoSlug = (await readOriginGitHubUrl(forkPath))?.replace('https://github.com/', '') ?? null;
    const pr = createPr(forkPath, repoSlug, { base, head: branch, title: prTitle, body: prBody });
    prUrl = pr.url;
    prOpened = pr.ok;
    if (!prOpened) {
      console.info(pc.yellow('could not open the PR automatically (it may already exist). open it with:'));
      if (prUrl) console.info(pc.dim(`  ${prUrl}`));
      printPrCreateStep(branch, base, prTitle);
    }
  } else {
    console.info(pc.yellow('`gh` not found, open the PR manually:'));
    printPrCreateStep(branch, base, prTitle);
  }

  const position = await returnToBase(forkPath, base);

  console.info();
  if (prUrl) {
    console.info(`${checkMark} sync pull request ${prOpened ? 'opened' : 'ready'}`);
    console.info(pc.dim(`  ${prUrl} · branch pushed, ${position}`));
  } else {
    console.info(`${checkMark} sync branch pushed`);
    console.info(pc.dim(`  '${branch}' is on origin, ${position}`));
  }
  const steps: Array<NextStep | undefined> = [
    prUrl
      ? {
          label: 'merge',
          line: hyperlink(pc.cyan(prUrl), prUrl),
          details: [pc.dim(`squash-merge it into '${base}'; the next sync offers to while it is open`)],
        }
      : undefined,
    await syncAlignmentsStep(config),
  ];
  printNextSteps(steps.filter((step): step is NextStep => !!step));
}

/**
 * Run `pnpm install` then `pnpm check` before committing the merge, so the lockfile and generated
 * files the merge left stale land in the same commit. Returns false if a step fails (the merge is
 * left in progress to retry).
 */
function finalizeWorkspace(forkPath: string): boolean {
  for (const args of [['install'], ['check']]) {
    console.info(pc.dim(`running pnpm ${args.join(' ')}...`));
    const result = spawnSync('pnpm', args, { cwd: forkPath, stdio: 'inherit' });
    if (result.status !== 0) return false;
  }
  return true;
}

/** Outcome of a sync cycle run on a fresh temporary branch, with its merge result when it merged. */
type SyncCycleOutcome =
  | { status: 'conflicts'; branch: TemporarySyncBranch; result: SyncRunResult }
  | { status: 'staged'; branch: TemporarySyncBranch; result: SyncRunResult }
  | { status: 'noop'; behind?: string; result?: SyncRunResult };

/**
 * Return to where the cycle started and drop the throwaway branch. Only for a branch that holds
 * nothing: an up-to-date run, or one that stopped before the merge.
 */
async function discardTemporarySyncBranch(forkPath: string, branch: TemporarySyncBranch): Promise<void> {
  if (branch.startBranch === 'HEAD') await switchDetached(forkPath, branch.startCommit);
  else await switchBranch(forkPath, branch.startBranch);
  await deleteBranch(forkPath, branch.temporaryBranch);
}

/**
 * After the merge step threw: drop the throwaway branch when the run stopped before the merge (a
 * gate, an unreachable upstream, a ref that does not resolve), so nothing changed and a rerun
 * starts a fresh cycle (an empty sync branch is never shipped). A branch that holds a merge or
 * changes stays as it is. Returns whether the branch was dropped.
 */
async function discardUnusedSyncBranch(forkPath: string, branch: TemporarySyncBranch): Promise<boolean> {
  const unused =
    (await getCurrentBranch(forkPath)) === branch.temporaryBranch &&
    !(await mergeInProgress(forkPath)) &&
    (await isClean(forkPath));
  if (!unused) return false;

  await discardTemporarySyncBranch(forkPath, branch);
  const start = branch.startBranch === 'HEAD' ? `at ${branch.startCommit.slice(0, 7)}` : `on '${branch.startBranch}'`;
  console.info(pc.dim(`removed the unused '${branch.temporaryBranch}', back ${start}.`));
  return true;
}

/**
 * Run one sync cycle on a fresh temporary branch: cut the branch, merge upstream (+ packages),
 * and report the resulting state. On `noop` (nothing new, or `behind`: only a point the last sync
 * already went past) the throwaway branch is gone and the start branch restored; a run that stops
 * before the merge throws, after dropping the branch the same way.
 */
async function runSyncCycle(config: RuntimeConfig): Promise<SyncCycleOutcome> {
  const { forkPath } = config;
  const branch = await setupTemporarySyncBranch(config);

  let result: SyncRunResult;
  try {
    result = await runSync(config, { stagedBranch: branch.temporaryBranch });
  } catch (error) {
    const discarded = await discardUnusedSyncBranch(forkPath, branch).catch(() => false);
    // Tracking a release or branch the last sync went past is nothing to sync, not a failure.
    // A pinned --ref behind the sync point stays an error: the run cannot do what it was asked.
    if (discarded && error instanceof BehindSyncPointError && !config.ref) {
      return { status: 'noop', behind: error.message };
    }
    throw error;
  }

  if (config.settings.syncWithPackages !== false) {
    // Run package sync even when the merge left conflicts: package.json files that are
    // themselves conflicted are skipped and reported; all others are still synced.
    await runPackages(config, { conflictedFiles: result.conflicts });
  }

  if (result.conflicts.length > 0) return { status: 'conflicts', branch, result };

  // Nothing staged: already up to date. Return to where the run started and drop the throwaway
  // branch (a fresh cycle never starts on a sync branch: those resume or ship instead).
  if (!(await mergeInProgress(forkPath))) {
    await discardTemporarySyncBranch(forkPath, branch);
    return { status: 'noop', result };
  }

  return { status: 'staged', branch, result };
}

/**
 * Commit an in-progress merge on the temporary sync branch as one single-parent commit, then stop
 * there for drift triage; shipping is always its own rerun. Stops early while conflicts remain.
 * `run` is the merge this run made, absent when it resumes an earlier run's merge.
 */
async function commitSyncMerge(config: RuntimeConfig, branch: string, run?: SyncRunResult): Promise<void> {
  const { forkPath } = config;
  const conflicts = await getConflictedFiles(forkPath);

  console.info();
  if (conflicts.length > 0) {
    printStep('conflicts', `${plural(conflicts.length, 'file')} still conflict on '${branch}'`, warningMark);
    printNextSteps(await conflictSteps(config, conflicts, run));
    return;
  }

  // Stage resolved conflicts and manual edits before tooling that may fail, so they are recorded.
  await stageAll(forkPath);

  if (!finalizeWorkspace(forkPath)) {
    console.info();
    printStep('checks', '`pnpm install` or `pnpm check` failed', warningMark);
    printNextSteps([
      { label: 'fix', line: 'what failed above', details: [pc.dim(`the merge stays staged on '${branch}'`)] },
      { label: 'finish', line: 'pnpm cella sync', details: [pc.dim('commits the sync and stops for drift triage')] },
    ]);
    return;
  }

  // The subject reads MERGE_HEAD, which commitSquash clears; re-stage what install/check touched.
  const message = await buildSyncCommitMessage(forkPath, 'MERGE_HEAD');
  await stageAll(forkPath);
  await commitSquash(forkPath, message);
  console.info();
  printStep('committed', `${message}\n${pc.dim(`on '${branch}', not pushed`)}`);
  const steps: Array<NextStep | undefined> = [
    syncReviewStep(config, run),
    {
      label: 'triage',
      line: 'pnpm cella analyze',
      details: [pc.dim('drift triage: commit any follow-ups on this branch')],
    },
    await syncAlignmentsStep(config, run),
    { label: 'ship', line: 'pnpm cella sync', details: [pc.dim('pushes the branch and opens the squash-merge PR')] },
  ];
  printNextSteps(steps.filter((step): step is NextStep => !!step));
}

/**
 * Merge the open sync PR(s) so the trunk carries the recorded sync point before a new cycle cuts
 * from it. The newest PR is a content superset of any older ones (each cycle re-syncs from the
 * same stale trunk base), so the newest is squash-merged and the rest are closed. A merge GitHub
 * refuses (conflicts, failing required checks) stops the run.
 */
async function mergeOpenSyncPrs(config: RuntimeConfig, open: GhPullRequest[]): Promise<'continue' | 'cancel'> {
  const { forkPath, settings } = config;
  const base = resolveReleaseBase(settings);
  const [newest, ...superseded] = open;

  console.info();
  console.info(pc.dim(`squash-merging #${newest.number} into '${base}'...`));
  const merged = mergePrSquash(forkPath, newest.number, { deleteBranch: true });
  if (!merged.ok) {
    console.info();
    console.info(pc.yellow(`could not merge #${newest.number}: resolve it first, then re-run \`pnpm cella sync\`:`));
    if (merged.output) console.info(pc.dim(merged.output.replace(/^/gm, '  ')));
    console.info(pc.dim(`  ${newest.url}`));
    return 'cancel';
  }
  console.info(`${checkMark} merged #${newest.number}`);
  // Drop the stale local branch that tracked the merged PR (the remote one went with --delete-branch).
  await deleteBranch(forkPath, newest.headRefName);

  for (const pr of superseded) {
    console.info(pc.dim(`closing #${pr.number}: its changes are included in #${newest.number}...`));
    closePr(forkPath, pr.number);
    await deleteBranch(forkPath, pr.headRefName);
  }

  return 'continue';
}

/**
 * Before cutting a fresh sync branch, offer to merge an earlier sync PR that is still open: the
 * sync point lives in the manifest on the sync branch, so a cycle cut from a trunk without it
 * re-includes that PR's whole delta. A silent `continue` without `gh`, an open PR or a TTY.
 */
async function guardAgainstOpenSyncPr(config: RuntimeConfig): Promise<'continue' | 'cancel'> {
  const { forkPath } = config;

  if (!ghAvailable() || !process.stdout.isTTY) return 'continue';

  const open = listOpenSyncPrs(forkPath, DEFAULT_SYNC_PREFIX);
  if (open.length === 0) return 'continue';

  const many = open.length > 1;
  console.info();
  console.info(
    `${warningMark} ${pc.yellow(`${many ? `${open.length} earlier sync PRs are` : 'an earlier sync PR is'} still open and unmerged:`)}`,
  );
  for (const pr of open) {
    console.info(pc.dim(`  #${pr.number}  ${pr.title}`));
    console.info(pc.dim(`         ${pr.url}`));
  }
  console.info(pc.dim(`  starting a new sync now produces a PR that re-includes ${many ? 'these' : 'those'} changes.`));
  console.info();

  const choice = await select<'merge' | 'continue' | 'cancel'>({
    message: 'how do you want to proceed?',
    choices: [
      {
        value: 'merge',
        name: `merge ${many ? 'them' : `#${open[0].number}`} first, then sync   ${pc.dim('(recommended)')}`,
      },
      { value: 'continue', name: `continue anyway   ${pc.dim('(new PR will re-include the unmerged changes)')}` },
      { value: 'cancel', name: pc.red('cancel') },
    ],
    loop: false,
  });

  if (choice === 'cancel') return 'cancel';
  if (choice === 'continue') return 'continue';
  return mergeOpenSyncPrs(config, open);
}

/**
 * Run the standalone `cella sync` command. Idempotent: each run advances the sync one stage (cut
 * and merge, commit, ship) and never commits and ships in the same run.
 */
export async function runSyncCommand(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;
  const currentBranch = await getCurrentBranch(forkPath);
  const onSyncBranch = isTemporarySyncBranch(currentBranch);

  // Resume path: finish the merge an earlier run left staged on this branch.
  if (onSyncBranch && (await mergeInProgress(forkPath))) {
    await commitSyncMerge(config, currentBranch);
    return;
  }

  // On a sync branch with the merge already committed: ship it. Edits not committed would be left
  // out of the pushed branch, so a dirty tree stops the run.
  if (onSyncBranch) {
    if (!(await isClean(forkPath))) {
      console.info();
      console.info(
        pc.yellow(
          `sync branch '${currentBranch}' has uncommitted changes.\n` +
            'commit them first (`git commit --amend --no-edit` or a new commit).',
        ),
      );
      return;
    }
    await shipSyncBranch(config, currentBranch);
    return;
  }

  // Fresh cycle, from a clean tree only.
  if (!(await isClean(forkPath))) {
    throw new Error('working directory has uncommitted changes. please commit or stash before syncing.');
  }
  if ((await guardAgainstOpenSyncPr(config)) === 'cancel') return;

  const outcome = await runSyncCycle(config);

  if (outcome.status === 'noop') {
    console.info();
    if (outcome.behind) {
      console.info(pc.green('nothing to sync: the last sync already went past this upstream point.'));
      for (const line of outcome.behind.split('\n')) console.info(pc.dim(`  ${line}`));
    } else {
      console.info(pc.green('already up to date with upstream, nothing to sync.'));
    }
    const align = await syncAlignmentsStep(config, outcome.result);
    if (align) printNextSteps([align]);
    return;
  }

  const { temporaryBranch } = outcome.branch;
  if (outcome.status === 'conflicts') {
    const conflicts = await getConflictedFiles(forkPath);
    printStep('conflicts', `${plural(conflicts.length, 'file')} on '${temporaryBranch}'`, warningMark);
    printNextSteps(await conflictSteps(config, conflicts, outcome.result));
    return;
  }

  await commitSyncMerge(config, temporaryBranch, outcome.result);
}

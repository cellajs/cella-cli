/**
 * Upgrade service for the cella CLI.
 *
 * Runs the merge engine directly in the app (no worktree) so conflicts surface in the IDE, on
 * a fresh temporary branch cut from the trunk. The service is idempotent: if a run stops at
 * conflicts, resolve them and run `cella upgrade` again to finish the same merge.
 */

import { spawnSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import { buildUpgradeBranchName, isUpgradeBranch, resolveTrunk, upgradeBranchPrefix } from '../config/load';
import type { CommitRangeEntry, MergeResult, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import {
  checkMark,
  commitListMax,
  createSpinner,
  hyperlink,
  type NextStep,
  plural,
  printEngineReports,
  printNextSteps,
  printStep,
  printUpgradeComplete,
  printUpstreamOverrideChanges,
  spinnerFail,
  spinnerSuccess,
  warningMark,
} from '../utils/display';
import { errorMessage } from '../utils/errors';
import {
  branchExists,
  commitSquash,
  countCommitsBetween,
  createBranchFrom,
  deleteBranch,
  fastForwardBranch,
  fetchRemote,
  flattenBranch,
  getBranchWorktree,
  getCommitInfo,
  getConflictedFiles,
  getCurrentBranch,
  getMergeBase,
  getShortSha,
  getTrackingBranch,
  getTrackingStatus,
  isAncestor,
  isClean,
  listBranchMergeCommits,
  listCommitsBetween,
  mergeAbort,
  mergeInProgress,
  pullFastForward,
  pushBranch,
  readManifestAtRef,
  readPackageVersionAtRef,
  readUpgradePointAtRef,
  revParse,
  stageAll,
  switchBranch,
  switchDetached,
} from '../utils/git';
import { alignmentsStep, readOpenAlignments } from './align';
import { alignmentUrl, listAlignmentIds, readAlignment, readPending } from './alignments';
import { readManifest, readUpgradePoint } from './manifest';
import {
  BehindUpgradePointError,
  readOriginGitHubUrl,
  runEngineWithSpinner,
  UpstreamConfigChangedError,
} from './merge-engine';
import { runPackages } from './package-json-merge';
import { closePr, createPr, type GhPullRequest, ghAvailable, listOpenUpgradePrs, mergePrSquash } from './pull-requests';
import { existingUpgradeReviewPage, type ReviewPageReport, reportReviewPage, reviewStep } from './review-page';

/** Context for the temporary branch an upgrade cycle runs on. */
interface UpgradeBranch {
  /** The freshly cut temporary branch, e.g. `cella/upgrade/20260702-1430`. */
  name: string;
  /** The trunk the branch was cut from and PRs land into (`releaseBase`, default `main`). */
  trunk: string;
  /** The branch the user was on before the cycle started, 'HEAD' when detached (for cleanup on no-op). */
  startBranch: string;
  /** The commit the user was on before the cycle started (to return to a detached start). */
  startCommit: string;
}

/**
 * Make sure the trunk is current with its remote and return the ref an upgrade cycle cuts its branch
 * from. Compares refs and never checks the trunk out, so this also works from a linked worktree
 * while another worktree has the trunk checked out. A trunk behind its remote is fast-forwarded
 * (or, checked out elsewhere, left alone and the remote-tracking ref used); a diverged trunk stops
 * the run, since a PR against an out-of-date trunk brings avoidable conflicts.
 */
async function resolveCycleStart(repoRoot: string, trunk: string, currentBranch: string): Promise<string> {
  // No local trunk branch to compare: cut from origin's, which `git switch` would have created it from.
  if (!(await branchExists(repoRoot, trunk))) {
    await fetchRemote(repoRoot, 'origin').catch(() => {});
    console.info(pc.dim(`'${trunk}' has no local branch: cutting from 'origin/${trunk}'.`));
    return `origin/${trunk}`;
  }

  const { tracking, ahead, behind } = await getTrackingStatus(repoRoot, trunk);

  if (!tracking) {
    console.info(pc.dim(`'${trunk}' has no tracking branch: skipping the up-to-date check.`));
    return trunk;
  }

  if (ahead > 0 && behind > 0) {
    throw new Error(
      `'${trunk}' has diverged from '${tracking}' (${ahead} ahead, ${behind} behind).\n` +
        `Reconcile '${trunk}' with '${tracking}' first (e.g. rebase or reset it), then re-run the upgrade.`,
    );
  }

  if (behind > 0) {
    const worktree = currentBranch === trunk ? null : await getBranchWorktree(repoRoot, trunk);
    if (worktree) {
      console.info(
        pc.dim(`'${trunk}' is ${behind} behind '${tracking}' but checked out at ${worktree}; leaving it as it is.`),
      );
      return tracking;
    }
    console.info(pc.dim(`fast-forwarding '${trunk}' to '${tracking}' (${behind} behind)...`));
    if (currentBranch === trunk) await pullFastForward(repoRoot);
    else await fastForwardBranch(repoRoot, trunk, tracking);
    return trunk;
  }

  if (ahead > 0) {
    console.info(pc.dim(`'${trunk}' is ${ahead} commit(s) ahead of '${tracking}' (unpushed); continuing.`));
  }
  return trunk;
}

/**
 * Bring the trunk up to date and cut a fresh throwaway `cella/upgrade/<stamp>` branch from it, or
 * from HEAD when HEAD builds on the trunk: preflight commits, such as a CLI bump or the renames an
 * alignment asks for, then ride in the upgrade PR from any branch.
 */
async function cutUpgradeBranch(config: RuntimeConfig): Promise<UpgradeBranch> {
  const { repoRoot, settings } = config;
  const trunk = resolveTrunk(settings);
  const startBranch = await getCurrentBranch(repoRoot);
  const startCommit = (await getCommitInfo(repoRoot, 'HEAD')).hash;

  console.info(pc.dim(`updating '${trunk}'...`));
  let startPoint = await resolveCycleStart(repoRoot, trunk, startBranch);
  const added = await countCommitsBetween(repoRoot, startPoint, 'HEAD');
  if (added > 0 && (await isAncestor(repoRoot, startPoint, 'HEAD'))) {
    console.info(pc.dim(`cutting from HEAD, which adds ${plural(added, 'commit')} to '${startPoint}'.`));
    startPoint = 'HEAD';
  }

  const upgradeBranch = buildUpgradeBranchName();

  console.info(pc.dim(`creating temporary upgrade branch '${upgradeBranch}' from '${startPoint}'...`));
  console.info();
  await createBranchFrom(repoRoot, upgradeBranch, startPoint);

  return { name: upgradeBranch, trunk, startBranch, startCommit };
}

/**
 * The trunk ref an upgrade branch was cut from, to read its own commits against (`<ref>..HEAD`): the
 * trunk, or its remote-tracking ref when the trunk is behind it. `resolveCycleStart` cuts from
 * `origin` when another worktree holds a stale trunk, and that stale trunk would count origin's
 * newer commits as part of the upgrade branch.
 */
async function resolveTrunkRef(repoRoot: string, trunk: string): Promise<string> {
  if (!(await branchExists(repoRoot, trunk))) return `origin/${trunk}`;
  const tracking = await getTrackingBranch(repoRoot, trunk);
  return tracking && (await isAncestor(repoRoot, trunk, tracking)) ? tracking : trunk;
}

/**
 * Leave the upgrade branch for the trunk, after shipping it. When another worktree has the trunk
 * checked out, git refuses to switch to it: detach at the trunk instead, so this worktree holds
 * no branch and the upgrade branch can be deleted once its PR lands. Returns where it left HEAD.
 */
async function returnToTrunk(repoRoot: string, trunk: string): Promise<string> {
  const worktree = await getBranchWorktree(repoRoot, trunk);
  if (worktree) {
    console.info(pc.dim(`'${trunk}' is checked out at ${worktree}; detaching at '${trunk}' here instead...`));
    await switchDetached(repoRoot, trunk);
    return `detached at '${trunk}'`;
  }

  console.info(pc.dim(`switching back to '${trunk}'...`));
  await switchBranch(repoRoot, trunk);
  await pullFastForward(repoRoot).catch(() => {});
  return `back on '${trunk}'`;
}

/** An upgrade's merge result, with the review page the run wrote. */
interface UpgradeRunResult extends MergeResult {
  reviewPage?: ReviewPageReport;
}

/** Run the merge engine against the current branch, leaving the merge staged in the app. */
export async function runUpgrade(
  config: RuntimeConfig,
  options?: {
    stagedBranch?: string;
  },
): Promise<UpgradeRunResult> {
  createSpinner('starting upgrade...');

  let result: MergeResult;
  try {
    result = await runEngineWithSpinner(config, true);
  } catch (error) {
    // The engine threw, usually a stop before the merge: end the spinner, and when the CLI config
    // gate stopped it, show what upstream changed.
    spinnerSuccess();
    if (error instanceof UpstreamConfigChangedError) {
      printUpstreamOverrideChanges({ upstreamOverrides: error.report });
      console.info();
    }
    throw error;
  }

  if (result.conflicts.length === 0) {
    spinnerSuccess();
  } else {
    spinnerFail('upgrade merge completed with conflicts');
  }

  // Print summary (no file lists for an upgrade) plus the shared upstream-changes reports
  printEngineReports(result, 'merge summary');
  if (config.unpinned) {
    console.info(pc.yellow('⚠ --unpinned: every pinned entry was merged from upstream; keep only what you want.'));
    console.info();
  }

  const staged = await mergeInProgress(config.repoRoot);
  const stagedBranch =
    options?.stagedBranch && result.conflicts.length === 0 && staged ? options.stagedBranch : undefined;
  printUpgradeComplete(result, { stagedBranch });
  const reviewPage = await reportReviewPage(config.repoRoot, result, 'upgrade');

  return { ...result, reviewPage };
}

/** Conflicted files the `resolve` step lists before it counts the rest. */
const conflictsListed = 10;

/**
 * The `align` step after an upgrade run: from the merge result when this run merged, otherwise from
 * the app's upgrade point and pending list.
 */
async function upgradeAlignmentsStep(config: RuntimeConfig, run?: MergeResult): Promise<NextStep | undefined> {
  if (run?.alignments && run.upstreamCommit) {
    const { open, arrived } = run.alignments;
    return alignmentsStep(config, { ref: run.upstreamCommit.hash, open, arrived });
  }
  const view = await readOpenAlignments(config);
  return view ? alignmentsStep(config, view) : undefined;
}

/** The review page of this upgrade: the one this run wrote, or on a rerun the one the merge run left. */
function upgradeReviewStep(config: RuntimeConfig, run?: UpgradeRunResult): NextStep | undefined {
  const page = run ? run.reviewPage : existingUpgradeReviewPage(config.repoRoot);
  return page ? reviewStep(page) : undefined;
}

/** Next steps while an upgrade branch holds conflicts: resolve, let a rerun commit, review, align. */
async function conflictSteps(config: RuntimeConfig, conflicts: string[], run?: UpgradeRunResult): Promise<NextStep[]> {
  const listed = conflicts.slice(0, conflictsListed).map((file) => pc.dim(file));
  if (conflicts.length > conflictsListed) listed.push(pc.dim(`+ ${conflicts.length - conflictsListed} more`));
  const steps: Array<NextStep | undefined> = [
    {
      label: 'resolve',
      line: `${plural(conflicts.length, 'conflict')} in your editor, then stage them`,
      details: listed,
    },
    {
      label: 'finish',
      line: 'pnpm cella upgrade',
      details: [
        pc.dim('commits the upgrade and stops for drift triage'),
        pc.dim('let the rerun commit: a manual `git commit` records a merge commit that bloats the PR'),
      ],
    },
    upgradeReviewStep(config, run),
    await upgradeAlignmentsStep(config, run),
  ];
  return steps.filter((step): step is NextStep => !!step);
}

/** Conventional PR title prefix required by release-please. */
const upgradePrTitle = 'chore: upgrade cella';

/**
 * Build the upgrade commit subject, e.g. `chore: upgrade cella to v0.2.2 (4f7d87c)`.
 *
 * The upstream version comes from the manifest's release tag when tracking releases, else from
 * upstream's root package.json at the merged commit. Falls back to the bare title (+ short sha)
 * when a lookup fails, so committing never blocks on cosmetics.
 */
async function buildUpgradeCommitMessage(repoRoot: string, upstreamRef: string): Promise<string> {
  const shortSha = await getShortSha(repoRoot, upstreamRef).catch(() => '');
  if (!shortSha) return upgradePrTitle;

  const manifest = await readManifest(repoRoot);
  const version =
    manifest?.upstream.release ?? (await readPackageVersionAtRef(repoRoot, upstreamRef).catch(() => null));
  return version
    ? `${upgradePrTitle} to v${version.replace(/^v/, '')} (${shortSha})`
    : `${upgradePrTitle} to ${shortSha}`;
}

/**
 * Qualify bare `#123` references in an upstream commit subject with the upstream repo slug.
 * Left bare, GitHub would auto-link them to the app's own issue/PR #123 in the PR body.
 */
function qualifyPrRefs(subject: string, repoSlug?: string): string {
  if (!repoSlug) return subject;
  return subject.replace(/(^|[^\w/])#(\d+)\b/g, `$1${repoSlug}#$2`);
}

/** Inputs for {@link buildUpgradePrBody}, recovered from the committed upgrade manifests. */
interface UpgradePrBodyInput {
  /** GitHub slug of the upstream repo, e.g. 'cellajs/cella'. */
  repoSlug?: string;
  /** Upstream version or release tag at the upgrade point (leading `v` optional). */
  version?: string | null;
  /** Previous upgrade point (full sha), when known. */
  fromSha?: string | null;
  /** Upstream commit this upgrade moved to (full sha). */
  toSha: string;
  /** Upstream commits in the range, oldest first (possibly truncated to the newest N). */
  commits: CommitRangeEntry[];
  /** Total commits in the range (may exceed `commits.length` when truncated). */
  totalCount: number;
  /** Upstream alignments at the upgrade point: the total, and the ones the app has not handled yet. */
  alignments?: { total: number; open: Array<{ id: string; title: string; url?: string }> };
}

/** Render the upgrade PR body: where the upgrade moved to, plus the upstream commits it brought in. */
export function buildUpgradePrBody(input: UpgradePrBodyInput): string {
  const { repoSlug, version, fromSha, toSha, commits, totalCount, alignments } = input;
  const githubUrl = repoSlug ? `https://github.com/${repoSlug}` : undefined;
  const short = (sha: string) => sha.slice(0, 7);
  const commitRef = (sha: string) =>
    githubUrl ? `[\`${short(sha)}\`](${githubUrl}/commit/${sha})` : `\`${short(sha)}\``;

  const upstreamName = githubUrl ? `[${repoSlug}](${githubUrl})` : 'cella';
  const versionSuffix = version ? ` (v${version.replace(/^v/, '')})` : '';
  const lines = [`Upgrades ${upstreamName} to ${commitRef(toSha)}${versionSuffix}.`];

  if (totalCount > 0 && fromSha) {
    const compare = githubUrl ? ` ([compare](${githubUrl}/compare/${short(fromSha)}...${short(toSha)}))` : '';
    lines.push(
      '',
      `**${totalCount} upstream commit${totalCount === 1 ? '' : 's'} since the last upgrade**${compare}:`,
      '',
    );
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
 * Build the PR body for a finished upgrade branch: the upstream commits between the trunk's last
 * recorded upgrade point and the one this branch moves to, both read from committed manifests.
 * Undefined when the branch has no committed manifest (the caller falls back to `--fill`).
 */
async function buildUpgradePrBodyForBranch(repoRoot: string, trunk: string): Promise<string | undefined> {
  const manifest = await readManifestAtRef(repoRoot, 'HEAD');
  if (!manifest) return undefined;

  const toSha = manifest.upstream.commit.toLowerCase();
  // The trunk's committed manifest is the previous upgrade point; merge-base covers apps whose
  // last upgrade predates the manifest. `refs/cella/last-upgrade` is no help here: the merge already
  // moved it to `toSha`.
  const fromSha =
    (await readUpgradePointAtRef(repoRoot, trunk)) ?? (await getMergeBase(repoRoot, trunk, toSha).catch(() => null));
  const version = manifest.upstream.release ?? (await readPackageVersionAtRef(repoRoot, toSha).catch(() => null));

  const totalCount = fromSha ? await countCommitsBetween(repoRoot, fromSha, toSha).catch(() => 0) : 0;
  const commits = fromSha && totalCount > 0 ? await listCommitsBetween(repoRoot, fromSha, toSha, commitListMax) : [];

  const alignments = await readPrBodyAlignments(repoRoot, toSha, manifest.upstream.repo).catch(() => undefined);
  return buildUpgradePrBody({
    repoSlug: manifest.upstream.repo,
    version,
    fromSha,
    toSha,
    commits,
    totalCount,
    alignments,
  });
}

/** Alignments for the PR body: the total at the upgrade point and the app's open ones, with permalinks. */
async function readPrBodyAlignments(
  repoRoot: string,
  toSha: string,
  repoSlug?: string,
): Promise<UpgradePrBodyInput['alignments']> {
  const githubUrl = repoSlug ? `https://github.com/${repoSlug}` : undefined;
  const [ids, pending] = await Promise.all([listAlignmentIds(repoRoot, toSha), readPending(repoRoot)]);
  const open = await Promise.all(
    pending.map(async (id) => ({
      id,
      title: (await readAlignment(repoRoot, toSha, id))?.title ?? id,
      url: alignmentUrl(githubUrl, toSha, id),
    })),
  );
  return { total: ids.length, open };
}

/** Print the GitHub CLI command for opening the finished upgrade PR. */
function printPrCreateStep(branch: string, trunk: string, title = upgradePrTitle): void {
  console.info(pc.dim(`  gh pr create --base ${trunk} --head ${branch} --title "${title}" --fill`));
}

/**
 * Safety net run before an upgrade branch goes public: rewrite a branch holding merge commits as one
 * commit with identical content. A manual `git commit` on the staged merge records a two-parent
 * merge commit, and since upstream's history is not on `origin`, the PR would list every upstream
 * commit ever made. Returns true if the branch was rewritten, so the caller force-pushes.
 */
async function flattenUpgradeBranch(repoRoot: string, branch: string, trunk: string): Promise<boolean> {
  const mergeCommits = await listBranchMergeCommits(repoRoot, trunk);
  if (mergeCommits.length === 0) return false;

  // The most recent merge's second parent is the upstream tip that was merged in.
  const message = await buildUpgradeCommitMessage(repoRoot, `${mergeCommits[0]}^2`);

  console.info(
    pc.yellow(
      `'${branch}' contains ${mergeCommits.length} merge commit(s): the PR would list the entire upstream history.`,
    ),
  );
  console.info(pc.dim(`flattening '${branch}' to a single commit (same content)...`));
  await flattenBranch(repoRoot, trunk, message);
  return true;
}

/**
 * Push the finished upgrade branch to `origin`, open a PR into the trunk, and switch back to the
 * trunk (see `returnToTrunk`). A failed push prints the manual steps and leaves you on the branch;
 * a missing or failed `gh` prints the `gh` command but still returns you to the trunk.
 */
async function shipUpgradeBranch(config: RuntimeConfig, branch: string): Promise<void> {
  const { repoRoot, settings } = config;
  const trunk = resolveTrunk(settings);
  // The PR targets `trunk`; its commits and body are read against the trunk the branch was cut from.
  const trunkRef = await resolveTrunkRef(repoRoot, trunk);

  const flattened = await flattenUpgradeBranch(repoRoot, branch, trunkRef);
  let prUrl: string | undefined;
  let prOpened = false;

  // The PR title is the versioned upgrade commit subject, rebuilt from the manifest rather than read
  // from HEAD: drift-triage commits may sit on top of the upgrade commit (release-please only needs
  // the prefix).
  const upstreamCommit = (await readManifest(repoRoot))?.upstream.commit;
  const prTitle = upstreamCommit ? await buildUpgradeCommitMessage(repoRoot, upstreamCommit) : upgradePrTitle;

  console.info(pc.dim(`pushing '${branch}' to origin...`));
  try {
    await pushBranch(repoRoot, 'origin', branch, { forceWithLease: flattened });
  } catch (error) {
    console.info(pc.yellow(`push failed (${errorMessage(error).split('\n')[0]}). finish manually:`));
    console.info(pc.dim(`  git push -u origin ${branch}`));
    printPrCreateStep(branch, trunk, prTitle);
    return;
  }

  if (ghAvailable()) {
    console.info(pc.dim('opening a pull request...'));
    const prBody = (await buildUpgradePrBodyForBranch(repoRoot, trunkRef)) ?? '';
    const repoSlug = (await readOriginGitHubUrl(repoRoot))?.replace('https://github.com/', '') ?? null;
    const pr = createPr(repoRoot, repoSlug, { base: trunk, head: branch, title: prTitle, body: prBody });
    prUrl = pr.url;
    prOpened = pr.ok;
    if (!prOpened) {
      console.info(pc.yellow('could not open the PR automatically (it may already exist). open it with:'));
      if (prUrl) console.info(pc.dim(`  ${prUrl}`));
      printPrCreateStep(branch, trunk, prTitle);
    }
  } else {
    console.info(pc.yellow('`gh` not found, open the PR manually:'));
    printPrCreateStep(branch, trunk, prTitle);
  }

  const position = await returnToTrunk(repoRoot, trunk);

  console.info();
  if (prUrl) {
    console.info(`${checkMark} upgrade pull request ${prOpened ? 'opened' : 'ready'}`);
    console.info(pc.dim(`  ${prUrl} · branch pushed, ${position}`));
  } else {
    console.info(`${checkMark} upgrade branch pushed`);
    console.info(pc.dim(`  '${branch}' is on origin, ${position}`));
  }
  const steps: Array<NextStep | undefined> = [
    prUrl
      ? {
          label: 'merge',
          line: hyperlink(pc.cyan(prUrl), prUrl),
          details: [pc.dim(`squash-merge it into '${trunk}'; the next upgrade offers to while it is open`)],
        }
      : undefined,
    await upgradeAlignmentsStep(config),
  ];
  printNextSteps(steps.filter((step): step is NextStep => !!step));
}

/**
 * Run `pnpm install` then `pnpm check` before committing the merge, so the lockfile and generated
 * files the merge left stale land in the same commit. The install passes `--no-frozen-lockfile`:
 * the merged `package.json` leaves the lockfile stale, and pnpm freezes it under `CI`. Returns
 * false if a step fails (the merge is left in progress to retry).
 */
function finalizeWorkspace(repoRoot: string): boolean {
  for (const args of [['install', '--no-frozen-lockfile'], ['check']]) {
    console.info(pc.dim(`running pnpm ${args.join(' ')}...`));
    const result = spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' });
    if (result.status !== 0) return false;
  }
  return true;
}

/** Outcome of an upgrade cycle run on a fresh temporary branch, with its merge result when it merged. */
type UpgradeCycleOutcome =
  | { status: 'conflicts'; branch: UpgradeBranch; result: UpgradeRunResult }
  | { status: 'staged'; branch: UpgradeBranch; result: UpgradeRunResult }
  | { status: 'noop'; behind?: string; result?: UpgradeRunResult };

/**
 * Return to where the cycle started and drop the throwaway branch. Only for a branch that holds
 * nothing: an up-to-date run, or one that stopped before the merge.
 */
async function discardUpgradeBranch(repoRoot: string, branch: UpgradeBranch): Promise<void> {
  if (branch.startBranch === 'HEAD') await switchDetached(repoRoot, branch.startCommit);
  else await switchBranch(repoRoot, branch.startBranch);
  await deleteBranch(repoRoot, branch.name);
}

/**
 * After the merge step threw: drop the throwaway branch when the run stopped before the merge (a
 * gate, an unreachable upstream, a ref that does not resolve), so nothing changed and a rerun
 * starts a fresh cycle (an empty upgrade branch is never shipped). A branch that holds a merge or
 * changes stays as it is. Returns whether the branch was dropped.
 */
async function discardUnusedUpgradeBranch(repoRoot: string, branch: UpgradeBranch): Promise<boolean> {
  const unused =
    (await getCurrentBranch(repoRoot)) === branch.name &&
    !(await mergeInProgress(repoRoot)) &&
    (await isClean(repoRoot));
  if (!unused) return false;

  await discardUpgradeBranch(repoRoot, branch);
  const start = branch.startBranch === 'HEAD' ? `at ${branch.startCommit.slice(0, 7)}` : `on '${branch.startBranch}'`;
  console.info(pc.dim(`removed the unused '${branch.name}', back ${start}.`));
  return true;
}

/**
 * Run one upgrade cycle on a fresh temporary branch: cut the branch, merge upstream (+ packages),
 * and report the resulting state. On `noop` (nothing new, or `behind`: only a point the last upgrade
 * already went past) the throwaway branch is gone and the start branch restored; a run that stops
 * before the merge throws, after dropping the branch the same way.
 */
async function runUpgradeCycle(config: RuntimeConfig): Promise<UpgradeCycleOutcome> {
  const { repoRoot } = config;
  const branch = await cutUpgradeBranch(config);

  let result: UpgradeRunResult;
  try {
    result = await runUpgrade(config, { stagedBranch: branch.name });
  } catch (error) {
    const discarded = await discardUnusedUpgradeBranch(repoRoot, branch).catch(() => false);
    // Tracking a release or branch the last upgrade went past is nothing to upgrade, not a failure.
    // A pinned --ref behind the upgrade point stays an error: the run cannot do what it was asked.
    if (discarded && error instanceof BehindUpgradePointError && !config.ref) {
      return { status: 'noop', behind: error.message };
    }
    throw error;
  }

  if (config.settings.mergePackageJson !== false) {
    // Merge package.json keys even when the merge left conflicts: package.json files that are
    // themselves conflicted are skipped and reported; all others still merge.
    await runPackages(config, { conflictedFiles: result.conflicts });
  }

  if (result.conflicts.length > 0) return { status: 'conflicts', branch, result };

  // Nothing staged: already up to date. Return to where the run started and drop the throwaway
  // branch (a fresh cycle never starts on an upgrade branch: those resume or ship instead).
  if (!(await mergeInProgress(repoRoot))) {
    await discardUpgradeBranch(repoRoot, branch);
    return { status: 'noop', result };
  }

  return { status: 'staged', branch, result };
}

/**
 * Commit an in-progress merge on the temporary upgrade branch as one single-parent commit, then stop
 * there for drift triage; shipping is always its own rerun. Stops early while conflicts remain.
 * `run` is the merge this run made, absent when it resumes an earlier run's merge.
 */
async function commitUpgradeMerge(config: RuntimeConfig, branch: string, run?: UpgradeRunResult): Promise<void> {
  const { repoRoot } = config;
  const conflicts = await getConflictedFiles(repoRoot);

  console.info();
  if (conflicts.length > 0) {
    printStep('conflicts', `${plural(conflicts.length, 'file')} still conflict on '${branch}'`, warningMark);
    printNextSteps(await conflictSteps(config, conflicts, run));
    return;
  }

  // Stage resolved conflicts and manual edits before tooling that may fail, so they are recorded.
  await stageAll(repoRoot);

  if (!finalizeWorkspace(repoRoot)) {
    console.info();
    printStep('checks', '`pnpm install` or `pnpm check` failed', warningMark);
    printNextSteps([
      { label: 'fix', line: 'what failed above', details: [pc.dim(`the merge stays staged on '${branch}'`)] },
      {
        label: 'finish',
        line: 'pnpm cella upgrade',
        details: [pc.dim('commits the upgrade and stops for drift triage')],
      },
    ]);
    return;
  }

  // The subject reads MERGE_HEAD, which commitSquash clears; re-stage what install/check touched.
  const message = await buildUpgradeCommitMessage(repoRoot, 'MERGE_HEAD');
  await stageAll(repoRoot);
  await commitSquash(repoRoot, message);
  console.info();
  printStep('committed', `${message}\n${pc.dim(`on '${branch}', not pushed`)}`);
  const steps: Array<NextStep | undefined> = [
    upgradeReviewStep(config, run),
    {
      label: 'triage',
      line: 'pnpm cella analyze',
      details: [pc.dim('drift triage: commit any follow-ups on this branch')],
    },
    await upgradeAlignmentsStep(config, run),
    { label: 'ship', line: 'pnpm cella upgrade', details: [pc.dim('pushes the branch and opens the squash-merge PR')] },
  ];
  printNextSteps(steps.filter((step): step is NextStep => !!step));
}

/**
 * Whether the merge in progress is one the engine finished: the manifest it writes last records
 * MERGE_HEAD as the upstream commit. A run stopped by ctrl-c or a throw leaves a merge without it.
 */
async function engineFinishedMerge(repoRoot: string): Promise<boolean> {
  // MERGE_HEAD of a release tag names the tag object
  const [recorded, merged] = await Promise.all([readUpgradePoint(repoRoot), revParse(repoRoot, 'MERGE_HEAD^{commit}')]);
  return recorded !== null && recorded === merged;
}

/**
 * Handle a merge in progress the engine did not finish. On a branch without a committed upgrade it
 * is the engine's own, stopped by ctrl-c or a throw: the merge goes, and the branch with it, which
 * would ship empty. On top of a committed upgrade it is a merge of the app's own, left to git.
 */
async function handleUnfinishedMerge(config: RuntimeConfig, branch: string): Promise<void> {
  const { repoRoot } = config;
  const trunk = resolveTrunk(config.settings);
  const cutPoint = await getMergeBase(repoRoot, 'HEAD', await resolveTrunkRef(repoRoot, trunk));
  const [committed, atCut] = await Promise.all([
    readUpgradePointAtRef(repoRoot, 'HEAD'),
    readUpgradePointAtRef(repoRoot, cutPoint),
  ]);

  console.info();
  if (committed !== atCut) {
    console.info(pc.yellow(`'${branch}' has a merge in progress that \`cella upgrade\` did not start.`));
    console.info(pc.dim('finish it with `git commit` or undo it with `git merge --abort`, then rerun to ship.'));
    return;
  }

  await mergeAbort(repoRoot);
  const position = await returnToTrunk(repoRoot, trunk);
  await deleteBranch(repoRoot, branch);
  console.info(
    pc.yellow(`an earlier run stopped before it finished the merge on '${branch}': undid it and removed the branch.`),
  );
  console.info(pc.dim(`${position}: run \`pnpm cella upgrade\` again to start a fresh upgrade.`));
}

/**
 * Merge the open upgrade PR(s) so the trunk carries the recorded upgrade point before a new cycle cuts
 * from it. The newest PR is a content superset of any older ones (each cycle upgrades again from the
 * same stale trunk), so the newest is squash-merged and the rest are closed. A merge GitHub
 * refuses (conflicts, failing required checks) stops the run.
 */
async function mergeOpenUpgradePrs(config: RuntimeConfig, open: GhPullRequest[]): Promise<'continue' | 'cancel'> {
  const { repoRoot, settings } = config;
  const trunk = resolveTrunk(settings);
  const [newest, ...superseded] = open;

  console.info();
  console.info(pc.dim(`squash-merging #${newest.number} into '${trunk}'...`));
  const merged = mergePrSquash(repoRoot, newest.number, { deleteBranch: true });
  if (!merged.ok) {
    console.info();
    console.info(pc.yellow(`could not merge #${newest.number}: resolve it first, then re-run \`pnpm cella upgrade\`:`));
    if (merged.error) console.info(pc.dim(merged.error.replace(/^/gm, '  ')));
    console.info(pc.dim(`  ${newest.url}`));
    return 'cancel';
  }
  console.info(`${checkMark} merged #${newest.number}`);
  // Drop the stale local branch that tracked the merged PR (the remote one went with --delete-branch).
  await deleteBranch(repoRoot, newest.headRefName);

  for (const pr of superseded) {
    console.info(pc.dim(`closing #${pr.number}: its changes are included in #${newest.number}...`));
    closePr(repoRoot, pr.number);
    await deleteBranch(repoRoot, pr.headRefName);
  }

  return 'continue';
}

/**
 * Before cutting a fresh upgrade branch, offer to merge an earlier upgrade PR that is still open: the
 * upgrade point lives in the manifest on the upgrade branch, so a cycle cut from a trunk without it
 * re-includes that PR's whole delta. A silent `continue` without `gh`, an open PR or a TTY.
 */
async function guardAgainstOpenUpgradePr(config: RuntimeConfig): Promise<'continue' | 'cancel'> {
  const { repoRoot } = config;

  if (!ghAvailable() || !process.stdout.isTTY) return 'continue';

  const open = listOpenUpgradePrs(repoRoot, upgradeBranchPrefix);
  if (open.length === 0) return 'continue';

  const many = open.length > 1;
  console.info();
  console.info(
    `${warningMark} ${pc.yellow(`${many ? `${open.length} earlier upgrade PRs are` : 'an earlier upgrade PR is'} still open and unmerged:`)}`,
  );
  for (const pr of open) {
    console.info(pc.dim(`  #${pr.number}  ${pr.title}`));
    console.info(pc.dim(`         ${pr.url}`));
  }
  console.info(
    pc.dim(`  starting a new upgrade now produces a PR that re-includes ${many ? 'these' : 'those'} changes.`),
  );
  console.info();

  const choice = await select<'merge' | 'continue' | 'cancel'>({
    message: 'how do you want to proceed?',
    choices: [
      {
        value: 'merge',
        name: `merge ${many ? 'them' : `#${open[0].number}`} first, then upgrade   ${pc.dim('(recommended)')}`,
      },
      { value: 'continue', name: `continue anyway   ${pc.dim('(new PR will re-include the unmerged changes)')}` },
      { value: 'cancel', name: pc.red('cancel') },
    ],
    loop: false,
  });

  if (choice === 'cancel') return 'cancel';
  if (choice === 'continue') return 'continue';
  return mergeOpenUpgradePrs(config, open);
}

/**
 * Run the standalone `cella upgrade` command. Idempotent: each run advances the upgrade one stage
 * (cut and merge, commit, ship) and never commits and ships in the same run.
 */
export async function runUpgradeCommand(config: RuntimeConfig): Promise<void> {
  const { repoRoot } = config;
  const currentBranch = await getCurrentBranch(repoRoot);
  const onUpgradeBranch = isUpgradeBranch(currentBranch);

  // Resume path: finish the merge an earlier run left staged on this branch.
  if (onUpgradeBranch && (await mergeInProgress(repoRoot))) {
    if (await engineFinishedMerge(repoRoot)) await commitUpgradeMerge(config, currentBranch);
    else await handleUnfinishedMerge(config, currentBranch);
    return;
  }

  // On an upgrade branch with the merge already committed: ship it. Edits not committed would be left
  // out of the pushed branch, so a dirty tree stops the run.
  if (onUpgradeBranch) {
    if (!(await isClean(repoRoot))) {
      console.info();
      console.info(
        pc.yellow(
          `upgrade branch '${currentBranch}' has uncommitted changes.\n` +
            'commit them first (`git commit --amend --no-edit` or a new commit).',
        ),
      );
      return;
    }
    await shipUpgradeBranch(config, currentBranch);
    return;
  }

  // Fresh cycle, from a clean tree only.
  if (!(await isClean(repoRoot))) {
    throw new Error('working directory has uncommitted changes. please commit or stash before upgrading.');
  }
  if ((await guardAgainstOpenUpgradePr(config)) === 'cancel') return;

  const outcome = await runUpgradeCycle(config);

  if (outcome.status === 'noop') {
    console.info();
    if (outcome.behind) {
      console.info(pc.green('nothing to upgrade: the last upgrade already went past this upstream point.'));
      for (const line of outcome.behind.split('\n')) console.info(pc.dim(`  ${line}`));
    } else {
      console.info(pc.green('already up to date with upstream, nothing to upgrade.'));
    }
    const align = await upgradeAlignmentsStep(config, outcome.result);
    if (align) printNextSteps([align]);
    return;
  }

  const { name: upgradeBranch } = outcome.branch;
  if (outcome.status === 'conflicts') {
    const conflicts = await getConflictedFiles(repoRoot);
    printStep('conflicts', `${plural(conflicts.length, 'file')} on '${upgradeBranch}'`, warningMark);
    printNextSteps(await conflictSteps(config, conflicts, outcome.result));
    return;
  }

  await commitUpgradeMerge(config, upgradeBranch, outcome.result);
}

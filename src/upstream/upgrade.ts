import { spawnSync } from 'node:child_process';
import { isUpgradeBranch } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import {
  createSpinner,
  type NextStep,
  plural,
  printNextSteps,
  printStep,
  spinnerFail,
  spinnerSuccess,
  spinnerText,
  warningMark,
} from '../utils/display';
import { commitSquash, getConflictedFiles, getCurrentBranch, isClean, mergeInProgress, stageAll } from '../utils/git';
import { applyDirectMerge, settleMerge } from './apply';
import { classifyUpgrade, summarize } from './classify';
import {
  assertAheadOfUpgradePoint,
  assertCliVersion,
  assertUpstreamConfigFollowed,
  BehindUpgradePointError,
  UpstreamConfigChangedError,
} from './gates';
import type { MergeResult } from './model';
import { runPackages } from './package-json-merge';
import { buildUpgradeCommitMessage, guardAgainstOpenUpgradePr, shipUpgradeBranch } from './pull-requests';
import {
  printCheckoutStep,
  printEngineReports,
  printUpgradeComplete,
  printUpstreamOverrideChanges,
  printUpstreamStep,
  readUpstreamReports,
  upgradeAlignmentsStep,
} from './report';
import { existingUpgradeReviewPage, type ReviewPageReport, reportReviewPage, reviewStep } from './review-page';
import {
  cutUpgradeBranch,
  discardUnusedUpgradeBranch,
  discardUpgradeBranch,
  undoUnfinishedMerge,
  upgradeFinishedMerge,
} from './upgrade-branch';
import { ensureUpgradePoint, readAlignmentsInRange, readUpgradeRange, recordUpgrade } from './upgrade-point';
import { fetchUpstream, resolveUpstreamRef } from './upstream-ref';

/** An upgrade's merge result, with the review page the run wrote. */
interface UpgradeRunResult extends MergeResult {
  reviewPage?: ReviewPageReport;
}

/**
 * Run the standalone `cella upgrade` command, in the app itself so conflicts surface in the IDE.
 * Idempotent: each run advances the upgrade one stage (cut and merge, commit, ship) and never commits
 * and ships in the same run; after conflicts, resolve them and rerun to finish the same merge. Returns
 * 0 when a stage finished, there was nothing to upgrade or the person cancelled, and 1 where a person
 * must act before a rerun can go on.
 */
export async function runUpgradeCommand(config: RuntimeConfig): Promise<number> {
  const { repoRoot } = config;

  // Where an earlier run stopped: a merge to commit or undo, or a committed upgrade to ship.
  const currentBranch = await getCurrentBranch(repoRoot);
  if (isUpgradeBranch(currentBranch)) {
    if (!(await mergeInProgress(repoRoot))) return shipUpgradeBranch(config, currentBranch);
    return (await upgradeFinishedMerge(repoRoot))
      ? commitUpgradeMerge(config, currentBranch)
      : undoUnfinishedMerge(config, currentBranch);
  }

  if (!(await isClean(repoRoot))) {
    throw new Error('working directory has uncommitted changes. please commit or stash before upgrading.');
  }
  const guard = await guardAgainstOpenUpgradePr(config);
  if (guard !== 'continue') return guard === 'refused' ? 1 : 0;

  const branch = await cutUpgradeBranch(config);
  let run: UpgradeRunResult;
  try {
    run = await runUpgrade(config, { stagedBranch: branch.name });
  } catch (error) {
    const discarded = await discardUnusedUpgradeBranch(repoRoot, branch).catch(() => false);
    // Tracking a release or branch the last upgrade went past is nothing to upgrade, not a failure.
    // A pinned --ref behind the upgrade point stays an error: the run cannot do what it was asked.
    if (discarded && error instanceof BehindUpgradePointError && !config.ref)
      return printNothingToUpgrade(config, error);
    throw error;
  }

  // Nothing staged: a fresh cycle never starts on an upgrade branch (those resume or ship), so this one goes.
  if (run.conflicts.length === 0 && !(await mergeInProgress(repoRoot))) {
    await discardUpgradeBranch(repoRoot, branch);
    return printNothingToUpgrade(config, run);
  }
  return commitUpgradeMerge(config, branch.name, run);
}

/**
 * Merge upstream into the current branch and leave the merge staged, conflicts keeping their markers:
 * resolve upstream, gate, classify, apply, merge package.json, record the upgrade point, report.
 * A gate stops the run before anything merges.
 */
export async function runUpgrade(
  config: RuntimeConfig,
  options?: { stagedBranch?: string },
): Promise<UpgradeRunResult> {
  const { repoRoot } = config;
  createSpinner('starting upgrade...');

  let result: MergeResult;
  try {
    await printCheckoutStep(repoRoot);
    await fetchUpstream(config);
    const pick = await resolveUpstreamRef(config);
    await ensureUpgradePoint(repoRoot, 'HEAD', pick.ref);
    const upstream = await readUpgradeRange(config, pick);
    await printUpstreamStep(config, upstream);

    await assertCliVersion(repoRoot, upstream.ref);
    await assertAheadOfUpgradePoint(config, upstream);
    await assertUpstreamConfigFollowed(config, upstream);

    const alignments = await readAlignmentsInRange(repoRoot, upstream);
    const files = await classifyUpgrade(config, upstream);
    const applied = await applyDirectMerge(repoRoot, upstream.ref, upstream.mergeRef, config, files, spinnerText);
    const staged = await settleMerge(repoRoot, files, applied);
    if (config.packageJsonKeys !== false) await runPackages(config, upstream, applied.remainingConflicts);

    const open = [...new Set([...alignments.open, ...alignments.arrived])];
    if (staged) await recordUpgrade(repoRoot, upstream, open);

    result = {
      files,
      summary: summarize(files),
      conflicts: applied.remainingConflicts,
      autoMergedFiles: applied.autoMergedFiles,
      protectedConflicts: applied.protectedConflicts,
      ...(await readUpstreamReports(config, upstream, files)),
      alignments: { ...alignments, open },
    };
  } catch (error) {
    spinnerSuccess();
    if (error instanceof UpstreamConfigChangedError) {
      printUpstreamOverrideChanges({ upstreamOverrides: error.report });
      console.info();
    }
    throw error;
  }

  if (result.conflicts.length === 0) spinnerSuccess();
  else spinnerFail('upgrade merge completed with conflicts');

  printEngineReports(result, 'merge summary');
  if (config.unpinned) {
    console.info(pc.yellow('⚠ --unpinned: every pinned entry was merged from upstream; keep only what you want.'));
    console.info();
  }

  const staged = await mergeInProgress(repoRoot);
  const stagedBranch =
    options?.stagedBranch && result.conflicts.length === 0 && staged ? options.stagedBranch : undefined;
  printUpgradeComplete(result, { stagedBranch });
  const reviewPage = await reportReviewPage(repoRoot, result, 'upgrade');

  return { ...result, reviewPage };
}

/** Close a run that found nothing to upgrade: already up to date, or upstream behind the last upgrade. */
async function printNothingToUpgrade(config: RuntimeConfig, outcome: UpgradeRunResult | Error): Promise<number> {
  console.info();
  if (outcome instanceof Error) {
    console.info(pc.green('nothing to upgrade: the last upgrade already went past this upstream point.'));
    for (const line of outcome.message.split('\n')) console.info(pc.dim(`  ${line}`));
  } else {
    console.info(pc.green('already up to date with upstream, nothing to upgrade.'));
  }
  const align = await upgradeAlignmentsStep(config, outcome instanceof Error ? undefined : outcome);
  if (align) printNextSteps([align]);
  return 0;
}

/** Conflicted files the `resolve` step lists before it counts the rest. */
const conflictsListed = 10;

/** The review page of this upgrade: the one this run wrote, or on a rerun the one the merge run left. */
async function upgradeReviewStep(config: RuntimeConfig, run?: UpgradeRunResult): Promise<NextStep | undefined> {
  const page = run ? run.reviewPage : await existingUpgradeReviewPage(config.repoRoot);
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
    await upgradeReviewStep(config, run),
    await upgradeAlignmentsStep(config, run),
  ];
  return steps.filter((step): step is NextStep => !!step);
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

/**
 * Commit an in-progress merge on the temporary upgrade branch as one single-parent commit, then stop
 * there for drift triage; shipping is always its own rerun. Stops early, returning 1, while conflicts
 * remain or when `pnpm install` or `pnpm check` fails. `run` is the merge this run made, absent when
 * it resumes an earlier run's merge.
 */
async function commitUpgradeMerge(config: RuntimeConfig, branch: string, run?: UpgradeRunResult): Promise<number> {
  const { repoRoot } = config;
  const conflicts = await getConflictedFiles(repoRoot);

  console.info();
  if (conflicts.length > 0) {
    const where = run ? `on '${branch}'` : `still conflict on '${branch}'`;
    printStep('conflicts', `${plural(conflicts.length, 'file')} ${where}`, warningMark);
    printNextSteps(await conflictSteps(config, conflicts, run));
    return 1;
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
    return 1;
  }

  // The subject reads MERGE_HEAD, which commitSquash clears; re-stage what install/check touched.
  const message = await buildUpgradeCommitMessage(repoRoot, 'MERGE_HEAD');
  await stageAll(repoRoot);
  await commitSquash(repoRoot, message);
  console.info();
  printStep('committed', `${message}\n${pc.dim(`on '${branch}', not pushed`)}`);
  const steps: Array<NextStep | undefined> = [
    await upgradeReviewStep(config, run),
    {
      label: 'triage',
      line: 'pnpm cella analyze',
      details: [pc.dim('drift triage: commit any follow-ups on this branch')],
    },
    await upgradeAlignmentsStep(config, run),
    { label: 'ship', line: 'pnpm cella upgrade', details: [pc.dim('pushes the branch and opens the squash-merge PR')] },
  ];
  printNextSteps(steps.filter((step): step is NextStep => !!step));
  return 0;
}

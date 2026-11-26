import { readFile, rm, writeFile } from 'node:fs/promises';
import { buildUpgradeBranchName, resolveTrunk } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { plural } from '../utils/display';
import {
  branchExists,
  countCommitsBetween,
  createBranchFrom,
  deleteBranch,
  fastForwardBranch,
  fetchRemote,
  getBranchWorktree,
  getCommitInfo,
  getCurrentBranch,
  getMergeBase,
  getTrackingBranch,
  getTrackingStatus,
  gitPath,
  isAncestor,
  isClean,
  mergeAbort,
  mergeInProgress,
  pullFastForward,
  revParse,
  switchBranch,
  switchDetached,
} from '../utils/git';
import { readUpgradePoint, readUpgradePointAtRef } from './upgrade-point';

/** The temporary branch an upgrade cycle runs on. */
interface UpgradeBranch {
  /** The freshly cut temporary branch, e.g. `cella/upgrade/20260702-1430`. */
  name: string;
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

  const tracking = await getTrackingBranch(repoRoot, trunk);
  if (!tracking) {
    console.info(pc.dim(`'${trunk}' has no tracking branch: skipping the up-to-date check.`));
    return trunk;
  }

  // Best-effort, so an offline run compares with what is already local.
  await fetchRemote(repoRoot, tracking.split('/')[0]).catch(() => {});
  const { ahead, behind } = await getTrackingStatus(repoRoot, trunk);

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
export async function cutUpgradeBranch(config: RuntimeConfig): Promise<UpgradeBranch> {
  const { repoRoot } = config;
  const trunk = resolveTrunk(config);
  const startBranch = await getCurrentBranch(repoRoot);
  const startCommit = (await getCommitInfo(repoRoot, 'HEAD')).hash;

  console.info(pc.dim(`updating '${trunk}'...`));
  let startPoint = await resolveCycleStart(repoRoot, trunk, startBranch);
  const added = await countCommitsBetween(repoRoot, startPoint, 'HEAD');
  if (added > 0 && (await isAncestor(repoRoot, startPoint, 'HEAD'))) {
    console.info(pc.dim(`cutting from HEAD, which adds ${plural(added, 'commit')} to '${startPoint}'.`));
    startPoint = 'HEAD';
  }

  const name = buildUpgradeBranchName();
  console.info(pc.dim(`creating temporary upgrade branch '${name}' from '${startPoint}'...`));
  console.info();
  await createBranchFrom(repoRoot, name, startPoint);
  return { name, startBranch, startCommit };
}

/**
 * The trunk ref an upgrade branch was cut from, to read its own commits against (`<ref>..HEAD`): the
 * trunk, or its remote-tracking ref when the trunk is behind it. `resolveCycleStart` cuts from
 * `origin` when another worktree holds a stale trunk, and that stale trunk would count origin's
 * newer commits as part of the upgrade branch.
 */
export async function resolveTrunkRef(repoRoot: string, trunk: string): Promise<string> {
  if (!(await branchExists(repoRoot, trunk))) return `origin/${trunk}`;
  const tracking = await getTrackingBranch(repoRoot, trunk);
  return tracking && (await isAncestor(repoRoot, trunk, tracking)) ? tracking : trunk;
}

/**
 * Leave the upgrade branch for the trunk, after shipping it. When another worktree has the trunk
 * checked out, git refuses to switch to it: detach at the trunk instead, so this worktree holds
 * no branch and the upgrade branch can be deleted once its PR lands. Returns where it left HEAD.
 */
export async function returnToTrunk(repoRoot: string, trunk: string): Promise<string> {
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

/**
 * Return to where the cycle started and drop the throwaway branch. Only for a branch that holds
 * nothing: an up-to-date run, or one that stopped before the merge.
 */
export async function discardUpgradeBranch(repoRoot: string, branch: UpgradeBranch): Promise<void> {
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
export async function discardUnusedUpgradeBranch(repoRoot: string, branch: UpgradeBranch): Promise<boolean> {
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
 * Whether the merge in progress is one an upgrade run took past its merge step: the manifest records MERGE_HEAD as the
 * upstream commit. A run stopped by ctrl-c or a throw before the manifest leaves a merge without it. A run stopped
 * after it can end before its stop printed anything, which {@link reviewStopShown} answers.
 */
export async function upgradeFinishedMerge(repoRoot: string): Promise<boolean> {
  // MERGE_HEAD of a release tag names the tag object
  const [recorded, merged] = await Promise.all([readUpgradePoint(repoRoot), revParse(repoRoot, 'MERGE_HEAD^{commit}')]);
  return recorded !== null && recorded === merged;
}

/** The file in the git dir that holds the upstream commit of the merge whose review or conflict stop a run printed. */
const reviewStopFile = 'cella-upgrade-review-stop';

/** Record that this run printed the stop, with the list of what arrived, for the merge in progress. */
export async function recordReviewStop(repoRoot: string): Promise<void> {
  await writeFile(await gitPath(repoRoot, reviewStopFile), `${await revParse(repoRoot, 'MERGE_HEAD^{commit}')}\n`);
}

/** Whether a run printed the stop for the merge in progress: a record of another merge does not count. */
export async function reviewStopShown(repoRoot: string): Promise<boolean> {
  const [record, merged] = await Promise.all([
    readFile(await gitPath(repoRoot, reviewStopFile), 'utf8').catch(() => ''),
    revParse(repoRoot, 'MERGE_HEAD^{commit}'),
  ]);
  return merged !== null && record.trim() === merged;
}

/** Remove the record of the stop, once the merge is committed. */
export async function clearReviewStop(repoRoot: string): Promise<void> {
  await rm(await gitPath(repoRoot, reviewStopFile), { force: true });
}

/**
 * Handle a merge in progress no upgrade run finished. On a branch without a committed upgrade it is
 * an upgrade run's own, stopped by ctrl-c or a throw: the merge goes, and the branch with it, which
 * would ship empty. On top of a committed upgrade it is a merge of the app's own, left to git: the
 * run returns 1.
 */
export async function undoUnfinishedMerge(config: RuntimeConfig, branch: string): Promise<number> {
  const { repoRoot } = config;
  const trunk = resolveTrunk(config);
  const cutPoint = await getMergeBase(repoRoot, 'HEAD', await resolveTrunkRef(repoRoot, trunk));
  const [committed, atCut] = await Promise.all([
    readUpgradePointAtRef(repoRoot, 'HEAD'),
    readUpgradePointAtRef(repoRoot, cutPoint),
  ]);

  console.info();
  if (committed !== atCut) {
    console.info(pc.yellow(`'${branch}' has a merge in progress that \`cella upgrade\` did not start.`));
    console.info(pc.dim('finish it with `git commit` or undo it with `git merge --abort`, then rerun to ship.'));
    return 1;
  }

  await mergeAbort(repoRoot);
  const position = await returnToTrunk(repoRoot, trunk);
  await deleteBranch(repoRoot, branch);
  console.info(
    pc.yellow(`an earlier run stopped before it finished the merge on '${branch}': undid it and removed the branch.`),
  );
  console.info(pc.dim(`${position}: run \`pnpm cella upgrade\` again to start a fresh upgrade.`));
  return 0;
}

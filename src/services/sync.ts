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
  printEngineReports,
  printFlagWarnings,
  printLogFileReport,
  printSyncComplete,
  printUpstreamOverrideChanges,
  spinnerFail,
  spinnerSuccess,
  warningMark,
} from '../utils/display';
import { errorMessage } from '../utils/errors';
import { closePr, type GhPullRequest, ghAvailable, listOpenSyncPrs, mergePrSquash } from '../utils/gh';
import {
  assertClean,
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
import { listNoteIds, noteUrl, readNote, readPending } from '../utils/migration-notes';
import { BehindSyncPointError, runEngineWithSpinner, UpstreamConfigChangedError } from './merge-engine';
import { printMigrationNotesLine } from './migrate';
import { runPackages } from './packages';

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
 * while another worktree has the trunk checked out.
 *
 * Fetches the trunk's upstream and reacts to how local compares:
 * - behind (fast-forwardable): fast-forward it so the branch is cut from the latest trunk. When
 *   another worktree has the trunk checked out, its ref can't move under that checkout: cut from
 *   the remote-tracking ref instead and leave the trunk as it is.
 * - diverged (local commits the remote lacks *and* vice versa): abort with guidance, since
 *   syncing onto a stale/diverged trunk produces a PR against an out-of-date base and avoidable
 *   conflicts.
 * - ahead-only / up to date / no upstream (local-only repo): fine, just note it and continue.
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

/**
 * Cut a fresh temporary sync branch from the trunk.
 *
 * Brings `releaseBase` up to date, then creates `cella/sync/<stamp>` from it (`git switch -c`
 * from wherever the run started) so the merge lands on an isolated throwaway branch, never a
 * long-lived integration branch.
 */
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

/**
 * Run the merge engine against the current branch (the core merge step).
 *
 * Performs the merge directly in the fork and leaves it staged: conflicted files keep their
 * markers for IDE 3-way resolution, everything else is resolved per the override rules. Called
 * by `runSyncCycle`.
 */
export async function runSync(
  config: RuntimeConfig,
  options?: {
    stagedBranch?: string;
  },
): Promise<MergeResult> {
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

  printLogFileReport(config, result.files);

  const stagedBranch =
    options?.stagedBranch && result.conflicts.length === 0 && hasStagedSyncChanges(result)
      ? options.stagedBranch
      : undefined;
  printSyncComplete(result, { stagedBranch });

  printFlagWarnings({ hard: config.hard, unpinned: config.unpinned });

  await printMigrationNotesLine(config, result);

  return result;
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
  /** Upstream migration notes at the sync point: the total, and the ones the app has not handled yet. */
  notes?: { total: number; open: Array<{ id: string; title: string; url?: string }> };
}

/** Render the sync PR body: where the sync moved to, plus the upstream commits it brought in. */
export function buildSyncPrBody(input: SyncPrBodyInput): string {
  const { repoSlug, version, fromSha, toSha, commits, totalCount, notes } = input;
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

  if (notes && notes.total > 0) {
    const { total, open } = notes;
    if (open.length === 0) lines.push('', `**Migration notes**: all ${total} handled.`);
    else {
      lines.push(
        '',
        `**Migration notes**: ${Math.max(0, total - open.length)} of ${total} handled, open (\`pnpm cella migrate\`):`,
        '',
      );
      for (const note of open)
        lines.push(`- ${note.url ? `[${note.title}](${note.url})` : note.title} (\`${note.id}\`)`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Build the PR body for a finished sync branch: the upstream commits between the trunk's last
 * recorded sync point and the one this branch moves to (both read from committed manifests, so
 * this works on the rerun that ships the branch, long after the merge engine ran).
 *
 * Returns undefined when the branch has no committed manifest: the caller falls back to `--fill`.
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
  const commits =
    fromSha && totalCount > 0
      ? await listCommitsBetween(forkPath, fromSha, toSha, {
          skip: totalCount > COMMIT_LIST_MAX ? totalCount - COMMIT_LIST_MAX : 0,
          limit: COMMIT_LIST_MAX,
        })
      : [];

  const notes = await readPrBodyNotes(forkPath, toSha, manifest.upstream.repo).catch(() => undefined);
  return buildSyncPrBody({ repoSlug: manifest.upstream.repo, version, fromSha, toSha, commits, totalCount, notes });
}

/** Migration notes for the PR body: the total at the sync point and the app's open ones, with permalinks. */
async function readPrBodyNotes(forkPath: string, toSha: string, repoSlug?: string): Promise<SyncPrBodyInput['notes']> {
  const githubUrl = repoSlug ? `https://github.com/${repoSlug}` : undefined;
  const [ids, pending] = await Promise.all([listNoteIds(forkPath, toSha), readPending(forkPath, toSha)]);
  const open = await Promise.all(
    pending.map(async (id) => ({
      id,
      title: (await readNote(forkPath, toSha, id))?.title ?? id,
      url: noteUrl(githubUrl, toSha, id),
    })),
  );
  return { total: ids.length, open };
}

/** Print the GitHub CLI command for opening the finished sync PR. */
function printPrCreateStep(branch: string, base: string, title = SYNC_PR_TITLE): void {
  console.info(pc.dim(`  gh pr create --base ${base} --head ${branch} --title "${title}" --fill`));
}

/** Print the "push + open a PR" steps for a sync branch whose merge is already committed. */
function printShipSteps(temporaryBranch: string, base: string, title?: string): void {
  console.info(pc.dim(`  git push -u origin ${temporaryBranch}`));
  printPrCreateStep(temporaryBranch, base, title);
}

/** Whether sync applied changes that need a finishing rerun. */
function hasStagedSyncChanges(result: MergeResult): boolean {
  return result.files.some((file) => SYNC_APPLIED_STATUSES.includes(file.status));
}

/** Extract the first URL from command output, usually the PR URL emitted by GitHub CLI. */
function extractFirstUrl(output: string): string | undefined {
  return output.match(/https?:\/\/\S+/)?.[0];
}

/**
 * Safety net run before a sync branch goes public: flatten away merge commits.
 *
 * The finishing rerun commits the sync as a single-parent commit (`commitSquash`), but a manual
 * `git commit` while the merge is staged records a two-parent merge commit instead. Upstream's
 * history isn't shared with `origin` (sync PRs are squash-merged), so such a commit makes the PR
 * list every upstream commit ever made, and that list grows with every upstream release.
 *
 * When the branch contains merge commits, rewrite it as one commit with identical content
 * (the PR diff is unchanged). Returns true if the branch was rewritten, so the caller can
 * force-push over the version already on the remote.
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

/** Indent every line of `text` by two spaces, for nesting captured `gh` output under a message. */
function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/**
 * Push the finished sync branch to `origin`, open a PR into the trunk, and switch back to the
 * trunk (or detach at it when another worktree has it checked out, see `returnToBase`). Runs when
 * `cella sync` is invoked on a sync branch whose merge is already committed:
 * shipping is always its own run, after the commit stage stopped for drift triage.
 *
 * Before pushing, any merge commits on the branch are flattened away (see `flattenSyncBranch`)
 * so the PR never lists the upstream branch's entire history.
 *
 * Every step degrades gracefully: a failed push (no `origin`, auth) prints the manual steps and
 * leaves you on the branch; a missing/failed `gh` (or an existing PR) prints the `gh` command but
 * still returns you to the trunk since the branch is already pushed.
 */
async function shipSyncBranch(config: RuntimeConfig, branch: string): Promise<void> {
  const { forkPath, settings } = config;
  const base = resolveReleaseBase(settings);
  // The PR targets `base`; its commits and body are read against the trunk the branch was cut from.
  const cutBase = await resolveCutBase(forkPath, base);

  const flattened = await flattenSyncBranch(forkPath, branch, cutBase);
  let prUrl: string | undefined;
  let prOpened = false;

  // The squash commit's subject is the versioned sync message; reused as the PR title so the
  // PR name carries the upstream version and commit id (release-please only needs the prefix).
  const headSubject = (await getCommitInfo(forkPath, 'HEAD').catch(() => null))?.message;
  const prTitle = headSubject?.startsWith(SYNC_PR_TITLE) ? headSubject : SYNC_PR_TITLE;

  console.info(pc.dim(`pushing '${branch}' to origin...`));
  try {
    await pushBranch(forkPath, 'origin', branch, { forceWithLease: flattened });
  } catch (error) {
    console.info(pc.yellow(`push failed (${errorMessage(error).split('\n')[0]}). finish manually:`));
    printShipSteps(branch, base, prTitle);
    return;
  }

  if (ghAvailable()) {
    console.info(pc.dim('opening a pull request...'));
    const prBody = await buildSyncPrBodyForBranch(forkPath, cutBase);
    const bodyArgs = prBody ? ['--body', prBody] : ['--fill'];
    const pr = spawnSync('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', prTitle, ...bodyArgs], {
      cwd: forkPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prUrl = extractFirstUrl(`${pr.stdout ?? ''}\n${pr.stderr ?? ''}`);
    prOpened = pr.status === 0;
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
  await printMigrationNotesLine(config);
}

/**
 * Reconcile dependencies and regenerate derived files before committing a resumed merge.
 *
 * A sync merge (plus package.json key-sync) changes `package.json`, which leaves the lockfile
 * and generated files (SDK, etc.) stale and often unstaged. Mirroring what lefthook would do,
 * but up front, we run `pnpm install` then `pnpm check`, so the merge commit is complete and
 * consistent. Returns false if a step fails (the merge is left in progress to retry).
 */
function finalizeWorkspace(forkPath: string): boolean {
  for (const args of [['install'], ['check']]) {
    console.info(pc.dim(`running pnpm ${args.join(' ')}...`));
    const result = spawnSync('pnpm', args, { cwd: forkPath, stdio: 'inherit' });
    if (result.status !== 0) return false;
  }
  return true;
}

/** Outcome of a sync cycle run on a fresh temporary branch. */
type SyncCycleOutcome =
  | { status: 'conflicts'; branch: TemporarySyncBranch }
  | { status: 'staged'; branch: TemporarySyncBranch }
  | { status: 'noop'; behind?: string };

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
 * and report the resulting state.
 *
 * - `conflicts`: merge staged with unresolved conflicts, left for IDE resolution.
 * - `staged`: clean merge staged, ready to commit.
 * - `noop`: upstream had nothing new, or (`behind`) only a point the last sync already went past;
 *   the throwaway branch was deleted and the original branch restored.
 *
 * A run that stops before the merge throws, after the throwaway branch is dropped the same way.
 */
async function runSyncCycle(config: RuntimeConfig): Promise<SyncCycleOutcome> {
  const { forkPath } = config;
  const branch = await setupTemporarySyncBranch(config);

  let result: MergeResult;
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

  if (result.conflicts.length > 0) return { status: 'conflicts', branch };

  // Nothing staged: already up to date. Return to where the run started and drop the throwaway
  // branch (a fresh cycle never starts on a sync branch: those resume or ship instead).
  if (!(await mergeInProgress(forkPath))) {
    await discardTemporarySyncBranch(forkPath, branch);
    return { status: 'noop' };
  }

  return { status: 'staged', branch };
}

/**
 * Commit an in-progress merge on the temporary sync branch, never shipping in the same run.
 *
 * Runs directly after a clean merge, or on a rerun once a conflicted merge is resolved and
 * staged. If conflicts remain we point them out and stop; once none remain we reconcile
 * dependencies (`pnpm install` + `pnpm check`), stage everything, and commit the staged delta
 * as a single squashed commit (see `commitSquash`). It then stops on the committed branch:
 * that is the window for drift triage (`cella analyze` diffs committed HEAD) and follow-up
 * commits. Shipping (push + PR) is always its own rerun (see `runSyncCommand`).
 */
async function commitSyncMerge(config: RuntimeConfig, branch: string): Promise<void> {
  const { forkPath } = config;
  const conflicts = await getConflictedFiles(forkPath);

  console.info();
  if (conflicts.length > 0) {
    console.info(pc.yellow(`${conflicts.length} file(s) still conflict on '${branch}':`));
    for (const file of conflicts) console.info(pc.dim(`  ${file}`));
    console.info(pc.dim('resolve and stage them, then re-run `pnpm cella sync` to finish (it commits for you).'));
    return;
  }

  // Stage everything up front (resolved conflicts + any manual edits) before running tooling that
  // may fail: `finalizeWorkspace` returns early on a failing `pnpm check`, so staging afterwards
  // would never happen and the edits would never be recorded in the merge.
  await stageAll(forkPath);

  // Reconcile deps + regenerate derived files (package.json key-sync and the merge both touch
  // package.json, leaving the lockfile and generated files stale/unstaged).
  if (!finalizeWorkspace(forkPath)) {
    console.info();
    console.info(
      pc.yellow('`pnpm install`/`pnpm check` failed. fix the issues, then re-run `pnpm cella sync` to finish.'),
    );
    return;
  }

  // Build the commit subject before squashing (commitSquash clears MERGE_HEAD), re-stage (the
  // install/check step may have touched files), then commit the staged delta as a single-parent
  // commit so the PR shows one clean commit, not the whole upstream history (the merge's
  // upstream ancestry isn't shared on the remote).
  const message = await buildSyncCommitMessage(forkPath, 'MERGE_HEAD');
  await stageAll(forkPath);
  await commitSquash(forkPath, message);
  console.info();
  console.info(pc.green(`committed the sync on '${branch}' as '${message}'.`));
  printTriageSteps(branch);
  await printMigrationNotesLine(config);
}

/** Guidance after the commit stage stops on the committed sync branch. */
function printTriageSteps(branch: string): void {
  console.info(pc.dim(`staying on '${branch}' without pushing.`));
  console.info(pc.dim('  run drift triage (`pnpm cella analyze`), commit any follow-ups, then:'));
  console.info(pc.dim('  pnpm cella sync   (pushes the branch and opens the PR)'));
}

/**
 * Merge the open sync PR(s) so the trunk carries the recorded sync point before a new cycle cuts
 * from it. The newest PR is a content superset of any older ones (each cycle re-syncs from the
 * same stale trunk base), so the newest is squash-merged and the rest are closed.
 *
 * A merge GitHub refuses (conflicts with the trunk, or failing required checks, the "breaking
 * changes" to fix first) stops the run: those must be resolved on the PR before syncing again.
 * On success the fresh cycle cuts from the merged trunk: `resolveCycleStart` fetches it and
 * fast-forwards the local trunk (or cuts from `origin`'s when another worktree has it checked out).
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
    if (merged.output) console.info(pc.dim(indentLines(merged.output)));
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
 * Before cutting a fresh sync branch, warn when an earlier sync PR is still open and unmerged.
 *
 * The last-sync point is recorded in the manifest committed *on the sync branch*, not on the
 * trunk. So a new cycle cut from a trunk that still lacks a merged sync PR re-includes that PR's
 * whole delta on top of the new upstream commits: the "why are there suddenly so many changes"
 * surprise. This offers to squash-merge the open PR first (so the new cycle cuts from an
 * up-to-date trunk), continue anyway, or cancel.
 *
 * Degrades to a silent no-op (`continue`) when it can't help: no `gh`, no open sync PR, or a
 * non-interactive session (no TTY to prompt on).
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
 * Run the standalone `cella sync` command.
 *
 * Idempotent. Each run advances the sync one stage and never commits and ships in the same run:
 * - Anywhere else: require a clean tree, cut a fresh temporary branch and merge upstream; a
 *   clean merge is committed right away (the run stops there, for drift triage), a conflicted
 *   one stops for IDE resolution. A run that stops before the merge (upstream needs a newer CLI,
 *   upstream changed its sync config, upstream is behind the last sync point) drops the branch
 *   again and leaves everything as it was.
 * - On a sync branch with a merge in progress: commit it (resume after conflicts), then stop.
 * - On a sync branch with the merge already committed: push and open the PR, then switch back
 *   to the trunk (detach at it when another worktree has it checked out). Shipping is
 *   deliberately its own run: the pause before it is where drift triage and follow-up commits
 *   happen.
 */
export async function runSyncCommand(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;
  const currentBranch = await getCurrentBranch(forkPath);
  const onSyncBranch = isTemporarySyncBranch(currentBranch);

  // Resume path: an earlier run left a merge staged on this temporary branch (e.g. after
  // conflicts). Re-running finishes that merge; it never starts over.
  if (onSyncBranch && (await mergeInProgress(forkPath))) {
    await commitSyncMerge(config, currentBranch);
    return;
  }

  // On a sync branch with the merge already committed: ship it (push + PR + back to trunk).
  if (onSyncBranch) {
    // shipSyncBranch only pushes HEAD, so any edits made after the squash commit would be silently
    // left out of the pushed branch/PR. Refuse to ship over a dirty tree and make them commit.
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

  // Fresh cycle: only ever cut the temporary branch from a clean tree.
  await assertClean(forkPath);

  // Guard against stacking: if an earlier sync PR is still open, its delta would re-appear in
  // this cycle's PR. Offer to merge it first (or bail) before cutting a new branch.
  if ((await guardAgainstOpenSyncPr(config)) === 'cancel') return;

  const outcome = await runSyncCycle(config);
  console.info();

  if (outcome.status === 'noop') {
    if (outcome.behind) {
      console.info(pc.green('nothing to sync: the last sync already went past this upstream point.'));
      for (const line of outcome.behind.split('\n')) console.info(pc.dim(`  ${line}`));
    } else {
      console.info(pc.green('already up to date with upstream, nothing to sync.'));
    }
    return;
  }

  const { temporaryBranch } = outcome.branch;
  if (outcome.status === 'conflicts') {
    console.info(`${warningMark} ${pc.yellow(`conflicts on '${temporaryBranch}'. Resolve and stage them, then:`)}`);
    console.info(pc.dim('  pnpm cella sync'));
    console.info(pc.dim('  rerun commits the sync and stops for drift triage; a further rerun ships (push + PR).'));
    console.info(pc.dim('  let the rerun commit: a manual `git commit` records a merge commit that bloats the PR.'));
    return;
  }

  // Clean merge: commit it in the same run (never shipping; that stays a separate rerun).
  await commitSyncMerge(config, temporaryBranch);
}

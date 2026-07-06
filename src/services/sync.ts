/**
 * Sync service for the cella CLI.
 *
 * Runs the merge engine directly in the fork (no worktree) so conflicts surface in the IDE, on
 * a fresh temporary branch cut from the trunk. The command is idempotent: if a run stops at
 * conflicts, resolve them and run `cella sync` again to finish the same merge.
 */

import { spawnSync } from 'node:child_process';
import type { MergeResult, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { buildTemporarySyncBranch, isTemporarySyncBranch, resolveReleaseBase } from '../utils/config';
import {
  createSpinner,
  printFlagWarnings,
  printSummary,
  printSyncComplete,
  spinnerFail,
  spinnerSuccess,
  spinnerText,
  warningMark,
  writeLogFile,
} from '../utils/display';
import {
  assertClean,
  type CommitRangeEntry,
  commitSquash,
  countCommitsBetween,
  createBranchFrom,
  deleteBranch,
  flattenBranch,
  getCommitInfo,
  getConflictedFiles,
  getCurrentBranch,
  getMergeBase,
  getShortSha,
  getUpstreamStatus,
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
} from '../utils/git';
import { readSyncManifest } from '../utils/manifest';
import { runMergeEngine } from './merge-engine';
import { runPackages } from './packages';

/** Context for the temporary branch a sync cycle runs on. */
interface TemporarySyncBranch {
  /** The freshly cut temporary branch, e.g. `cella/sync/20260702-1430`. */
  temporaryBranch: string;
  /** The trunk the branch was cut from and PRs land into (`releaseBase`, default `main`). */
  base: string;
  /** The branch the user was on before the cycle started (for cleanup on no-op). */
  startBranch: string;
}

/**
 * Make sure the trunk is current with its remote before a sync cycle cuts a branch from it.
 *
 * Fetches the trunk's upstream and reacts to how local compares:
 * - behind (fast-forwardable): fast-forward it so the branch is cut from the latest trunk.
 * - diverged (local commits the remote lacks *and* vice versa): abort with guidance, since
 *   syncing onto a stale/diverged trunk produces a PR against an out-of-date base and avoidable
 *   conflicts.
 * - ahead-only / up to date / no upstream (local-only repo): fine, just note it and continue.
 */
async function ensureBaseUpToDate(forkPath: string, base: string): Promise<void> {
  const { upstream, ahead, behind } = await getUpstreamStatus(forkPath);

  if (!upstream) {
    console.info(pc.dim(`'${base}' has no upstream — skipping the up-to-date check.`));
    return;
  }

  if (ahead > 0 && behind > 0) {
    throw new Error(
      `'${base}' has diverged from '${upstream}' (${ahead} ahead, ${behind} behind).\n` +
        `Reconcile '${base}' with '${upstream}' first (e.g. rebase or reset it), then re-run sync.`,
    );
  }

  if (behind > 0) {
    console.info(pc.dim(`fast-forwarding '${base}' to '${upstream}' (${behind} behind)...`));
    await pullFastForward(forkPath);
    return;
  }

  if (ahead > 0) {
    console.info(pc.dim(`'${base}' is ${ahead} commit(s) ahead of '${upstream}' (unpushed) — continuing.`));
  }
}

/**
 * Cut a fresh temporary sync branch from the trunk.
 *
 * Switches to `releaseBase`, fast-forwards it, then creates `cella/sync/<stamp>` so the
 * merge lands on an isolated throwaway branch rather than a long-lived integration branch.
 */
async function setupTemporarySyncBranch(config: RuntimeConfig): Promise<TemporarySyncBranch> {
  const { forkPath, settings } = config;
  const base = resolveReleaseBase(settings);
  const startBranch = await getCurrentBranch(forkPath);

  console.info(pc.dim(`switching to '${base}' and updating...`));
  await switchBranch(forkPath, base);
  await ensureBaseUpToDate(forkPath, base);

  const temporaryBranch = buildTemporarySyncBranch();

  console.info(pc.dim(`creating temporary sync branch '${temporaryBranch}' from '${base}'...`));
  console.info();
  await createBranchFrom(forkPath, temporaryBranch, base);

  return { temporaryBranch, base, startBranch };
}

/**
 * Run the merge engine against the current branch (the core merge step).
 *
 * Performs the merge directly in the fork and leaves it staged: conflicted files keep their
 * markers for IDE 3-way resolution, everything else is resolved per the override rules. Called
 * by `runSyncCycle` and by the forks service.
 */
export async function runSync(
  config: RuntimeConfig,
  options?: {
    stagedBranch?: string;
  },
): Promise<MergeResult> {
  createSpinner('starting sync...');

  const result = await runMergeEngine(config, {
    apply: true,
    onProgress: (message) => {
      spinnerText(message);
    },
    onStep: (label, detail) => {
      spinnerSuccess(label, detail);
      createSpinner('...');
    },
  });

  if (result.success) {
    spinnerSuccess();
  } else {
    spinnerFail('sync completed with conflicts');
  }

  // Print summary only (no file lists for sync)
  printSummary(result.summary, 'merge summary');

  // Write log file if requested
  if (config.logFile) {
    const logPath = writeLogFile(config.forkPath, result.files);
    console.info();
    console.info(pc.dim(`full file list written to: ${logPath}`));
  }

  const stagedBranch =
    options?.stagedBranch && result.conflicts.length === 0 && hasStagedSyncChanges(result)
      ? options.stagedBranch
      : undefined;
  printSyncComplete(result, { stagedBranch });

  printFlagWarnings({ hard: config.hard, unpinned: config.unpinned });

  return result;
}

/** Conventional PR title prefix required by release-please. */
const SYNC_PR_TITLE = 'chore: sync upstream cella';

/** Most recent upstream commits listed in a sync PR body (mirrors the engine's fetch display cap). */
const PR_BODY_COMMIT_MAX = 50;

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
export interface SyncPrBodyInput {
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
}

/** Render the sync PR body: where the sync moved to, plus the upstream commits it brought in. */
export function buildSyncPrBody(input: SyncPrBodyInput): string {
  const { repoSlug, version, fromSha, toSha, commits, totalCount } = input;
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

  return `${lines.join('\n')}\n`;
}

/**
 * Build the PR body for a finished sync branch: the upstream commits between the trunk's last
 * recorded sync point and the one this branch moves to (both read from committed manifests, so
 * this works on the rerun that ships the branch, long after the merge engine ran).
 *
 * Returns undefined when the branch has no committed manifest — the caller falls back to `--fill`.
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
          oldestFirst: true,
          skip: totalCount > PR_BODY_COMMIT_MAX ? totalCount - PR_BODY_COMMIT_MAX : 0,
          limit: PR_BODY_COMMIT_MAX,
        })
      : [];

  return buildSyncPrBody({ repoSlug: manifest.upstream.repo, version, fromSha, toSha, commits, totalCount });
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

/** Guidance shown after a fresh cycle stages a merge: re-run to finish and ship it. */
function printFinishSteps(): void {
  console.info(pc.dim('  pnpm cella sync'));
}

/** Whether sync applied changes that need a finishing rerun. */
function hasStagedSyncChanges(result: MergeResult): boolean {
  return result.files.some((file) => ['behind', 'diverged', 'renamed', 'ignored', 'pinned'].includes(file.status));
}

/** Whether the GitHub CLI is available on PATH. */
function ghAvailable(): boolean {
  return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
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
 * list every upstream commit ever made — and that list grows with every upstream release.
 *
 * When the branch contains merge commits, rewrite it as one commit with identical content
 * (the PR diff is unchanged). Returns true if the branch was rewritten, so the caller can
 * force-push over a previously pushed version.
 */
async function flattenSyncBranch(forkPath: string, branch: string, base: string): Promise<boolean> {
  const mergeCommits = await listBranchMergeCommits(forkPath, base);
  if (mergeCommits.length === 0) return false;

  // The most recent merge's second parent is the upstream tip that was merged in.
  const message = await buildSyncCommitMessage(forkPath, `${mergeCommits[0]}^2`);

  console.info(
    pc.yellow(
      `'${branch}' contains ${mergeCommits.length} merge commit(s) — the PR would list the entire upstream history.`,
    ),
  );
  console.info(pc.dim(`flattening '${branch}' to a single commit (same content)...`));
  await flattenBranch(forkPath, base, message);
  return true;
}

/**
 * Push the finished sync branch to `origin`, open a PR into the trunk, and switch back to the
 * trunk. Runs automatically once a rerun completes the merge cleanly.
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

  const flattened = await flattenSyncBranch(forkPath, branch, base);
  let prUrl: string | undefined;
  let prOpened = false;

  // The squash commit's subject is the versioned sync message — reuse it as the PR title so the
  // PR name carries the upstream version and commit id (release-please only needs the prefix).
  const headSubject = (await getCommitInfo(forkPath, 'HEAD').catch(() => null))?.message;
  const prTitle = headSubject?.startsWith(SYNC_PR_TITLE) ? headSubject : SYNC_PR_TITLE;

  console.info(pc.dim(`pushing '${branch}' to origin...`));
  try {
    await pushBranch(forkPath, 'origin', branch, { forceWithLease: flattened });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.info(pc.yellow(`push failed (${detail.split('\n')[0]}). finish manually:`));
    printShipSteps(branch, base, prTitle);
    return;
  }

  if (ghAvailable()) {
    console.info(pc.dim('opening a pull request...'));
    const prBody = await buildSyncPrBodyForBranch(forkPath, base);
    const bodyArgs = prBody ? ['--body', prBody] : ['--fill'];
    const pr = spawnSync('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', prTitle, ...bodyArgs], {
      cwd: forkPath,
      encoding: 'utf-8',
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
    console.info(pc.yellow('`gh` not found — open the PR manually:'));
    printPrCreateStep(branch, base, prTitle);
  }

  console.info(pc.dim(`switching back to '${base}'...`));
  await switchBranch(forkPath, base);
  await pullFastForward(forkPath).catch(() => {});

  console.info();
  if (prUrl) {
    console.info(`${pc.green('✓')} Sync pull request ${prOpened ? 'opened' : 'ready'}`);
    console.info(pc.dim(`  ${prUrl} · branch pushed, back on '${base}'`));
  } else {
    console.info(`${pc.green('✓')} Sync branch pushed`);
    console.info(pc.dim(`  '${branch}' is on origin, back on '${base}'`));
  }
}

/**
 * Reconcile dependencies and regenerate derived files before committing a resumed merge.
 *
 * A sync merge (plus package.json key-sync) changes `package.json`, which leaves the lockfile
 * and generated files (SDK, etc.) stale and often unstaged. Mirroring what lefthook would do —
 * but up front — we run `pnpm install` then `pnpm check`, so the merge commit is complete and
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
  | { status: 'noop' };

/**
 * Run one sync cycle on a fresh temporary branch: cut the branch, merge upstream (+ packages),
 * and report the resulting state.
 *
 * - `conflicts`: merge staged with unresolved conflicts, left for IDE resolution.
 * - `staged`: clean merge staged, ready to commit.
 * - `noop`: upstream had nothing new; the throwaway branch was deleted and the original branch
 *   restored.
 */
async function runSyncCycle(config: RuntimeConfig): Promise<SyncCycleOutcome> {
  const { forkPath } = config;
  const branch = await setupTemporarySyncBranch(config);

  const result = await runSync(config, { stagedBranch: branch.temporaryBranch });

  if (config.settings.syncWithPackages !== false) {
    // Run package sync even when the merge left conflicts: package.json files that are
    // themselves conflicted are skipped and reported; all others are still synced.
    await runPackages(config, { conflictedFiles: result.conflicts });
  }

  if (result.conflicts.length > 0) return { status: 'conflicts', branch };

  // Nothing staged: already up to date. Clean up the throwaway branch.
  if (!mergeInProgress(forkPath)) {
    await switchBranch(forkPath, branch.startBranch === branch.temporaryBranch ? branch.base : branch.startBranch);
    await deleteBranch(forkPath, branch.temporaryBranch);
    return { status: 'noop' };
  }

  return { status: 'staged', branch };
}

/**
 * Finish an in-progress merge left by an earlier `cella sync` run on the same temporary branch.
 *
 * This is what makes the command idempotent: after a run stops at conflicts, resolve and stage
 * them, then run `cella sync` again. If conflicts remain we point them out and stop; once none
 * remain we reconcile dependencies (`pnpm install` + `pnpm check`), stage everything, commit the
 * staged delta as a single squashed commit (see `commitSquash`), then push the branch and open
 * the PR (see `shipSyncBranch`).
 */
async function resumeSyncMerge(config: RuntimeConfig, branch: string): Promise<void> {
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
  // commit so the PR shows one clean commit instead of the whole upstream history (the merge's
  // upstream ancestry isn't shared on the remote).
  const message = await buildSyncCommitMessage(forkPath, 'MERGE_HEAD');
  await stageAll(forkPath);
  await commitSquash(forkPath, message);
  console.info();
  console.info(pc.green(`committed the sync on '${branch}' as '${message}'.`));
  await shipSyncBranch(config, branch);
}

/**
 * Run the standalone `cella sync` command.
 *
 * Idempotent. Behaviour depends on where you are:
 * - On a sync branch with a merge in progress: finish that merge (resume after conflicts), then
 *   push and open the PR.
 * - On a sync branch with the merge already committed: push and open the PR (e.g. a previous
 *   push failed), then switch back to the trunk.
 * - Anywhere else: require a clean tree, then cut a fresh temporary branch and merge upstream.
 */
export async function runSyncCommand(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;
  const currentBranch = await getCurrentBranch(forkPath);
  const onSyncBranch = isTemporarySyncBranch(currentBranch);

  // Resume path: an earlier run left a merge staged on this temporary branch (e.g. after
  // conflicts). Re-running finishes it instead of starting over.
  if (onSyncBranch && mergeInProgress(forkPath)) {
    await resumeSyncMerge(config, currentBranch);
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
  const outcome = await runSyncCycle(config);
  console.info();

  if (outcome.status === 'noop') {
    console.info(pc.green('already up to date with upstream — nothing to sync.'));
    return;
  }

  const { temporaryBranch } = outcome.branch;
  if (outcome.status === 'conflicts') {
    console.info(`${warningMark} ${pc.yellow(`conflicts on '${temporaryBranch}'. Resolve and stage them, then:`)}`);
    printFinishSteps();
    console.info(pc.dim('  rerun commits the sync, pushes the branch, and opens a PR.'));
    console.info(pc.dim('  let the rerun commit — a manual `git commit` records a merge commit that bloats the PR.'));
  }
}

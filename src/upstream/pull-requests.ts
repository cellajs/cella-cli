import { spawnSync } from 'node:child_process';
import { select } from '@inquirer/prompts';
import semver from 'semver';
import { resolveTrunk, upgradeBranchPrefix } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { checkMark, hyperlink, type NextStep, printNextSteps, warningMark } from '../utils/display';
import { errorMessage } from '../utils/errors';
import {
  type CommitRangeEntry,
  countCommitsBetween,
  deleteBranch,
  flattenBranch,
  getMergeBase,
  getShortSha,
  git,
  gitHubRepo,
  isClean,
  listBranchMergeCommits,
  listCommitsBetween,
  pushBranch,
  readRemoteUrl,
} from '../utils/git';
import { printable } from '../utils/terminal-text';
import { alignmentUrl, listAlignmentIds, readAlignment, readPending } from './alignments';
import { upgradeAlignmentsStep } from './report';
import { listRunChanges, printRunChanges } from './review-page';
import { resolveTrunkRef, returnToTrunk } from './upgrade-branch';
import { readManifest, readManifestAtRef, readUpgradePointAtRef } from './upgrade-point';

/** An open pull request, as returned by `gh pr list --json`. */
export interface GhPullRequest {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  isCrossRepository: boolean;
  author: { login: string };
}

/** Result of a `gh` invocation: whether it exited 0, its stdout, and why it failed. */
interface GhResult {
  ok: boolean;
  output: string;
  /** gh's stderr when the call failed, empty when it succeeded. */
  error: string;
}

/** Whether the GitHub CLI is available on PATH. */
function ghAvailable(): boolean {
  return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * Run `gh` in `cwd`, capturing stdout and stderr apart. Never throws: a missing `gh` or a failed
 * call degrades the upgrade to printing the PR steps.
 */
function runGh(cwd: string, args: string[]): GhResult {
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = result.status === 0;
  const error = ok ? '' : (result.stderr || result.error?.message || '').trim();
  return { ok, output: (result.stdout ?? '').trim(), error };
}

/**
 * Keep the upgrade PRs (head branch under `prefix`, e.g. `cella/upgrade/`), newest first (highest PR number).
 * Only pull requests from this repository's own branches count: one from another repository never does,
 * whatever its branch is named.
 */
export function ownUpgradePrs(prs: GhPullRequest[], prefix: string): GhPullRequest[] {
  return prs.filter((pr) => !pr.isCrossRepository && pr.headRefName.startsWith(`${prefix}/`)).sort((a, b) => b.number - a.number);
}

/**
 * List the open upgrade PRs that `ownUpgradePrs` keeps. Returns an empty array when `gh` fails
 * (no auth, no origin) so callers degrade to a no-op.
 */
function listOpenUpgradePrs(cwd: string, prefix: string): GhPullRequest[] {
  const { ok, output } = runGh(cwd, [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,headRefName,url,isCrossRepository,author',
    '--limit',
    '50',
  ]);
  if (!ok || !output) return [];

  let parsed: GhPullRequest[];
  try {
    parsed = JSON.parse(output) as GhPullRequest[];
  } catch {
    return [];
  }

  return ownUpgradePrs(parsed, prefix);
}

/**
 * Open a PR through the GitHub REST API. `gh pr create` goes through GraphQL, which a Claude
 * cloud session's GitHub proxy refuses. `repoSlug` is `owner/repo`; without it `gh` resolves
 * `{owner}/{repo}` from the current repository. When the create fails, `url` is the open PR for
 * the same head branch, if there is one (a PR that already exists gets a 422).
 */
function createPr(
  cwd: string,
  repoSlug: string | null,
  pr: { base: string; head: string; title: string; body: string },
): GhResult & { url?: string } {
  const repo = repoSlug ?? '{owner}/{repo}';
  const fields = ['title', 'head', 'base', 'body'] as const;
  const created = runGh(cwd, [
    'api',
    `repos/${repo}/pulls`,
    '-X',
    'POST',
    ...fields.flatMap((field) => ['-f', `${field}=${pr[field]}`]),
    '--jq',
    '.html_url',
  ]);
  if (created.ok) return { ...created, url: created.output || undefined };

  const owner = repoSlug ? repoSlug.split('/')[0] : '{owner}';
  const existing = runGh(cwd, ['api', `repos/${repo}/pulls?state=open&head=${owner}:${pr.head}`, '--jq', '.[0].html_url // empty']);
  return { ...created, url: existing.ok && existing.output ? existing.output : undefined };
}

/** Squash-merge a PR (by number, branch, or URL) now; fails when the PR is not mergeable. */
function mergePrSquash(cwd: string, ref: string | number, options: { deleteBranch?: boolean } = {}): GhResult {
  return runGh(cwd, ['pr', 'merge', String(ref), '--squash', ...(options.deleteBranch ? ['--delete-branch'] : [])]);
}

/** Close a PR without merging (used to discard superseded upgrade PRs). */
function closePr(cwd: string, ref: string | number): GhResult {
  return runGh(cwd, ['pr', 'close', String(ref)]);
}

/** Conventional PR title prefix required by release-please. */
const upgradePrTitle = 'chore: upgrade cella';

/** Most recent upstream commits listed in the upgrade PR body */
const commitListMax = 50;

/** The `version` field of the root `package.json` committed at a ref; null when absent or unparsable. */
export async function readPackageVersionAtRef(cwd: string, ref: string): Promise<string | null> {
  const raw = await git(['show', `${ref}:package.json`], cwd, { ignoreErrors: true });
  if (!raw) return null;

  try {
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : null;
  } catch {
    return null;
  }
}

/**
 * Build the upgrade commit subject, e.g. `chore: upgrade cella to v0.2.2 (4f7d87c)`.
 *
 * The upstream version comes from the manifest's release tag when tracking releases, else from
 * upstream's root package.json at the merged commit. Falls back to the bare title (+ short sha)
 * when a lookup fails, so committing never blocks on cosmetics.
 */
export async function buildUpgradeCommitMessage(repoRoot: string, upstreamRef: string): Promise<string> {
  const shortSha = await getShortSha(repoRoot, upstreamRef).catch(() => '');
  if (!shortSha) return upgradePrTitle;

  const manifest = await readManifest(repoRoot);
  const version = semver.valid(manifest?.upstream.release ?? (await readPackageVersionAtRef(repoRoot, upstreamRef).catch(() => null)));
  return version ? `${upgradePrTitle} to v${version} (${shortSha})` : `${upgradePrTitle} to ${shortSha}`;
}

/**
 * Qualify bare `#123` references in an upstream commit subject with the upstream repo slug. A
 * reader of the app's PR would take a bare one for the app's own issue or PR.
 */
function qualifyPrRefs(subject: string, repoSlug?: string): string {
  if (!repoSlug) return subject;
  return subject.replace(/(^|[^\w/])#(\d+)\b/g, `$1${repoSlug}#$2`);
}

/** `text` as one Markdown code span: mentions, closing keywords and HTML in an upstream subject stay text. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const [fence, pad] = ['`'.repeat(longest + 1), longest > 0 ? ' ' : ''];
  return `${fence}${pad}${text}${pad}${fence}`;
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
  const githubUrl = repoSlug ? gitHubRepo(repoSlug)?.url : undefined;
  const short = (sha: string) => sha.slice(0, 7);
  const commitRef = (sha: string) => (githubUrl ? `[\`${short(sha)}\`](${githubUrl}/commit/${sha})` : `\`${short(sha)}\``);

  const upstreamName = githubUrl ? `[${repoSlug}](${githubUrl})` : 'cella';
  const validVersion = semver.valid(version);
  const versionSuffix = validVersion ? ` (v${validVersion})` : '';
  const lines = [`Upgrades ${upstreamName} to ${commitRef(toSha)}${versionSuffix}.`];

  if (totalCount > 0 && fromSha) {
    const compare = githubUrl ? ` ([compare](${githubUrl}/compare/${short(fromSha)}...${short(toSha)}))` : '';
    lines.push('', `**${totalCount} upstream commit${totalCount === 1 ? '' : 's'} since the last upgrade**${compare}:`, '');
    if (totalCount > commits.length) lines.push(`- …${totalCount - commits.length} earlier commit(s) not shown`);
    for (const commit of commits) {
      lines.push(`- ${commitRef(commit.hash)} ${codeSpan(qualifyPrRefs(commit.message, repoSlug))}`);
    }
  }

  if (alignments && alignments.total > 0) {
    const { total, open } = alignments;
    if (open.length === 0) lines.push('', `**Alignments**: all ${total} handled.`);
    else {
      lines.push('', `**Alignments**: ${Math.max(0, total - open.length)} of ${total} handled, open (\`pnpm cella align\`):`, '');
      for (const alignment of open)
        lines.push(`- ${alignment.url ? `[${codeSpan(alignment.title)}](${alignment.url})` : codeSpan(alignment.title)} (\`${alignment.id}\`)`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Build the PR body for a finished upgrade branch: the upstream commits between the trunk's last
 * recorded upgrade point and the one this branch moves to, both read from committed manifests.
 * `refs/cella/last-upgrade` is no help here: the merge already moved it to the new point. Undefined
 * when the branch has no committed manifest (the caller falls back to `--fill`).
 */
async function buildUpgradePrBodyForBranch(repoRoot: string, trunk: string): Promise<string | undefined> {
  const manifest = await readManifestAtRef(repoRoot, 'HEAD');
  if (!manifest) return undefined;

  const toSha = manifest.upstream.commit.toLowerCase();
  const fromSha = await readUpgradePointAtRef(repoRoot, trunk);
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
async function readPrBodyAlignments(repoRoot: string, toSha: string, repoSlug?: string): Promise<UpgradePrBodyInput['alignments']> {
  const githubUrl = repoSlug ? gitHubRepo(repoSlug)?.url : undefined;
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

  console.info(pc.yellow(`'${branch}' contains ${mergeCommits.length} merge commit(s): the PR would list the entire upstream history.`));
  console.info(pc.dim(`flattening '${branch}' to a single commit (same content)...`));
  await flattenBranch(repoRoot, trunk, message);
  return true;
}

/**
 * Push the finished upgrade branch to `origin`, open a PR into the trunk, and switch back to the
 * trunk (see `returnToTrunk`). Edits not committed would be left out of the pushed branch, so a
 * dirty tree stops the run. A failed push prints the manual steps and leaves you on the branch,
 * and returns 1; a missing or failed `gh` prints the `gh` command but still returns you to the trunk.
 */
export async function shipUpgradeBranch(config: RuntimeConfig, branch: string): Promise<number> {
  const { repoRoot } = config;
  if (!(await isClean(repoRoot))) {
    console.info();
    console.info(pc.yellow(`upgrade branch '${branch}' has uncommitted changes.`));
    console.info(pc.yellow('commit them first (`git commit --amend --no-edit` or a new commit).'));
    return 1;
  }

  const trunk = resolveTrunk(config);
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

  const cutPoint = await getMergeBase(repoRoot, trunkRef, 'HEAD');
  printRunChanges(`'${branch}' changes what CI runs, with this repository's secrets:`, await listRunChanges(repoRoot, cutPoint, 'HEAD'));
  console.info(pc.dim(`pushing '${branch}' to origin...`));
  try {
    await pushBranch(repoRoot, 'origin', branch, { forceWithLease: flattened });
  } catch (error) {
    console.info(pc.yellow(`push failed (${errorMessage(error).split('\n')[0]}). finish manually:`));
    console.info(pc.dim(`  git push -u origin ${branch}`));
    printPrCreateStep(branch, trunk, prTitle);
    return 1;
  }

  if (ghAvailable()) {
    console.info(pc.dim('opening a pull request...'));
    const prBody = (await buildUpgradePrBodyForBranch(repoRoot, trunkRef)) ?? '';
    const repoSlug = gitHubRepo(await readRemoteUrl(repoRoot, 'origin'))?.slug ?? null;
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
  return 0;
}

/**
 * Merge the open upgrade PR(s) so the trunk carries the recorded upgrade point before a new cycle cuts
 * from it. The newest PR is a content superset of any older ones (each cycle upgrades again from the
 * same stale trunk), so the newest is squash-merged and the rest are closed. A merge GitHub
 * refuses (conflicts, failing required checks) stops the run.
 */
async function mergeOpenUpgradePrs(config: RuntimeConfig, open: GhPullRequest[]): Promise<'continue' | 'refused'> {
  const { repoRoot } = config;
  const trunk = resolveTrunk(config);
  const [newest, ...superseded] = open;

  console.info();
  console.info(pc.dim(`squash-merging #${newest.number} into '${trunk}'...`));
  const merged = mergePrSquash(repoRoot, newest.number, { deleteBranch: true });
  if (!merged.ok) {
    console.info();
    console.info(pc.yellow(`could not merge #${newest.number}: resolve it first, then re-run \`pnpm cella upgrade\`:`));
    if (merged.error) console.info(pc.dim(merged.error.replace(/^/gm, '  ')));
    console.info(pc.dim(`  ${newest.url}`));
    return 'refused';
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
export async function guardAgainstOpenUpgradePr(config: RuntimeConfig): Promise<'continue' | 'cancel' | 'refused'> {
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
    console.info(pc.dim(`  #${pr.number}  ${printable(pr.title)}  by ${printable(pr.author.login)}`));
    console.info(pc.dim(`         ${pr.url}`));
  }
  console.info(pc.dim(`  starting a new upgrade now produces a PR that re-includes ${many ? 'these' : 'those'} changes.`));
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

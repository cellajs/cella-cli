import { resolve } from 'node:path';
import { defaultUpstreamRemote, resolveUpstream } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import {
  checkMark,
  hyperlink,
  type NextStep,
  plural,
  printProgressStep,
  printSectionHeader,
  stepIndent,
  warningMark,
} from '../utils/display';
import {
  type CommitRangeEntry,
  getCurrentBranch,
  getShortSha,
  getTrackingStatus,
  getWorkingTreeChangeCount,
  listCommitsBetween,
  splitPrNumber,
} from '../utils/git';
import { fitText, padVisible, shortAge, terminalColumns } from '../utils/layout';
import { isGeneratedFile } from '../utils/repo-files';
import { alignmentsStep, readOpenAlignments } from './align';
import { changedFromUpstream } from './classify';
import { compareUpstreamOverrides } from './config-gate';
import { configFile, isManagedFile } from './managed-files';
import type { AnalysisSummary, AnalyzedFile, FileStatus, MergeResult, UpstreamContext } from './model';
import { groupIgnoredUpstreamChanges } from './protection';

/** Options for generating links in CLI output */
export interface LinkOptions {
  /** Base GitHub URL for upstream (e.g., 'https://github.com/cellajs/cella') */
  upstreamGitHubUrl?: string;
  /** Upstream commit the run analyzed: file links show the file as it is there */
  upstreamSha?: string;
  /** Base GitHub URL of the app's `origin`, for links to the app's own commits */
  appGitHubUrl?: string;
  /** File link mode: 'commit' links to commit, 'file' links to file in repo */
  fileLinkMode?: 'commit' | 'file';
  /** Repository path for resolving file paths */
  repoRoot?: string;
}

/** Most recent upstream commits listed under the `upstream` step */
const commitStepMax = 10;

/** A commit subject colored by kind: releases dim, breaking changes (`feat!:`) with a yellow type. */
function styleSubject(subject: string): string {
  if (/^chore(\([^)]*\))?: release\b/.test(subject)) return pc.dim(subject);
  const breaking = /^([a-z]+(\([^)]*\))?!:)/.exec(subject);
  return breaking ? `${pc.yellow(breaking[1])}${subject.slice(breaking[1].length)}` : subject;
}

/**
 * The `checkout` step: branch and commit, whether the tree is clean, and how the branch stands to
 * its remote when it is ahead or behind.
 */
export function formatCheckoutStep(checkout: {
  branch: string;
  headSha: string;
  changeCount: number;
  tracking: { tracking: string | null; ahead: number; behind: number };
}): string {
  const { branch, headSha, changeCount, tracking } = checkout;
  const parts = [
    changeCount === 0 ? 'clean' : `${plural(changeCount, 'uncommitted change')}, not included in the analysis`,
  ];
  if (tracking.tracking && (tracking.ahead > 0 || tracking.behind > 0)) {
    parts.push(`${tracking.ahead} ahead, ${tracking.behind} behind ${tracking.tracking}`);
  }
  return `${branch} @ ${headSha}${pc.dim(` · ${parts.join(' · ')}`)}`;
}

/**
 * The `upstream` step: the branch or release upgraded to and how many commits it brings since the
 * last upgrade, then those commits (see {@link formatUpstreamCommits}).
 */
export function formatUpstreamStep(upstream: {
  label: string;
  sha: string;
  baseSha: string;
  pinned: boolean;
  commitCount: number;
  commits: CommitRangeEntry[];
  githubUrl?: string;
}): string {
  const { label, sha, baseSha, pinned, commitCount, commits, githubUrl } = upstream;
  const since =
    commitCount === 0
      ? 'no new commits since the last upgrade'
      : `${plural(commitCount, 'new commit')} since the last upgrade at ${baseSha}`;
  return [
    `${label} @ ${sha}${pc.dim(`${pinned ? ' · --ref' : ''} · ${since}`)}`,
    ...formatUpstreamCommits(commitCount, commits, githubUrl),
  ].join('\n');
}

/**
 * The upstream commits under the `upstream` step: newest first, one line each with the short hash,
 * the subject cut to the terminal width, the PR number and the age; hash and PR link to GitHub.
 * `commits` comes oldest first, as `listCommitsBetween` returns it.
 */
export function formatUpstreamCommits(
  commitCount: number,
  commits: CommitRangeEntry[],
  upstreamGitHubUrl?: string,
): string[] {
  const shown = commits.slice(-commitStepMax).reverse();
  const rows = shown.map((commit) => ({ commit, ...splitPrNumber(commit.message) }));
  const prWidth = Math.max(0, ...rows.map((row) => (row.pr ? `#${row.pr}`.length : 0)));
  const ages = rows.map((row) => (row.commit.timestamp ? shortAge(row.commit.timestamp) : ''));
  const ageWidth = Math.max(0, ...ages.map((age) => age.length));
  const subjectWidth = Math.max(
    20,
    terminalColumns() - stepIndent - 7 - 2 - (prWidth ? prWidth + 2 : 0) - (ageWidth ? ageWidth + 2 : 0),
  );

  const lines = rows.map((row, index) => {
    const hash = hyperlink(
      row.commit.hash.slice(0, 7),
      upstreamGitHubUrl && `${upstreamGitHubUrl}/commit/${row.commit.hash}`,
    );
    const subject = fitText(row.subject, subjectWidth);
    let line = `${pc.dim(hash)}  ${padVisible(styleSubject(subject), subjectWidth)}`;
    if (prWidth) {
      const pr = row.pr ? hyperlink(`#${row.pr}`, upstreamGitHubUrl && `${upstreamGitHubUrl}/pull/${row.pr}`) : '';
      line += `  ${pc.dim(padVisible(pr, prWidth))}`;
    }
    if (ageWidth) line += `  ${pc.dim(ages[index].padStart(ageWidth))}`;
    return line.trimEnd();
  });
  if (commitCount > shown.length) lines.push(pc.dim(`+ ${commitCount - shown.length} earlier`));
  return lines;
}

/** Print the `checkout` step: see {@link formatCheckoutStep}. */
export async function printCheckoutStep(repoRoot: string): Promise<void> {
  const [branch, headSha, changeCount, tracking] = await Promise.all([
    getCurrentBranch(repoRoot),
    getShortSha(repoRoot, 'HEAD'),
    getWorkingTreeChangeCount(repoRoot),
    getTrackingStatus(repoRoot),
  ]);
  printProgressStep('checkout', formatCheckoutStep({ branch, headSha, changeCount, tracking }));
}

/** Print the `upstream` step: see {@link formatUpstreamStep}. */
export async function printUpstreamStep(config: RuntimeConfig, upstream: UpstreamContext): Promise<void> {
  const { repoRoot } = config;
  const [sha, baseSha, commits] = await Promise.all([
    getShortSha(repoRoot, upstream.commit.hash),
    getShortSha(repoRoot, upstream.mergeBase),
    upstream.commitCount > 0 ? listCommitsBetween(repoRoot, upstream.mergeBase, upstream.ref, commitStepMax) : [],
  ]);
  printProgressStep(
    'upstream',
    formatUpstreamStep({
      label: upstream.releaseTag ?? resolveUpstream(config).branchRef.replace(`${defaultUpstreamRemote}/`, ''),
      sha,
      baseSha,
      pinned: !!config.ref,
      commitCount: upstream.commitCount,
      commits,
      githubUrl: upstream.gitHub?.url,
    }),
  );
}

/**
 * The result fields that come from upstream alone, shared by analyze and upgrade: links and counts,
 * and the upstream changes the app never receives (the upstream config's `pinned`, `ignored` and
 * `packageJsonKeys` entries the app config does not follow, ignored files only upstream changed, and
 * the range the review page diffs upstream's changes over). Read from refs, so the merge state is
 * irrelevant; a failure leaves the reports out and never fails the run.
 */
export async function readUpstreamReports(
  config: RuntimeConfig,
  upstream: UpstreamContext,
  files: AnalyzedFile[],
): Promise<
  Pick<
    MergeResult,
    | 'upstreamGitHubUrl'
    | 'upstreamCommit'
    | 'upstreamCommitCount'
    | 'upstreamDiffRange'
    | 'upstreamOverrides'
    | 'ignoredUpstreamChanges'
  >
> {
  const { repoRoot } = config;
  const meta = {
    upstreamGitHubUrl: upstream.gitHub?.url,
    upstreamCommit: upstream.commit,
    upstreamCommitCount: upstream.commitCount,
  };
  try {
    const [baseSha, upstreamSha, upstreamOverrides] = await Promise.all([
      getShortSha(repoRoot, upstream.mergeBase),
      // the commit, not an annotated release tag object
      getShortSha(repoRoot, upstream.commit.hash),
      compareUpstreamOverrides(repoRoot, upstream.mergeBase, upstream.ref, config),
    ]);
    return {
      ...meta,
      upstreamDiffRange: `${baseSha}..${upstreamSha}`,
      upstreamOverrides,
      ignoredUpstreamChanges: groupIgnoredUpstreamChanges(files, config.ignored ?? []),
    };
  } catch {
    return meta;
  }
}

/**
 * The `align` step after an upgrade run: from the merge result when this run merged, otherwise from
 * the app's upgrade point and pending list.
 */
export async function upgradeAlignmentsStep(config: RuntimeConfig, run?: MergeResult): Promise<NextStep | undefined> {
  if (run?.alignments && run.upstreamCommit) {
    const { open, arrived } = run.alignments;
    return alignmentsStep(config, { ref: run.upstreamCommit.hash, open, arrived });
  }
  const view = await readOpenAlignments(config);
  return view ? alignmentsStep(config, view) : undefined;
}

export function formatMergeInProgressDetail(
  conflictCount: number,
  autoMergedFiles: string[],
  linkOptions: LinkOptions,
  maxFiles = 100,
): string {
  const lines = [`${plural(conflictCount, 'conflict')} to resolve in your editor`];

  if (autoMergedFiles.length === 0) {
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`  auto-merged files (${autoMergedFiles.length}):`);

  // Each file opens in VS Code from the app workspace when the app path is known
  const { repoRoot } = linkOptions;
  const shown = autoMergedFiles.slice(0, maxFiles);
  for (const filePath of shown) {
    lines.push(`  - ${repoRoot ? hyperlink(filePath, `vscode://file${resolve(repoRoot, filePath)}`) : filePath}`);
  }

  if (autoMergedFiles.length > shown.length) {
    lines.push(`  ... + ${autoMergedFiles.length - shown.length} more`);
  }

  return lines.join('\n');
}

/** Display configuration for a file status */
interface StatusConfig {
  icon: string;
  label: string;
  color: (text: string) => string;
  description?: string;
}

type SummaryStatus = FileStatus | 'managed';

/** Unified status display config: icon, label, color, and description for each status. */
const statusConfig: Record<FileStatus, StatusConfig> = {
  behind: { icon: pc.cyan('↓'), label: 'behind', color: pc.cyan, description: 'upstream changed, will update' },
  diverged: { icon: pc.magenta('⇅'), label: 'diverged', color: pc.magenta, description: 'both changed, will merge' },
  drifted: { icon: pc.yellow('!'), label: 'drifted', color: pc.yellow, description: 'app changed (at risk)' },
  ahead: { icon: pc.blue('↑'), label: 'ahead', color: pc.blue, description: 'app changed (protected)' },
  local: { icon: pc.green('+'), label: 'local', color: pc.green, description: 'local file in cella folders' },
  pinned: { icon: pc.green('⨀'), label: 'pinned', color: pc.green, description: 'both changed, app wins' },
  ignored: { icon: pc.gray('⨂'), label: 'ignored', color: pc.gray },
  identical: { icon: pc.gray('✓'), label: 'identical', color: pc.gray, description: 'no changes' },
  deleted: { icon: pc.red('✗'), label: 'deleted', color: pc.red },
  renamed: { icon: pc.blue('→'), label: 'renamed', color: pc.blue },
};

const summaryStatusConfig: Record<SummaryStatus, StatusConfig> = {
  ...statusConfig,
  managed: {
    icon: pc.cyan('◇'),
    label: 'managed',
    color: pc.cyan,
    description: 'package.jsons & cella/cella.config.ts handled separately',
  },
  ignored: { ...statusConfig.ignored, description: 'protected by ignored config' },
};

/** The grouped count of every status, under its own section header. */
export function printSummary(summary: AnalysisSummary, title = 'summary'): void {
  printSectionHeader(pc.cyan(title));

  const maxCount = Math.max(...Object.values(summary));
  const countWidth = String(maxCount).length + 1;

  // Grouped layout with blank lines between groups
  const groups: SummaryStatus[][] = [
    ['managed', 'ignored'],
    ['identical'],
    ['ahead', 'local', 'drifted'],
    ['diverged', 'pinned'],
    ['behind'],
  ];
  for (const group of groups) {
    if (group !== groups[0]) console.info();
    for (const status of group) {
      const { icon, label, color, description } = summaryStatusConfig[status];
      const countStr = color(String(summary[status]).padStart(countWidth));
      console.info(`  ${icon} ${countStr}  ${label.padEnd(15)}${description ? pc.dim(description) : ''}`);
    }
  }
}

/** Files with `status`, managed files left out: the list each analyze file group prints. */
export function filesWithStatus(files: AnalyzedFile[], status: FileStatus): AnalyzedFile[] {
  return files.filter((f) => f.status === status && !isManagedFile(f.path));
}

/**
 * Protected (pinned/ignored) files that upstream also changed since the last upgrade. The app
 * side wins whole-file on these, so upstream's hunks are dropped: the regression class where
 * a pinned stylesheet misses new upstream utilities that merged components rely on.
 */
function findProtectedBehind(files: AnalyzedFile[]): AnalyzedFile[] {
  // Generated output is rebuilt from the app's own sources, so upstream's copy has nothing to adopt.
  return files.filter((file) => file.upstreamChanged && !isManagedFile(file.path) && !isGeneratedFile(file.path));
}

/**
 * Every protected file upstream changed since the last upgrade that the upgrade leaves as the app has
 * it: those both sides changed ({@link findProtectedBehind}) and the ignored files only upstream
 * changed, added or deleted (`MergeResult.ignoredUpstreamChanges`). Analyze lists them as one
 * section, on the terminal and on the review page.
 */
export function findProtectedBehindUpstream(
  result: Pick<MergeResult, 'files' | 'ignoredUpstreamChanges'>,
): AnalyzedFile[] {
  const ignoredOnly = new Set((result.ignoredUpstreamChanges ?? []).flatMap((group) => group.paths));
  return [...findProtectedBehind(result.files), ...result.files.filter((file) => ignoredOnly.has(file.path))];
}

/** Hint under the protected files an upgrade kept the app version of. */
const protectedBehindHint =
  'pinned/ignored files where upstream also changed since the last upgrade; the app side wins on conflict, ' +
  'so review what upstream changed and adopt what you need.';

/** Icon by protection kind (⨂ ignored, ⨀ pinned) for protected-but-behind lines. */
export function protectionIcon(file: AnalyzedFile): string {
  return file.isIgnored ? statusConfig.ignored.icon : statusConfig.pinned.icon;
}

/** Per-file detail: how many lines upstream changed (dropped by the app-wins resolution). */
function formatUpstreamChangedLines(file: AnalyzedFile): string {
  if (file.upstreamChangedLines === undefined) return '';
  return pc.yellow(` · ${plural(file.upstreamChangedLines, 'line')} changed upstream`);
}

export function printUpgradeComplete(result: MergeResult): void {
  const updated = changedFromUpstream(result.files);
  const merges = updated.filter((file) => file.resolution === 'merge').length;
  const merged = result.autoMergedFiles?.length ?? Math.max(0, merges - result.conflicts.length);
  const conflicts = result.conflicts.length;

  const counts = `${plural(updated.length, 'file')} updated, ${merged} auto-merged, ${plural(conflicts, 'conflict')}`;
  console.info();
  if (conflicts > 0) {
    console.info(`${warningMark} upgrade merge staged with conflicts`);
    console.info(pc.dim(`  ${counts}`));
  } else {
    console.info(`${checkMark} upgrade merge complete`);
    console.info(pc.dim(`  ${counts}`));
  }

  printProtectedConflicts(result);
  console.info();
}

/**
 * List protected files the upgrade resolved to the app side although upstream changed them
 * (`MergeResult.protectedConflicts`). Printed right when the drop happens so it is not
 * discovered weeks later as a styling or behavior regression. Silent when empty.
 */
function printProtectedConflicts(result: MergeResult): void {
  const paths = result.protectedConflicts ?? [];
  if (paths.length === 0) return;

  const byPath = new Map(result.files.map((file) => [file.path, file]));
  // An ignored image or other binary the app keeps its own of has nothing to adopt: one line counts them.
  const binaries = paths.filter((path) => byPath.get(path)?.isIgnored && byPath.get(path)?.upstreamBinary);
  console.info();
  console.info(
    `${warningMark} ${pc.yellow(
      `${plural(paths.length, 'protected file kept', 'protected files kept')} the app version, dropping upstream changes:`,
    )}`,
  );
  for (const path of paths) {
    if (binaries.includes(path)) continue;
    const file = byPath.get(path);
    const icon = file ? protectionIcon(file) : statusConfig.pinned.icon;
    console.info(`  ${icon} ${path}${file ? formatUpstreamChangedLines(file) : ''}`);
  }
  if (binaries.length > 0) {
    console.info(
      `  ${statusConfig.ignored.icon} ${plural(binaries.length, 'ignored binary file')}, such as ${binaries[0]}`,
    );
  }
  console.info(pc.dim(`  ${protectedBehindHint}`));
}

/**
 * Ignored paths upstream changed since the last upgrade while the app left them untouched
 * (`MergeResult.ignoredUpstreamChanges`). Ignored paths never merge, so this is where new config
 * keys or version bumps under e.g. `shared/config` surface. One line per `ignored` entry with a
 * file count. Silent when empty.
 */
export function printIgnoredUpstreamChanges(result: MergeResult): void {
  const groups = result.ignoredUpstreamChanges ?? [];
  if (groups.length === 0) return;

  const total = groups.reduce((count, group) => count + group.paths.length, 0);
  console.info();
  console.info(
    `${warningMark} ${pc.yellow(`ignored paths changed upstream · ${plural(total, 'file')} under ${plural(groups.length, 'entry', 'entries')}`)}`,
  );
  for (const group of groups) {
    const counts = [plural(group.paths.length, 'file')];
    if (group.added > 0) counts.push(`${group.added} new`);
    if (group.deleted > 0) counts.push(`${group.deleted} deleted`);
    console.info(`  ${statusConfig.ignored.icon} ${group.entry} ${pc.dim(`· ${counts.join(', ')}`)}`);
  }
  console.info(pc.dim('  the app left these untouched and ignored paths never merge: review and adopt what you need.'));
}

/**
 * Upstream CLI config entries the app config does not follow (`MergeResult.upstreamOverrides`):
 * `pinned`, `ignored` and `packageJsonKeys` entries upstream added that the app lacks, and ones
 * upstream dropped that the app still has. The CLI config is managed and never merges, so these
 * only reach the app by hand. Silent when there is nothing to report; one dim line when upstream's
 * config was unreadable.
 */
export function printUpstreamOverrideChanges(result: Pick<MergeResult, 'upstreamOverrides'>): void {
  const report = result.upstreamOverrides;
  if (!report) return;

  console.info();
  if (report.type === 'unreadable') {
    const side = report.side === 'base' ? 'the last upgrade' : 'the incoming ref';
    console.info(
      pc.dim(`upstream CLI config not compared: upstream ${configFile} is missing or unreadable at ${side}`),
    );
    return;
  }

  const lines: string[] = [];
  for (const list of ['pinned', 'ignored', 'packageJsonKeys'] as const) {
    for (const entry of report[list].added) lines.push(`  ${pc.green('+')} ${list}: ${entry}`);
    for (const entry of report[list].removed) {
      lines.push(`  ${pc.red('−')} ${list}: ${entry}${pc.dim(' · dropped upstream, still in your config')}`);
    }
    for (const { from, to, coveredBy } of report[list].renamed ?? []) {
      const advice = coveredBy ? `'${coveredBy}' protects it already: drop the old entry` : 'rename it in your config';
      lines.push(`  ${pc.yellow('~')} ${list}: ${from} → ${to}${pc.dim(` · renamed upstream, ${advice}`)}`);
    }
    for (const { from, to } of report[list].moved ?? []) {
      lines.push(pc.dim(`  ~ ${list}: ${from} → ${to} · renamed upstream, your config never had it`));
    }
  }
  console.info(
    `${warningMark} ${pc.yellow(`upstream changed its CLI config · ${plural(lines.length, 'entry', 'entries')} to review`)}`,
  );
  for (const line of lines) console.info(line);
  console.info(pc.dim(`  ${configFile} never merges: add or drop these by hand where they fit your app.`));
}

/**
 * A pinned file whose app content is byte-identical to the previous upstream (status
 * `behind`, resolution `keep`) never actually diverged: the pin is silently freezing it at the old
 * upstream version and dropping upstream's new changes, a deletion included. Because the app copy equals the old
 * upstream, this produces no merge conflict and no type error, so it slips through unseen
 * (e.g. a pinned nav-config losing new upstream entries). These are the pins worth a look.
 * Managed files (package.json, the lockfile, the CLI config) are always pinned but stay out:
 * the package merge reconciles their keys, so the pin masks nothing there.
 */
export function findMaskingPins(files: AnalyzedFile[]): AnalyzedFile[] {
  return files.filter((file) => file.status === 'behind' && file.resolution === 'keep' && !isManagedFile(file.path));
}

/**
 * Warn when pins are masking upstream changes (see `findMaskingPins`). Silent by design
 * when there is nothing to report, so it is safe to call unconditionally after a summary.
 */
export function printMaskingPinWarning(files: AnalyzedFile[]): void {
  const masking = findMaskingPins(files);
  if (masking.length === 0) return;

  console.info();
  console.info(
    `${warningMark} ${pc.yellow(
      `${plural(masking.length, 'pinned file matches', 'pinned files match')} the previous upstream but changed upstream:`,
    )}`,
  );
  console.info(pc.yellow('  the pin keeps the old app copy and silently drops those upstream changes:'));
  for (const file of masking) {
    console.info(pc.dim(`  ⨀ ${file.path}`));
  }
  console.info(pc.yellow('  if the app never customized these, unpin them in cella/cella.config.ts to take upstream.'));
  console.info();
}

/**
 * Print the post-engine report block shared by analyze and upgrade: the summary, then the upstream
 * changes the upgrade never brings in (ignored paths and upstream's own CLI config), and pins that
 * silently freeze a file at the old upstream (no conflict, no type error).
 */
export function printEngineReports(result: MergeResult, title: string): void {
  printSummary(result.summary, title);
  printIgnoredUpstreamChanges(result);
  printUpstreamOverrideChanges(result);
  printMaskingPinWarning(result.files);
}

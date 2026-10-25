/**
 * Display utilities: console output formatting, spinners, hyperlinks, and the
 * report blocks analyze and sync print.
 */

import { resolve } from 'node:path';
import process from 'node:process';
import packageJson from '../../package.json' with { type: 'json' };
import type { AnalysisSummary, AnalyzedFile, CommitRangeEntry, FileStatus, MergeResult } from '../config/types';
import pc from './colors';
import { getEnv } from './env';
import { fitText, padVisible, shortAge, terminalColumns } from './layout';
import { CONFIG_FILE, isGeneratedFile, isManagedFile } from './managed-files';

/** Version from package.json */
export const VERSION = packageJson.version;

/** Options for generating links in CLI output */
export interface LinkOptions {
  /** Base GitHub URL for upstream (e.g., 'https://github.com/cellajs/cella') */
  upstreamGitHubUrl?: string;
  /** Upstream commit the run analyzed: file links show the file as it is there */
  upstreamSha?: string;
  /** Base GitHub URL of the fork's `origin`, for links to the fork's own commits */
  forkGitHubUrl?: string;
  /** File link mode: 'commit' links to commit, 'file' links to file in repo */
  fileLinkMode?: 'commit' | 'file';
  /** Fork repository path for resolving file paths */
  forkPath?: string;
}

/** Line divider */
export const DIVIDER = '─'.repeat(60);

/** Divider used above the exit entry of interactive menus */
export const MENU_DIVIDER = '─'.repeat(40);

/** Most recent upstream commits listed in the sync PR body */
export const COMMIT_LIST_MAX = 50;

/** Most recent upstream commits listed under the `upstream` step */
export const COMMIT_STEP_MAX = 10;

/** Width of the label column of step lines (`✓ upstream   …`) */
const STEP_LABEL_WIDTH = 9;

/** Where the detail of a step line starts: the mark, the label column and two spaces */
export const STEP_INDENT = 2 + STEP_LABEL_WIDTH + 2;

/** Warning mark for non-fatal warnings */
export const warningMark = pc.yellow('⚠');

/** Check mark for successful status lines */
export const checkMark = pc.green('✓');

/** A progress line: `text` is read on every frame, `stop()` clears the line. */
type Spinner = { text: string; stop(): void };

/** Active spinner reference */
let activeSpinner: Spinner | null = null;

/**
 * When true, stdout is reserved for machine-readable payloads (e.g. `--json`),
 * so all human-facing output (header, warnings, steps, spinner) is routed to stderr.
 */
let jsonMode = false;

/**
 * Enable JSON mode: keep stdout clean for the JSON payload by sending every
 * human-facing line (console.info/console.warn, header, spinner) to stderr.
 * This makes `cella --json ... | jq` pipe cleanly.
 */
export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
  if (!enabled) return;
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
  };
  console.info = toStderr;
  console.warn = toStderr;
}

/** Write a machine-readable payload to stdout (bypasses the stderr routing of JSON mode). */
export function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printHeader(): void {
  const left = '⧈ cella cli';
  const version = ` · v${VERSION}`;
  const right = 'cellajs.com';
  // Padding counts the visible characters only, not the ANSI codes
  const padding = Math.max(1, DIVIDER.length - `${left}${version}${right}`.length);
  console.info();
  console.info(`${pc.cyan(left)}${pc.dim(version)}${pc.cyan(`${' '.repeat(padding)}${right}`)}`);
  console.info(DIVIDER);
  console.info();
}

/** Start a progress spinner; suppressed in test environments and JSON mode. */
export function createSpinner(text: string): Spinner {
  const enabled = !jsonMode && !getEnv('VITEST') && getEnv('NODE_ENV') !== 'test' && !!process.stdout.isTTY;
  const frames = ['-', '\\', '|', '/'];
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const spinner: Spinner = {
    text,
    stop() {
      clearInterval(timer);
      if (enabled) process.stdout.write('\r\x1b[2K');
    },
  };
  const render = () => process.stdout.write(`\r${pc.cyan(frames[frame++ % frames.length])} ${spinner.text}`);
  if (enabled) {
    render();
    timer = setInterval(render, 80);
  }
  activeSpinner = spinner;
  return spinner;
}

/**
 * Print a completed step of the merge engine on one line, `✓ label  detail`; further lines of
 * `detail` line up under its first.
 */
export function printStep(label: string, detail?: string, mark = checkMark): void {
  stopSpinner();
  const [first = '', ...rest] = (detail ?? '').split('\n');
  console.info(`${mark} ${pc.bold(label.padEnd(STEP_LABEL_WIDTH))}  ${first}`.trimEnd());
  for (const line of rest) console.info(line ? `${' '.repeat(STEP_INDENT)}${line}` : '');
}

/** Stop the spinner and print `message` as a completed step; `detail` adds a dim line and a blank line. */
export function spinnerSuccess(message?: string, detail?: string): void {
  stopSpinner();
  if (!message) return;
  console.info(`${checkMark} ${message}`);
  if (detail) {
    console.info(`  ${pc.dim(detail)}`);
    console.info();
  }
}

export function spinnerFail(message: string): void {
  stopSpinner();
  console.info(`${pc.red('✗')} ${message}`);
}

export function spinnerText(text: string): void {
  if (activeSpinner) {
    activeSpinner.text = text;
  }
}

function stopSpinner(): void {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
}

/**
 * Create a clickable hyperlink for terminals that support OSC 8.
 * Falls back to just the label if no URL provided.
 */
export function hyperlink(label: string, url?: string): string {
  if (!url) return label;
  // Strip control characters from URL to prevent terminal escape injection (CWE-116)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the security purpose here.
  const safeUrl = url.replace(/[\x00-\x1f\x7f]/g, '');
  // OSC 8 hyperlink format: \x1b]8;;URL\x07LABEL\x1b]8;;\x07
  return `\x1b]8;;${safeUrl}\x07${label}\x1b]8;;\x07`;
}

/** A trailing `(#1519)` in a squash-merge subject: the PR number, and the subject without it. */
function splitPrNumber(subject: string): { subject: string; pr?: number } {
  const match = /\s*\(#(\d+)\)\s*$/.exec(subject);
  return match ? { subject: subject.slice(0, match.index), pr: Number(match[1]) } : { subject };
}

/** A commit subject colored by kind: releases dim, breaking changes (`feat!:`) with a yellow type. */
function styleSubject(subject: string): string {
  if (/^chore(\([^)]*\))?: release\b/.test(subject)) return pc.dim(subject);
  const breaking = /^([a-z]+(\([^)]*\))?!:)/.exec(subject);
  return breaking ? `${pc.yellow(breaking[1])}${subject.slice(breaking[1].length)}` : subject;
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
  options: { columns?: number; max?: number; nowMs?: number } = {},
): string[] {
  const { columns = terminalColumns(), max = COMMIT_STEP_MAX, nowMs } = options;
  const shown = commits.slice(-max).reverse();
  const rows = shown.map((commit) => ({ commit, ...splitPrNumber(commit.message) }));
  const prWidth = Math.max(0, ...rows.map((row) => (row.pr ? `#${row.pr}`.length : 0)));
  const ages = rows.map((row) => (row.commit.timestamp ? shortAge(row.commit.timestamp, nowMs) : ''));
  const ageWidth = Math.max(0, ...ages.map((age) => age.length));
  const subjectWidth = Math.max(
    20,
    columns - STEP_INDENT - 7 - 2 - (prWidth ? prWidth + 2 : 0) - (ageWidth ? ageWidth + 2 : 0),
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

/** One step of `next steps`: a label for what to do, the command or link, and lines under it. */
export interface NextStep {
  label: string;
  line: string;
  details?: string[];
}

/**
 * The `next steps` section that closes analyze and sync, numbered in the order to take them. The
 * line and details of each step start at the column the engine's step details do.
 */
export function printNextSteps(steps: NextStep[]): void {
  if (steps.length === 0) return;
  printSectionHeader(pc.cyan('next steps'));
  for (const [index, step] of steps.entries()) {
    const label = step.label.padEnd(STEP_INDENT - 5);
    console.info(`  ${pc.dim(String(index + 1))} ${pc.bold(label)} ${step.line}`.trimEnd());
    for (const detail of step.details ?? []) console.info(`${' '.repeat(STEP_INDENT)}${detail}`);
  }
}

/** A section header: a blank line, the title, the divider under it, and a blank line. */
export function printSectionHeader(title: string): void {
  console.info();
  console.info(title);
  console.info(DIVIDER);
  console.info();
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

  // Each file opens in VS Code from the fork workspace when the fork path is known
  const { forkPath } = linkOptions;
  const shown = autoMergedFiles.slice(0, maxFiles);
  for (const filePath of shown) {
    lines.push(`  - ${forkPath ? hyperlink(filePath, `vscode://file${resolve(forkPath, filePath)}`) : filePath}`);
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
  behind: { icon: pc.cyan('↓'), label: 'behind', color: pc.cyan, description: 'upstream changed, will sync' },
  diverged: { icon: pc.magenta('⇅'), label: 'diverged', color: pc.magenta, description: 'both changed, will merge' },
  drifted: { icon: pc.yellow('!'), label: 'drifted', color: pc.yellow, description: 'fork changed (at risk)' },
  ahead: { icon: pc.blue('↑'), label: 'ahead', color: pc.blue, description: 'fork changed (protected)' },
  local: { icon: pc.green('+'), label: 'local', color: pc.green, description: 'local file in cella folders' },
  pinned: { icon: pc.green('⨀'), label: 'pinned', color: pc.green, description: 'both changed, fork wins' },
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
 * Protected (pinned/ignored) files that upstream also changed since the last sync. The fork
 * side wins whole-file on these, so upstream's hunks are dropped: the regression class where
 * a pinned stylesheet misses new upstream utilities that synced components rely on.
 */
export function findProtectedBehind(files: AnalyzedFile[]): AnalyzedFile[] {
  // Generated output is rebuilt from the fork's own sources, so upstream's copy has nothing to adopt.
  return files.filter((file) => file.upstreamChanged && !isManagedFile(file.path) && !isGeneratedFile(file.path));
}

/** Hint under the protected files a sync kept the fork version of. */
const PROTECTED_BEHIND_HINT =
  'pinned/ignored files where upstream also changed since the last sync; the fork side wins on conflict, ' +
  'so review what upstream changed and adopt what you need.';

/** Icon by protection kind (⨂ ignored, ⨀ pinned) for protected-but-behind lines. */
export function protectionIcon(file: AnalyzedFile): string {
  return file.isIgnored ? statusConfig.ignored.icon : statusConfig.pinned.icon;
}

/** Per-file detail: how many lines upstream changed (dropped by the fork-wins resolution). */
function formatUpstreamChangedLines(file: AnalyzedFile): string {
  if (file.upstreamChangedLines === undefined) return '';
  return pc.yellow(` · ${plural(file.upstreamChangedLines, 'line')} changed upstream`);
}

export function printSyncComplete(result: MergeResult, options: { stagedBranch?: string } = {}): void {
  const updated = result.files.filter((file) => file.status === 'behind' || file.status === 'diverged').length;
  const diverged = result.files.filter((file) => file.status === 'diverged').length;
  const merged = result.autoMergedFiles?.length ?? Math.max(0, diverged - result.conflicts.length);
  const conflicts = result.conflicts.length;

  const counts = `${plural(updated, 'file')} updated, ${merged} auto-merged, ${plural(conflicts, 'conflict')}`;
  console.info();
  if (options.stagedBranch) {
    console.info(`${checkMark} sync merge staged on '${options.stagedBranch}'`);
    console.info(pc.dim(`  ${counts}. committing next...`));
  } else if (conflicts > 0) {
    console.info(`${warningMark} sync merge staged with conflicts`);
    console.info(pc.dim(`  ${counts}`));
  } else {
    console.info(`${checkMark} sync complete`);
    console.info(pc.dim(`  ${counts}`));
  }

  printProtectedConflicts(result);
  console.info();
}

/**
 * List protected files the sync resolved to the fork side although upstream changed them
 * (`MergeResult.protectedConflicts`). Printed right when the drop happens so it is not
 * discovered weeks later as a styling or behavior regression. Silent when empty.
 */
function printProtectedConflicts(result: MergeResult): void {
  const paths = result.protectedConflicts ?? [];
  if (paths.length === 0) return;

  const byPath = new Map(result.files.map((file) => [file.path, file]));
  console.info();
  console.info(
    `${warningMark} ${pc.yellow(
      `${plural(paths.length, 'protected file kept', 'protected files kept')} the fork version, dropping upstream changes:`,
    )}`,
  );
  for (const path of paths) {
    const file = byPath.get(path);
    const icon = file ? protectionIcon(file) : statusConfig.pinned.icon;
    console.info(`  ${icon} ${path}${file ? formatUpstreamChangedLines(file) : ''}`);
  }
  console.info(pc.dim(`  ${PROTECTED_BEHIND_HINT}`));
}

/** `1 file`, `2 files`: a count with its noun. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Ignored paths upstream changed since the last sync while the fork left them untouched
 * (`MergeResult.ignoredUpstreamChanges`). Ignored paths never sync, so this is where new config
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
  console.info(pc.dim('  the fork left these untouched and ignored paths never sync: review and adopt what you need.'));
}

/**
 * Upstream sync config entries the fork config does not follow (`MergeResult.upstreamOverrides`):
 * `overrides` entries and `packageJsonSync` keys upstream added that the fork lacks, and ones
 * upstream dropped that the fork still has. The sync config is managed and never merges, so these
 * only reach the fork by hand. Silent when there is nothing to report; one dim line when upstream's
 * config was unreadable.
 */
export function printUpstreamOverrideChanges(result: Pick<MergeResult, 'upstreamOverrides'>): void {
  const report = result.upstreamOverrides;
  if (!report) return;

  console.info();
  if (report.kind === 'unreadable') {
    const side = report.side === 'base' ? 'the last sync point' : 'the incoming ref';
    console.info(
      pc.dim(`upstream sync config not compared: upstream ${CONFIG_FILE} is missing or unreadable at ${side}`),
    );
    return;
  }

  const lines: string[] = [];
  for (const list of ['pinned', 'ignored', 'packageJsonSync'] as const) {
    for (const entry of report[list].added) lines.push(`  ${pc.green('+')} ${list}: ${entry}`);
    for (const entry of report[list].removed) {
      lines.push(`  ${pc.red('−')} ${list}: ${entry}${pc.dim(' · dropped upstream, still in your config')}`);
    }
  }
  console.info(
    `${warningMark} ${pc.yellow(`upstream changed its sync config · ${plural(lines.length, 'entry', 'entries')} to review`)}`,
  );
  for (const line of lines) console.info(line);
  console.info(pc.dim(`  ${CONFIG_FILE} never syncs: add or drop these by hand where they fit your app.`));
}

/**
 * A pinned file whose fork content is byte-identical to the previous upstream (status
 * `behind`) never actually diverged: the pin is silently freezing it at the old upstream
 * version and dropping upstream's new changes. Because the fork copy equals the old
 * upstream, this produces no merge conflict and no type error, so it slips through unseen
 * (e.g. a pinned nav-config losing new upstream entries). These are the pins worth a look.
 * Managed files (package.json, the lockfile, the sync config) are always pinned but stay out:
 * the package sync reconciles their keys, so the pin masks nothing there.
 */
export function findMaskingPins(files: AnalyzedFile[]): AnalyzedFile[] {
  return files.filter(
    (file) =>
      file.isPinned &&
      !isManagedFile(file.path) &&
      file.status === 'behind' &&
      file.existsInFork &&
      file.existsInUpstream,
  );
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
  console.info(pc.yellow('  the pin keeps the old fork copy and silently drops those upstream changes:'));
  for (const file of masking) {
    console.info(pc.dim(`  ⨀ ${file.path}`));
  }
  console.info(
    pc.yellow('  if the fork never customized these, unpin them in cella/cella.config.ts to take upstream.'),
  );
  console.info();
}

/**
 * Print the post-engine report block shared by analyze and sync: the summary, then the upstream
 * changes the sync never brings in (ignored paths and upstream's own sync config), and pins that
 * silently freeze a file at the old upstream (no conflict, no type error).
 */
export function printEngineReports(result: MergeResult, title: string): void {
  printSummary(result.summary, title);
  printIgnoredUpstreamChanges(result);
  printUpstreamOverrideChanges(result);
  printMaskingPinWarning(result.files);
}

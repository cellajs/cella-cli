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
import { CONFIG_FILE, isManagedFile } from './managed-files';

/** Version from package.json */
export const VERSION = packageJson.version;

/** Options for generating links in CLI output */
export interface LinkOptions {
  /** Base GitHub URL for upstream (e.g., 'https://github.com/cellajs/cella') */
  upstreamGitHubUrl?: string;
  /** Upstream branch name for file links */
  upstreamBranch?: string;
  /** File link mode: 'commit' links to commit, 'file' links to file in repo */
  fileLinkMode?: 'commit' | 'file';
  /** Fork repository path for resolving file paths */
  forkPath?: string;
}

/** Line divider */
export const DIVIDER = '─'.repeat(60);

/** Divider used above the exit entry of interactive menus */
export const MENU_DIVIDER = '─'.repeat(40);

/** Most recent upstream commits shown per commit list (fetch detail, PR body) */
export const COMMIT_LIST_MAX = 50;

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
  const right = 'cellajs.com';
  // Padding counts the visible characters only, not the ANSI codes
  const padding = Math.max(1, 60 - `${left} v${VERSION}`.length - right.length);
  console.info();
  console.info(`${pc.cyan(left)}${pc.dim(` · v${VERSION}`)}${pc.cyan(`${' '.repeat(padding)}${right}`)}`);
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

/** The fetched-upstream detail block, with clickable short commit hashes. */
export function formatFetchedUpstreamDetail(
  commitCount: number,
  commits: CommitRangeEntry[],
  upstreamGitHubUrl?: string,
  maxShownCommits = COMMIT_LIST_MAX,
): string {
  const lines = [`${plural(commitCount, 'new commit')} since last merge`];

  const shown = commits.slice(0, maxShownCommits);
  for (const commit of shown) {
    const shortHash = commit.hash.slice(0, 7);
    const commitUrl = upstreamGitHubUrl ? `${upstreamGitHubUrl}/commit/${commit.hash}` : undefined;
    const hashLabel = hyperlink(shortHash, commitUrl);
    lines.push(`  ${hashLabel} "${commit.message}" (${commit.date})`);
  }

  if (commitCount > shown.length) {
    lines.push(`  ... and ${commitCount - shown.length} more`);
  }

  return lines.join('\n');
}

function printSectionHeader(title: string): void {
  console.info();
  console.info(title);
  console.info(DIVIDER);
  console.info();
}

/**
 * The dim ` ≠ <date> <link>` tail of a file line, per fileLinkMode: the file at the upstream branch,
 * or the commit (a plain short hash without a GitHub URL). Empty without a date.
 */
function formatFileDateInfo(
  filePath: string,
  commit: string | undefined,
  date: string | undefined,
  options: LinkOptions,
): string {
  if (!date) return '';
  const { upstreamGitHubUrl: url, upstreamBranch, fileLinkMode = 'commit' } = options;
  let link = commit?.slice(0, 9) ?? '';
  if (url && fileLinkMode === 'file' && upstreamBranch) {
    link = hyperlink(filePath.split('/').pop() || filePath, `${url}/blob/${upstreamBranch}/${filePath}`);
  } else if (url) {
    link = commit ? hyperlink(link, `${url}/commit/${commit}`) : '';
  }
  return pc.dim(` ≠ ${date} ${link}`);
}

export function formatMergeInProgressDetail(
  conflictCount: number,
  autoMergedFiles: string[],
  linkOptions: LinkOptions,
  maxFiles = 100,
): string {
  const lines = [`${conflictCount} conflicts to resolve in IDE`];

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

function printSummary(summary: AnalysisSummary, title = 'summary'): void {
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

/** Options shared by the file-list section printers. */
interface FileSectionOptions {
  /** Override section header title */
  title?: string;
  /** Footer hint text (dimmed), one line per entry */
  hint?: string | string[];
  /** Which commit/date fields to use: 'fork' or 'upstream' */
  dateSource?: 'fork' | 'upstream';
  /** Per-file detail appended after the date/link info */
  suffix?: (file: AnalyzedFile) => string;
}

/**
 * Print a list of files as a section: header, one line per file (capped), optional hint.
 * `icon` may vary per file (e.g. pinned vs ignored) and `suffix` appends per-file detail.
 */
function printFileSection(
  files: AnalyzedFile[],
  title: string,
  linkOptions: LinkOptions,
  options: FileSectionOptions & { icon: string | ((file: AnalyzedFile) => string) },
): void {
  if (files.length === 0) return;

  printSectionHeader(`${title} ${pc.dim(`· ${files.length} files`)}`);

  const useUpstream = options.dateSource === 'upstream';
  const maxLines = 100;
  const shown = files.length > maxLines ? files.slice(0, maxLines) : files;

  for (const file of shown) {
    const icon = typeof options.icon === 'string' ? options.icon : options.icon(file);
    const commit = useUpstream ? file.upstreamCommit : file.changedCommit;
    const date = useUpstream ? file.upstreamChangedAt : file.changedAt;
    const dateInfo = formatFileDateInfo(file.path, commit, date, linkOptions);
    console.info(`  ${icon} ${file.path}${dateInfo}${options.suffix?.(file) ?? ''}`);
  }

  if (files.length > maxLines) {
    console.info(pc.dim(`  ... + ${files.length - maxLines} more`));
  }

  if (options.hint) {
    console.info();
    for (const line of Array.isArray(options.hint) ? options.hint : [options.hint]) {
      console.info(pc.dim(`  ${line}`));
    }
  }
}

/**
 * Print a group of files with a specific status, including section header and footer.
 */
function printFileGroup(
  files: AnalyzedFile[],
  status: FileStatus,
  linkOptions: LinkOptions,
  options?: FileSectionOptions,
): void {
  const filtered = files.filter((f) => f.status === status && !isManagedFile(f.path));
  const config = statusConfig[status];
  const title = options?.title ?? `${config.icon} ${config.label}`;
  printFileSection(filtered, title, linkOptions, { ...options, icon: config.icon });
}

/**
 * Protected (pinned/ignored) files that upstream also changed since the last sync. The fork
 * side wins whole-file on these, so upstream's hunks are dropped: the regression class where
 * a pinned stylesheet misses new upstream utilities that synced components rely on.
 */
export function findProtectedBehind(files: AnalyzedFile[]): AnalyzedFile[] {
  return files.filter((file) => file.upstreamChanged && !isManagedFile(file.path));
}

/** Shared hint for protected-but-behind output (analyze section and sync summary). */
const PROTECTED_BEHIND_HINT =
  'pinned/ignored files where upstream also changed since the last sync; the fork side wins on conflict, ' +
  'so diff each against upstream and adopt what you need.';

/** Icon by protection kind (⨂ ignored, ⨀ pinned) for protected-but-behind lines. */
function protectionIcon(file: AnalyzedFile): string {
  return file.isIgnored ? statusConfig.ignored.icon : statusConfig.pinned.icon;
}

/** Per-file detail: how many lines upstream changed (dropped by the fork-wins resolution). */
function formatUpstreamChangedLines(file: AnalyzedFile): string {
  if (file.upstreamChangedLines === undefined) return '';
  return pc.yellow(` · ${plural(file.upstreamChangedLines, 'line')} changed upstream`);
}

/** What a protected-but-behind list needs for its `git diff` hints. */
type ProtectedDiffSource = Pick<MergeResult, 'upstreamDiffRange' | 'protectedUpstreamChanges'>;

/**
 * Pasteable `git diff` lines for a protected-but-behind list: one per `pinned` or `ignored` entry
 * that holds a listed path, under a line that introduces them. The range runs from the last sync
 * point to upstream, so each shows only what upstream changed; a diff of the fork against upstream
 * would show the fork's own changes too. Empty without a range or a matching entry.
 */
function protectedDiffHints(source: ProtectedDiffSource | undefined, paths: string[]): string[] {
  const range = source?.upstreamDiffRange;
  if (!range) return [];
  const listed = new Set(paths);
  const groups = (source?.protectedUpstreamChanges ?? []).filter((group) => group.paths.some((p) => listed.has(p)));
  if (groups.length === 0) return [];
  return [
    'what upstream changed since the last sync, per pinned/ignored entry:',
    ...groups.map((group) => `  git diff ${range} -- ${shellPath(group.entry)}`),
  ];
}

/** Per-file detail for pinned `ahead` files: upstream lines the fork lacks (only when > 0). */
function formatUpstreamLinesAbsent(file: AnalyzedFile): string {
  const n = file.upstreamLinesAbsent ?? 0;
  return n > 0 ? pc.yellow(` · ${plural(n, 'upstream line')} absent`) : '';
}

/**
 * Print all analyze-mode file group sections in review order:
 * behind, ahead (protected), protected-but-behind, drifted, and diverged.
 *
 * Protected-but-behind covers every `pinned`-status file (both changed, fork wins) plus
 * ignored files upstream also changed, so there is no separate `pinned` group. With `diffSource`
 * (the merge result) it ends with one `git diff` line per pinned/ignored entry.
 */
export function printAnalysisFileGroups(
  files: AnalyzedFile[],
  linkOptions: LinkOptions,
  diffSource?: ProtectedDiffSource,
): void {
  const protectedBehind = findProtectedBehind(files);
  printFileGroup(files, 'behind', linkOptions, {
    title: pc.cyan('↓ behind on upstream'),
  });
  printFileGroup(files, 'ahead', linkOptions, {
    title: `${pc.blue('↑ protected in fork')}`,
    suffix: formatUpstreamLinesAbsent,
    hint: [
      'these files have fork changes but are protected (pinned); upstream did not change them since the last sync.',
      'pinned files keep the fork copy whole; a count here is upstream content the fork never received, ' +
        'deliberately or not: `analyze --unpinned` shows what a merge would bring in.',
    ],
  });
  printFileSection(protectedBehind, `${warningMark} ${pc.yellow('protected but behind upstream')}`, linkOptions, {
    icon: protectionIcon,
    suffix: formatUpstreamChangedLines,
    dateSource: 'upstream',
    hint: [
      PROTECTED_BEHIND_HINT,
      ...protectedDiffHints(
        diffSource,
        protectedBehind.map((file) => file.path),
      ),
    ],
  });
  printFileGroup(files, 'drifted', linkOptions, {
    title: `${warningMark} ${pc.yellow('drifted from upstream')}`,
    hint: 'these files have fork changes but are not pinned or ignored.',
  });
  printFileGroup(files, 'diverged', linkOptions, {
    title: `${pc.magenta('⇅ diverged')}`,
    hint: 'both fork and upstream changed.',
    dateSource: 'upstream',
  });
}

export function printSyncComplete(result: MergeResult, options: { stagedBranch?: string } = {}): void {
  const updated = result.files.filter((file) => file.status === 'behind' || file.status === 'diverged').length;
  const diverged = result.files.filter((file) => file.status === 'diverged').length;
  const merged = result.autoMergedFiles?.length ?? Math.max(0, diverged - result.conflicts.length);
  const conflicts = result.conflicts.length;

  console.info();
  if (options.stagedBranch) {
    console.info(`${checkMark} sync merge staged on '${options.stagedBranch}'`);
    console.info(
      pc.dim(`  ${updated} files updated, ${merged} auto-merged, ${conflicts} conflicts. committing next...`),
    );
  } else {
    console.info(`${checkMark} sync complete`);
    console.info(pc.dim(`  ${updated} files updated, ${merged} auto-merged, ${conflicts} conflicts`));
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
  for (const line of [PROTECTED_BEHIND_HINT, ...protectedDiffHints(result, paths)]) console.info(pc.dim(`  ${line}`));
}

/** `1 file`, `2 files`: a count with its noun. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Quote a path for a pasteable shell command when it holds characters the shell would interpret. */
function shellPath(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ignored paths upstream changed since the last sync while the fork left them untouched
 * (`MergeResult.ignoredUpstreamChanges`). Ignored paths never sync, so this is where new config
 * keys or version bumps under e.g. `shared/config` surface. One line per `ignored` entry with a
 * file count, plus a pasteable `git diff` of upstream's side. Silent when empty.
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
    if (result.upstreamDiffRange) {
      console.info(pc.dim(`    git diff ${result.upstreamDiffRange} -- ${shellPath(group.entry)}`));
    }
  }
  console.info(pc.dim('  the fork left these untouched and ignored paths never sync: diff and adopt what you need.'));
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
function printMaskingPinWarning(files: AnalyzedFile[]): void {
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

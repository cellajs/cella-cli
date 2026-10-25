/**
 * The file sections of the analyze report, in the order they need you: files that sync on their
 * own first, the upstream changes the sync leaves out last. Each file is a row with its path, a
 * count and an age in columns. Large groups collapse unless `--all` asks for every path.
 */

import { basename } from 'node:path';
import type { AnalyzedFile, MergeResult } from '../config/types';
import pc from '../utils/colors';
import {
  filesWithStatus,
  findProtectedBehind,
  hyperlink,
  type LinkOptions,
  plural,
  printSectionHeader,
  protectionIcon,
  warningMark,
} from '../utils/display';
import { compactCount, padVisible, shortAge, terminalColumns, visibleWidth } from '../utils/layout';
import { isUnderAnyFolder, normalizeEntry } from '../utils/overrides';

/** Behind files listed one per row up to this count; more collapse to one row per folder. */
const BEHIND_FLAT_MAX = 15;

/** Pinned files listed in full up to this count; more list only the ones missing many upstream lines. */
const AHEAD_FLAT_MAX = 8;

/** Upstream lines a pinned file must miss to keep its own row once the section is cut short. */
const ABSENT_SHOWN_MIN = 10;

/** Rows of one kind under one override entry that collapse to a single row. */
const ENTRY_COLLAPSE_MIN = 5;

/** Rows a section prints at most. */
const SECTION_ROWS_MAX = 100;

export interface AnalyzeReportOptions {
  links: LinkOptions;
  /** List every path instead of collapsing large groups (`--all`). */
  all?: boolean;
  /** The fork config's override entries: protected files collapse by the entry that holds them. */
  overrides?: { ignored?: string[]; pinned?: string[] };
  columns?: number;
  nowMs?: number;
}

/** One row of a section: a path or a collapsed group's label, with optional icon, count, tag and age. */
interface Row {
  label: string;
  /** Dim text after the label, inside the label column */
  note?: string;
  link?: string;
  icon?: string;
  count?: string;
  countColor?: (text: string) => string;
  tag?: string;
  tagColor?: (text: string) => string;
  age?: string;
}

/** Which change a section dates and links: the `changed*` or `upstream*` fields, and whose repo holds the commit. */
interface Side {
  fields: 'changed' | 'upstream';
  repo: 'upstream' | 'fork';
}

const UPSTREAM_CHANGE: Side = { fields: 'changed', repo: 'upstream' };
const UPSTREAM_SIDE: Side = { fields: 'upstream', repo: 'upstream' };
const FORK_SIDE: Side = { fields: 'changed', repo: 'fork' };

/** `value` padded to `width`, colored when it is not empty; plain spaces otherwise, so lines trim. */
function cell(value: string | undefined, width: number, color?: (text: string) => string, align?: 'end'): string {
  if (!value) return ' '.repeat(width);
  return padVisible(color ? color(value) : value, width, align === 'end' ? 'end' : 'start');
}

/** Rows as aligned lines: label column as wide as the longest label, then count, tag and age columns. */
function formatRows(rows: Row[], caption?: string): string[] {
  const iconWidth = rows.some((row) => row.icon) ? 2 : 0;
  const labelWidth = Math.max(...rows.map((row) => row.label.length + (row.note ? row.note.length + 1 : 0)));
  const countWidth = Math.max(0, ...rows.map((row) => row.count?.length ?? 0));
  const tagWidth = Math.max(0, ...rows.map((row) => row.tag?.length ?? 0));
  const ageWidth = Math.max(0, ...rows.map((row) => row.age?.length ?? 0));

  const lines: string[] = [];
  if (caption && countWidth > 0) lines.push(pc.dim(caption.padStart(2 + iconWidth + labelWidth + 2 + countWidth)));
  for (const row of rows) {
    const icon = iconWidth ? cell(row.icon, iconWidth) : '';
    const label = `${hyperlink(row.label, row.link)}${row.note ? ` ${pc.dim(row.note)}` : ''}`;
    const cells = [`  ${icon}${padVisible(label, labelWidth)}`];
    if (countWidth) cells.push(cell(row.count, countWidth, row.countColor, 'end'));
    if (tagWidth) cells.push(cell(row.tag, tagWidth, row.tagColor));
    if (ageWidth) cells.push(cell(row.age, ageWidth, pc.dim, 'end'));
    lines.push(cells.join('  ').trimEnd());
  }
  return lines;
}

/** Rows as lines, cut at {@link SECTION_ROWS_MAX} with a count of the rest. */
function formatCappedRows(rows: Row[], caption?: string): string[] {
  if (rows.length <= SECTION_ROWS_MAX) return formatRows(rows, caption);
  return [
    ...formatRows(rows.slice(0, SECTION_ROWS_MAX), caption),
    pc.dim(`  + ${rows.length - SECTION_ROWS_MAX} more`),
  ];
}

/** A dim hint line, with a command in the plain color so it stands out. */
function hint(text: string, command = ''): string {
  return `  ${pc.dim(text)}${command}`;
}

function printSection(title: string, count: number, body: string[], hints: string[] = []): void {
  printSectionHeader(`${title} ${pc.dim(`· ${plural(count, 'file')}`)}`);
  for (const line of body) console.info(line);
  if (hints.length === 0) return;
  console.info();
  for (const line of hints) console.info(line);
}

function byPath(a: AnalyzedFile, b: AnalyzedFile): number {
  return a.path.localeCompare(b.path);
}

/**
 * Where a row links, per `fileLinkMode`: the file as it is at the analyzed upstream commit, or the
 * commit that last changed it, in the repo that holds that commit (a fork commit 404s upstream).
 */
function fileLink(file: AnalyzedFile, side: Side, links: LinkOptions): string | undefined {
  const { fileLinkMode = 'commit', upstreamGitHubUrl, upstreamSha, forkGitHubUrl } = links;
  if (fileLinkMode === 'file') {
    if (!upstreamGitHubUrl || !upstreamSha || !file.existsInUpstream) return undefined;
    return `${upstreamGitHubUrl}/blob/${upstreamSha}/${file.path}`;
  }
  const commit = side.fields === 'upstream' ? file.upstreamCommit : file.changedCommit;
  const repo = side.repo === 'upstream' ? upstreamGitHubUrl : forkGitHubUrl;
  return commit && repo ? `${repo}/commit/${commit}` : undefined;
}

function changeTimestamp(file: AnalyzedFile, side: Side): number | undefined {
  return side.fields === 'upstream' ? file.upstreamChangedTs : file.changedTs;
}

/** A file added or deleted upstream: `new` (the fork lacks it) or `deleted` (upstream lacks it). */
function changeKind(file: AnalyzedFile): 'new' | 'deleted' | 'changed' {
  if (!file.existsInFork) return 'new';
  if (!file.existsInUpstream) return 'deleted';
  return 'changed';
}

const KIND_TAG = { new: { tag: 'new', color: pc.green }, deleted: { tag: 'deleted', color: pc.red } } as const;

function fileRow(file: AnalyzedFile, side: Side, options: AnalyzeReportOptions, extra: Partial<Row> = {}): Row {
  const timestamp = changeTimestamp(file, side);
  const kind = changeKind(file);
  return {
    label: file.path,
    link: fileLink(file, side, options.links),
    age: timestamp ? shortAge(timestamp, options.nowMs) : undefined,
    ...(kind === 'changed' ? {} : { tag: KIND_TAG[kind].tag, tagColor: KIND_TAG[kind].color }),
    ...extra,
  };
}

/** The deepest folder every path shares, '' when they share none. */
function commonFolder(paths: string[]): string {
  const folders = paths.map((path) => path.split('/').slice(0, -1));
  const [first] = folders;
  let depth = 0;
  while (depth < first.length && folders.every((parts) => parts[depth] === first[depth])) depth++;
  return first.slice(0, depth).join('/');
}

/**
 * Behind files as one row per top-level folder: the deepest folder the group shares, its count,
 * and as many file names as fit, added (`+`) and deleted (`−`) first. A file alone in its group
 * keeps its whole path.
 */
function formatFolderRows(files: AnalyzedFile[], columns: number): string[] {
  const groups = new Map<string, AnalyzedFile[]>();
  for (const file of files) {
    const top = file.path.includes('/') ? file.path.split('/')[0] : file.path;
    groups.set(top, [...(groups.get(top) ?? []), file]);
  }
  const rows = [...groups.values()]
    .map((group) => ({
      label: group.length === 1 ? group[0].path : `${commonFolder(group.map((file) => file.path))}/`,
      files: group,
    }))
    .sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));

  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const countWidth = Math.max(...rows.map((row) => String(row.files.length).length));
  const order = { new: 0, deleted: 1, changed: 2 };
  return rows.map((row) => {
    let line = `  ${row.label.padEnd(labelWidth)}  ${pc.cyan(String(row.files.length).padStart(countWidth))}`;
    if (row.files.length === 1) return line.trimEnd();
    // A name two files share (`SKILL.md`) is shown with its path inside the folder.
    const seen = new Map<string, number>();
    for (const file of row.files) seen.set(basename(file.path), (seen.get(basename(file.path)) ?? 0) + 1);
    const names = row.files
      .map((file) => ({
        kind: changeKind(file),
        name: (seen.get(basename(file.path)) ?? 0) > 1 ? file.path.slice(row.label.length) : basename(file.path),
      }))
      .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
    let width = visibleWidth(line);
    for (const { kind, name } of names) {
      const text = kind === 'new' ? `+${name}` : kind === 'deleted' ? `−${name}` : name;
      if (width + 2 + text.length > columns - 2) {
        line += pc.dim(' …');
        break;
      }
      line += `  ${kind === 'new' ? pc.green(text) : kind === 'deleted' ? pc.red(text) : pc.dim(text)}`;
      width += 2 + text.length;
    }
    return line;
  });
}

function printBehind(files: AnalyzedFile[], options: AnalyzeReportOptions, columns: number): void {
  const behind = filesWithStatus(files, 'behind').sort(byPath);
  if (behind.length === 0) return;
  const title = pc.cyan('↓ behind on upstream');
  if (options.all || behind.length <= BEHIND_FLAT_MAX) {
    printSection(title, behind.length, formatCappedRows(behind.map((file) => fileRow(file, UPSTREAM_CHANGE, options))));
    return;
  }
  printSection(title, behind.length, formatFolderRows(behind, columns), [
    hint('every path: ', 'pnpm cella analyze --all'),
  ]);
}

function printFlat(files: AnalyzedFile[], title: string, side: Side, options: AnalyzeReportOptions): void {
  if (files.length === 0) return;
  const rows = [...files].sort(byPath).map((file) => fileRow(file, side, options));
  printSection(title, files.length, formatCappedRows(rows));
}

function absentLines(file: AnalyzedFile): number {
  return file.upstreamLinesAbsent ?? 0;
}

/** `11 with 1–2 lines absent, 1 with none` for the pinned files a cut-short section leaves out. */
function describeAbsent(files: AnalyzedFile[]): string {
  const counts = files.map(absentLines);
  const missing = counts.filter((count) => count > 0);
  const parts: string[] = [];
  if (missing.length > 0) {
    const [low, high] = [Math.min(...missing), Math.max(...missing)];
    parts.push(`${missing.length} with ${low === high ? plural(low, 'line') : `${low}–${high} lines`} absent`);
  }
  if (missing.length < counts.length) parts.push(`${counts.length - missing.length} with none`);
  return parts.join(', ');
}

/**
 * Pinned files the fork changed. A count is upstream content the fork does not have, dropped by
 * an earlier sync or removed on purpose. A long list keeps the files missing the most.
 */
function printAhead(files: AnalyzedFile[], options: AnalyzeReportOptions): void {
  const ahead = filesWithStatus(files, 'ahead').sort((a, b) => absentLines(b) - absentLines(a) || byPath(a, b));
  if (ahead.length === 0) return;

  let shown = ahead;
  if (!options.all && ahead.length > AHEAD_FLAT_MAX) {
    const many = ahead.filter((file) => absentLines(file) >= ABSENT_SHOWN_MIN);
    shown = many.length > 0 ? many : ahead.slice(0, 5);
  }
  const rest = ahead.slice(shown.length);
  const rows = shown.map((file) =>
    fileRow(file, FORK_SIDE, options, {
      count: absentLines(file) > 0 ? String(absentLines(file)) : undefined,
      countColor: pc.yellow,
    }),
  );
  const body = formatCappedRows(rows, 'upstream lines absent');
  if (rest.length > 0) body.push(pc.dim(`  + ${rest.length} more: ${describeAbsent(rest)}`));
  const hints = ahead.some((file) => absentLines(file) > 0)
    ? [hint('what a merge would bring in: ', 'pnpm cella analyze --unpinned')]
    : [];
  printSection(pc.blue('↑ protected in fork'), ahead.length, body, hints);
}

/** A protected file upstream changed, with the override entry that protects it. */
interface ProtectedItem {
  file: AnalyzedFile;
  kind: 'new' | 'deleted' | 'changed';
  entry?: string;
}

/** The most specific `ignored` or `pinned` entry holding a path. */
function entryFinder(overrides: AnalyzeReportOptions['overrides']): (path: string) => string | undefined {
  const entries = [...(overrides?.ignored ?? []), ...(overrides?.pinned ?? [])]
    .map(normalizeEntry)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (path) => entries.find((entry) => isUnderAnyFolder(path, [entry]));
}

const KIND_ORDER = { new: 0, changed: 1, deleted: 2 };

function protectedRow(items: ProtectedItem[], options: AnalyzeReportOptions): Row {
  const [{ file, kind, entry }] = items;
  const lines = items.map((item) => item.file.upstreamChangedLines);
  const total = lines.every((count) => count !== undefined)
    ? lines.reduce<number>((sum, count) => sum + (count ?? 0), 0)
    : undefined;
  const sign = kind === 'new' ? '+' : kind === 'deleted' ? '−' : '';
  const newest = Math.max(0, ...items.map((item) => changeTimestamp(item.file, UPSTREAM_SIDE) ?? 0));
  const row: Row = {
    label: file.path,
    link: fileLink(file, UPSTREAM_SIDE, options.links),
    icon: protectionIcon(file),
    count: total === undefined ? undefined : `${sign}${compactCount(total)}`,
    countColor: kind === 'new' ? pc.green : kind === 'deleted' ? pc.red : pc.yellow,
    ...(kind === 'changed' ? {} : { tag: KIND_TAG[kind].tag, tagColor: KIND_TAG[kind].color }),
    age: newest ? shortAge(newest, options.nowMs) : undefined,
  };
  if (items.length === 1 || !entry) return row;

  const names = new Set(items.map((item) => basename(item.file.path)));
  const { upstreamGitHubUrl, upstreamSha } = options.links;
  return {
    ...row,
    label: `${entry}/`,
    note: names.size === 1 ? `· ${items.length} × ${[...names][0]}` : `· ${items.length} files`,
    link: upstreamGitHubUrl && upstreamSha ? `${upstreamGitHubUrl}/tree/${upstreamSha}/${entry}` : undefined,
  };
}

/**
 * Protected files upstream changed since the last sync, which the sync leaves as the fork has
 * them: pinned or ignored files both sides changed, and ignored files only upstream changed,
 * added or deleted. New files first, then by the lines upstream changed. Five or more of one kind
 * under one override entry collapse to a row for the entry.
 */
function printProtectedBehind(result: MergeResult, options: AnalyzeReportOptions): void {
  const findEntry = entryFinder(options.overrides);
  const ignoredOnly = new Set((result.ignoredUpstreamChanges ?? []).flatMap((group) => group.paths));
  const items: ProtectedItem[] = [
    ...findProtectedBehind(result.files).map((file) => ({ file, kind: 'changed' as const })),
    ...result.files.filter((file) => ignoredOnly.has(file.path)).map((file) => ({ file, kind: changeKind(file) })),
  ].map((item) => ({ ...item, entry: findEntry(item.file.path) }));
  if (items.length === 0) return;

  const groups = new Map<string, ProtectedItem[]>();
  for (const item of items) {
    const key = options.all || !item.entry ? item.file.path : `${item.kind}\0${item.entry}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const single = (group: ProtectedItem[]) => group.length < ENTRY_COLLAPSE_MIN;
  const lines = (group: ProtectedItem[]) => group.reduce((sum, item) => sum + (item.file.upstreamChangedLines ?? 0), 0);
  const ordered = [...groups.values()]
    .flatMap((group) => (single(group) ? group.map((item) => [item]) : [group]))
    .sort(
      (a, b) =>
        Number(a.length > 1) - Number(b.length > 1) ||
        KIND_ORDER[a[0].kind] - KIND_ORDER[b[0].kind] ||
        lines(b) - lines(a) ||
        byPath(a[0].file, b[0].file),
    );

  printSection(
    `${warningMark} ${pc.yellow('protected but behind upstream')}`,
    items.length,
    formatCappedRows(
      ordered.map((group) => protectedRow(group, options)),
      'lines changed upstream',
    ),
    [hint('the fork side wins: adopt what you need from the review page')],
  );
}

/**
 * Print the analyze file sections: behind, diverged, protected in fork, drifted, and protected but
 * behind upstream. Every `pinned`-status file is a protected-but-behind one, so there is no
 * separate `pinned` section.
 */
export function printAnalysisFileGroups(result: MergeResult, options: AnalyzeReportOptions): void {
  const columns = options.columns ?? terminalColumns();
  printBehind(result.files, options, columns);
  printFlat(filesWithStatus(result.files, 'diverged'), pc.magenta('⇅ diverged'), UPSTREAM_SIDE, options);
  printAhead(result.files, options);
  printFlat(
    filesWithStatus(result.files, 'drifted'),
    `${warningMark} ${pc.yellow('drifted from upstream')}`,
    FORK_SIDE,
    options,
  );
  printProtectedBehind(result, options);
}

/**
 * Branch mode of the stats service (`cella stats --since <ref>`).
 *
 * Counts what the current branch changed since it left a ref, by kind of file, so a pull request
 * can say where its lines went: source, tests, generated output, docs.
 */

import pc from '../utils/colors';
import { createSpinner, DIVIDER, spinnerSuccess, writeStdout } from '../utils/display';
import { git } from '../utils/git';
import { classifyFile, getWorkspacePackages, matchPackage, sourceExtensions, type WorkspacePackage } from './stats';

/** Kind of a changed file. `source` is code and styles that are none of the other kinds. */
export type ChangeKind = 'source' | 'test' | 'stories' | 'generated' | 'json' | 'docs' | 'other';

/** What a changed source line holds. */
export type LineContent = 'code' | 'comments' | 'blank';

interface LineChange {
  added: number;
  removed: number;
}

interface KindChange extends LineChange {
  files: number;
}

export interface FileChange extends LineChange {
  path: string;
  kind: ChangeKind;
}

/** What a branch changed since it left a ref */
export interface BranchStats {
  /** The ref asked for, as typed */
  since: string;
  /** Short sha of the commit the branch left the ref at */
  mergeBase: string;
  /** Current branch name, or the short sha of a detached HEAD */
  head: string;
  total: KindChange;
  kinds: Record<ChangeKind, KindChange>;
  /** Changed source lines by what they hold; null when git could not produce the patch */
  sourceContent: Record<LineContent, LineChange> | null;
  /** Changed source lines per workspace package */
  sourceByPackage: Record<string, KindChange>;
  files: FileChange[];
  /** Files with uncommitted changes, which are not counted */
  uncommitted: number;
}

const kindLabels: Record<ChangeKind, string> = {
  source: 'source',
  test: 'tests',
  stories: 'stories',
  generated: 'generated',
  json: 'json',
  docs: 'docs',
  other: 'other',
};

const docExtensions = new Set(['md', 'mdx']);

/** Lock files are written by the package manager, whatever their extension */
const lockFiles = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

/** Code and style extensions whose lines are split into code, comments and blank */
const codeExtensions = [...sourceExtensions].filter((ext) => !ext.startsWith('json'));

/**
 * Classify a changed file. Every file in a diff counts, so beyond the snapshot's categories this
 * knows docs and a rest group, and reads a lock file as generated.
 */
export function classifyChange(filePath: string): ChangeKind {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (lockFiles.has(name)) return 'generated';

  const category = classifyFile(filePath);
  if (category !== 'other') return category;

  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (docExtensions.has(ext)) return 'docs';
  return sourceExtensions.has(ext) ? 'source' : 'other';
}

/**
 * Classify one source line. A diff shows changed lines only, so a comment is recognized by how the
 * line starts: `//`, `/*`, the `*` of a block comment's body or end, and JSX's `{/*`.
 */
export function classifyLine(text: string): LineContent {
  const line = text.trim();
  if (!line) return 'blank';
  if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('{/*')) {
    return 'comments';
  }
  return 'code';
}

/** Parse `git diff --numstat -z --no-renames`: one `added<TAB>removed<TAB>path` record per file. */
export function parseNumstat(output: string): FileChange[] {
  const files: FileChange[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const [added, removed, ...rest] = record.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    // A binary file reports `-` for both counts
    files.push({
      path,
      kind: classifyChange(path),
      added: Number.parseInt(added, 10) || 0,
      removed: Number.parseInt(removed, 10) || 0,
    });
  }
  return files;
}

/**
 * Count the changed lines of a zero-context patch by what they hold, for the files `isCounted`
 * accepts. Hunk headers say how many lines follow, so a changed line that itself starts with
 * `+++` or `---` is never taken for a file header.
 */
export function countLineContent(
  patch: string,
  isCounted: (filePath: string) => boolean,
): Record<LineContent, LineChange> {
  const content: Record<LineContent, LineChange> = {
    code: { added: 0, removed: 0 },
    comments: { added: 0, removed: 0 },
    blank: { added: 0, removed: 0 },
  };

  let counted = false;
  let remaining = 0;

  for (const line of patch.split('\n')) {
    if (remaining > 0) {
      // "\ No newline at end of file" follows a line without being one
      if (line.startsWith('\\')) continue;
      remaining--;
      if (!counted) continue;
      const change = line.startsWith('+') ? 'added' : 'removed';
      content[classifyLine(line.slice(1))][change]++;
      continue;
    }

    // A path git had to quote matches no header below, so every file starts out uncounted
    if (line.startsWith('diff --git ')) {
      counted = false;
      continue;
    }

    if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      counted = isCounted(line.slice(6));
      continue;
    }

    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) remaining = Number(hunk[1] ?? 1) + Number(hunk[2] ?? 1);
  }

  return content;
}

/**
 * Collect what HEAD changed since it left `since`: committed work only, compared with the merge
 * base, which is what a pull request into that ref shows.
 */
export async function collectBranchStats(forkPath: string, since: string): Promise<BranchStats> {
  const sinceSha = await git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`], forkPath, {
    ignoreErrors: true,
  });
  if (!sinceSha) throw new Error(`unknown ref '${since}'. pass a branch, tag or commit, such as origin/main`);

  const mergeBase = await git(['merge-base', sinceSha, 'HEAD'], forkPath, { ignoreErrors: true });
  if (!mergeBase) throw new Error(`the current branch shares no history with '${since}'`);

  const range = [mergeBase, 'HEAD'];
  const files = parseNumstat(await git(['diff', '--numstat', '-z', '--no-renames', ...range], forkPath));
  const kindOf = new Map(files.map((file) => [file.path, file.kind]));

  const emptyKind = (): KindChange => ({ files: 0, added: 0, removed: 0 });
  const kinds: Record<ChangeKind, KindChange> = {
    source: emptyKind(),
    test: emptyKind(),
    stories: emptyKind(),
    generated: emptyKind(),
    json: emptyKind(),
    docs: emptyKind(),
    other: emptyKind(),
  };
  const total = emptyKind();
  const packages: WorkspacePackage[] = await getWorkspacePackages(forkPath).catch(() => []);
  const byPackage = new Map<string, KindChange>();

  const add = (target: KindChange, file: FileChange) => {
    target.files++;
    target.added += file.added;
    target.removed += file.removed;
  };

  for (const file of files) {
    add(total, file);
    add(kinds[file.kind], file);
    if (file.kind !== 'source') continue;

    const pkg = matchPackage(file.path, packages);
    const entry = byPackage.get(pkg) ?? emptyKind();
    add(entry, file);
    byPackage.set(pkg, entry);
  }

  // The patch of code files only: generated JSON can run to megabytes and holds no comments.
  const patch = await git(
    ['diff', '-U0', '--no-renames', '--no-color', ...range, '--', ...codeExtensions.map((ext) => `*.${ext}`)],
    forkPath,
    { ignoreErrors: true },
  );
  const sourceContent =
    kinds.source.files > 0 && !patch ? null : countLineContent(patch, (path) => kindOf.get(path) === 'source');

  const sourceByPackage = Object.fromEntries(
    [...byPackage.entries()].sort((a, b) => net(b[1]) - net(a[1]) || a[0].localeCompare(b[0])),
  );

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], forkPath);
  const status = await git(['status', '--porcelain'], forkPath, { ignoreErrors: true });

  return {
    since,
    mergeBase: mergeBase.slice(0, 7),
    head: branch === 'HEAD' ? await git(['rev-parse', '--short', 'HEAD'], forkPath) : branch,
    total,
    kinds,
    sourceContent,
    sourceByPackage,
    files: files.sort((a, b) => net(b) - net(a) || a.path.localeCompare(b.path)),
    uncommitted: status.split('\n').filter(Boolean).length,
  };
}

function net(change: LineChange): number {
  return change.added - change.removed;
}

/** `+12`, `-3` or a bare `0`. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Kinds that changed, the one that grew most first. */
function changedKinds(stats: BranchStats): [ChangeKind, KindChange][] {
  return (Object.entries(stats.kinds) as [ChangeKind, KindChange][])
    .filter(([, change]) => change.files > 0)
    .sort((a, b) => net(b[1]) - net(a[1]));
}

/** `code +70, comments +35, blank +15`: the net lines of each part that changed. */
function formatNetList(parts: [string, LineChange][]): string {
  return parts
    .filter(([, change]) => change.added > 0 || change.removed > 0)
    .map(([label, change]) => `${label} ${signed(net(change))}`)
    .join(', ');
}

/**
 * Format the stats as markdown for a pull request description: a table with one row per kind of
 * file, then where the source lines went.
 */
export function formatMarkdown(stats: BranchStats): string {
  const row = (label: string, change: KindChange) =>
    `| ${label} | ${change.files} | ${signed(change.added)} | ${signed(-change.removed)} | ${signed(net(change))} |`;
  const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

  const lines = [
    '| Kind | Files | Added | Removed | Net |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...changedKinds(stats).map(([kind, change]) =>
      row(kind === 'json' ? 'JSON' : capitalize(kindLabels[kind]), change),
    ),
    `| **Total** | **${stats.total.files}** | **${signed(stats.total.added)}** | **${signed(-stats.total.removed)}** | **${signed(net(stats.total))}** |`,
  ];

  const notes: string[] = [];
  if (stats.sourceContent) {
    const content = formatNetList(Object.entries(stats.sourceContent));
    if (content) notes.push(`Source lines by content: ${content}.`);
  }
  const byPackage = formatNetList(Object.entries(stats.sourceByPackage));
  if (byPackage) notes.push(`Source lines by package: ${byPackage}.`);

  return notes.length > 0 ? [...lines, '', ...notes].join('\n') : lines.join('\n');
}

/** Print the stats as aligned terminal tables. */
function printBranchStats(stats: BranchStats, verbose: boolean): void {
  const columns = (files: string, change: LineChange, label: string) =>
    `  ${files.padStart(5)} ${signed(change.added).padStart(8)} ${signed(-change.removed).padStart(8)} ${pc.cyan(signed(net(change)).padStart(8))}  ${label}`;

  console.info();
  console.info(pc.dim(`  ${'files'.padStart(5)} ${'added'.padStart(8)} ${'removed'.padStart(8)} ${'net'.padStart(8)}`));
  for (const [kind, change] of changedKinds(stats)) {
    console.info(columns(String(change.files), change, kindLabels[kind]));
  }
  console.info(columns(String(stats.total.files), stats.total, pc.bold('total')));

  if (stats.sourceContent && stats.kinds.source.files > 0) {
    console.info();
    console.info(pc.dim('  source lines by content'));
    for (const [content, change] of Object.entries(stats.sourceContent)) {
      console.info(columns('', change, content));
    }
  }

  const packages = Object.entries(stats.sourceByPackage);
  if (packages.length > 0) {
    console.info();
    console.info(pc.dim('  source lines by package'));
    for (const [name, change] of packages) {
      console.info(columns(String(change.files), change, name));
    }
  }

  if (verbose) {
    console.info();
    console.info(DIVIDER);
    console.info();
    for (const file of stats.files) {
      console.info(columns('', file, `${file.path}  ${pc.dim(kindLabels[file.kind])}`));
    }
  }

  if (stats.uncommitted > 0) {
    console.info();
    console.info(
      pc.dim(`  ${stats.uncommitted} uncommitted file${stats.uncommitted === 1 ? ' is' : 's are'} not counted`),
    );
  }

  console.info();
}

/**
 * Run the stats service in branch mode.
 */
export async function runBranchStats(
  forkPath: string,
  options: { since: string; markdown?: boolean; verbose?: boolean },
): Promise<void> {
  createSpinner('counting changed lines...');
  const stats = await collectBranchStats(forkPath, options.since);
  spinnerSuccess(`Counted what ${stats.head} changed since ${stats.since} (${stats.mergeBase})`);

  if (stats.total.files === 0) {
    console.info(pc.dim(`  nothing committed since ${stats.since}`));
    return;
  }

  if (options.markdown) {
    writeStdout(formatMarkdown(stats));
    if (stats.uncommitted > 0) console.info(pc.dim(`${stats.uncommitted} uncommitted file(s) are not counted`));
    return;
  }

  printBranchStats(stats, options.verbose ?? false);
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCommand } from '../../config/types';
import { git } from '../../utils/git';
import { alignmentFindings, type BranchChanges, owedAlignmentFindings } from './alignment-rules';
import { changedLinesFromDiff, onChangedLines } from './changed-lines';
import { commentFindings } from './comment-rules';
import { docFindings } from './doc-rules';
import { frontendFindings, frontendStores } from './frontend-rules';
import { changedLineRules } from './prose-rules';
import { type Finding, formatFinding, isRequested, openRepository, repoFiles, repoRoot } from './repo';
import { stampFindings } from './stamp-rules';
import { tailwindContext, tailwindFindings } from './tailwind-class-rules';
import { textColorFindings } from './text-color-rules';
import { tokenContrastFindings } from './token-contrast-rules';
import { loadAllowlist, productNameFindings, vocabularyFindings } from './vocabulary-rules';

export interface StyleOptions {
  /** Repo-relative paths whose files the in-file rules read; none reads every file. */
  paths: string[];
}

/** The branch's changes since its merge base with `origin/main`, uncommitted and untracked files included; empty without that ref. */
async function branchChanges(): Promise<BranchChanges> {
  const run = (...args: string[]) => git(args, repoRoot);
  try {
    const base = await run('merge-base', 'HEAD', 'origin/main');
    const untracked = await run('ls-files', '-o', '--exclude-standard');
    const paths = (diff: string) => `${diff}\n${untracked}`.split('\n').filter(Boolean);
    return {
      changed: paths(await run('diff', '--name-only', base)),
      added: paths(await run('diff', '--name-only', '--no-renames', '--diff-filter=A', base)),
      messages: await run('log', '--format=%B', `${base}..HEAD`),
    };
  } catch {
    return { changed: [], added: [], messages: '' };
  }
}

/** The `+` lines of the branch's diff since its merge base with `origin/main`, working tree included, and the untracked files; null without that ref. */
async function changedLines(): Promise<{ changed: Map<string, Set<number>> | null; untracked: Set<string> }> {
  const run = (...args: string[]) => git(args, repoRoot);
  try {
    const base = await run('merge-base', 'HEAD', 'origin/main');
    const untracked = new Set((await run('ls-files', '-o', '--exclude-standard')).split('\n').filter(Boolean));
    return { changed: changedLinesFromDiff(await run('diff', '--unified=0', '--no-color', base)), untracked };
  } catch {
    return { changed: null, untracked: new Set() };
  }
}

/** Runs every rule over the repository in `root` and prints the findings; 1 when there are any. */
async function runStyle(root: string, { paths }: StyleOptions): Promise<number> {
  await openRepository(root);
  const allowlist = await loadAllowlist();
  const files = repoFiles();
  const stores = frontendStores(files);
  const tailwind = await tailwindContext(files, allowlist.markerClasses);
  const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');

  const requested = files.filter((file) => isRequested(file, paths));
  const findings: Finding[] = paths
    .filter((path) => !files.some((file) => isRequested(file, [path])))
    .map((path) => ({ file: path, rule: 'path-argument', message: 'no file matches this path' }));
  findings.push(...alignmentFindings(requested, read));
  // Alignments are written where they live: an app's own changes to its own paths owe none. Every upgraded app has an
  // upgrade manifest, and an upgrade by a CLI before 0.5 also copied the alignments folder in, so the folder alone does
  // not mark the template.
  if (
    paths.length === 0 &&
    files.includes('cella/alignments/_TEMPLATE.md') &&
    !files.includes('cella/cella.manifest.json')
  ) {
    findings.push(...owedAlignmentFindings(await branchChanges(), read('cella/cella.config.ts')));
  }
  for (const file of requested) {
    const content = readFileSync(join(repoRoot, file));
    if (content.includes(0)) continue;
    const source = content.toString('utf8');
    const prose = allowlist.proseExclude?.some((prefix) => file.startsWith(prefix))
      ? []
      : [...docFindings(file, source), ...commentFindings(file, source)];
    const inFile = [
      ...vocabularyFindings(file, source, allowlist),
      ...productNameFindings(file, source),
      ...prose,
      ...frontendFindings(file, source, stores),
      ...stampFindings(file, source),
      ...tailwindFindings(file, source, tailwind),
      ...textColorFindings(file, source),
      ...tokenContrastFindings(file, source),
    ];
    findings.push(...inFile.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)));
  }
  const ratchet = await changedLines();
  const kept = onChangedLines(findings, changedLineRules, ratchet.changed, ratchet.untracked);
  findings.length = 0;
  findings.push(...kept);

  if (findings.length > 0) {
    console.error(
      [`[style] ${findings.length} finding(s):`, ...findings.map((finding) => `  ${formatFinding(finding)}`)].join(
        '\n',
      ),
    );
    return 1;
  }
  console.info('[style] OK, terminology, documentation, comments and frontend code follow the required style.');
  return 0;
}

export const styleCommand: ToolCommand<StyleOptions> = {
  name: 'style',
  group: 'gate',
  description: 'the style check: terminology, docs, comments and frontend code; exits 1 on any finding',
  jobs: [],
  operands: ['[paths...]', 'limit the files the in-file rules read to these repo-relative paths'],
  parse: ({ operands }) => ({ paths: operands }),
  run: runStyle,
};

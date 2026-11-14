import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultUpstreamRemote } from '../config/load';
import { readUpgradePoint } from '../upstream/upgrade-point';
import { git } from '../utils/git';
import { parseUnifiedDiff } from '../utils/unified-diff';
import type { Finding } from './rule';

/** What a branch changes against its base: every changed path, the paths it adds, and its commit messages. */
export interface BranchChanges {
  changed: string[];
  added: string[];
  messages: string;
}

/** Git in the repository, printing a non-ASCII path as is: the rules look paths up by their name on disk. */
const run = (root: string, ...args: string[]) => git(['-c', 'core.quotePath=false', ...args], root);

/** The branch's changes since `base`, uncommitted and untracked files included. */
export async function branchChanges(root: string, base: string): Promise<BranchChanges> {
  const untracked = await run(root, 'ls-files', '-o', '--exclude-standard');
  const paths = (diff: string) => `${diff}\n${untracked}`.split('\n').filter(Boolean);
  return {
    changed: paths(await run(root, 'diff', '--name-only', base)),
    added: paths(await run(root, 'diff', '--name-only', '--no-renames', '--diff-filter=A', base)),
    messages: await run(root, 'log', '--format=%B', `${base}..HEAD`),
  };
}

/** The lines of each file a zero-context diff adds or changes, from the `+` side of its hunks. */
export function changedLinesFromDiff(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  for (const { newPath, hunks } of parseUnifiedDiff(diff)) {
    if (!newPath || hunks.length === 0) continue;
    const set = lines.get(newPath) ?? new Set<number>();
    for (const { newStart, newCount } of hunks) for (let i = 0; i < newCount; i++) set.add(newStart + i);
    lines.set(newPath, set);
  }
  return lines;
}

/**
 * The `+` lines of the branch's diff since `base`, working tree included, and the untracked files. In an app (it has
 * the upgrade's upstream remote), a line of `files` identical to a line of upstream's copy at the manifest's upstream
 * commit is upstream's, so an upgrade's own lines do not count.
 */
export async function changedLines(
  root: string,
  base: string,
  files: Set<string>,
): Promise<{ changed: Map<string, Set<number>>; untracked: Set<string> }> {
  const untracked = new Set((await run(root, 'ls-files', '-o', '--exclude-standard')).split('\n').filter(Boolean));
  const changed = changedLinesFromDiff(await run(root, 'diff', '--unified=0', '--no-color', base));
  const isApp = await git(['remote', 'get-url', defaultUpstreamRemote], root, { ignoreErrors: true });
  const upstream = isApp ? await readUpgradePoint(root) : null;
  for (const file of upstream ? files : []) {
    const lines = changed.get(file);
    const theirs = await git(['show', `${upstream}:${file}`], root, { ignoreErrors: true });
    if (!lines || !theirs) continue;
    const upstreamLines = new Set(theirs.split('\n'));
    const ours = readFileSync(join(root, file), 'utf8').split('\n');
    for (const line of lines) if (upstreamLines.has(ours[line - 1])) lines.delete(line);
  }
  return { changed, untracked };
}

/**
 * Keeps a finding of a changed-line rule only on a line the branch changed; an untracked file counts whole, and a
 * finding of any other rule passes. Without a base (`changed` is null) the changed-line rules report nothing.
 */
export function onChangedLines(
  findings: Finding[],
  rules: Set<string>,
  changed: Map<string, Set<number>> | null,
  untracked: Set<string>,
): Finding[] {
  return findings.filter((finding) => {
    if (!rules.has(finding.rule)) return true;
    if (changed === null) return false;
    if (untracked.has(finding.file)) return true;
    return finding.line !== undefined && (changed.get(finding.file)?.has(finding.line) ?? false);
  });
}

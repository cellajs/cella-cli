import { parseUnifiedDiff } from '../utils/unified-diff';
import type { Finding } from './repo';

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

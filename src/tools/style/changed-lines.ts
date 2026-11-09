import type { Finding } from './repo';

/** The lines of each file a diff adds or changes, from the `+` side of its unified hunks. */
export function changedLinesFromDiff(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let file = '';
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const set = lines.get(file) ?? new Set<number>();
    for (let i = 0; i < count; i++) set.add(start + i);
    lines.set(file, set);
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

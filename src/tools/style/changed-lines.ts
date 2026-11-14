import type { Finding } from './repo';

/**
 * The lines of each file a zero-context diff adds or changes, from the `+` side of its hunks. Hunk headers say how many
 * lines follow, so a changed line that itself starts with `+++ b/` is never taken for a file header.
 */
export function changedLinesFromDiff(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let file = '';
  let remaining = 0;
  for (const line of diff.split('\n')) {
    if (remaining > 0) {
      // "\ No newline at end of file" follows a line without being one
      if (!line.startsWith('\\')) remaining--;
      continue;
    }
    // A path git had to quote matches no header, so its hunks count for no file
    if (line.startsWith('diff --git ')) file = '';
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[2]);
    const count = hunk[3] === undefined ? 1 : Number(hunk[3]);
    remaining = Number(hunk[1] ?? 1) + count;
    if (!file) continue;
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

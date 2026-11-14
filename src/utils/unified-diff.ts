/** One hunk of a zero-context diff. */
interface DiffHunk {
  /** First line of the new side; with `newCount` 0, the line the removal follows. */
  newStart: number;
  newCount: number;
  /** The hunk's lines with their `+` or `-` sign; "\ No newline at end of file" left out. */
  lines: string[];
}

/** One file of a diff. A path is null for `/dev/null` and for a path git had to quote. */
interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

/**
 * The files of a zero-context diff (`git diff --unified=0`). Hunk headers say how many lines follow, so a changed
 * line that itself starts with `+++ b/` or `--- a/` is never taken for a file header.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let remaining = 0;
  for (const line of diff.split('\n')) {
    if (remaining > 0) {
      // "\ No newline at end of file" follows a line without being one
      if (line.startsWith('\\')) continue;
      remaining--;
      hunk?.lines.push(line);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      continue;
    }
    const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunk = { newStart: Number(header[2]), newCount: Number(header[3] ?? 1), lines: [] };
      file?.hunks.push(hunk);
      remaining = Number(header[1] ?? 1) + hunk.newCount;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('--- a/')) file.oldPath = line.slice(6) || null;
    else if (line.startsWith('+++ b/')) file.newPath = line.slice(6) || null;
  }
  return files;
}

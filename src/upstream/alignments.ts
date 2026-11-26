import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { git, splitPrNumber } from '../utils/git';
import { writeOwnedFile } from '../utils/repo-files';
import { printable } from '../utils/terminal-text';

/**
 * Upstream folder holding one subfolder per breaking change: a README.md that opens with flat frontmatter, then the
 * title and a summary paragraph, plus at most one codemod (the one non-test `.ts` file). Upstream-only: the upgrade
 * never brings it into an app and removes a copy it finds. Alignments are read from upstream commits the upgrade
 * already fetched.
 */
export const alignmentsDir = 'cella/alignments';

/**
 * The app's record of alignments still to handle, as `{ "pending": [...] }`: the upgrade adds the ones that arrive with
 * it, and `cella align mark` removes them. A missing file means nothing is pending, so a new app needs no seed. A
 * pending alignment is information, never a gate.
 */
export const pendingFile = 'cella/cella.alignments.json';

/** An alignment folder name: `<YYYYMMDDThhmm>-<slug>`, UTC minute precision, so ids sort chronologically. */
export const alignmentId = /^\d{8}T\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What catches app code the change leaves behind: the typecheck, the tests the app inherits, or nothing. */
export const caughtBy = ['compiler', 'tests', 'nothing'] as const;

type CaughtBy = (typeof caughtBy)[number];

/** One alignment, as read at an upstream ref. */
export interface Alignment {
  id: string;
  /** The README's `# ` heading; the id when the README has none. */
  title: string;
  /** The paragraph under the title. */
  summary: string;
  /** Changes upstream in a way app-specific code must follow. */
  breaking: boolean;
  /** Bumped `clientCacheVersion` or shipped a lens module. */
  clientCacheBump: boolean;
  /** Null when the frontmatter names none, or a value outside {@link CaughtBy}. */
  caughtBy: CaughtBy | null;
  /** The change needs `pnpm generate`. */
  generate: boolean;
  /** Identifiers, wire fields or config keys app code may still use, matched as {@link grepAlignmentTerms} says. */
  grep: string[];
  /** Default scan roots for the codemod. */
  roots: string[];
  /** File name of the codemod inside the alignment folder, or null for a manual one. */
  codemod: string | null;
}

/** Where an alignment came from: the upstream commit that added its README. */
interface AlignmentSource {
  commit: string;
  /** From a trailing `(#NNNN)` in the commit subject, as squash merges write it; null without one. */
  pr: number | null;
  /** Ids of the other alignments the same commit added. */
  sharedCommit: string[];
  /** Every path the commit changed. */
  changedFiles: string[];
}

/** Whether a file in an alignment folder is a codemod script: a `.ts` file that is not a test. */
export function isCodemodFile(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts');
}

/** A comma-separated frontmatter value as a list, empty items dropped. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Whether a path is upstream-only: the upgrade never brings it in and removes an app copy. */
export function isUpstreamOnly(filePath: string): boolean {
  return filePath === alignmentsDir || filePath.startsWith(`${alignmentsDir}/`);
}

/** The lines after the frontmatter, without HTML comment lines (a comment opens at the start of a line). */
export function bodyLines(lines: string[]): string[] {
  let inComment = false;
  return lines.filter((line) => {
    if (!inComment && !line.trimStart().startsWith('<!--')) return true;
    inComment = !line.includes('-->');
    return false;
  });
}

/** Parse an alignment README. Unreadable frontmatter values fall back to false, null or empty. */
export function parseAlignment(id: string, source: string, fileNames: string[]): Alignment {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, Math.max(close, 1))) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (match) meta.set(match[1], match[2].trim());
  }

  const body = bodyLines(lines.slice(close + 1)).join('\n');
  const blocks = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const title = /^# (.+)$/.exec(blocks[0] ?? '')?.[1].trim();
  const summary = title && blocks[1] && !/^(#|>|[-*|]|```)/.test(blocks[1]) ? blocks[1].replace(/\s*\n\s*/g, ' ') : '';
  const caughtByValue = caughtBy.find((value) => value === meta.get('caughtBy')) ?? null;

  return {
    id,
    title: printable(title || id),
    summary: printable(summary),
    breaking: meta.get('breaking') === 'true',
    clientCacheBump: meta.get('clientCacheBump') === 'true',
    caughtBy: caughtByValue,
    generate: meta.get('generate') === 'true',
    grep: splitList(meta.get('grep')),
    roots: splitList(meta.get('roots')),
    codemod: fileNames.find(isCodemodFile) ?? null,
  };
}

/** Ids of every alignment at `ref`, oldest first; empty when the ref has no alignments folder. */
export async function listAlignmentIds(cwd: string, ref: string): Promise<string[]> {
  const out = await git(['ls-tree', '--name-only', `${ref}:${alignmentsDir}`], cwd, { ignoreErrors: true });
  return out
    .split('\n')
    .filter((name) => alignmentId.test(name))
    .sort();
}

/** One alignment at `ref`, or null when its README is not there. */
export async function readAlignment(cwd: string, ref: string, id: string): Promise<Alignment | null> {
  const source = await git(['show', `${ref}:${alignmentsDir}/${id}/README.md`], cwd, { ignoreErrors: true });
  if (!source) return null;
  const files = await git(['ls-tree', '--name-only', `${ref}:${alignmentsDir}/${id}`], cwd, { ignoreErrors: true });
  return parseAlignment(id, source, files.split('\n').filter(Boolean));
}

/** Alignments upstream added between two commits: present at `to`, absent at `from`. */
export async function arrivedAlignmentIds(cwd: string, from: string, to: string): Promise<string[]> {
  const [before, after] = await Promise.all([listAlignmentIds(cwd, from), listAlignmentIds(cwd, to)]);
  const known = new Set(before);
  return after.filter((id) => !known.has(id));
}

/** The upstream commit at or before `ref` that added the alignment's README; null when git finds none. */
export async function readAlignmentSource(cwd: string, ref: string, id: string): Promise<AlignmentSource | null> {
  const out = await git(['log', '-1', '--diff-filter=A', '--format=%H%x09%s', ref, '--', `${alignmentsDir}/${id}/README.md`], cwd, {
    ignoreErrors: true,
  });
  if (!out) return null;
  const [commit, subject = ''] = out.split('\t');
  const { pr = null } = splitPrNumber(subject);

  const nulSeparated = (text: string) => text.split('\0').filter(Boolean);
  const [changed, added] = await Promise.all([
    git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', commit], cwd),
    git(['diff-tree', '--root', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', '-z', commit, '--', alignmentsDir], cwd),
  ]);
  const readmeId = new RegExp(`^${alignmentsDir}/([^/]+)/README\\.md$`);
  const sharedCommit = nulSeparated(added)
    .map((path) => readmeId.exec(path)?.[1])
    .filter((other): other is string => !!other && other !== id && alignmentId.test(other))
    .sort();

  return { commit, pr, sharedCommit, changedFiles: nulSeparated(changed) };
}

/**
 * Lines in the working tree where any of `terms` occurs, limited to the files `inFiles` accepts,
 * sorted by file and line. Terms match as fixed strings. A term that starts and ends with a letter
 * or digit matches as a whole word. Any other term, such as `.results` or the prefix `onboarding_`,
 * matches anywhere, because git's `-w` would also demand a non-word character beside that edge.
 * An empty list yields no hits.
 */
export async function grepAlignmentTerms(
  cwd: string,
  terms: string[],
  inFiles: (path: string) => boolean,
): Promise<Array<{ file: string; line: number }>> {
  const isWord = (term: string) => /^[a-z0-9]/i.test(term) && /[a-z0-9]$/i.test(term);
  const grep = async (flags: string[], matching: string[]) =>
    matching.length === 0
      ? ''
      : git(['grep', '-n', '-I', ...flags, '-F', '-z', ...matching.flatMap((term) => ['-e', term]), '--'], cwd, {
          ignoreErrors: true,
        });
  const outputs = await Promise.all([
    grep(['-w'], terms.filter(isWord)),
    grep(
      [],
      terms.filter((t) => !isWord(t)),
    ),
  ]);
  const hits = new Map<string, { file: string; line: number }>();
  // With -z each match is `<path>\0<line>\0<text>`, one match per output line
  for (const [file, line] of outputs
    .join('\n')
    .split('\n')
    .map((match) => match.split('\0'))) {
    if (file && line && inFiles(file)) hits.set(`${file}\0${line}`, { file, line: Number(line) });
  }
  return [...hits.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The app's pending alignment ids. A missing file is an empty list. */
export async function readPending(cwd: string): Promise<string[]> {
  const path = join(cwd, pendingFile);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { pending?: unknown };
  return Array.isArray(parsed.pending) ? parsed.pending.filter((id): id is string => typeof id === 'string') : [];
}

/** Write the pending ids, sorted and de-duplicated; an empty list deletes the file. */
export async function writePending(cwd: string, ids: string[]): Promise<void> {
  const path = join(cwd, pendingFile);
  const pending = [...new Set(ids)].sort();
  if (pending.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeOwnedFile(path, `${JSON.stringify({ pending }, null, 2)}\n`);
}

/** GitHub permalink to an alignment's README at a commit, when upstream is on GitHub. */
export function alignmentUrl(upstreamGitHubUrl: string | undefined, commit: string, id: string): string | undefined {
  return upstreamGitHubUrl ? `${upstreamGitHubUrl}/blob/${commit}/${alignmentsDir}/${id}/README.md` : undefined;
}

/**
 * The info line `cella align` ends with, e.g. `alignments: 94 of 97 handled · 3 open: pnpm cella align`.
 * Analyze and upgrade list the alignments under their `next steps` instead.
 */
export function formatAlignmentsLine(total: number, open: number): string {
  const parts = [open === 0 ? `all ${total} handled` : `${Math.max(0, total - open)} of ${total} handled`];
  if (open > 0) parts.push(`${open} open: pnpm cella align`);
  return `alignments: ${parts.join(' · ')}`;
}

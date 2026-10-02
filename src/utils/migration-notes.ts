/**
 * Upstream migration notes, read from git.
 *
 * Upstream ships one note per sync-breaking change in `cella/migrations/<id>/`: a README.md that
 * opens with flat frontmatter, then the title and a summary paragraph, plus at most one codemod
 * (the one non-test `.ts` file). The folder is upstream-only: the sync never brings it into the
 * fork and removes a copy it finds. Notes are read from upstream commits the sync already fetched.
 *
 * The fork records only the notes it has not handled yet, in `cella/cella.migrations.json` as
 * `{ "pending": [...] }`. The sync adds the notes that arrive with it; `cella migrate --mark`
 * removes them. A missing file means nothing is pending, so a new app needs no seed. Notes are
 * information, never a gate: nothing blocks on a pending note.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from './git';

/** Upstream folder holding one subfolder per note. Upstream-only: never synced into a fork. */
export const NOTES_DIR = 'cella/migrations';

/** The fork's record of notes still to handle. */
export const PENDING_FILE = 'cella/cella.migrations.json';

/** A note folder name: `<YYYYMMDDThhmm>-<slug>`, UTC minute precision, so ids sort chronologically. */
const NOTE_ID = /^\d{8}T\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One note, as read at an upstream ref. */
export interface MigrationNote {
  id: string;
  /** The README's `# ` heading; the id when the README has none. */
  title: string;
  /** The paragraph under the title. */
  summary: string;
  /** Changes upstream in a way app-specific code must follow. */
  syncBreaking: boolean;
  /** Bumped `clientCacheVersion` or shipped a lens module. */
  clientCacheBump: boolean;
  /** Default scan roots for the codemod. */
  roots: string[];
  /** File name of the codemod inside the note folder, or null for a manual note. */
  codemod: string | null;
}

/** Whether a path is upstream-only: the sync never brings it in and removes a fork copy. */
export function isUpstreamOnly(filePath: string): boolean {
  return filePath === NOTES_DIR || filePath.startsWith(`${NOTES_DIR}/`);
}

/** Parse a note README. Unreadable frontmatter values fall back to false/empty. */
export function parseNote(id: string, source: string, fileNames: string[]): MigrationNote {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, Math.max(close, 1))) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (match) meta.set(match[1], match[2].trim());
  }

  const body = lines
    .slice(close + 1)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  const blocks = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const title = /^# (.+)$/.exec(blocks[0] ?? '')?.[1].trim();
  const summary = title && blocks[1] && !/^(#|>|[-*|]|```)/.test(blocks[1]) ? blocks[1].replace(/\s*\n\s*/g, ' ') : '';

  return {
    id,
    title: title || id,
    summary,
    syncBreaking: meta.get('syncBreaking') === 'true',
    clientCacheBump: meta.get('clientCacheBump') === 'true',
    roots: (meta.get('roots') ?? '')
      .split(',')
      .map((root) => root.trim())
      .filter(Boolean),
    codemod: fileNames.find((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')) ?? null,
  };
}

/** Ids of every note at `ref`, oldest first; empty when the ref has no notes folder. */
export async function listNoteIds(cwd: string, ref: string): Promise<string[]> {
  const out = await git(['ls-tree', '--name-only', `${ref}:${NOTES_DIR}`], cwd, { ignoreErrors: true });
  return out
    .split('\n')
    .filter((name) => NOTE_ID.test(name))
    .sort();
}

/** One note at `ref`, or null when its README is not there. */
export async function readNote(cwd: string, ref: string, id: string): Promise<MigrationNote | null> {
  const source = await git(['show', `${ref}:${NOTES_DIR}/${id}/README.md`], cwd, { ignoreErrors: true });
  if (!source) return null;
  const files = await git(['ls-tree', '--name-only', `${ref}:${NOTES_DIR}/${id}`], cwd, { ignoreErrors: true });
  return parseNote(id, source, files.split('\n').filter(Boolean));
}

/** Notes upstream added between two commits: present at `to`, absent at `from`. */
export async function arrivedNoteIds(cwd: string, from: string, to: string): Promise<string[]> {
  const [before, after] = await Promise.all([listNoteIds(cwd, from), listNoteIds(cwd, to)]);
  const known = new Set(before);
  return after.filter((id) => !known.has(id));
}

/**
 * The fork's pending note ids. A missing file is an empty list. A file still in the older
 * `{ "applied": [...] }` shape converts once: pending = notes at `syncRef` minus applied.
 */
export async function readPending(cwd: string, syncRef: string | null): Promise<string[]> {
  const path = join(cwd, PENDING_FILE);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { pending?: unknown; applied?: unknown };
  if (Array.isArray(parsed.pending)) return parsed.pending.filter((id): id is string => typeof id === 'string');
  if (!Array.isArray(parsed.applied) || !syncRef) return [];
  const applied = new Set(parsed.applied);
  return (await listNoteIds(cwd, syncRef)).filter((id) => !applied.has(id));
}

/** Write the pending ids, sorted and de-duplicated; an empty list deletes the file. */
export async function writePending(cwd: string, ids: string[]): Promise<void> {
  const path = join(cwd, PENDING_FILE);
  const pending = [...new Set(ids)].sort();
  if (pending.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ pending }, null, 2)}\n`, 'utf8');
}

/** GitHub permalink to a note's README at a commit, when upstream is on GitHub. */
export function noteUrl(upstreamGitHubUrl: string | undefined, commit: string, id: string): string | undefined {
  return upstreamGitHubUrl ? `${upstreamGitHubUrl}/blob/${commit}/${NOTES_DIR}/${id}/README.md` : undefined;
}

/**
 * The one info line sync, analyze and migrate print, e.g.
 * `migration notes: 94 of 97 handled · 3 arrived with this sync · 3 open: pnpm cella migrate`.
 */
export function formatNotesLine(
  total: number,
  open: number,
  arrived?: number,
  options: { dryRun?: boolean } = {},
): string {
  const parts = [open === 0 ? `all ${total} handled` : `${Math.max(0, total - open)} of ${total} handled`];
  if (arrived) parts.push(`${arrived} ${options.dryRun ? 'arrive' : 'arrived'} with this sync`);
  if (open > 0) parts.push(`${open} open: pnpm cella migrate`);
  return `migration notes: ${parts.join(' · ')}`;
}

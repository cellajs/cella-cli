/**
 * Migrate service: the upstream migration notes this fork has not handled yet.
 *
 * Notes live upstream only (see `utils/migration-notes`). They are read at the upstream commit the
 * fork last synced to, which the sync already fetched, so this works offline after a sync and
 * while a conflicted sync is still open. Each note also gets a GitHub permalink for readers
 * without the upstream remote. Nothing here blocks: the list is information to act on.
 *
 * `--run` runs a note's codemod from an extracted copy and puts back the files it changed that
 * were identical to upstream (see `runNote`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MergeResult, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { DEFAULT_UPSTREAM_REMOTE } from '../utils/config';
import { writeStdout } from '../utils/display';
import {
  batchRestoreWorktreeFromRef,
  ensureRemote,
  fetch,
  getStoredSyncRef,
  git,
  listIdenticalToRef,
  readManifestBaseAtRef,
} from '../utils/git';
import { readManifestBase } from '../utils/manifest';
import {
  formatNotesLine,
  isCodemodFile,
  listNoteIds,
  type MigrationNote,
  NOTES_DIR,
  noteUrl,
  readNote,
  readPending,
  writePending,
} from '../utils/migration-notes';
import { getGitHubBaseUrl } from './merge-engine';

/** Where `--extract` writes a note folder: inside the fork, so a codemod resolves the fork's packages. */
const EXTRACT_DIR = 'node_modules/.cache/cella/migrations';

/** How many restored paths `--run` lists before it cuts the list short. */
const RESTORED_LIST_MAX = 20;

/** Make sure an upstream commit is in this clone, fetching upstream once when it is not. */
async function ensureUpstreamCommit(config: RuntimeConfig, sha: string): Promise<void> {
  const { forkPath } = config;
  const present = async () =>
    !!(await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], forkPath, { ignoreErrors: true }));
  if (await present()) return;
  await ensureRemote(forkPath, DEFAULT_UPSTREAM_REMOTE, config.settings.upstreamUrl);
  await fetch(forkPath, DEFAULT_UPSTREAM_REMOTE);
  if (!(await present()))
    throw new Error(`upstream commit ${sha.slice(0, 7)} is not reachable from '${DEFAULT_UPSTREAM_REMOTE}'`);
}

/** The upstream commit the fork last synced to, fetched if this clone lacks it; null before any sync. */
async function resolveNotesRef(config: RuntimeConfig): Promise<string | null> {
  const { forkPath } = config;
  const ref = (await getStoredSyncRef(forkPath)) ?? (await readManifestBaseAtRef(forkPath, 'HEAD'));
  if (!ref) return null;
  await ensureUpstreamCommit(config, ref);
  return ref;
}

/** Open and total note counts at the fork's sync point, for the info line; null before any sync. */
async function readNotesStatus(config: RuntimeConfig): Promise<{ total: number; open: number } | null> {
  try {
    const ref = await resolveNotesRef(config);
    if (!ref) return null;
    const [ids, pending] = await Promise.all([listNoteIds(config.forkPath, ref), readPending(config.forkPath, ref)]);
    return ids.length > 0 || pending.length > 0 ? { total: ids.length, open: pending.length } : null;
  } catch {
    return null;
  }
}

/** Print the dim info line at the end of a sync or analyze run. Never fails the run. */
export async function printMigrationNotesLine(config: RuntimeConfig, result?: MergeResult): Promise<void> {
  const notes = result?.migrationNotes;
  if (notes) {
    if (notes.total === 0) return;
    console.info();
    console.info(
      pc.dim(formatNotesLine(notes.total, notes.open, notes.arrived.length, { dryRun: config.service === 'analyze' })),
    );
    return;
  }
  const status = await readNotesStatus(config);
  if (!status) return;
  console.info();
  console.info(pc.dim(formatNotesLine(status.total, status.open)));
}

/** One note as `--json` reports it. */
function toJson(note: MigrationNote, url: string | undefined, open: boolean) {
  return { ...note, kind: note.codemod ? 'codemod' : 'manual', open, url: url ?? null };
}

/** Print one note in the human list. */
function printNote(index: number, note: MigrationNote, url: string | undefined): void {
  const tags = [
    note.codemod ? 'codemod' : 'manual',
    note.syncBreaking ? 'sync-breaking' : null,
    note.clientCacheBump ? 'cache-bump' : null,
  ]
    .filter(Boolean)
    .join(', ');
  console.info(`${index}. ${note.title}  ${pc.dim(`[${tags}]`)}`);
  console.info(pc.dim(`   id:      ${note.id}`));
  if (note.summary) console.info(`   ${note.summary}`);
  console.info(pc.dim(`   read:    pnpm cella migrate --show ${note.id}`));
  if (url) console.info(pc.dim(`            ${url}`));
  if (note.codemod) console.info(pc.dim(`   codemod: pnpm cella migrate --run ${note.id}`));
  console.info();
}

/**
 * Write a note's folder under {@link EXTRACT_DIR}, byte for byte. Returns the note, the folder
 * (relative to the fork) and its files.
 */
async function writeNoteFolder(
  config: RuntimeConfig,
  ref: string,
  id: string,
): Promise<{ note: MigrationNote; target: string; files: string[] }> {
  const { forkPath } = config;
  const note = await readNote(forkPath, ref, id);
  if (!note) throw new Error(`no migration note '${id}' at upstream ${ref.slice(0, 7)}`);

  const files = (await git(['ls-tree', '-r', '--name-only', `${ref}:${NOTES_DIR}/${id}`], forkPath))
    .split('\n')
    .filter(Boolean);
  const target = join(EXTRACT_DIR, id);
  for (const file of files) {
    // Byte for byte: the git helper trims its output.
    const content = execFileSync('git', ['show', `${ref}:${NOTES_DIR}/${id}/${file}`], {
      cwd: forkPath,
      maxBuffer: 50 * 1024 * 1024,
    });
    const path = join(forkPath, target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { note, target, files };
}

/** `--extract <id>`: write the note folder under {@link EXTRACT_DIR} and print how to run its codemod. */
async function extractNote(config: RuntimeConfig, ref: string, id: string): Promise<void> {
  const { note, target, files } = await writeNoteFolder(config, ref, id);

  console.info(`${pc.green('✓')} extracted ${files.length} file(s) to ${target}/`);
  console.info(pc.dim(`  the README's ${NOTES_DIR}/${id}/ paths are this folder.`));
  if (note.codemod) {
    console.info(pc.dim(`  pnpm exec tsx ${target}/${note.codemod} inventory ${note.roots.join(' ')}`));
    console.info(pc.dim(`  or, keeping files identical to upstream as they are: pnpm cella migrate --run ${id}`));
  }
}

/**
 * The codemod of an extracted note: the file named with `--script`, else the one script in the
 * folder itself. Throws when the folder holds no script or several.
 */
function resolveCodemod(id: string, files: string[], script?: string): string {
  if (script) {
    const name = script.replace(/^\.\//, '');
    if (!files.includes(name)) {
      throw new Error(`migration note '${id}' has no file '${script}'. its files: ${files.join(', ')}`);
    }
    return name;
  }
  const scripts = files.filter((file) => !file.includes('/') && isCodemodFile(file));
  if (scripts.length === 0) {
    throw new Error(
      `migration note '${id}' ships no codemod script: its steps are manual, read them with \`pnpm cella migrate --show ${id}\`.`,
    );
  }
  if (scripts.length > 1) {
    throw new Error(
      `migration note '${id}' ships ${scripts.length} scripts (${scripts.join(', ')}): name the one to run with --script <file>.`,
    );
  }
  return scripts[0];
}

/**
 * `--run <id>`: extract the note and run its codemod with `tsx` from the fork root, with the
 * arguments given after `--`, else `inventory` (report only) and the note's roots.
 *
 * A codemod's roots cover template-owned files too. A file identical to upstream already is the way
 * upstream wants it, so a rewrite there is drift (upstream may have changed the file after writing
 * the codemod). Files identical to the last synced upstream commit before the run, and changed by
 * it, get their upstream content back. That commit is `upstream.commit` in the working tree's
 * manifest, during a staged sync the incoming commit. The whole working tree is compared, so the
 * roots named after `--` are covered whichever they are.
 */
async function runNote(config: RuntimeConfig, ref: string, id: string): Promise<void> {
  const { forkPath } = config;
  const { note, target, files } = await writeNoteFolder(config, ref, id);
  const script = join(target, resolveCodemod(id, files, config.script));
  const args = config.runArgs?.length ? config.runArgs : ['inventory', ...note.roots];

  const upstreamCommit = (await readManifestBase(forkPath)) ?? ref;
  await ensureUpstreamCommit(config, upstreamCommit);
  const identical = await listIdenticalToRef(forkPath, upstreamCommit);

  console.info(pc.dim(`running pnpm exec tsx ${script} ${args.join(' ')}`));
  console.info();
  const child = spawnSync('pnpm', ['exec', 'tsx', script, ...args], { cwd: forkPath, stdio: 'inherit' });
  if (child.error) throw new Error(`could not run the codemod: ${child.error.message}`);

  // Also after a failed run: a codemod that stopped halfway may have rewritten files already.
  const stillIdentical = await listIdenticalToRef(forkPath, upstreamCommit);
  const restored = [...identical].filter((path) => !stillIdentical.has(path)).sort();
  await batchRestoreWorktreeFromRef(forkPath, upstreamCommit, restored);

  const upstreamShort = upstreamCommit.slice(0, 9);
  console.info();
  if (restored.length > 0) {
    console.info(`${pc.green('✓')} restored ${restored.length} file(s) to upstream ${upstreamShort}`);
    console.info(pc.dim('  the codemod changed them, and they were identical to upstream before the run:'));
    for (const path of restored.slice(0, RESTORED_LIST_MAX)) console.info(pc.dim(`    ${path}`));
    if (restored.length > RESTORED_LIST_MAX) {
      console.info(pc.dim(`    ... + ${restored.length - RESTORED_LIST_MAX} more`));
    }
  } else {
    console.info(pc.dim(`no file identical to upstream ${upstreamShort} was changed by the codemod.`));
  }

  if (child.status !== 0) throw new Error(`the codemod exited with code ${child.status ?? 'unknown'}`);
  if (!config.runArgs?.length) {
    const apply = ['rewrite', ...note.roots].join(' ');
    console.info(pc.dim(`report only. to apply: pnpm cella migrate --run ${id} -- ${apply}`));
  }
}

/** `--mark <ids…>`: drop handled notes from the pending list. */
async function markNotes(config: RuntimeConfig, ref: string, pending: string[], ids: string[]): Promise<void> {
  const open = new Set(pending);
  const unknown = ids.filter((id) => !open.has(id));
  for (const id of ids) open.delete(id);
  await writePending(config.forkPath, [...open]);
  const marked = ids.length - unknown.length;
  if (marked > 0) console.info(`${pc.green('✓')} recorded ${marked} note(s) as handled`);
  if (unknown.length > 0) console.info(pc.dim(`not pending, left as is: ${unknown.join(', ')}`));
  console.info(pc.dim(formatNotesLine((await listNoteIds(config.forkPath, ref)).length, open.size)));
}

/** Run the migrate service. */
export async function runMigrate(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;
  const ref = await resolveNotesRef(config);
  if (!ref) {
    console.info(pc.dim('no sync point recorded yet: migration notes start with the first `pnpm cella sync`.'));
    return;
  }

  const pending = await readPending(forkPath, ref);
  const githubUrl = getGitHubBaseUrl(config.settings.upstreamUrl) ?? undefined;
  const urlOf = (id: string) => noteUrl(githubUrl, ref, id);

  if (config.mark?.length) return markNotes(config, ref, pending, config.mark);
  if (config.run) return runNote(config, ref, config.run);
  if (config.extract) return extractNote(config, ref, config.extract);

  if (config.show) {
    const source = await git(['show', `${ref}:${NOTES_DIR}/${config.show}/README.md`], forkPath, {
      ignoreErrors: true,
    });
    if (!source) throw new Error(`no migration note '${config.show}' at upstream ${ref.slice(0, 7)}`);
    const url = urlOf(config.show);
    if (url) console.info(pc.dim(url));
    console.info(source);
    return;
  }

  const ids = config.all ? await listNoteIds(forkPath, ref) : pending;
  const notes = (await Promise.all(ids.map((id) => readNote(forkPath, ref, id)))).map(
    (note, i) =>
      note ?? {
        id: ids[i],
        title: `${ids[i]} (no longer upstream)`,
        summary: '',
        syncBreaking: false,
        clientCacheBump: false,
        roots: [],
        codemod: null,
      },
  );
  const total = (await listNoteIds(forkPath, ref)).length;

  if (config.json) {
    const open = new Set(pending);
    const out = {
      upstreamCommit: ref,
      total,
      open: pending.length,
      notes: notes.map((note) => toJson(note, urlOf(note.id), open.has(note.id))),
    };
    writeStdout(JSON.stringify(out, null, 2));
    return;
  }

  console.info(pc.dim(formatNotesLine(total, pending.length)));
  if (notes.length === 0) return;
  console.info();
  for (const [i, note] of notes.entries()) printNote(i + 1, note, urlOf(note.id));
  if (pending.length > 0) {
    console.info(pc.dim("work each note's README, check with `pnpm check`, then record it:"));
    console.info(pc.dim(`  pnpm cella migrate --mark ${pending.join(' ')}`));
  }
}

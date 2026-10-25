/**
 * Align service: the upstream alignments this fork has not handled yet.
 *
 * Alignments live upstream only (see `utils/alignments`). They are read at the upstream commit the
 * fork last synced to, which the sync already fetched, so this works offline after a sync and
 * while a conflicted sync is still open. Each alignment also gets a GitHub permalink for readers
 * without the upstream remote. Nothing here blocks: the list is information to act on.
 *
 * Next to what the README says, each alignment shows what git can tell about it: the upstream
 * commit and PR that added it, the files of that commit the app owns or changed, and where app
 * code still uses the README's `grep` terms (see `describeAlignment`).
 *
 * `--run` runs an alignment's codemod from an extracted copy and puts back the files it changed
 * that were identical to upstream (see `runAlignment`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MergeResult, RuntimeConfig } from '../config/types';
import {
  ALIGNMENTS_DIR,
  type Alignment,
  alignmentUrl,
  formatAlignmentsLine,
  grepAlignmentTerms,
  isUpstreamOnly,
  listAlignmentIds,
  readAlignment,
  readAlignmentSource,
  readPending,
  writePending,
} from '../utils/alignments';
import pc from '../utils/colors';
import { DEFAULT_UPSTREAM_REMOTE } from '../utils/config';
import { checkMark, writeStdout } from '../utils/display';
import {
  batchRestoreWorktreeFromRef,
  ensureRemote,
  fetchRemote,
  getStoredSyncRef,
  git,
  listIdenticalToRef,
  MAX_BUFFER,
  readManifestBaseAtRef,
  revParse,
} from '../utils/git';
import { isGeneratedFile, isManagedFile } from '../utils/managed-files';
import { readManifestBase } from '../utils/manifest';
import { isUnderAnyFolder } from '../utils/overrides';
import { getGitHubBaseUrl } from './merge-engine';

/** Where `--extract` writes an alignment folder: inside the fork, so a codemod resolves the fork's packages. */
const EXTRACT_DIR = 'node_modules/.cache/cella/alignments';

/** How many restored paths `--run` lists before it cuts the list short. */
const RESTORED_LIST_MAX = 20;

/** How many paths or grep hits `--show` lists per block before it cuts the list short. */
const SHOW_LIST_MAX = 30;

/** An alignment with what git tells about it, as `--json` writes it. */
interface DescribedAlignment extends Alignment {
  kind: 'codemod' | 'manual';
  open: boolean;
  url: string | null;
  /** The upstream commit that added the README, or null when git finds none. */
  commit: string | null;
  pr: number | null;
  prUrl: string | null;
  /** Ids of the other alignments that commit added. */
  sharedCommit: string[];
  /** Paths that commit changed which the app pins, ignores, or changed from upstream. */
  yourFiles: string[];
  /** Where app code uses a `grep` term: files that differ from upstream only. */
  grepHits: Array<{ file: string; line: number }>;
}

/** What the fork holds against the upstream commit it synced to, read once per run. */
interface ForkView {
  githubUrl: string | undefined;
  /** Whether the app pins or ignores a path (managed and generated files left out). */
  owns: (path: string) => boolean;
  /** Tracked paths whose working tree copy differs from the sync point, or that the sync point lacks. */
  changed: Set<string>;
}

/** Make sure an upstream commit is in this clone, fetching upstream once when it is not. */
async function ensureUpstreamCommit(config: RuntimeConfig, sha: string): Promise<void> {
  const { forkPath } = config;
  const present = async () => !!(await revParse(forkPath, `${sha}^{commit}`));
  if (await present()) return;
  await ensureRemote(forkPath, DEFAULT_UPSTREAM_REMOTE, config.settings.upstreamUrl);
  await fetchRemote(forkPath, DEFAULT_UPSTREAM_REMOTE);
  if (!(await present()))
    throw new Error(`upstream commit ${sha.slice(0, 7)} is not reachable from '${DEFAULT_UPSTREAM_REMOTE}'`);
}

/** The upstream commit the fork last synced to, fetched if this clone lacks it; null before any sync. */
async function resolveAlignmentsRef(config: RuntimeConfig): Promise<string | null> {
  const { forkPath } = config;
  const ref = (await getStoredSyncRef(forkPath)) ?? (await readManifestBaseAtRef(forkPath, 'HEAD'));
  if (!ref) return null;
  await ensureUpstreamCommit(config, ref);
  return ref;
}

/** Open and total alignment counts at the fork's sync point, for the info line; null before any sync. */
async function readAlignmentsStatus(config: RuntimeConfig): Promise<{ total: number; open: number } | null> {
  try {
    const ref = await resolveAlignmentsRef(config);
    if (!ref) return null;
    const [ids, pending] = await Promise.all([listAlignmentIds(config.forkPath, ref), readPending(config.forkPath)]);
    return ids.length > 0 || pending.length > 0 ? { total: ids.length, open: pending.length } : null;
  } catch {
    return null;
  }
}

/** Print the dim info line at the end of a sync or analyze run. Never fails the run. */
export async function printAlignmentsLine(config: RuntimeConfig, result?: MergeResult): Promise<void> {
  const alignments = result?.alignments;
  if (alignments) {
    if (alignments.total === 0) return;
    console.info();
    console.info(
      pc.dim(
        formatAlignmentsLine(alignments.total, alignments.open, alignments.arrived.length, {
          dryRun: config.service === 'analyze',
        }),
      ),
    );
    return;
  }
  const status = await readAlignmentsStatus(config);
  if (!status) return;
  console.info();
  console.info(pc.dim(formatAlignmentsLine(status.total, status.open)));
}

/** Read the fork's overrides and its differences from the sync point, for the derived fields. */
async function readForkView(config: RuntimeConfig, ref: string): Promise<ForkView> {
  const { pinned = [], ignored = [] } = config.overrides ?? {};
  const counts = (path: string) => !isManagedFile(path) && !isGeneratedFile(path) && !isUpstreamOnly(path);
  const out = await git(['diff', '--name-only', '--no-renames', '-z', ref, '--'], config.forkPath);
  return {
    githubUrl: getGitHubBaseUrl(config.settings.upstreamUrl) ?? undefined,
    owns: (path) => counts(path) && isUnderAnyFolder(path, [...pinned, ...ignored]),
    changed: new Set(out.split('\0').filter((path) => path && counts(path))),
  };
}

/** An alignment plus its source commit, the app's files in it and the grep hits in app code. */
async function describeAlignment(
  config: RuntimeConfig,
  view: ForkView,
  ref: string,
  alignment: Alignment,
  open: boolean,
): Promise<DescribedAlignment> {
  const { forkPath } = config;
  const [source, grepHits] = await Promise.all([
    readAlignmentSource(forkPath, ref, alignment.id),
    grepAlignmentTerms(forkPath, alignment.grep, (path) => view.changed.has(path)),
  ]);
  const pr = source?.pr ?? null;
  return {
    ...alignment,
    kind: alignment.codemod ? 'codemod' : 'manual',
    open,
    url: alignmentUrl(view.githubUrl, ref, alignment.id) ?? null,
    commit: source?.commit ?? null,
    pr,
    prUrl: pr !== null && view.githubUrl ? `${view.githubUrl}/pull/${pr}` : null,
    sharedCommit: source?.sharedCommit ?? [],
    yourFiles: (source?.changedFiles ?? []).filter((path) => view.owns(path) || view.changed.has(path)),
    grepHits,
  };
}

/** `grep: 3 hits in 2 app files`, `grep: no app hits`, or null for an alignment without grep terms. */
function grepSummary(alignment: DescribedAlignment): string | null {
  if (alignment.grep.length === 0) return null;
  const hits = alignment.grepHits.length;
  if (hits === 0) return 'grep: no app hits';
  const files = new Set(alignment.grepHits.map((hit) => hit.file)).size;
  return `grep: ${hits} hit${hits === 1 ? '' : 's'} in ${files} app file${files === 1 ? '' : 's'}`;
}

/** Print one alignment in the human list. */
function printAlignment(index: number, alignment: DescribedAlignment): void {
  const tags = [
    alignment.codemod ? 'codemod' : 'manual',
    alignment.syncBreaking ? 'sync-breaking' : null,
    alignment.clientCacheBump ? 'cache-bump' : null,
    alignment.caughtBy ? `caught by: ${alignment.caughtBy}` : null,
    alignment.generate ? 'generate' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const grep = grepSummary(alignment);
  console.info(`${index}. ${alignment.title}  ${pc.dim(`[${tags}]`)}`);
  console.info(pc.dim(`   id:      ${alignment.id}`));
  if (alignment.summary) console.info(`   ${alignment.summary}`);
  if (alignment.pr !== null) {
    console.info(pc.dim(`   added in #${alignment.pr}${alignment.prUrl ? `  ${alignment.prUrl}` : ''}`));
  }
  if (grep) console.info(pc.dim(`   ${grep}`));
  console.info(pc.dim(`   read:    pnpm cella align --show ${alignment.id}`));
  if (alignment.url) console.info(pc.dim(`            ${alignment.url}`));
  if (alignment.codemod) console.info(pc.dim(`   codemod: pnpm cella align --run ${alignment.id}`));
  console.info();
}

/** Print a titled block of lines for `--show`, cut short after {@link SHOW_LIST_MAX}. */
function printShowBlock(title: string, items: string[]): void {
  if (items.length === 0) return;
  console.info(pc.dim(`${title} (${items.length}):`));
  for (const item of items.slice(0, SHOW_LIST_MAX)) console.info(pc.dim(`  ${item}`));
  if (items.length > SHOW_LIST_MAX) console.info(pc.dim(`  ... + ${items.length - SHOW_LIST_MAX} more`));
}

/**
 * `--show <id>`: the README, then what git tells about it. Read at the sync point, or at the
 * fetched upstream branch when the sync point lacks it (an alignment read before its sync merges).
 */
async function showAlignment(config: RuntimeConfig, ref: string, pending: string[], id: string): Promise<void> {
  const { forkPath } = config;
  const upstreamBranch = `${DEFAULT_UPSTREAM_REMOTE}/${config.settings.upstreamBranch}`;
  let readRef = ref;
  let alignment = await readAlignment(forkPath, ref, id);
  if (!alignment && (await revParse(forkPath, upstreamBranch))) {
    alignment = await readAlignment(forkPath, upstreamBranch, id);
    readRef = upstreamBranch;
  }
  if (!alignment) throw new Error(`no alignment '${id}' at upstream ${ref.slice(0, 7)} or ${upstreamBranch}`);

  const source = await git(['show', `${readRef}:${ALIGNMENTS_DIR}/${id}/README.md`], forkPath);
  const described = await describeAlignment(
    config,
    await readForkView(config, ref),
    readRef,
    alignment,
    pending.includes(id),
  );

  if (readRef !== ref) console.info(pc.dim(`not at the sync point ${ref.slice(0, 7)}: read at ${upstreamBranch}`));
  if (described.url) console.info(pc.dim(described.url));
  console.info(source);
  console.info();
  if (described.commit) {
    const pr = described.pr !== null ? `#${described.pr} ` : '';
    console.info(
      pc.dim(`added in ${pr}(${described.commit.slice(0, 9)})${described.prUrl ? `  ${described.prUrl}` : ''}`),
    );
  }
  printShowBlock('added in the same commit', described.sharedCommit);
  printShowBlock('files of that commit the app pins, ignores or changed', described.yourFiles);
  const grep = grepSummary(described);
  if (grep) console.info(pc.dim(`${grep} (${described.grep.join(', ')})`));
  printShowBlock(
    'grep hits',
    described.grepHits.map((hit) => `${hit.file}:${hit.line}`),
  );
}

/**
 * Write an alignment's folder under {@link EXTRACT_DIR}, byte for byte. Returns the alignment, the
 * folder (relative to the fork) and its files.
 */
async function writeAlignmentFolder(
  config: RuntimeConfig,
  ref: string,
  id: string,
): Promise<{ alignment: Alignment; target: string; files: string[] }> {
  const { forkPath } = config;
  const alignment = await readAlignment(forkPath, ref, id);
  if (!alignment) throw new Error(`no alignment '${id}' at upstream ${ref.slice(0, 7)}`);

  const files = (await git(['ls-tree', '-r', '--name-only', `${ref}:${ALIGNMENTS_DIR}/${id}`], forkPath))
    .split('\n')
    .filter(Boolean);
  const target = join(EXTRACT_DIR, id);
  for (const file of files) {
    // Byte for byte: the git helper trims its output.
    const content = execFileSync('git', ['show', `${ref}:${ALIGNMENTS_DIR}/${id}/${file}`], {
      cwd: forkPath,
      maxBuffer: MAX_BUFFER,
    });
    const path = join(forkPath, target, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { alignment, target, files };
}

/** `--extract <id>`: write the alignment folder under {@link EXTRACT_DIR} and print how to run its codemod. */
async function extractAlignment(config: RuntimeConfig, ref: string, id: string): Promise<void> {
  const { alignment, target, files } = await writeAlignmentFolder(config, ref, id);

  console.info(`${checkMark} extracted ${files.length} file(s) to ${target}/`);
  console.info(pc.dim(`  the README's ${ALIGNMENTS_DIR}/${id}/ paths are this folder.`));
  if (alignment.codemod) {
    console.info(pc.dim(`  pnpm exec tsx ${target}/${alignment.codemod} inventory ${alignment.roots.join(' ')}`));
    console.info(pc.dim(`  or, keeping files identical to upstream as they are: pnpm cella align --run ${id}`));
  }
}

/**
 * `--run <id>`: run the alignment's codemod with `tsx` from the fork root, then give each file that
 * was identical to the manifest's upstream commit before the run, and changed by it, its upstream
 * content back.
 */
async function runAlignment(config: RuntimeConfig, ref: string, id: string): Promise<void> {
  const { forkPath } = config;
  const { alignment, target } = await writeAlignmentFolder(config, ref, id);
  if (!alignment.codemod) {
    throw new Error(
      `alignment '${id}' ships no codemod script: its steps are manual, read them with \`pnpm cella align --show ${id}\`.`,
    );
  }
  const script = join(target, alignment.codemod);
  const args = config.runArgs?.length ? config.runArgs : ['inventory', ...alignment.roots];

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
    console.info(`${checkMark} restored ${restored.length} file(s) to upstream ${upstreamShort}`);
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
    const apply = ['rewrite', ...alignment.roots].join(' ');
    console.info(pc.dim(`report only. to apply: pnpm cella align --run ${id} -- ${apply}`));
  }
}

/** `--mark <ids…>`: drop handled alignments from the pending list. */
async function markAlignments(config: RuntimeConfig, ref: string, pending: string[], ids: string[]): Promise<void> {
  const open = new Set(pending);
  const unknown = ids.filter((id) => !open.has(id));
  for (const id of ids) open.delete(id);
  await writePending(config.forkPath, [...open]);
  const marked = ids.length - unknown.length;
  if (marked > 0) console.info(`${checkMark} recorded ${marked} alignment(s) as handled`);
  if (unknown.length > 0) console.info(pc.dim(`not pending, left as is: ${unknown.join(', ')}`));
  console.info(pc.dim(formatAlignmentsLine((await listAlignmentIds(config.forkPath, ref)).length, open.size)));
}

/** Run the align service. */
export async function runAlign(config: RuntimeConfig): Promise<void> {
  const { forkPath } = config;
  const ref = await resolveAlignmentsRef(config);
  if (!ref) {
    console.info(pc.dim('no sync point recorded yet: alignments start with the first `pnpm cella sync`.'));
    return;
  }

  const pending = await readPending(forkPath);

  if (config.mark?.length) return markAlignments(config, ref, pending, config.mark);
  if (config.run) return runAlignment(config, ref, config.run);
  if (config.extract) return extractAlignment(config, ref, config.extract);
  if (config.show) return showAlignment(config, ref, pending, config.show);

  const ids = config.all ? await listAlignmentIds(forkPath, ref) : pending;
  const read = await Promise.all(ids.map((id) => readAlignment(forkPath, ref, id)));
  const alignments: Alignment[] = read.map(
    (alignment, i) =>
      alignment ?? {
        id: ids[i],
        title: `${ids[i]} (no longer upstream)`,
        summary: '',
        syncBreaking: false,
        clientCacheBump: false,
        caughtBy: null,
        generate: false,
        grep: [],
        roots: [],
        codemod: null,
      },
  );
  const total = (await listAlignmentIds(forkPath, ref)).length;
  const open = new Set(pending);
  const view = await readForkView(config, ref);
  const described = await Promise.all(
    alignments.map((alignment) => describeAlignment(config, view, ref, alignment, open.has(alignment.id))),
  );

  if (config.json) {
    writeStdout(JSON.stringify({ upstreamCommit: ref, total, open: pending.length, alignments: described }, null, 2));
    return;
  }

  console.info(pc.dim(formatAlignmentsLine(total, pending.length)));
  if (described.length === 0) return;
  console.info();
  for (const [i, alignment] of described.entries()) printAlignment(i + 1, alignment);

  const schema = described.filter((alignment) => alignment.open && alignment.generate);
  if (schema.length > 1) {
    console.info(
      pc.dim(
        `${schema.length} open alignments change the schema: work their code steps first, then run pnpm generate once.`,
      ),
    );
  }
  if (pending.length > 0) {
    console.info(pc.dim("work each alignment's README, check with `pnpm check`, then record it:"));
    console.info(pc.dim(`  pnpm cella align --mark ${pending.join(' ')}`));
  }
}

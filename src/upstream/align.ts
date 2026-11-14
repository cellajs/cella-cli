/**
 * Align command: the upstream alignments this app has not handled yet.
 *
 * Alignments live upstream only (see `upstream/alignments`). They are read at the upstream commit the
 * app last upgraded to, which the upgrade already fetched, so this works offline after an upgrade and
 * while a conflicted upgrade is still open. Each alignment also gets a GitHub permalink for readers
 * without the upstream remote. Nothing here blocks: the list is information to act on.
 *
 * Next to what the README says, each alignment shows what git can tell about it: the upstream
 * commit and PR that added it, the files of that commit the app owns or changed, and where app
 * code still uses the README's `grep` terms (see `describeAlignment`).
 *
 * `align run` runs an alignment's codemod from an extracted copy and puts back the files it changed
 * that were identical to upstream (see align-run.ts).
 */

import process from 'node:process';
import { defaultUpstreamRemote } from '../config/load';
import type { RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { checkMark, hyperlink, type NextStep, plural, writeStdout } from '../utils/display';
import { ensureRemote, fetchRemote, git, gitHubRepo, revParse } from '../utils/git';
import { isGeneratedFile } from '../utils/repo-files';
import { runAlignment } from './align-run';
import {
  type Alignment,
  alignmentsDir,
  alignmentUrl,
  formatAlignmentsLine,
  grepAlignmentTerms,
  isUpstreamOnly,
  listAlignmentIds,
  parseAlignment,
  readAlignment,
  readAlignmentSource,
  readPending,
  writePending,
} from './alignments';
import { isManagedFile } from './managed-files';
import { isUnderAnyFolder } from './protection';
import { readStoredUpgradePoint, readUpgradePoint } from './upgrade-point';

/** How many paths or grep hits `align show` lists per block before it cuts the list short. */
const showListMax = 30;

/** What `align` does: list the alignments, show one, run its codemod with the words after `--`, or mark some handled. */
export type AlignOptions =
  | { job: 'list'; all: boolean; json: boolean }
  | { job: 'show'; id: string }
  | { job: 'run'; id: string; codemodArgs: string[] }
  | { job: 'mark'; ids: string[] };

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

/** What the app holds against the upstream commit it upgraded to, read once per run. */
interface AppView {
  githubUrl: string | undefined;
  /** Whether the app pins or ignores a path (managed and generated files left out). */
  owns: (path: string) => boolean;
  /** Tracked paths whose working tree copy differs from the upgrade point, or that the upgrade point lacks. */
  changed: Set<string>;
}

/**
 * The upstream commit the app last upgraded to, with upstream fetched once when this clone lacks
 * it; null before any upgrade. The manifest is the record, since it travels with the repository;
 * this clone's own ref stands in for a missing one.
 */
async function resolveAlignmentsRef(config: RuntimeConfig): Promise<string | null> {
  const { repoRoot } = config;
  const ref = (await readUpgradePoint(repoRoot)) ?? (await readStoredUpgradePoint(repoRoot));
  if (!ref) return null;
  const present = async () => !!(await revParse(repoRoot, `${ref}^{commit}`));
  if (await present()) return ref;
  await ensureRemote(repoRoot, defaultUpstreamRemote, config.upstreamUrl);
  await fetchRemote(repoRoot, defaultUpstreamRemote);
  if (!(await present()))
    throw new Error(`upstream commit ${ref.slice(0, 7)} is not reachable from '${defaultUpstreamRemote}'`);
  return ref;
}

/** Open alignments at the app's upgrade point, for a run without a merge result; null before any upgrade. */
export async function readOpenAlignments(config: RuntimeConfig): Promise<AlignmentsView | null> {
  const ref = await resolveAlignmentsRef(config);
  return ref ? { ref, open: await readPending(config.repoRoot) } : null;
}

/** Alignments for the `align` step: the ref to read them at, and the ids by state. */
interface AlignmentsView {
  ref: string;
  /** Open in the app: listed by `pnpm cella align` */
  open: string[];
  /** Arriving with an upgrade a dry run previews: not open until the upgrade lands */
  arriving?: string[];
  /** Arrived with the upgrade this run made: open, and counted as such */
  arrived?: string[];
}

/** Alignment rows the `align` step lists before it points to `pnpm cella align`. */
const stepRowsMax = 5;

/** The tags the `align` step and `cella align` show: `codemod · breaking · caught by compiler · generate`. */
function alignmentTags(alignment: Alignment): string {
  return [
    alignment.codemod ? 'codemod' : 'manual',
    alignment.breaking ? 'breaking' : 'not breaking',
    alignment.caughtBy ? `caught by ${alignment.caughtBy}` : null,
    alignment.clientCacheBump ? 'cache bump' : null,
    alignment.generate ? 'generate' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The `align` step that closes analyze and upgrade: the alignments arriving with the upgrade (in a dry
 * run) and the open ones, by title with their kind, then the command. Without a terminal each row
 * also gets its id, for `pnpm cella align show <id>`. Undefined when there are none.
 */
export async function alignmentsStep(config: RuntimeConfig, view: AlignmentsView): Promise<NextStep | undefined> {
  const arriving = view.arriving ?? [];
  const open = view.open.filter((id) => !arriving.includes(id));
  const arrived = (view.arrived ?? []).filter((id) => open.includes(id));
  if (arriving.length === 0 && open.length === 0) return undefined;

  const line =
    arriving.length > 0
      ? `${plural(arriving.length, 'alignment')} ${arriving.length === 1 ? 'arrives' : 'arrive'} with this upgrade${open.length > 0 ? pc.dim(` · ${open.length} open`) : ''}`
      : `${plural(open.length, 'alignment')} open${arrived.length > 0 ? pc.dim(` · ${arrived.length} arrived with this upgrade`) : ''}`;

  const githubUrl = gitHubRepo(config.upstreamUrl)?.url;
  const ids = [...arriving, ...open];
  const details: string[] = [];
  for (const id of ids.slice(0, stepRowsMax)) {
    const alignment = await readAlignment(config.repoRoot, view.ref, id).catch(() => null);
    const title = hyperlink(alignment?.title ?? id, alignmentUrl(githubUrl, view.ref, id));
    details.push(`${pc.cyan('○')} ${title}${alignment ? pc.dim(` · ${alignmentTags(alignment)}`) : ''}`);
    if (!process.stdout.isTTY) details.push(pc.dim(`  id ${id}`));
  }
  if (ids.length > stepRowsMax) details.push(pc.dim(`+ ${ids.length - stepRowsMax} more`));
  details.push(`${arriving.length > 0 ? pc.dim('after the upgrade: ') : ''}pnpm cella align`);
  return { label: 'align', line, details };
}

/** Read the app's `pinned` and `ignored` entries and its differences from the upgrade point, for the derived fields. */
async function readAppView(config: RuntimeConfig, ref: string): Promise<AppView> {
  const { pinned = [], ignored = [] } = config;
  const counts = (path: string) => !isManagedFile(path) && !isGeneratedFile(path) && !isUpstreamOnly(path);
  const out = await git(['diff', '--name-only', '--no-renames', '-z', ref, '--'], config.repoRoot);
  return {
    githubUrl: gitHubRepo(config.upstreamUrl)?.url,
    owns: (path) => counts(path) && isUnderAnyFolder(path, [...pinned, ...ignored]),
    changed: new Set(out.split('\0').filter((path) => path && counts(path))),
  };
}

/** An alignment plus its source commit, the app's files in it and the grep hits in app code. */
async function describeAlignment(
  config: RuntimeConfig,
  view: AppView,
  ref: string,
  alignment: Alignment,
  open: boolean,
): Promise<DescribedAlignment> {
  const { repoRoot } = config;
  const [source, grepHits] = await Promise.all([
    readAlignmentSource(repoRoot, ref, alignment.id),
    grepAlignmentTerms(repoRoot, alignment.grep, (path) => view.changed.has(path)),
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
  return `grep: ${plural(hits, 'hit')} in ${plural(files, 'app file')}`;
}

/** Print one alignment in the human list. */
function printAlignment(index: number, alignment: DescribedAlignment): void {
  const grep = grepSummary(alignment);
  console.info(`${index}. ${alignment.title}  ${pc.dim(alignmentTags(alignment))}`);
  console.info(pc.dim(`   id:      ${alignment.id}`));
  if (alignment.summary) console.info(`   ${alignment.summary}`);
  if (alignment.pr !== null) {
    console.info(pc.dim(`   added in #${alignment.pr}${alignment.prUrl ? `  ${alignment.prUrl}` : ''}`));
  }
  if (grep) console.info(pc.dim(`   ${grep}`));
  console.info(pc.dim(`   read:    pnpm cella align show ${alignment.id}`));
  if (alignment.url) console.info(pc.dim(`            ${alignment.url}`));
  if (alignment.codemod) console.info(pc.dim(`   codemod: pnpm cella align run ${alignment.id}`));
  console.info();
}

/** Print a titled block of lines for `align show`, cut short after {@link showListMax}. */
function printShowBlock(title: string, items: string[]): void {
  if (items.length === 0) return;
  console.info(pc.dim(`${title} (${items.length}):`));
  for (const item of items.slice(0, showListMax)) console.info(pc.dim(`  ${item}`));
  if (items.length > showListMax) console.info(pc.dim(`  ... + ${items.length - showListMax} more`));
}

/**
 * `align show <id>`: the README, then what git tells about it. Read at the upgrade point, or at the
 * fetched upstream branch when the upgrade point lacks it (an alignment read before its upgrade merges).
 */
async function showAlignment(config: RuntimeConfig, ref: string, pending: string[], id: string): Promise<void> {
  const { repoRoot } = config;
  const upstreamBranch = config.upstreamRef;
  let readRef = ref;
  let alignment = await readAlignment(repoRoot, ref, id);
  if (!alignment && (await revParse(repoRoot, upstreamBranch))) {
    alignment = await readAlignment(repoRoot, upstreamBranch, id);
    readRef = upstreamBranch;
  }
  if (!alignment) throw new Error(`no alignment '${id}' at upstream ${ref.slice(0, 7)} or ${upstreamBranch}`);

  const source = await git(['show', `${readRef}:${alignmentsDir}/${id}/README.md`], repoRoot);
  const described = await describeAlignment(
    config,
    await readAppView(config, ref),
    readRef,
    alignment,
    pending.includes(id),
  );

  if (readRef !== ref) console.info(pc.dim(`not at the last upgrade ${ref.slice(0, 7)}: read at ${upstreamBranch}`));
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

/** `align mark <ids…>`: drop handled alignments from the pending list. */
async function markAlignments(config: RuntimeConfig, ref: string, pending: string[], ids: string[]): Promise<void> {
  const open = new Set(pending);
  const unknown = ids.filter((id) => !open.has(id));
  for (const id of ids) open.delete(id);
  await writePending(config.repoRoot, [...open]);
  const marked = ids.length - unknown.length;
  if (marked > 0) console.info(`${checkMark} recorded ${marked} alignment(s) as handled`);
  if (unknown.length > 0) console.info(pc.dim(`not pending, left as is: ${unknown.join(', ')}`));
  console.info(pc.dim(formatAlignmentsLine((await listAlignmentIds(config.repoRoot, ref)).length, open.size)));
}

/** `align`: the open alignments, or with `all` every upstream alignment, each with what git tells about it. */
async function listAlignments(
  config: RuntimeConfig,
  ref: string,
  pending: string[],
  options: { all: boolean; json: boolean },
): Promise<void> {
  const { repoRoot } = config;
  const every = await listAlignmentIds(repoRoot, ref);
  const alignments = await Promise.all(
    (options.all ? every : pending).map(
      async (id) =>
        (await readAlignment(repoRoot, ref, id)) ?? {
          ...parseAlignment(id, '', []),
          title: `${id} (no longer upstream)`,
        },
    ),
  );
  const view = await readAppView(config, ref);
  const described = await Promise.all(
    alignments.map((alignment) => describeAlignment(config, view, ref, alignment, pending.includes(alignment.id))),
  );

  if (options.json) {
    const payload = { upstreamCommit: ref, total: every.length, open: pending.length, alignments: described };
    writeStdout(JSON.stringify(payload, null, 2));
    return;
  }

  console.info(pc.dim(formatAlignmentsLine(every.length, pending.length)));
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
    console.info(pc.dim(`  pnpm cella align mark ${pending.join(' ')}`));
  }
}

/**
 * Run the align command. Before any upgrade a list is empty (its `--json` payload too), and a job
 * that names an alignment exits 1, since there is none to name.
 */
export async function runAlign(config: RuntimeConfig, options: AlignOptions): Promise<number> {
  const ref = await resolveAlignmentsRef(config);
  if (!ref) {
    console.info(pc.dim('no upgrade recorded yet: alignments start with the first `pnpm cella upgrade`.'));
    if (options.job !== 'list') return 1;
    if (options.json) writeStdout(JSON.stringify({ upstreamCommit: null, total: 0, open: 0, alignments: [] }, null, 2));
    return 0;
  }

  const pending = await readPending(config.repoRoot);
  if (options.job === 'run') return runAlignment(config.repoRoot, ref, options.id, options.codemodArgs);
  if (options.job === 'mark') await markAlignments(config, ref, pending, options.ids);
  else if (options.job === 'show') await showAlignment(config, ref, pending, options.id);
  else await listAlignments(config, ref, pending, options);
  return 0;
}

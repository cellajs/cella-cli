import type { RuntimeConfig } from '../config/types';
import { spinnerText } from '../utils/display';
import {
  type FileChange,
  type FileChangeInfo,
  getDiffStat,
  getFileChangeInfo,
  getFileChanges,
  getFileHashesAtRef,
} from '../utils/git';
import { isGeneratedFile } from '../utils/repo-files';
import { isManagedFile } from './managed-files';
import type { AnalysisSummary, AnalyzedFile, MergeResult, UpstreamContext } from './model';
import { isIgnored, isPinned } from './protection';

/** The protection rules the classifier applies (direction-specific). */
interface Protection {
  /** True if the file is inside owned/ignored territory (never merged). */
  isIgnored: (path: string) => boolean;
  /** True if the file is pinned (the app's copy wins). */
  isPinned: (path: string) => boolean;
}

/** Whether an ignored path can carry `upstreamOnly`: not managed and not generated output. */
function isReportableIgnored(filePath: string): boolean {
  return !isManagedFile(filePath) && !isGeneratedFile(filePath);
}

/** The tree facts `repairIncomingRenames` pairs against. */
interface RenameRepairContext {
  /** Paths at the merge-base. */
  basePaths: ReadonlySet<string>;
  /** Paths at the incoming tip. */
  incomingPaths: ReadonlySet<string>;
  /** Paths at the local tip. */
  localPaths: ReadonlySet<string>;
  /** True for a path whose local copy the merge carries whole (ignored or pinned). */
  isProtected: (path: string) => boolean;
}

const basenameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirnameOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Directory moves the same-named rename pairs agree on: source directory to the target directory most of its pairs name. */
function directoryMoves(changes: Map<string, FileChange>): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const [newPath, change] of changes) {
    if (change.status !== 'R' || !change.oldPath || basenameOf(change.oldPath) !== basenameOf(newPath)) continue;
    const from = dirnameOf(change.oldPath);
    const counts = votes.get(from) ?? new Map<string, number>();
    counts.set(dirnameOf(newPath), (counts.get(dirnameOf(newPath)) ?? 0) + 1);
    votes.set(from, counts);
  }
  const moves = new Map<string, string>();
  for (const [from, counts] of votes) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) moves.set(from, ranked[0][0]);
  }
  return moves;
}

const joinDir = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * Repairs incoming rename pairs in place so a moved file is carried by its path, not by git's
 * content pairing. Same or similar copies in a moved folder pair crosswise at `-M90%`
 * (`nl/app.json` to `nl/about.json`), which would land a protected file's local content at the
 * wrong path; a copy whose content pairs nowhere arrives as delete plus add, which would drop the
 * local copy for incoming's. A pair whose basename changes is re-aimed at the same-named path new
 * in incoming, in the directory its own files moved to, else in the one git's pairing points at;
 * crossed pairs swap in one pass, and any collision keeps git's pairing whole. A local path
 * incoming deleted is then paired with the same-named path added where its directory went, when
 * either path is protected: unpaired, a move into protected territory drops the file at both paths.
 */
export function repairIncomingRenames(changes: Map<string, FileChange>, context: RenameRepairContext): void {
  const dirMoves = directoryMoves(changes);
  const snapshot = new Map(changes);

  const crossed: { from: string; oldPath: string; change: FileChange }[] = [];
  const keptTargets = new Set<string>();
  const renameSources = new Set<string>();
  for (const [newPath, change] of changes) {
    if (change.status !== 'R' || !change.oldPath) continue;
    renameSources.add(change.oldPath);
    if (basenameOf(change.oldPath) === basenameOf(newPath)) keptTargets.add(newPath);
    else crossed.push({ from: newPath, oldPath: change.oldPath, change });
  }

  // Desired target per crossed pair; its current key when no same-named path is new in incoming.
  const desired = new Map<string, string>();
  for (const pair of crossed) {
    const name = basenameOf(pair.oldPath);
    const mappedDir = dirMoves.get(dirnameOf(pair.oldPath));
    const candidates = [
      ...(mappedDir === undefined ? [] : [joinDir(mappedDir, name)]),
      joinDir(dirnameOf(pair.from), name),
    ];
    const target = candidates.find(
      (path) => context.incomingPaths.has(path) && !context.basePaths.has(path) && !keptTargets.has(path),
    );
    desired.set(pair.from, target ?? pair.from);
  }

  const targets = [...desired.values()];
  if (new Set(targets).size === targets.length) {
    const targetSet = new Set(targets);
    for (const pair of crossed) {
      const target = desired.get(pair.from) as string;
      if (target === pair.from) continue;
      changes.set(target, {
        status: 'R',
        oldPath: pair.oldPath,
        baseHash: pair.change.baseHash,
        targetHash: snapshot.get(target)?.targetHash ?? null,
      });
    }
    // A key every repaired pair left is an added file.
    for (const pair of crossed) {
      if (desired.get(pair.from) === pair.from || targetSet.has(pair.from)) continue;
      changes.set(pair.from, { status: 'A', baseHash: null, targetHash: snapshot.get(pair.from)?.targetHash ?? null });
    }
  }

  for (const oldPath of context.localPaths) {
    if (context.incomingPaths.has(oldPath) || !context.basePaths.has(oldPath) || renameSources.has(oldPath)) continue;
    const mappedDir = dirMoves.get(dirnameOf(oldPath));
    if (mappedDir === undefined) continue;
    const target = joinDir(mappedDir, basenameOf(oldPath));
    if (!context.isProtected(oldPath) && !context.isProtected(target)) continue;
    if (!context.incomingPaths.has(target) || context.basePaths.has(target) || changes.get(target)?.status !== 'A')
      continue;

    changes.set(target, { status: 'R', oldPath, baseHash: null, targetHash: changes.get(target)?.targetHash ?? null });
    changes.delete(oldPath);
    renameSources.add(oldPath);
  }
}

/** The three trees the classifier compares: blob hash by path, and each side's changes since the merge-base. */
export interface Trees {
  base: Map<string, string>;
  app: Map<string, string>;
  upstream: Map<string, string>;
  appChanges: Map<string, FileChange>;
  upstreamChanges: Map<string, FileChange>;
}

/** Read the trees {@link classifyFiles} compares, with git plumbing on refs only, never the working tree. */
export async function readTrees(
  repoRoot: string,
  appRef: string,
  upstreamRef: string,
  baseRef: string,
): Promise<Trees> {
  // Changes between base and each tip; rename detection runs at -M90%.
  const [base, app, upstream, appChanges, upstreamChanges] = await Promise.all([
    getFileHashesAtRef(repoRoot, baseRef),
    getFileHashesAtRef(repoRoot, appRef),
    getFileHashesAtRef(repoRoot, upstreamRef),
    getFileChanges(repoRoot, baseRef, appRef),
    getFileChanges(repoRoot, baseRef, upstreamRef),
  ]);
  return { base, app, upstream, appChanges, upstreamChanges };
}

/** One path's classification, before the fields every file carries. */
type Verdict = Pick<AnalyzedFile, 'status' | 'resolution'> &
  Pick<Partial<AnalyzedFile>, 'renamedFrom' | 'upstreamChanged' | 'upstreamOnly'>;

/**
 * A path upstream moved a file to. A renamed directory (e.g. config/ → shared/) can leave the app's
 * pinned list naming the old path, so both paths count for pinned/ignored. `appMoved` holds the
 * paths the app moved a file away from.
 */
function classifyMove(
  path: string,
  oldPath: string,
  trees: Trees,
  protection: Protection,
  appMoved: ReadonlySet<string>,
): Verdict {
  const { base, app, upstream } = trees;
  const differsAtPath = app.get(path) !== upstream.get(path);
  const ownAtPath = app.has(path) && differsAtPath;
  const isProtected = (entry: string) => protection.isIgnored(entry) || protection.isPinned(entry);
  // A template copy the app never edited follows upstream's move: the app has nothing of its own to keep.
  const untouchedArrival =
    !isProtected(oldPath) && app.has(oldPath) && app.get(oldPath) === base.get(oldPath) && !ownAtPath;
  if ((isProtected(path) || isProtected(oldPath)) && !untouchedArrival) {
    // The app's copy moves along; with no copy at the old path, the app's version of the new path stays.
    // A copy at both paths leaves git's conflict, so the move never overwrites the app's own file.
    const resolution = !app.has(oldPath) ? 'keep' : ownAtPath ? 'merge' : 'move';
    const landing = resolution === 'move' ? app.get(oldPath) : app.get(path);
    // Upstream moved a file the app never touched into (or within) ignored territory.
    const upstreamOnly =
      protection.isIgnored(path) && app.get(oldPath) === base.get(oldPath) && isReportableIgnored(path);
    // Upstream changed the content beyond the move, and the copy the app keeps differs from it.
    const dropped =
      resolution !== 'merge' && upstream.get(path) !== base.get(oldPath) && landing !== upstream.get(path);
    return {
      status: 'pinned',
      resolution,
      renamedFrom: oldPath,
      upstreamChanged: (dropped && !upstreamOnly) || undefined,
      upstreamOnly: upstreamOnly || undefined,
    };
  }
  // The app edited or moved the old file, or has its own at the new path: git merges or conflicts.
  const appTouched = app.has(oldPath) ? app.get(oldPath) !== base.get(oldPath) : appMoved.has(oldPath) && differsAtPath;
  if (appTouched || ownAtPath) return { status: 'diverged', resolution: 'merge', renamedFrom: oldPath };
  // With the old path absent in the app (deleted), upstream's file still arrives at the new path.
  return { status: app.has(oldPath) ? 'renamed' : 'behind', resolution: 'take', renamedFrom: oldPath };
}

/**
 * A path upstream did not move, by who changed it since the merge-base; a deletion counts as a
 * change. `appMoved` holds the paths the app moved a file away from.
 */
function classifyPath(path: string, trees: Trees, protection: Protection, appMoved: ReadonlySet<string>): Verdict {
  const [baseHash, appHash, upstreamHash] = [trees.base.get(path), trees.app.get(path), trees.upstream.get(path)];
  const upstreamChanged = upstreamHash !== baseHash;
  // Ignored paths never merge: the app's copy, or its absence, stays wherever upstream changed them.
  if (protection.isIgnored(path)) return { status: 'ignored', resolution: upstreamChanged ? 'keep' : 'none' };
  if (appHash === upstreamHash) return { status: 'identical', resolution: 'none' };
  const pinned = protection.isPinned(path);

  if (!upstreamChanged) {
    // Changed in the app alone: the merge leaves it as the app has it.
    if (appHash === undefined) return { status: 'deleted', resolution: 'none' };
    return { status: baseHash === undefined ? 'local' : pinned ? 'ahead' : 'drifted', resolution: 'none' };
  }
  if (appHash === baseHash) {
    // Changed upstream alone: upstream's version arrives, its deletion included. A pinned copy stays
    // (a masking pin), except at a path new in upstream: pinned before its first arrival, as an
    // alignment can ask, upstream's copy arrives as the app's first one. A managed file follows
    // upstream's deletion: the package merge reads only the files upstream still has.
    const kept = pinned && baseHash !== undefined && (upstreamHash !== undefined || !isManagedFile(path));
    if (kept) return { status: 'behind', resolution: 'keep' };
    return { status: 'behind', resolution: upstreamHash === undefined ? 'remove' : 'take' };
  }
  // Both changed: a pin keeps the app's version, a deletion included (re-adding it would resurface it
  // every upgrade). Unpinned, git merges: upstream's change to a file the app deleted arrives, and to
  // one the app moved lands in the moved copy; an app change against upstream's deletion stays git's
  // modify/delete conflict for the review.
  if (pinned) return { status: appHash === undefined ? 'deleted' : 'pinned', resolution: 'keep' };
  if (appHash === undefined && !appMoved.has(path)) return { status: 'behind', resolution: 'take' };
  return { status: 'diverged', resolution: 'merge' };
}

/**
 * The flags of a protected path whose upstream change the upgrade drops. Both sides changed it (a
 * local edit or deletion, and upstream content that differs from base): the app wins whole-file, so
 * upstream's hunks are dropped (`upstreamChanged`). An ignored file only upstream changed, added or
 * deleted, or one upstream changed that the app does not have (an app's own screenshots it never
 * kept): nothing local is dropped, but ignored paths never upgrade, so the change would stay unseen
 * (`upstreamOnly`). A protected file only the app changed is plain `ahead`; the pinned counterpart of
 * `upstreamOnly` is the masking pin (`behind`).
 */
function droppedUpstreamChange(
  path: string,
  trees: Trees,
  protection: Protection,
): Pick<Verdict, 'upstreamChanged' | 'upstreamOnly'> {
  const [baseHash, appHash, upstreamHash] = [trees.base.get(path), trees.app.get(path), trees.upstream.get(path)];
  if (upstreamHash === baseHash || upstreamHash === appHash) return {};
  const appChanged = appHash !== baseHash;
  const ignored = protection.isIgnored(path);
  if (ignored && (!appChanged || appHash === undefined)) return isReportableIgnored(path) ? { upstreamOnly: true } : {};
  return appChanged && (ignored || protection.isPinned(path)) ? { upstreamChanged: true } : {};
}

/**
 * Classify every file of the three trees: its status, and its resolution, what the upgrade does with
 * it. Upgrade compares the app at HEAD with upstream, adopt cella's branch (the app side) with the
 * fork's (the upstream side).
 */
export function classifyFiles(trees: Trees, protection: Protection): AnalyzedFile[] {
  const upstreamChanges = new Map(trees.upstreamChanges);
  // Content pairing can cross same-named copies or miss one; a protected move must follow the path.
  repairIncomingRenames(upstreamChanges, {
    basePaths: new Set(trees.base.keys()),
    incomingPaths: new Set(trees.upstream.keys()),
    localPaths: new Set(trees.app.keys()),
    isProtected: (path) => protection.isIgnored(path) || protection.isPinned(path),
  });

  const movedFrom = new Map<string, string>();
  for (const [path, change] of upstreamChanges)
    if (change.status === 'R' && change.oldPath) movedFrom.set(path, change.oldPath);
  const oldPaths = new Set(movedFrom.values());
  const changed = new Set([...trees.appChanges.keys(), ...upstreamChanges.keys()]);
  const appMoved = new Set<string>();
  for (const change of trees.appChanges.values())
    if (change.status === 'R' && change.oldPath) appMoved.add(change.oldPath);

  return [...new Set([...trees.app.keys(), ...trees.upstream.keys()])].flatMap((path): AnalyzedFile[] => {
    const oldPath = movedFrom.get(path);
    // Old paths of upstream moves are classified at the new path.
    if (oldPath === undefined && oldPaths.has(path)) return [];
    const existsInApp = trees.app.has(path);
    const existsInUpstream = trees.upstream.has(path);
    const verdict: Verdict =
      oldPath !== undefined
        ? classifyMove(path, oldPath, trees, protection, appMoved)
        : !changed.has(path) && existsInApp && existsInUpstream
          ? { status: 'identical', resolution: 'none' }
          : { ...classifyPath(path, trees, protection, appMoved), ...droppedUpstreamChange(path, trees, protection) };
    return [
      {
        path,
        ...verdict,
        isIgnored: protection.isIgnored(path),
        isPinned: protection.isPinned(path),
        existsInApp,
        existsInUpstream,
      },
    ];
  });
}

/**
 * Size, in place, the upstream changes the upgrade leaves out: the lines upstream changed in each
 * flagged file since the merge-base, and the lines upstream has that a pinned `ahead` file lacks.
 */
async function countUpstreamLines(
  repoRoot: string,
  files: AnalyzedFile[],
  refs: { appRef: string; upstreamRef: string; baseRef: string },
): Promise<void> {
  // One numstat call limited to the flagged paths. A protected file upstream moved gets no count:
  // its numstat at the new path would count the whole file as added.
  const flagged = files.filter((file) => (file.upstreamChanged && !file.renamedFrom) || file.upstreamOnly);
  if (flagged.length > 0) {
    const stat = await getDiffStat(
      repoRoot,
      refs.baseRef,
      refs.upstreamRef,
      flagged.map((file) => file.path),
    );
    for (const file of flagged) {
      const entry = stat.get(file.path);
      if (entry && entry.additions !== null && entry.deletions !== null) {
        file.upstreamChangedLines = entry.additions + entry.deletions;
      } else if (entry) file.upstreamBinary = true;
    }
  }

  // Retroactive signal for pinned `ahead` files (upstream untouched since the merge-base, so the
  // count above cannot fire): lines upstream has that the app lacks, relative to the tips, not the
  // upgrade point. Pinned only; ignored territory is noise by design.
  const stale = files.filter((file) => file.status === 'ahead');
  if (stale.length > 0) {
    // from = upstream, to = app: numstat deletions are upstream lines absent in the app
    const stat = await getDiffStat(
      repoRoot,
      refs.upstreamRef,
      refs.appRef,
      stale.map((file) => file.path),
    );
    for (const file of stale) {
      const deletions = stat.get(file.path)?.deletions;
      if (deletions !== null && deletions !== undefined) file.upstreamLinesAbsent = deletions;
    }
  }
}

/**
 * Classify every file changed between the app and upstream refs from a shared merge-base, in a repo
 * that reaches all three, and size the upstream changes the upgrade leaves out.
 */
export async function analyzeRefs(
  repoRoot: string,
  appRef: string,
  upstreamRef: string,
  baseRef: string,
  protection: Protection,
): Promise<AnalyzedFile[]> {
  const files = classifyFiles(await readTrees(repoRoot, appRef, upstreamRef, baseRef), protection);
  await countUpstreamLines(repoRoot, files, { appRef, upstreamRef, baseRef });
  return files;
}

/**
 * Enrich analyzed files in place with change dates and commit hashes: local-side dates for
 * ahead/drifted, incoming-side dates for behind, and both sides for diverged/pinned.
 */
export async function enrichChangeInfo(
  repoPath: string,
  files: AnalyzedFile[],
  mergeBaseRef: string,
  localRef: string,
  incomingRef: string,
): Promise<void> {
  const appInfo = await getFileChangeInfo(repoPath, mergeBaseRef, localRef);
  const upstreamInfo = await getFileChangeInfo(repoPath, mergeBaseRef, incomingRef);
  const setChanged = (file: AnalyzedFile, info: FileChangeInfo | undefined) => {
    if (!info) return;
    file.changedAt = info.date;
    file.changedTs = info.timestamp;
    file.changedCommit = info.hash;
  };

  for (const file of files) {
    if (file.status === 'identical') continue;

    if (file.status === 'ahead' || file.status === 'drifted') {
      setChanged(file, appInfo.get(file.path));
    } else if (file.status === 'behind') {
      setChanged(file, upstreamInfo.get(file.path));
    } else if (file.status === 'diverged' || file.status === 'pinned' || file.upstreamChanged || file.upstreamOnly) {
      // Diverged/pinned (and protected files incoming changed) carry both sides.
      setChanged(file, appInfo.get(file.path));
      const info = upstreamInfo.get(file.path);
      if (info) {
        file.upstreamChangedAt = info.date;
        file.upstreamChangedTs = info.timestamp;
        file.upstreamCommit = info.hash;
      }
    }
  }
}

/** Protection for the upgrade direction (the app at HEAD, upstream incoming); `--unpinned` pins the managed files alone. */
function upgradeProtection(config: RuntimeConfig): Protection {
  return {
    isIgnored: (path) => isIgnored(path, config),
    isPinned: (path) => (config.unpinned ? isManagedFile(path) : isPinned(path, config)),
  };
}

/** Classify every file the upgrade compares: the app at HEAD against upstream at the run's ref, from the merge's base. */
export function classifyUpgrade(config: RuntimeConfig, upstream: UpstreamContext): Promise<AnalyzedFile[]> {
  spinnerText('analyzing files...');
  return analyzeRefs(config.repoRoot, 'HEAD', upstream.ref, upstream.mergeRef, upgradeProtection(config));
}

/** Counts by status; a changed managed file counts as `managed`. */
function summarize(files: AnalyzedFile[]): AnalysisSummary {
  const summary: AnalysisSummary = {
    managed: 0,
    identical: 0,
    ahead: 0,
    local: 0,
    drifted: 0,
    behind: 0,
    diverged: 0,
    pinned: 0,
    ignored: 0,
    deleted: 0,
    renamed: 0,
  };
  for (const file of files)
    summary[file.status !== 'identical' && isManagedFile(file.path) ? 'managed' : file.status]++;
  return summary;
}

/** The result fields analyze and upgrade read off the same classified files. */
export function classifiedResult(files: AnalyzedFile[]): Pick<MergeResult, 'files' | 'summary' | 'protectedConflicts'> {
  const protectedConflicts = files.filter((file) => file.upstreamChanged).map((file) => file.path);
  return { files, summary: summarize(files), protectedConflicts };
}

/** Files the upgrade changes from upstream: upstream's copy, its deletion or git's merge of both sides. */
export function changedFromUpstream(files: AnalyzedFile[]): AnalyzedFile[] {
  return files.filter(
    (file) => file.resolution === 'take' || file.resolution === 'remove' || file.resolution === 'merge',
  );
}

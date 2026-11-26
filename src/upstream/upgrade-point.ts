import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeConfig } from '../config/types';
import { printProgressStep } from '../utils/display';
import { countCommitsBetween, getCommitInfo, getMergeBase, git, gitHubRepo, isAncestor, revParse, stagePath } from '../utils/git';
import { writeOwnedFile } from '../utils/repo-files';
import { onShutdown } from '../utils/signals';
import { alignmentsDir, arrivedAlignmentIds, listAlignmentIds, pendingFile, readPending, writePending } from './alignments';
import type { MergeResult, UpstreamContext } from './model';
import type { UpstreamRef } from './upstream-ref';

/**
 * Committed manifest path, relative to the app root. `upstream.commit` seeds the merge-base on a
 * clone without {@link lastUpgradeRef} (fresh clone, CI), and the rest shows in each upgrade PR which
 * upstream point the app moved to.
 */
const manifestFile = 'cella/cella.manifest.json';

/** The local ref holding the upstream commit of the last upgrade. */
const lastUpgradeRef = 'refs/cella/last-upgrade';

/** The upgrade point recorded in {@link manifestFile}. */
interface UpgradeManifest {
  upstream: {
    /** GitHub slug of the upstream repo, e.g. 'cellajs/cella'. */
    repo?: string;
    /** Tracking mode at upgrade time. */
    track?: 'release' | 'branch';
    /** Integrated upstream commit SHA: the merge-base bootstrap seed. */
    commit: string;
    /** Release tag when tracking releases, else null. */
    release?: string | null;
    /** Human-readable link to the commit or release on GitHub. */
    url?: string;
    /** UTC timestamp of the upgrade (ISO 8601). */
    upgradedAt?: string;
  };
}

/** Parse and validate raw manifest JSON. Returns null when malformed or missing a 40-hex upstream commit. */
function parseManifest(raw: string): UpgradeManifest | null {
  try {
    const parsed = JSON.parse(raw) as UpgradeManifest;
    const commit = parsed?.upstream?.commit;
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Read and validate the working-tree manifest. Returns null when absent or malformed. */
export async function readManifest(cwd: string): Promise<UpgradeManifest | null> {
  try {
    return parseManifest(await readFile(join(cwd, manifestFile), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the upgrade manifest committed at a specific ref.
 *
 * This intentionally reads from git, not the working tree: a staged/aborted upgrade can leave the
 * worktree manifest ahead of the committed trunk, and that must not validate an upgrade point.
 */
export async function readManifestAtRef(cwd: string, ref: string): Promise<UpgradeManifest | null> {
  const raw = await git(['show', `${ref}:${manifestFile}`], cwd, { ignoreErrors: true });
  if (!raw) return null;
  return parseManifest(raw);
}

/** The upgrade point the working-tree manifest records, or null. */
export async function readUpgradePoint(cwd: string): Promise<string | null> {
  const manifest = await readManifest(cwd);
  return manifest ? manifest.upstream.commit.toLowerCase() : null;
}

/** The upgrade point from the manifest committed at `ref`, or null. */
export async function readUpgradePointAtRef(cwd: string, ref: string): Promise<string | null> {
  const manifest = await readManifestAtRef(cwd, ref);
  return manifest ? manifest.upstream.commit.toLowerCase() : null;
}

/** The stored last-upgrade upstream ref, or null when no upgrade has been recorded. */
export async function readStoredUpgradePoint(cwd: string): Promise<string | null> {
  return revParse(cwd, lastUpgradeRef);
}

/** Store the upstream commit hash after a successful upgrade merge. */
export async function storeUpgradePoint(cwd: string, upstreamHash: string): Promise<void> {
  await git(['update-ref', lastUpgradeRef, upstreamHash], cwd);
}

/** Whether a commit object is present in the local object store. */
async function commitObjectExists(cwd: string, sha: string): Promise<boolean> {
  return (await revParse(cwd, `${sha}^{commit}`)) !== null;
}

/**
 * The effective merge-base, preferring the recorded upgrade point when it's more recent.
 * This handles stale merge-base caused by previous squash upgrades (single-parent commits
 * don't update git's merge-base graph).
 *
 * The manifest committed at `headRef` records the upgrade point: it lands iff the upgrade commit lands
 * and travels with the repo. A recorded commit this clone lacks leaves git's own answer.
 */
export async function getEffectiveMergeBase(cwd: string, headRef: string, upstreamRef: string): Promise<string> {
  const gitBase = await getMergeBase(cwd, headRef, upstreamRef);
  const recorded = await readUpgradePointAtRef(cwd, headRef);
  if (!recorded || !(await commitObjectExists(cwd, recorded))) return gitBase;
  // Only prefer the recorded upgrade point when it is actually newer than git's own answer.
  return (await isAncestor(cwd, gitBase, recorded)) ? recorded : gitBase;
}

/**
 * Upstream as this run moves to it, once the upgrade point exists: the effective merge base, the
 * commit the ref names and what upstream added since the last upgrade.
 */
export async function readUpgradeRange(config: RuntimeConfig, pick: UpstreamRef): Promise<UpstreamContext> {
  const { repoRoot } = config;
  const mergeBase = await getEffectiveMergeBase(repoRoot, 'HEAD', pick.ref);
  const [mergeRef, commit, commitCount] = await Promise.all([
    config.unpinned ? getMergeBase(repoRoot, 'HEAD', pick.ref) : mergeBase,
    getCommitInfo(repoRoot, pick.ref),
    countCommitsBetween(repoRoot, mergeBase, pick.ref),
  ]);
  return { ...pick, mergeBase, mergeRef, commit, commitCount, gitHub: gitHubRepo(config.upstreamUrl) };
}

/**
 * Upstream's alignments at the incoming ref, the ones added since the upgrade point, and the app's
 * open list as it stands. Runs before the upgrade point moves.
 */
export async function readAlignmentsInRange(repoRoot: string, upstream: UpstreamContext): Promise<NonNullable<MergeResult['alignments']>> {
  const [ids, arrived, open] = await Promise.all([
    listAlignmentIds(repoRoot, upstream.ref),
    arrivedAlignmentIds(repoRoot, upstream.mergeBase, upstream.ref),
    readPending(repoRoot),
  ]);
  return { total: ids.length, arrived, open };
}

/** The root (parentless) commit of a ref's history, such as a create-cella scaffold's "Initial commit", or null. */
async function getRootCommit(cwd: string, ref: string): Promise<string | null> {
  const out = await git(['rev-list', '--max-parents=0', ref], cwd, { ignoreErrors: true });
  const roots = out.split('\n').filter(Boolean);
  return roots.length > 0 ? roots[roots.length - 1] : null;
}

/**
 * Read the scaffold provenance trailer from the app's root commit message.
 *
 * create-cella stamps `Cella-Base: <sha>` on the initial commit, recording the exact
 * upstream commit the scaffold snapshot was taken from. Riding in commit history, it
 * travels with push/clone (a local ref does not) and needs no file in the worktree.
 */
async function readRootTrailerBase(cwd: string, headRef: string): Promise<string | null> {
  const root = await getRootCommit(cwd, headRef);
  if (!root) return null;
  const message = await git(['show', '-s', '--format=%B', root], cwd, { ignoreErrors: true });
  const match = message.match(/^cella-base:\s*([0-9a-f]{40})$/im);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Whether the repository is a shallow clone (created with `git clone --depth`, or otherwise
 * carrying a `.git/shallow` graft). Shallow history is truncated below the graft point, so the
 * real common ancestor with upstream is absent: `git merge-base` finds nothing even when one
 * exists in the full history, and the 3-way file analysis walks an incomplete commit graph.
 */
async function isShallowRepository(cwd: string): Promise<boolean> {
  const out = await git(['rev-parse', '--is-shallow-repository'], cwd);
  return out === 'true';
}

/**
 * Restore full history on a shallow clone by fetching from its own origin, so merge-base and the
 * 3-way analysis see the real commit graph.
 *
 * Throws an actionable error when the history cannot be restored (e.g. no reachable origin),
 * because an upgrade cannot run correctly against truncated history.
 */
async function unshallowRepository(cwd: string): Promise<void> {
  try {
    await git(['fetch', '--unshallow'], cwd, { skipEditor: true });
  } catch (error) {
    const detail = error instanceof Error ? `\n\n${error.message}` : '';
    throw new Error(
      'this is a shallow clone and its full history could not be restored automatically.\n' +
        'An upgrade needs the complete history to find the common ancestor with upstream. Restore it with:\n\n' +
        '  git fetch --unshallow\n\n' +
        `then re-run the upgrade.${detail}`,
    );
  }
}

/**
 * Ensure a native git merge-base exists between the app and upstream. Runs after the upstream fetch,
 * so the base commit object is present, and after the ref is resolved, so release tags resolve.
 *
 * A create-cella scaffold has unrelated history with upstream, so `git merge-base` finds nothing
 * and every upgrade fails at the very first step. This bootstraps ancestry non-destructively:
 *   0. If the repo is a shallow clone, restore its full history first: the real ancestor is
 *      truncated away, so no graft can recover it; deepening the history brings it back.
 *   1. If a native merge-base already exists, do nothing (the common case).
 *   2. Otherwise resolve the upgrade point: sources are tried in order and the first
 *      one whose commit actually exists after the upstream fetch wins: the recorded
 *      upgrade point (`refs/cella/last-upgrade` ref, then committed/worktree `cella/cella.manifest.json`),
 *      then the scaffold origin (the root commit's `Cella-Base:` trailer).
 *   3. Graft the app's root commit onto that upgrade point with `git replace --graft`, so every native
 *      git operation (merge-base and the 3-way merge itself) sees correct ancestry, and record
 *      the upgrade point as `refs/cella/last-upgrade`. The replace ref is local-only and never pushed, so
 *      the app's own published history stays clean.
 *
 * Throws an actionable error when no upgrade point can be determined.
 */
export async function ensureUpgradePoint(cwd: string, headRef: string, upstreamRef: string): Promise<void> {
  if (await isShallowRepository(cwd)) {
    await unshallowRepository(cwd);
  }

  const nativeBase = await git(['merge-base', headRef, upstreamRef], cwd, { ignoreErrors: true });
  if (nativeBase) return;

  const sources: Array<() => Promise<string | null>> = [
    () => readStoredUpgradePoint(cwd),
    () => readUpgradePointAtRef(cwd, headRef),
    () => readUpgradePoint(cwd),
    () => readRootTrailerBase(cwd, headRef),
  ];

  let upgradePoint: string | null = null;
  for (const source of sources) {
    const sha = await source();
    if (sha && (await commitObjectExists(cwd, sha))) {
      upgradePoint = sha;
      break;
    }
  }
  if (!upgradePoint) {
    throw new Error(
      `no common ancestor between the app and '${upstreamRef}', and no upgrade point could be determined.\n\n` +
        'This app has unrelated history with upstream (typical for a create-cella scaffold, or after\n' +
        'upstream squashed its history) and no recorded upgrade point exists after fetching\n' +
        'upstream. Seed it manually with the upstream commit the app was created from, then re-run the upgrade:\n\n' +
        `  git update-ref ${lastUpgradeRef} <upstream-sha>\n`,
    );
  }

  const root = await getRootCommit(cwd, headRef);
  if (!root) throw new Error("could not determine the app's root commit to bootstrap upgrade ancestry");

  await git(['replace', '-f', '--graft', root, upgradePoint], cwd);
  await git(['update-ref', lastUpgradeRef, upgradePoint], cwd);
}

/**
 * Run `fn` with a temporary local graft that makes `upgradePoint` an ancestor of `headRef`, so
 * native git operations (merge-base resolution and the 3-way merge itself) see the recorded
 * upgrade point, not a stale historical ancestor.
 *
 * Squash upgrades advance the recorded upgrade point (manifest + `refs/cella/last-upgrade`) without
 * advancing git's commit graph, so a plain `git merge` replays every upstream change since the
 * last true merge ancestor: hunks the app already integrated (or deliberately resolved away)
 * re-apply as clean auto-merges or re-conflict on every upgrade. The graft adds `upgradePoint` as an
 * extra parent of the `headRef` commit via `git replace --graft`; replace refs are local-only
 * and the ref is deleted right after `fn`, or when ctrl-c or a kill ends the CLI during it, so
 * nothing ever leaks into pushed history.
 *
 * Runs `fn` without grafting when the graft is unnecessary or unsafe:
 * - `upgradePoint` is already an ancestor of `headRef` (git's own merge-base is not stale), or
 * - a replacement object already exists for the `headRef` commit (never clobber, e.g. the
 *   scaffold root graft from {@link ensureUpgradePoint} when the root commit is HEAD).
 */
export async function withUpgradePointGraft<T>(cwd: string, headRef: string, upgradePoint: string, fn: () => Promise<T>): Promise<T> {
  const headSha = await revParse(cwd, headRef);
  if (!headSha || !(await commitObjectExists(cwd, upgradePoint))) return fn();

  // Native ancestry already covers the base: nothing to graft.
  if (await isAncestor(cwd, upgradePoint, headSha)) return fn();

  // Never clobber an existing replacement object for this commit.
  const existingReplacement = await git(['replace', '-l', headSha], cwd);
  if (existingReplacement) return fn();

  const parentsRaw = await git(['log', '-1', '--format=%P', headSha], cwd);
  const parents = parentsRaw ? parentsRaw.split(/\s+/) : [];

  await git(['replace', '-f', '--graft', headSha, ...parents, upgradePoint], cwd);
  const removeGraft = async () => {
    await git(['replace', '-d', headSha], cwd, { ignoreErrors: true });
  };
  const forget = onShutdown(removeGraft);
  try {
    return await fn();
  } finally {
    forget();
    await removeGraft();
  }
}

/**
 * Record a staged upgrade, the manifest last: the app's open alignments (`pending`, an empty list
 * deletes the file), the app's copy of the alignments folder removed (apps that received it before it
 * became upstream-only, and new apps whose scaffold cloned it), the local ref moved to the upstream
 * commit, then the manifest. Each is staged so it rides in the upgrade commit, and a manifest naming
 * MERGE_HEAD tells a later run that this one finished the merge.
 */
export async function recordUpgrade(repoRoot: string, upstream: UpstreamContext, pending: string[]): Promise<void> {
  const { commit, releaseTag, gitHub } = upstream;
  await writePending(repoRoot, pending);
  await stagePath(repoRoot, pendingFile);

  if (existsSync(join(repoRoot, alignmentsDir))) {
    await git(['rm', '-r', '-q', '--ignore-unmatch', '--', alignmentsDir], repoRoot);
    await rm(join(repoRoot, alignmentsDir), { recursive: true, force: true });
    printProgressStep('alignments', `removed ${alignmentsDir}/: alignments stay upstream, list them with pnpm cella align`);
  }

  await storeUpgradePoint(repoRoot, commit.hash);
  const manifest: UpgradeManifest = {
    upstream: {
      repo: gitHub?.slug,
      track: releaseTag ? 'release' : 'branch',
      commit: commit.hash,
      release: releaseTag ?? null,
      url: gitHub && (releaseTag ? `${gitHub.url}/releases/tag/${releaseTag}` : `${gitHub.url}/commit/${commit.hash}`),
      upgradedAt: new Date().toISOString(),
    },
  };
  const manifestPath = join(repoRoot, manifestFile);
  // A fresh app may not have the cella/ folder yet on its first upgrade.
  await writeOwnedFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await stagePath(repoRoot, manifestFile);
}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getEnvSnapshot } from './env';

const execFileAsync = promisify(execFile);

/** Maximum stdout buffer for subprocess output (50MB). */
export const maxBuffer = 50 * 1024 * 1024;

/**
 * Replace the userinfo part of URLs in text (embedded tokens or passwords) with `***`.
 * Keeps secrets in git remote URLs out of error messages (CWE-532).
 */
function redactUrlSecrets(text: string): string {
  return text.replace(/https?:\/\/[^@\s]+@/g, (match) => {
    const protocol = match.startsWith('https') ? 'https' : 'http';
    return `${protocol}://***@`;
  });
}

/** Options for git command execution */
interface GitCommandOptions {
  /** Skip editor prompts (for merge commits, etc.) */
  skipEditor?: boolean;
  /** Ignore command errors: a failed command returns an empty string. */
  ignoreErrors?: boolean;
  /** Additional environment variables for the git command */
  env?: Record<string, string>;
}

/** Executes a git command and returns trimmed stdout. */
export async function git(args: string[], cwd: string, options: GitCommandOptions = {}): Promise<string> {
  const env = {
    ...getEnvSnapshot(),
    ...(options.skipEditor ? { GIT_EDITOR: 'true' } : {}),
    ...options.env,
  };

  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer });
    return stdout.trim();
  } catch (error) {
    if (options.ignoreErrors) return '';
    if (error instanceof Error) {
      error.message = redactUrlSecrets(error.message);
    }
    throw error;
  }
}

/** The object `ref` resolves to (`rev-parse -q --verify`), or null when it does not resolve. */
export async function revParse(cwd: string, ref: string): Promise<string | null> {
  return (await git(['rev-parse', '-q', '--verify', ref], cwd, { ignoreErrors: true })) || null;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export async function switchBranch(cwd: string, branch: string): Promise<void> {
  await git(['switch', branch], cwd);
}

/**
 * Detach HEAD at a commit or ref (`git switch --detach`), holding no branch.
 */
export async function switchDetached(cwd: string, ref: string): Promise<void> {
  await git(['switch', '--detach', ref], cwd);
}

/**
 * Create and check out a new branch from a specific start point (branch/ref).
 *
 * `--no-track` keeps a remote-tracking start point (`origin/main`) from becoming the new
 * branch's upstream, where a bare `git push` could then land on the trunk.
 */
export async function createBranchFrom(cwd: string, branch: string, startPoint: string): Promise<void> {
  await git(['switch', '-c', branch, '--no-track', startPoint], cwd);
}

/** Whether a local branch exists. */
export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await revParse(cwd, `refs/heads/${branch}`)) !== null;
}

/**
 * The worktree that has `branch` checked out, or null when none has.
 *
 * Git refuses to switch to a branch another worktree has checked out (and to move its ref), so
 * callers that would switch to a shared branch such as the trunk check here first.
 */
export async function getBranchWorktree(cwd: string, branch: string): Promise<string | null> {
  const output = await git(['worktree', 'list', '--porcelain'], cwd);
  let worktree: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return worktree;
  }
  return null;
}

/**
 * Fast-forward a branch no worktree has checked out to `ref`, without checking it out.
 *
 * Fetching from the repository itself (`git fetch . <ref>:<branch>`) moves the branch ref only,
 * and git refuses when that is not a fast-forward or a worktree has the branch checked out.
 */
export async function fastForwardBranch(cwd: string, branch: string, ref: string): Promise<void> {
  await git(['fetch', '--quiet', '.', `${ref}:refs/heads/${branch}`], cwd);
}

/** Delete a local branch (force). No-op if it doesn't exist. */
export async function deleteBranch(cwd: string, branch: string): Promise<void> {
  await git(['branch', '-D', branch], cwd, { ignoreErrors: true });
}

/** Fast-forward the current branch from its upstream tracking branch. */
export async function pullFastForward(cwd: string): Promise<void> {
  await git(['pull', '--ff-only'], cwd, { skipEditor: true });
}

/** How the current branch compares to its upstream tracking branch. */
interface TrackingStatus {
  /** Upstream tracking ref (e.g. `origin/main`), or null when none is configured. */
  tracking: string | null;
  /** Commits the local branch has that its upstream doesn't. */
  ahead: number;
  /** Commits the upstream has that the local branch doesn't. */
  behind: number;
}

/**
 * A branch's upstream tracking ref (e.g. `origin/main`), or null when none is configured.
 * `branch` defaults to the current one.
 */
export async function getTrackingBranch(cwd: string, branch = ''): Promise<string | null> {
  const tracking = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], cwd, {
    ignoreErrors: true,
  });
  return tracking || null;
}

/**
 * How far ahead/behind a branch is of its tracking branch, as last fetched. `branch` defaults to the
 * current one. A named branch is compared by ref, without checking it out, so this also works for a
 * branch another worktree has checked out. `tracking` is null when the branch has none (local-only repo).
 */
export async function getTrackingStatus(cwd: string, branch?: string): Promise<TrackingStatus> {
  const local = branch ? `refs/heads/${branch}` : 'HEAD';
  const tracking = await getTrackingBranch(cwd, branch);
  if (!tracking) return { tracking: null, ahead: 0, behind: 0 };

  const counts = await git(['rev-list', '--left-right', '--count', `${local}...${tracking}`], cwd);
  const [ahead, behind] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
  return { tracking, ahead: ahead ?? 0, behind: behind ?? 0 };
}

/**
 * Push a branch to a remote, setting upstream tracking.
 *
 * `forceWithLease` allows a rewritten branch (see `flattenBranch`) to replace the version
 * already on the remote, while still refusing to overwrite remote commits we haven't seen.
 */
export async function pushBranch(
  cwd: string,
  remote: string,
  branch: string,
  options: { forceWithLease?: boolean } = {},
): Promise<void> {
  await git(['push', '-u', ...(options.forceWithLease ? ['--force-with-lease'] : []), remote, branch], cwd);
}

/**
 * List merge commits made on the current branch itself: commits with two parents on the
 * first-parent chain from HEAD down to where the branch forked off `baseRef` (newest first).
 *
 * `--first-parent` keeps the walk on the branch's own commits, so merge commits that merely
 * exist inside a merged-in history (e.g. upstream's internal merges) don't count.
 */
export async function listBranchMergeCommits(cwd: string, baseRef: string): Promise<string[]> {
  const out = await git(['rev-list', '--merges', '--first-parent', `${baseRef}..HEAD`], cwd);
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * Rewrite the current branch as one commit with `message`, parented on the point where the
 * branch forked off `baseRef`. The tree (content) is kept exactly as-is; only the commit
 * graph changes, so the branch's diff against the base is untouched.
 *
 * Undoes a two-parent merge commit that was already made; {@link commitSquash} says why one is unwanted.
 */
export async function flattenBranch(cwd: string, baseRef: string, message: string): Promise<void> {
  const parent = await getMergeBase(cwd, baseRef, 'HEAD');
  const tree = await git(['rev-parse', 'HEAD^{tree}'], cwd);
  const commit = await git(['commit-tree', tree, '-p', parent, '-m', message], cwd);
  await git(['reset', '--hard', commit], cwd);
}

/**
 * Commit the staged changes as a single-parent commit, discarding any in-progress merge state.
 *
 * A normal commit with `MERGE_HEAD` present records a two-parent merge commit. Because the app
 * doesn't share pushed ancestry with upstream (the local `git replace` graft that makes merges
 * incremental is never pushed), such a merge commit makes the PR list the upstream branch's
 * entire history. Removing the merge state first collapses the staged delta into one clean
 * commit, so the PR shows a single commit with the incremental diff.
 */
export async function commitSquash(cwd: string, message: string): Promise<void> {
  for (const file of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) {
    const path = await gitPath(cwd, file);
    if (existsSync(path)) await unlink(path);
  }
  await git(['commit', '-m', message], cwd, { skipEditor: true });
}

/**
 * Absolute path of a file in the current worktree's git dir. In a linked worktree `.git` is a
 * pointer file and the git dir lives under the main checkout's `.git/worktrees/<name>`.
 */
async function gitPath(cwd: string, file: string): Promise<string> {
  return resolve(cwd, await git(['rev-parse', '--git-path', file], cwd));
}

/**
 * Stage every change in the working tree (`git add -A`), including untracked and deleted files.
 */
export async function stageAll(cwd: string): Promise<void> {
  await git(['add', '-A'], cwd);
}

/**
 * Whether a merge is currently in progress (MERGE_HEAD present), in a linked worktree too.
 */
export async function mergeInProgress(cwd: string): Promise<boolean> {
  return (await revParse(cwd, 'MERGE_HEAD')) !== null;
}

/** A trailing `(#1519)` that squash merges add to a commit subject: the PR number, and the subject without it. */
export function splitPrNumber(subject: string): { subject: string; pr?: number } {
  const match = /\s*\(#(\d+)\)\s*$/.exec(subject);
  return match ? { subject: subject.slice(0, match.index), pr: Number(match[1]) } : { subject };
}

export async function getShortSha(cwd: string, ref: string): Promise<string> {
  return git(['rev-parse', '--short', ref], cwd);
}

export async function getWorkingTreeChangeCount(cwd: string): Promise<number> {
  const status = await git(['status', '--porcelain'], cwd);
  if (!status) return 0;
  return status.split('\n').filter(Boolean).length;
}

/** Add the remote, or point an existing one at `url` (`remote add` fails when it exists). */
export async function ensureRemote(cwd: string, remoteName: string, url: string): Promise<void> {
  await git(['remote', 'add', remoteName, url], cwd, { ignoreErrors: true });
  await git(['remote', 'set-url', remoteName, url], cwd);
}

export async function fetchRemote(cwd: string, remoteName: string): Promise<void> {
  await git(['fetch', remoteName], cwd);
}

/** A remote's URL, empty when the repository has no such remote. */
export async function readRemoteUrl(cwd: string, remoteName: string): Promise<string> {
  return git(['remote', 'get-url', remoteName], cwd, { ignoreErrors: true });
}

/**
 * A GitHub repository from a remote URL (SSH `git@github.com:owner/repo.git` or HTTPS) or an
 * `owner/repo` slug: its slug and base URL. Undefined for anything else, such as a local path.
 */
export function gitHubRepo(remote: string): { slug: string; url: string } | undefined {
  const match = remote.match(/^(?:.*github\.com[:/])?([\w-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) return undefined;
  const slug = `${match[1]}/${match[2]}`;
  return { slug, url: `https://github.com/${slug}` };
}

/** One commit of a log: its full hash, subject and relative date. */
export interface CommitRangeEntry {
  hash: string;
  message: string;
  date: string;
  /** Unix epoch seconds of the commit */
  timestamp?: number;
}

export async function getCommitInfo(cwd: string, ref: string): Promise<CommitRangeEntry> {
  const format = '%H%n%s%n%ar'; // hash, subject, relative date
  const output = await git(['log', '-1', `--format=${format}`, ref], cwd);
  const [hash, message, date] = output.split('\n');
  return { hash, message, date };
}

/** The number of commits in `toRef` that are not in `fromRef`. */
export async function countCommitsBetween(cwd: string, fromRef: string, toRef: string): Promise<number> {
  const output = await git(['rev-list', '--count', `${fromRef}..${toRef}`], cwd);
  return Number.parseInt(output.trim(), 10) || 0;
}

/**
 * List commits in a ref range, oldest-first to match GitHub compare ordering. With `limit`, only the
 * newest `limit` commits (git applies `-n` before `--reverse`).
 */
export async function listCommitsBetween(
  cwd: string,
  fromRef: string,
  toRef: string,
  limit?: number,
): Promise<CommitRangeEntry[]> {
  const args = ['log', '--format=%H%x1f%s%x1f%ar%x1f%ct', '--reverse', `${fromRef}..${toRef}`];
  if (limit) args.push(`-n${limit}`);

  const output = await git(args, cwd, { ignoreErrors: true });
  if (!output) return [];

  const commits: CommitRangeEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [hash, message, date, timestamp] = line.split('\x1f');
    if (!hash || !message || !date) continue;
    commits.push({ hash, message, date, timestamp: Number(timestamp) || undefined });
  }
  return commits;
}

export interface FileChangeInfo {
  date: string;
  hash: string;
  /** Unix epoch seconds of the change, for sorting */
  timestamp: number;
}

/**
 * Relative date and commit hash of the last change for every file in a range,
 * as filePath -> { date, hash, timestamp }; one `git log` call for the whole range.
 */
export async function getFileChangeInfo(
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<Map<string, FileChangeInfo>> {
  const info = new Map<string, FileChangeInfo>();
  const output = await git(['log', '--name-only', '--format=%h %ct %ar', `${fromRef}..${toRef}`], cwd, {
    ignoreErrors: true,
  });
  if (!output) return info;

  let currentHash = '';
  let currentDate = '';
  let currentTimestamp = 0;
  for (const line of output.split('\n')) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{7,})\s+(\d+)\s+(.+)$/);
    if (match) {
      currentHash = match[1];
      currentTimestamp = Number(match[2]);
      currentDate = match[3];
    } else if (currentHash && currentDate && !info.has(line)) {
      // git log lists newest first, so the first entry per path is its last change.
      info.set(line, { date: currentDate, hash: currentHash, timestamp: currentTimestamp });
    }
  }
  return info;
}

/** Whether the working tree is clean (no uncommitted changes). */
export async function isClean(cwd: string): Promise<boolean> {
  return (await getWorkingTreeChangeCount(cwd)) === 0;
}

/**
 * Perform a merge in the current directory, leaving it staged (--no-commit --no-edit).
 * Always uses --no-ff to prevent fast-forward, ensuring HEAD stays in place
 * and MERGE_HEAD is created for proper merge state tracking.
 */
export async function merge(cwd: string, ref: string): Promise<{ success: boolean; conflicts: string[] }> {
  try {
    await git(['merge', '--no-ff', '--no-commit', '--no-edit', ref], cwd, { skipEditor: true });
    return { success: true, conflicts: [] };
  } catch (error) {
    const conflicts = await getConflictedFiles(cwd);
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    throw error;
  }
}

export async function getConflictedFiles(cwd: string): Promise<string[]> {
  const output = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

export async function mergeAbort(cwd: string): Promise<void> {
  await git(['merge', '--abort'], cwd);
}

export async function fileExistsAtRef(cwd: string, ref: string, filePath: string): Promise<boolean> {
  const result = await git(['ls-tree', '--name-only', ref, '--', filePath], cwd, { ignoreErrors: true });
  return result !== '';
}

/**
 * Check out paths from a ref into index and worktree. During a merge this also settles unmerged
 * (conflicted) paths on `ref`'s version, which `git restore --source` refuses to do.
 */
export async function checkoutFromRef(cwd: string, ref: string, paths: string[]): Promise<void> {
  await git(['checkout', ref, '--', ...paths], cwd);
}

/**
 * Restore a path from a ref into the working tree only, leaving the index untouched,
 * so adopted changes remain unstaged for review.
 */
export async function restoreWorktreeFromRef(cwd: string, ref: string, filePath: string): Promise<void> {
  await git(['restore', `--source=${ref}`, '--worktree', '--', filePath], cwd);
}

/**
 * Restore paths from a ref into the working tree only, in batches, leaving the index untouched.
 * Paths are taken literally, so a file name with glob characters (`[id].tsx`) restores that file.
 */
export async function batchRestoreWorktreeFromRef(cwd: string, ref: string, filePaths: string[]): Promise<void> {
  const batchSize = 200;
  for (let i = 0; i < filePaths.length; i += batchSize) {
    const batch = filePaths.slice(i, i + batchSize);
    await git(['--literal-pathspecs', 'restore', `--source=${ref}`, '--worktree', '--', ...batch], cwd);
  }
}

/**
 * Paths at `ref` whose working tree copy is byte-identical to it. Renames are not detected, so a
 * file the working tree moved away counts as changed at its old path.
 */
export async function listIdenticalToRef(cwd: string, ref: string): Promise<Set<string>> {
  const nulSeparated = (out: string) => out.split('\0').filter(Boolean);
  const [tracked, changed] = await Promise.all([
    git(['ls-tree', '-r', '--name-only', '-z', ref], cwd),
    git(['diff', '--name-only', '--no-renames', '-z', ref, '--'], cwd),
  ]);
  const differs = new Set(nulSeparated(changed));
  return new Set(nulSeparated(tracked).filter((path) => !differs.has(path)));
}

/** Tracked paths under `paths` whose working tree copy differs from `ref` (renames not detected). */
export async function listChangedSinceRef(cwd: string, ref: string, paths: string[]): Promise<string[]> {
  const out = await git(['--literal-pathspecs', 'diff', '--name-only', '--no-renames', '-z', ref, '--', ...paths], cwd);
  return out.split('\0').filter(Boolean);
}

export async function getMergeBase(cwd: string, ref1: string, ref2: string): Promise<string> {
  return git(['merge-base', ref1, ref2], cwd);
}

/** File change status codes from git diff-tree */
type FileChangeStatus = 'A' | 'D' | 'M' | 'T' | 'R';

/** File change info from git diff-tree */
export interface FileChange {
  status: FileChangeStatus;
  baseHash: string | null;
  targetHash: string | null;
  /** For renames: the original path (before rename) */
  oldPath?: string;
}

/**
 * Files changed between two refs (`git diff-tree -r -M90%`), as filePath -> FileChange.
 * Status codes: A=added, D=deleted, M=modified, T=type-changed, R=renamed (90% similarity
 * threshold). A rename is keyed by its NEW path, with `oldPath` stored in the value.
 */
export async function getFileChanges(
  cwd: string,
  baseRef: string,
  targetRef: string,
): Promise<Map<string, FileChange>> {
  const output = await git(['diff-tree', '-r', '-M90%', '--no-commit-id', baseRef, targetRef], cwd);
  const changes = new Map<string, FileChange>();

  // diff-tree prints the all-zero hash for a missing side (added/deleted files).
  const hashOrNull = (hash: string) => (hash === '0'.repeat(40) ? null : hash);

  for (const line of output.split('\n')) {
    // `:oldmode newmode oldhash newhash status\tpath`; a rename is `Rxx\toldpath\tnewpath`.
    const m = line.match(/^:\d+ \d+ ([a-f0-9]+) ([a-f0-9]+) ([ADMRT])\d*\t([^\t]+)(?:\t(.+))?$/);
    if (!m) continue;
    const status = m[3] as FileChangeStatus;
    changes.set(m[5] ?? m[4], {
      status,
      baseHash: hashOrNull(m[1]),
      targetHash: hashOrNull(m[2]),
      ...(status === 'R' ? { oldPath: m[4] } : {}),
    });
  }
  return changes;
}

/** Lines added/removed for one path (`null` for binary files, where git reports `-`). */
interface DiffStat {
  additions: number | null;
  deletions: number | null;
}

/**
 * Lines added/removed per file between two refs (`git diff --numstat`), optionally limited
 * to `paths`. Renames are not detected (`--no-renames`) so every entry is keyed by its plain
 * path, never git's `old => new` notation.
 */
export async function getDiffStat(
  cwd: string,
  fromRef: string,
  toRef: string,
  paths: string[] = [],
): Promise<Map<string, DiffStat>> {
  const args = ['diff', '--numstat', '--no-renames', fromRef, toRef];
  if (paths.length > 0) args.push('--', ...paths);
  const out = await git(args, cwd, { ignoreErrors: true });

  const stat = new Map<string, DiffStat>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    stat.set(path, {
      additions: a === '-' ? null : Number(a),
      deletions: d === '-' ? null : Number(d),
    });
  }
  return stat;
}

/** All file hashes at a ref (one `ls-tree -r` call), as filePath -> hash. */
export async function getFileHashesAtRef(cwd: string, ref: string): Promise<Map<string, string>> {
  const output = await git(['ls-tree', '-r', ref], cwd);
  const hashes = new Map<string, string>();

  if (!output) return hashes;

  for (const line of output.split('\n')) {
    if (!line) continue;
    // Parse: <mode> <type> <hash>\t<path>
    const match = line.match(/^\d+ \w+ ([a-f0-9]+)\t(.+)$/);
    if (match) {
      const [, hash, filePath] = match;
      hashes.set(filePath, hash);
    }
  }

  return hashes;
}

/**
 * Tracked delete (`git rm -f`), recording a deletion in the merge result. A path the index lacks is
 * skipped, which git otherwise refuses for the whole batch. With `cached`, the paths leave the index
 * only and the working tree is untouched.
 */
export async function gitRm(cwd: string, paths: string[], options: { cached?: boolean } = {}): Promise<void> {
  await git(['rm', ...(options.cached ? ['--cached'] : []), '-f', '--ignore-unmatch', '--', ...paths], cwd);
}

/** Move a file (`git mv -f`), creating parent directories as needed. */
export async function gitMv(cwd: string, oldPath: string, newPath: string): Promise<void> {
  const newDir = dirname(join(cwd, newPath));
  await mkdir(newDir, { recursive: true });

  await git(['mv', '-f', oldPath, newPath], cwd);
}

/**
 * Moves the copy of `from` that `ref` holds to `to`, staged in the index and written to the worktree, and removes
 * `from`. Any merge stages at `to` give way to it; the blob is copied by id, so binary files stay intact.
 */
export async function moveFromRef(cwd: string, ref: string, from: string, to: string): Promise<void> {
  const [mode, , blob] = (await git(['ls-tree', ref, '--', from], cwd)).split(/\s+/);
  if (!blob) throw new Error(`${ref} holds no ${from}`);
  await gitRm(cwd, [to], { cached: true });
  await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${to}`], cwd);
  await mkdir(dirname(join(cwd, to)), { recursive: true });
  await git(['checkout-index', '-f', '--', to], cwd);
  await removeFileFully(cwd, from);
}

export async function fileExistsInWorktree(cwd: string, filePath: string): Promise<boolean> {
  return existsSync(join(cwd, filePath));
}

/**
 * Remove a file from the worktree filesystem if it exists.
 * Used to clean up files that git rm may not have removed (e.g., after squash merge).
 */
export async function removeFileFromWorktree(cwd: string, filePath: string): Promise<void> {
  const fullPath = join(cwd, filePath);
  try {
    await unlink(fullPath);
    await cleanupEmptyParentDirs(cwd, dirname(filePath));
  } catch {
    // File missing or not removable: ignore
  }
}

/**
 * Fully remove a file: tracked delete from the index (git rm) plus filesystem removal
 * for cases git rm leaves behind (e.g. during a merge), including empty parent dirs.
 */
export async function removeFileFully(cwd: string, filePath: string): Promise<void> {
  await gitRm(cwd, [filePath]);
  await removeFileFromWorktree(cwd, filePath);
}

/**
 * Recursively remove empty parent directories up to (but not including) the root.
 * Stops when encountering a non-empty directory or the root.
 */
async function cleanupEmptyParentDirs(cwd: string, relativePath: string): Promise<void> {
  if (!relativePath || relativePath === '.') return;

  const fullPath = join(cwd, relativePath);
  try {
    const entries = await readdir(fullPath);
    if (entries.length === 0) {
      await rmdir(fullPath);
      await cleanupEmptyParentDirs(cwd, dirname(relativePath));
    }
  } catch {
    // Directory missing, not empty, or not removable: stop
  }
}

/** Stage a single path (git add). Best-effort: never throws. */
export async function stagePath(cwd: string, path: string): Promise<void> {
  await git(['add', '--', path], cwd, { ignoreErrors: true });
}

/**
 * Whether `ancestor` is an ancestor of `descendant`.
 * @throws when git cannot answer, such as for a commit this clone lacks.
 */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return true;
  } catch (error) {
    // Exit code 1 is git's "no".
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

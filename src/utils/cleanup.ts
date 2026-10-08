/**
 * Worktree cleanup and signal handlers for graceful abort. Worktrees live in a
 * temp directory outside the repo so they never appear in the IDE.
 */

import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import pc from './colors';
import { checkMark, warningMark } from './display';
import { errorMessage } from './errors';
import { listWorktrees, mergeAbort, removeWorktree } from './git';

/**
 * Managed worktree kinds and their system-temp directory prefixes.
 *
 * - `sync`: temporary merge preview worktree. Registered for signal cleanup and
 *   removed when the process exits.
 * - `view`: legacy "upstream view" worktree that backed VS Code diff links in
 *   older CLI versions (before browser diffs). No longer created; the prefix is
 *   kept so leftovers from previous versions are removed on the next run.
 */
const WORKTREE_PREFIXES = {
  sync: 'cella-sync-',
  view: 'cella-view-',
} as const;

type WorktreeKind = keyof typeof WORKTREE_PREFIXES;

/**
 * Build the system-temp worktree path for a kind: the repo folder name plus a hash of its full
 * path, so two repos with the same folder name (or parallel test runs) never share one.
 */
function buildWorktreePath(kind: WorktreeKind, repoPath: string): string {
  const key = createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 8);
  return join(tmpdir(), `${WORKTREE_PREFIXES[kind]}${basename(repoPath)}-${key}`);
}

/** The path earlier CLI versions used, the repo folder name alone. Cleaned up, never created. */
function legacyWorktreePath(kind: WorktreeKind, repoPath: string): string {
  return join(tmpdir(), `${WORKTREE_PREFIXES[kind]}${basename(repoPath)}`);
}

/** The temporary sync worktree path in the system temp directory (invisible to the IDE). */
export function getWorktreePath(repoPath: string): string {
  return buildWorktreePath('sync', repoPath);
}

let cleanupRegistered = false;

let currentWorktreePath: string | null = null;
let currentRepoPath: string | null = null;

/** Register a worktree for cleanup on exit/abort. */
export function registerWorktree(repoPath: string, worktreePath: string): void {
  currentRepoPath = repoPath;
  currentWorktreePath = worktreePath;
}

/** Unregister the worktree (call after successful cleanup). */
function unregisterWorktree(): void {
  currentRepoPath = null;
  currentWorktreePath = null;
}

export async function cleanupWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await removeWorktree(repoPath, worktreePath);

  // git worktree remove can leave the directory; force-remove what remains.
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }

  unregisterWorktree();
}

/**
 * Clean up any leftover worktrees from a previous (interrupted) run, including
 * the legacy upstream-view worktree created by older CLI versions.
 * No-op when no leftovers exist (the common case).
 */
export async function cleanupLeftoverWorktrees(repoPath: string): Promise<void> {
  for (const kind of Object.keys(WORKTREE_PREFIXES) as WorktreeKind[]) {
    for (const worktreePath of [buildWorktreePath(kind, repoPath), legacyWorktreePath(kind, repoPath)]) {
      if (existsSync(worktreePath)) await cleanupWorktree(repoPath, worktreePath);
    }
  }

  // Also prune any orphaned git worktree references for our managed prefixes.
  const prefixes = Object.values(WORKTREE_PREFIXES);
  const worktrees = await listWorktrees(repoPath);
  for (const wt of worktrees) {
    if (prefixes.some((prefix) => wt.includes(prefix)) && !existsSync(wt)) {
      await removeWorktree(repoPath, wt);
    }
  }
}

async function handleAbort(signal: string): Promise<void> {
  console.info();
  console.info(`${warningMark} interrupted (${signal}): cleaning up...`);

  if (currentRepoPath && currentWorktreePath) {
    try {
      await mergeAbort(currentWorktreePath);
    } catch {
      // Ignore: merge may not be in progress
    }

    try {
      await cleanupWorktree(currentRepoPath, currentWorktreePath);
      console.info(`${checkMark} no changes were made to your repository.`);
    } catch (error) {
      console.error(`${pc.red('✗')} failed to clean up worktree: ${errorMessage(error)}`);
    }
  }

  process.exit(1);
}

export function registerSignalHandlers(): void {
  if (cleanupRegistered) return;

  process.on('SIGINT', () => handleAbort('SIGINT'));
  process.on('SIGTERM', () => handleAbort('SIGTERM'));

  cleanupRegistered = true;
}

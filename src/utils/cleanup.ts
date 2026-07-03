/**
 * Cleanup utilities for sync CLI v2.
 *
 * Handles worktree cleanup and signal handlers for graceful abort.
 * Uses a temp directory outside the repo so worktree doesn't appear in VSCode.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import pc from './colors';
import { warningMark } from './display';
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

/** Build the system-temp worktree path for a kind, keyed by repo name for uniqueness. */
function buildWorktreePath(kind: WorktreeKind, repoPath: string): string {
  return join(tmpdir(), `${WORKTREE_PREFIXES[kind]}${basename(repoPath)}`);
}

/** Get the temporary sync worktree path in system temp directory (invisible to VSCode). */
export function getWorktreePath(repoPath: string): string {
  return buildWorktreePath('sync', repoPath);
}

/** Track if cleanup is registered */
let cleanupRegistered = false;

/** Track current worktree for cleanup */
let currentWorktreePath: string | null = null;
let currentRepoPath: string | null = null;

/**
 * Register a worktree for cleanup on exit/abort.
 */
export function registerWorktree(repoPath: string, worktreePath: string): void {
  currentRepoPath = repoPath;
  currentWorktreePath = worktreePath;
}

/**
 * Unregister the worktree (call after successful cleanup).
 */
function unregisterWorktree(): void {
  currentRepoPath = null;
  currentWorktreePath = null;
}

/**
 * Clean up the worktree directory.
 */
export async function cleanupWorktree(repoPath: string, worktreePath: string): Promise<void> {
  // Try git worktree remove first
  await removeWorktree(repoPath, worktreePath);

  // Force remove directory if it still exists
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
    const worktreePath = buildWorktreePath(kind, repoPath);
    if (existsSync(worktreePath)) {
      await cleanupWorktree(repoPath, worktreePath);
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

/**
 * Handle abort signal (Ctrl+C).
 */
async function handleAbort(signal: string): Promise<void> {
  console.info();
  console.info(`${warningMark} Interrupted (${signal}) - cleaning up...`);

  if (currentRepoPath && currentWorktreePath) {
    try {
      // Try to abort any in-progress merge in the worktree
      await mergeAbort(currentWorktreePath);
    } catch {
      // Ignore - merge may not be in progress
    }

    try {
      await cleanupWorktree(currentRepoPath, currentWorktreePath);
      console.info(`${pc.green('✓')} no changes were made to your repository.`);
    } catch (error) {
      console.error(
        `${pc.red('✗')} failed to clean up worktree: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  process.exit(1);
}

/**
 * Register signal handlers for graceful cleanup.
 */
export function registerSignalHandlers(): void {
  if (cleanupRegistered) return;

  process.on('SIGINT', () => handleAbort('SIGINT'));
  process.on('SIGTERM', () => handleAbort('SIGTERM'));

  cleanupRegistered = true;
}

/**
 * Shared helpers for the fork-aware services (`forks` and `contributions`).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ForkConfig } from '../config/types';
import pc from '../utils/colors';
import { git } from '../utils/git';

/**
 * Base directory that relative fork `localPath` values resolve against.
 *
 * A `localPath` like `../my-app` is written relative to the repository's main checkout. When
 * the CLI runs inside a linked worktree (e.g. `.claude/worktrees/x`), resolving against the
 * worktree would point inside the worktrees directory, so resolve against the main repository
 * root: the parent of the shared git common dir. Falls back to `repoPath` outside a repository.
 */
export async function resolveForkBasePath(repoPath: string): Promise<string> {
  const commonDir = await git(['rev-parse', '--git-common-dir'], repoPath, { ignoreErrors: true });
  return commonDir ? dirname(resolve(repoPath, commonDir)) : repoPath;
}

/** A fork config paired with its validation result. */
export interface ValidatedFork {
  fork: ForkConfig;
  resolvedPath: string;
  valid: boolean;
  error?: string;
}

/**
 * Validate a fork's local path resolves safely and points at a git repository.
 *
 * @param requireConfig when true, the fork must also contain a `cella.config.ts`.
 */
export function validateForkPath(fork: ForkConfig, basePath: string, requireConfig = false): ValidatedFork {
  const resolvedPath = resolve(basePath, fork.localPath);

  // Validate resolved path doesn't escape the parent directory via traversal (CWE-22)
  if (!resolvedPath.startsWith(resolve(basePath, '..'))) {
    return { fork, resolvedPath, valid: false, error: 'path resolves outside parent directory' };
  }
  if (!existsSync(resolvedPath)) return { fork, resolvedPath, valid: false, error: 'path does not exist' };
  if (!existsSync(`${resolvedPath}/.git`)) return { fork, resolvedPath, valid: false, error: 'not a git repository' };
  if (requireConfig && !existsSync(`${resolvedPath}/cella.config.ts`)) {
    return { fork, resolvedPath, valid: false, error: 'missing cella.config.ts' };
  }

  return { fork, resolvedPath, valid: true };
}

/**
 * Print the "no forks configured" empty-state with a config example.
 *
 * @param action a short dim line describing what forks enable (e.g. 'add forks to your config:').
 */
export function printNoForksHint(action: string): void {
  console.info(pc.yellow('no forks configured in cella.config.ts'));
  console.info(pc.dim(action));
  console.info(pc.dim(`  forks: [{ name: 'my-app', localPath: '../my-app', pullBranch: 'development' }]`));
}

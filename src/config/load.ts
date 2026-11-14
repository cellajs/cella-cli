/**
 * Config loading utilities for the cella CLI.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { configFile } from '../upstream/managed-files';
import { errorMessage } from '../utils/errors';
import { resolveAppModuleFolders } from './app-modules';
import { type CellaCliConfig, cellaConfigSchema, type PackageJsonKey, type UpgradeSettings } from './types';

/** Default git remote name used to point at the upstream repository. */
export const defaultUpstreamRemote = 'cella-upstream';

/** Default branch used when a config omits `upstreamBranch` or `releaseBase`; also cella's fork-compare base. */
export const defaultBranch = 'main';

/**
 * Prefix for the temporary integration branches that `cella upgrade` cuts per run
 * (e.g. `cella/upgrade/20260702-1430`).
 *
 * The three-segment shape (`cella/upgrade/<stamp>`) means it can never collide with a real branch
 * named `cella` or `cella/upgrade`.
 */
export const upgradeBranchPrefix = 'cella/upgrade';

/** The package.json keys that merge when a config omits `packageJsonKeys`. */
export const defaultPackageJsonKeys: PackageJsonKey[] = ['dependencies', 'devDependencies'];

/** Whether the repo at `repoPath` is upstream cella itself (its root package.json is named 'cella'). */
export function isUpstreamRepo(repoPath: string): boolean {
  return JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')).name === 'cella';
}

/** Whether `branch` is one of the temporary integration branches `cella upgrade` cuts. */
export function isUpgradeBranch(branch: string): boolean {
  return branch.startsWith(`${upgradeBranchPrefix}/`);
}

/**
 * Resolve the trunk branch `cella upgrade` cuts the temporary branch from and PRs into.
 */
export function resolveTrunk(settings: UpgradeSettings): string {
  return settings.releaseBase ?? defaultBranch;
}

/**
 * Build a unique temporary integration branch name for an upgrade cycle, e.g.
 * `cella/upgrade/20260702-1430`. Cutting a fresh branch per cycle keeps each PR
 * scoped to that upgrade's upstream delta.
 */
export function buildUpgradeBranchName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${upgradeBranchPrefix}/${stamp}`;
}

/**
 * Resolve the upstream tracking plan from upgrade settings.
 *
 * Single source of truth shared by the CLI entry point and the merge engine.
 * The concrete ref for release tracking (latest tag) can only be resolved after
 * fetching, so this returns a plan; the merge engine turns it into a ref.
 *
 * - `track`: 'release' (default) upgrades to the latest release tag; 'branch' follows the tip.
 * - `branchRef`: `<defaultUpstreamRemote>/<branch>`, the branch-track ref and static fallback.
 */
export function resolveUpstream(settings: UpgradeSettings): {
  track: 'release' | 'branch';
  branchRef: string;
} {
  const track = settings.upstreamTrack ?? 'release';
  const branch = settings.upstreamBranch ?? defaultBranch;
  const branchRef = `${defaultUpstreamRemote}/${branch}`;
  return { track, branchRef };
}

/**
 * Load cella/cella.config.ts from a repository path.
 */
export async function loadConfig(repoRoot: string): Promise<CellaCliConfig> {
  const configPath = join(repoRoot, configFile);

  if (!existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }

  // Resolve symlinks and validate the path stays within the repository
  const realConfigPath = realpathSync(configPath);
  const realRepoRoot = realpathSync(resolve(repoRoot));
  if (!realConfigPath.startsWith(`${realRepoRoot}/`)) {
    throw new Error('config path resolves outside the repository');
  }

  let configModule: { default?: unknown };
  try {
    configModule = await import(realConfigPath);
  } catch (error) {
    // Syntax/runtime errors while evaluating the config must fail closed: a config that
    // cannot be loaded means upgrade protections (ignored/pinned) are unknown.
    throw new Error(`failed to load ${configPath}: ${errorMessage(error)}`);
  }

  // Strict schema validation.
  const result = cellaConfigSchema.safeParse(configModule.default);
  if (!result.success) {
    throw new Error(`invalid ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  const config: CellaCliConfig = result.data;

  // Auto-derive app-owned module folders (modules declaring `owner: 'app'`) and merge
  // them into ignored. This keeps app modules as app territory: upstream never
  // adds/modifies/deletes them during upgrade, and the adopt service never offers
  // them back upstream. Derived entries always exist (they come from real files), so
  // config validation never warns about them.
  const appModuleFolders = resolveAppModuleFolders(realRepoRoot);
  if (appModuleFolders.length > 0) {
    const existing = config.overrides?.ignored ?? [];
    config.overrides = {
      ...config.overrides,
      ignored: [...new Set([...existing, ...appModuleFolders])],
    };
  }

  return config;
}

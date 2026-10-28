/**
 * Config loading utilities for the cella CLI.
 *
 * Shared between main entry point and forks service.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type CellaCliConfig, cellaConfigSchema, type PackageJsonKey, type SyncSettings } from '../config/types';
import { errorMessage } from './errors';
import { CONFIG_FILE } from './managed-files';
import { resolveAppModuleFolders } from './module-territory';

/** Default git remote name used to point at the upstream repository. */
export const DEFAULT_UPSTREAM_REMOTE = 'cella-upstream';

/** Default branch used when a config omits `upstreamBranch` or `releaseBase`; also cella's fork-compare base. */
export const DEFAULT_BRANCH = 'main';

/**
 * Prefix for the temporary integration branches that `cella upgrade` cuts per run
 * (e.g. `cella/upgrade/20260702-1430`).
 *
 * The three-segment shape (`cella/upgrade/<stamp>`) means it can never collide with a real branch
 * named `cella` or `cella/upgrade`.
 */
export const UPGRADE_BRANCH_PREFIX = 'cella/upgrade';

/** Branch prefixes of a cycle in progress or an open PR: CLI 0.5 cut its branches under `cella/sync`. */
export const TEMPORARY_BRANCH_PREFIXES = [UPGRADE_BRANCH_PREFIX, 'cella/sync'];

/** The package.json keys that merge when a config omits `packageJsonKeys`. */
export const DEFAULT_PACKAGE_JSON_KEYS: PackageJsonKey[] = ['dependencies', 'devDependencies'];

/** Settings renamed in 0.6, by their old name: `loadConfig` reads them under the new one. */
const RENAMED_SETTINGS = { packageJsonSync: 'packageJsonKeys', syncWithPackages: 'mergePackageJson' } as const;

/** A warning per renamed setting the config still uses. */
export function renamedSettingWarnings(config: CellaCliConfig): string[] {
  return Object.entries(RENAMED_SETTINGS)
    .filter(([old]) => old in config.settings)
    .map(([old, current]) => `settings.${old} is renamed to ${current}: rename it in ${CONFIG_FILE}`);
}

/** Whether the repo at `repoPath` is upstream cella itself (its root package.json is named 'cella'). */
export function isUpstreamRepo(repoPath: string): boolean {
  return JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')).name === 'cella';
}

/** Whether `branch` is one of the temporary integration branches `cella upgrade` cuts. */
export function isTemporarySyncBranch(branch: string): boolean {
  return TEMPORARY_BRANCH_PREFIXES.some((prefix) => branch.startsWith(`${prefix}/`));
}

/**
 * Resolve the trunk branch `cella upgrade` cuts the temporary branch from and PRs into.
 */
export function resolveReleaseBase(settings: SyncSettings): string {
  return settings.releaseBase ?? DEFAULT_BRANCH;
}

/**
 * Build a unique temporary integration branch name for an upgrade cycle, e.g.
 * `cella/upgrade/20260702-1430`. Cutting a fresh branch per cycle keeps each PR
 * scoped to that upgrade's upstream delta.
 */
export function buildTemporarySyncBranch(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${UPGRADE_BRANCH_PREFIX}/${stamp}`;
}

/**
 * Resolve the upstream tracking plan from sync settings.
 *
 * Single source of truth shared by the CLI entry point and the merge engine.
 * The concrete ref for release tracking (latest tag) can only be resolved after
 * fetching, so this returns a plan; the merge engine turns it into a ref.
 *
 * - `track`: 'release' (default) upgrades to the latest release tag; 'branch' follows the tip.
 * - `branchRef`: `<DEFAULT_UPSTREAM_REMOTE>/<branch>`, the branch-track ref and static fallback.
 */
export function resolveUpstream(settings: SyncSettings): {
  track: 'release' | 'branch';
  branchRef: string;
} {
  const track = settings.upstreamTrack ?? 'release';
  const branch = settings.upstreamBranch ?? DEFAULT_BRANCH;
  const branchRef = `${DEFAULT_UPSTREAM_REMOTE}/${branch}`;
  return { track, branchRef };
}

/**
 * Load cella/cella.config.ts from a fork/repo path.
 */
export async function loadConfig(forkPath: string): Promise<CellaCliConfig> {
  const configPath = join(forkPath, CONFIG_FILE);

  if (!existsSync(configPath)) {
    throw new Error(`config file not found: ${configPath}`);
  }

  // Resolve symlinks and validate path stays within fork directory
  const realConfigPath = realpathSync(configPath);
  const realForkPath = realpathSync(resolve(forkPath));
  if (!realConfigPath.startsWith(`${realForkPath}/`)) {
    throw new Error('config path resolves outside fork directory');
  }

  let configModule: { default?: unknown };
  try {
    configModule = await import(realConfigPath);
  } catch (error) {
    // Syntax/runtime errors while evaluating the config must fail closed: a config that
    // cannot be loaded means sync protections (ignored/pinned) are unknown.
    throw new Error(`failed to load ${configPath}: ${errorMessage(error)}`);
  }

  // Strict schema validation.
  const result = cellaConfigSchema.safeParse(configModule.default);
  if (!result.success) {
    throw new Error(`invalid ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  const config: CellaCliConfig = result.data;
  // Settings renamed in 0.6 keep working under their old names (see RENAMED_SETTINGS).
  config.settings.packageJsonKeys ??= config.settings.packageJsonSync;
  config.settings.mergePackageJson ??= config.settings.syncWithPackages;

  // Auto-derive fork-owned module folders (modules declaring `owner: 'app'`) and merge
  // them into ignored. This keeps app modules as fork territory: upstream never
  // adds/modifies/deletes them during sync, and the contributions service never offers
  // them back upstream. Derived entries always exist (they come from real files), so
  // config validation never warns about them.
  const appModuleFolders = resolveAppModuleFolders(realForkPath);
  if (appModuleFolders.length > 0) {
    const existing = config.overrides?.ignored ?? [];
    config.overrides = {
      ...config.overrides,
      ignored: [...new Set([...existing, ...appModuleFolders])],
    };
  }

  return config;
}

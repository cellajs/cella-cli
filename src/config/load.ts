/**
 * Config loading utilities for the cella CLI.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { configFile } from '../upstream/managed-files';
import { warningMark } from '../utils/display';
import { errorMessage } from '../utils/errors';
import { resolveAppModuleFolders } from './app-modules';
import { type CellaCliConfig, cellaConfigSchema, type PackageJsonKey } from './types';

/** Default git remote name used to point at the upstream repository. */
export const defaultUpstreamRemote = 'cella-upstream';

/** Default branch used when a config omits `upstreamBranch` or `trunk`; also cella's fork-compare base. */
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
export function resolveTrunk(config: CellaCliConfig): string {
  return config.trunk ?? defaultBranch;
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
 * Resolve the upstream tracking plan from the config.
 *
 * Single source of truth shared by the CLI entry point and the merge engine.
 * The concrete ref for release tracking (latest tag) can only be resolved after
 * fetching, so this returns a plan; the merge engine turns it into a ref.
 *
 * - `track`: 'release' (default) upgrades to the latest release tag; 'branch' follows the tip.
 * - `branchRef`: `<defaultUpstreamRemote>/<branch>`, the branch-track ref and static fallback.
 */
export function resolveUpstream(config: CellaCliConfig): {
  track: 'release' | 'branch';
  branchRef: string;
} {
  const track = config.upstreamTrack ?? 'release';
  const branch = config.upstreamBranch ?? defaultBranch;
  const branchRef = `${defaultUpstreamRemote}/${branch}`;
  return { track, branchRef };
}

/** The 0.7 shape: the settings and the two path lists in wrappers, `forks` beside them. */
const shape07 = z.looseObject({
  settings: z.record(z.string(), z.unknown()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

/** Configs warned about in this process: the menu and the command it picks each load the config. */
const warnedPaths = new Set<string>();

/**
 * A config in the 0.7 shape, mapped to the current one with one warning that names the keys to move: `cella upgrade`
 * installs the new CLI and runs its later stages with it before the app can edit its config. Goes at 1.0.
 *
 * @throws when the config mixes both shapes.
 */
function fromShape07(value: unknown, configPath: string): unknown {
  const parsed = shape07.safeParse(value);
  if (!parsed.success || (!parsed.data.settings && !parsed.data.overrides)) return value;
  const { settings = {}, overrides = {}, ...rest } = parsed.data;
  const mixed = Object.keys(rest).filter((key) => key !== 'forks');
  if (mixed.length > 0) {
    throw new Error(`${configPath} mixes the 0.7 shape (settings, overrides) with top-level ${mixed.join(', ')}`);
  }

  const { releaseBase, mergePackageJson, ...kept } = settings;
  const moved = [
    ...Object.keys(kept).map((key) => `settings.${key}`),
    ...Object.keys(overrides).map((key) => `overrides.${key}`),
  ];
  const changes = [
    `move ${moved.join(', ')} to the top level`,
    ...(releaseBase === undefined ? [] : ['rename settings.releaseBase to trunk']),
    ...(mergePackageJson === undefined ? [] : ['drop settings.mergePackageJson (false is packageJsonKeys: false)']),
  ];
  if (!warnedPaths.has(configPath)) {
    console.warn(
      `${warningMark} ${configPath} has the 0.7 shape, which the CLI reads until 1.0: ${changes.join(', ')}.`,
    );
  }
  warnedPaths.add(configPath);
  return {
    ...rest,
    ...kept,
    ...overrides,
    ...(releaseBase === undefined ? {} : { trunk: releaseBase }),
    ...(mergePackageJson === false ? { packageJsonKeys: false } : {}),
  };
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
  const result = cellaConfigSchema.safeParse(fromShape07(configModule.default, configPath));
  if (!result.success) {
    throw new Error(`invalid ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  const config: CellaCliConfig = result.data;

  // Auto-derive app-owned module folders (modules declaring `owner: 'app'`) and merge
  // them into ignored. This keeps app modules as app territory: upstream never
  // adds/modifies/deletes them during upgrade, and the adopt command never offers
  // them back upstream. Derived entries always exist (they come from real files), so
  // config validation never warns about them.
  const appModuleFolders = resolveAppModuleFolders(realRepoRoot);
  if (appModuleFolders.length > 0) config.ignored = [...new Set([...(config.ignored ?? []), ...appModuleFolders])];

  return config;
}

/**
 * Packages service for sync CLI v2.
 *
 * Syncs package.json keys between fork and upstream, three-way against the merge-base
 * package.json (upstream as of the previous sync):
 * - Add: entries that are new upstream are added
 * - Follow: an entry the fork never touched (still equal to its base value) follows upstream,
 *   whether upstream rewrote a script, changed a range, or dropped the entry
 * - Keep: an entry the fork added or changed stays, except that a strictly higher upstream
 *   version still bumps it; an entry the fork removed is not re-added
 * - Supports nested `pnpm` key (overrides, patchedDependencies, packageExtensions)
 * - A workspace package.json upstream added since the base arrives verbatim
 * Without a base (first sync, unrelated history) every upstream entry is added or bumped and
 * nothing is removed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageJsonSyncKey, RuntimeConfig } from '../config/types';
import pc from '../utils/colors';
import { createSpinner, spinnerSuccess, spinnerText, warningMark } from '../utils/display';
import { getEffectiveMergeBase, git } from '../utils/git';
import { isIgnored } from '../utils/overrides';

/** Package.json structure */
interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  overrides?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
    patchedDependencies?: Record<string, string>;
    packageExtensions?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ComparableVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseComparableVersion(version: string): ComparableVersion | null {
  const trimmed = version.trim();

  if (
    trimmed === '' ||
    trimmed === '*' ||
    trimmed.includes('workspace:') ||
    trimmed.includes('catalog:') ||
    trimmed.includes('file:') ||
    trimmed.includes('link:') ||
    trimmed.includes('git+') ||
    trimmed.includes('github:') ||
    trimmed.includes('http://') ||
    trimmed.includes('https://') ||
    trimmed.includes('||')
  ) {
    return null;
  }

  const match = trimmed.match(
    /^(?:\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );

  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersions(left: ComparableVersion, right: ComparableVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/**
 * Check if upstream version is higher than fork version.
 * Returns true only if upstream is strictly higher — never downgrades.
 * For non-parseable values (workspace:*, etc.), returns false (keep fork's).
 */
function isHigherVersion(upstreamVersion: string, forkVersion: string): boolean {
  if (upstreamVersion === forkVersion) return false;

  const upCoerced = parseComparableVersion(upstreamVersion);
  const forkCoerced = parseComparableVersion(forkVersion);

  if (!upCoerced || !forkCoerced) return false;

  return compareVersions(upCoerced, forkCoerced) > 0;
}

interface RecordMergeResult {
  merged: Record<string, string>;
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
}

/**
 * Three-way merge for a Record<string, string> key (dependencies, scripts, overrides, ...).
 * `baseRecord` is the key at the merge-base: an entry whose fork value still equals its base
 * value was never touched by the fork and follows upstream, an update or a removal alike. An
 * entry the fork changed stays, unless `bumpHigher` and upstream carries a strictly higher
 * version. An entry the fork removed (in base, absent in fork) is not re-added. Without a base
 * every upstream entry is added or bumped and nothing is removed.
 * Returns the merged record sorted alphabetically, plus the keys added, updated and removed.
 */
function mergeRecord(
  forkRecord: Record<string, string> | undefined,
  upstreamRecord: Record<string, string> | undefined,
  baseRecord: Record<string, string> | undefined,
  bumpHigher = true,
): RecordMergeResult | undefined {
  if (!upstreamRecord) return undefined;

  const merged = { ...(forkRecord || {}) };
  const base = baseRecord || {};
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  for (const [name, upstreamValue] of Object.entries(upstreamRecord)) {
    const forkValue = merged[name];

    if (forkValue === undefined) {
      // In base but not in fork: the fork removed it on purpose
      if (name in base) continue;
      merged[name] = upstreamValue;
      added.push(name);
    } else if (forkValue === upstreamValue) {
    } else if (base[name] === forkValue) {
      // Untouched by the fork: follow upstream, a downgrade or a rewritten script included
      merged[name] = upstreamValue;
      updated.push(name);
    } else if (bumpHigher && isHigherVersion(upstreamValue, forkValue)) {
      // Both sides changed it: a strictly higher upstream version wins (with upstream's range prefix)
      merged[name] = upstreamValue;
      updated.push(name);
    }
    // Otherwise the fork's own value stays
  }

  // Entries upstream dropped: removed when the fork never touched them
  for (const [name, forkValue] of Object.entries(merged)) {
    if (name in upstreamRecord) continue;
    if (base[name] !== undefined && base[name] === forkValue) {
      delete merged[name];
      removed.push(name);
    }
  }

  const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
  const changed = added.length + updated.length + removed.length > 0;
  return { merged: sorted, changed, added, updated, removed };
}

/** A subpath map (`{ ".": …, "./config": … }`), as opposed to a string or a conditions object. */
function isSubpathMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((name) => name.startsWith('.'));
}

/**
 * Safe merge for the `exports` key — add upstream subpaths the fork lacks, never touch the
 * fork's own. Only merges when both sides are subpath maps: a string or conditions object
 * can't take extra subpaths, and condition order is significant. Keeps the fork's key order.
 */
function safeMergeExports(
  forkExports: unknown,
  upstreamExports: unknown,
): { merged: Record<string, unknown>; changed: boolean; added: string[] } | undefined {
  if (!isSubpathMap(upstreamExports)) return undefined;
  if (forkExports !== undefined && !isSubpathMap(forkExports)) return undefined;

  const merged = { ...(forkExports || {}) };
  const added = Object.keys(upstreamExports).filter((name) => !(name in merged));
  for (const name of added) merged[name] = upstreamExports[name];

  return { merged, changed: added.length > 0, added };
}

/**
 * Merge for the `pnpm` key — `overrides` and `patchedDependencies` merge three-way like any
 * record; `packageExtensions` and other sub-keys are add-only.
 */
function safeMergePnpm(
  forkPnpm: PackageJson['pnpm'],
  upstreamPnpm: PackageJson['pnpm'],
  basePnpm: PackageJson['pnpm'],
): { merged: PackageJson['pnpm']; changed: boolean } | undefined {
  if (!upstreamPnpm) return undefined;

  const merged: NonNullable<PackageJson['pnpm']> = { ...(forkPnpm || {}) };
  let changed = false;

  // pnpm.overrides — same as dependency overrides: add, follow, bump versions
  if (upstreamPnpm.overrides) {
    const result = mergeRecord(
      merged.overrides as Record<string, string> | undefined,
      upstreamPnpm.overrides as Record<string, string>,
      basePnpm?.overrides as Record<string, string> | undefined,
    );
    if (result?.changed) {
      merged.overrides = result.merged;
      changed = true;
    }
  }

  // pnpm.patchedDependencies — patch paths carry no version to compare, so equality only
  if (upstreamPnpm.patchedDependencies) {
    const result = mergeRecord(
      merged.patchedDependencies as Record<string, string> | undefined,
      upstreamPnpm.patchedDependencies as Record<string, string>,
      basePnpm?.patchedDependencies as Record<string, string> | undefined,
      false,
    );
    if (result?.changed) {
      merged.patchedDependencies = result.merged;
      changed = true;
    }
  }

  // pnpm.packageExtensions — add new packages and add new sub-keys, never remove
  if (upstreamPnpm.packageExtensions) {
    const forkExts = (merged.packageExtensions || {}) as Record<string, Record<string, unknown>>;
    const upstreamExts = upstreamPnpm.packageExtensions as Record<string, Record<string, unknown>>;

    for (const [pkg, upstreamExt] of Object.entries(upstreamExts)) {
      if (!(pkg in forkExts)) {
        // New package extension — add entirely
        forkExts[pkg] = upstreamExt;
        changed = true;
      } else {
        // Existing package — add new sub-keys only
        for (const [subKey, subValue] of Object.entries(upstreamExt)) {
          if (!(subKey in forkExts[pkg])) {
            forkExts[pkg][subKey] = subValue;
            changed = true;
          }
        }
      }
    }

    merged.packageExtensions = forkExts;
  }

  // Other pnpm sub-keys — add if missing in fork
  for (const [key, value] of Object.entries(upstreamPnpm)) {
    if (['overrides', 'patchedDependencies', 'packageExtensions'].includes(key)) continue;
    if (!(key in merged)) {
      merged[key] = value;
      changed = true;
    }
  }

  return { merged, changed };
}

/**
 * Read a package.json file.
 */
function readPackageJson(filePath: string): PackageJson | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a package.json file (pretty-printed).
 */
function writePackageJson(filePath: string, data: PackageJson): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/** The package.json path of a workspace location ('' is the root). */
function packageJsonPath(relativePath: string): string {
  return relativePath ? `${relativePath}/package.json` : 'package.json';
}

/**
 * Read a package.json at a git ref, raw and parsed; null when the ref has no such file.
 */
async function readPackageJsonAtRef(
  forkPath: string,
  ref: string,
  relativePath: string,
): Promise<{ raw: string; data: PackageJson } | null> {
  try {
    const raw = await git(['show', `${ref}:${packageJsonPath(relativePath)}`], forkPath);
    return { raw, data: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/**
 * Every package.json location upstream has; the fork side is judged per location.
 */
async function discoverPackageLocations(forkPath: string, upstreamRef: string): Promise<string[]> {
  const stdout = await git(['ls-tree', '-r', '--name-only', upstreamRef], forkPath, { ignoreErrors: true });
  return stdout
    .split('\n')
    .filter((p) => p.endsWith('/package.json') || p === 'package.json')
    .map((p) => (p === 'package.json' ? '' : p.replace('/package.json', '')));
}

/**
 * The upstream commit the fork last synced (the recorded sync point, else git's merge-base);
 * null when neither resolves, which turns every key merge into add-only.
 */
async function resolveMergeBase(forkPath: string, upstreamRef: string): Promise<string | null> {
  try {
    return (await getEffectiveMergeBase(forkPath, 'HEAD', upstreamRef)).base || null;
  } catch {
    return null;
  }
}

/**
 * Sync a single package.json file three-way (fork, upstream, merge-base).
 *
 * A location the fork lacks is a workspace upstream added since the base: its package.json
 * lands verbatim when the merge brought the directory (and the location is not ignored). A
 * package.json the base had and the fork removed stays removed.
 */
async function syncPackageJson(
  config: RuntimeConfig,
  baseRef: string | null,
  relativePath: string,
  keysToSync: PackageJsonSyncKey[],
): Promise<{ updated: boolean; changes: string[] }> {
  const { forkPath, upstreamRef } = config;
  const changes: string[] = [];
  const pkgRelPath = packageJsonPath(relativePath);
  const pkgPath = join(forkPath, pkgRelPath);

  const forkPkg = readPackageJson(pkgPath);
  const upstream = await readPackageJsonAtRef(forkPath, upstreamRef, relativePath);
  const basePkg = baseRef ? (await readPackageJsonAtRef(forkPath, baseRef, relativePath))?.data : undefined;

  if (!upstream) return { updated: false, changes };

  if (!forkPkg) {
    const workspaceArrived = relativePath !== '' && existsSync(join(forkPath, relativePath));
    if (basePkg || !workspaceArrived || isIgnored(pkgRelPath, config)) return { updated: false, changes };
    writeFileSync(pkgPath, upstream.raw.endsWith('\n') ? upstream.raw : `${upstream.raw}\n`, 'utf-8');
    return { updated: true, changes: ['copied from upstream (new workspace)'] };
  }

  const upstreamPkg = upstream.data;
  let updated = false;

  for (const key of keysToSync) {
    if (key === 'pnpm') {
      // Handle nested pnpm key
      const result = safeMergePnpm(forkPkg.pnpm, upstreamPkg.pnpm, basePkg?.pnpm);
      if (result?.changed) {
        forkPkg.pnpm = result.merged;
        updated = true;
        changes.push('pnpm: merged');
      }
      continue;
    }

    if (key === 'packageManager') {
      // String key: follow upstream when the fork never touched it, else only bump higher
      const upstreamValue = upstreamPkg[key] as string | undefined;
      const forkValue = forkPkg[key] as string | undefined;
      const baseValue = basePkg?.[key] as string | undefined;

      if (upstreamValue && !forkValue) {
        if (baseValue) continue;
        forkPkg[key] = upstreamValue;
        updated = true;
        changes.push(`${key}: added`);
      } else if (
        upstreamValue &&
        forkValue &&
        upstreamValue !== forkValue &&
        (forkValue === baseValue || isHigherVersion(upstreamValue, forkValue))
      ) {
        forkPkg[key] = upstreamValue;
        updated = true;
        changes.push(`${key}: updated`);
      }
      continue;
    }

    if (key === 'exports') {
      // Add-only, subpath maps only: the fork gains new upstream subpaths, keeps any it defines
      // itself, and a subpath it has repointed stays repointed.
      const result = safeMergeExports(forkPkg.exports, upstreamPkg.exports);
      if (result?.changed) {
        forkPkg.exports = result.merged;
        updated = true;
        changes.push(...result.added.map((name) => `exports.${name}: added`));
      }
      continue;
    }

    // All Record<string, string> keys merge three-way; scripts carry no version to compare.
    const forkValue = forkPkg[key] as Record<string, string> | undefined;
    const upstreamValue = upstreamPkg[key] as Record<string, string> | undefined;
    const baseValue = basePkg?.[key] as Record<string, string> | undefined;

    const result = mergeRecord(forkValue, upstreamValue, baseValue, key !== 'scripts');
    if (result?.changed) {
      (forkPkg as Record<string, unknown>)[key] = result.merged;
      updated = true;
      changes.push(
        ...result.added.map((name) => `${key}.${name}: added`),
        ...result.updated.map((name) => `${key}.${name}: updated`),
        ...result.removed.map((name) => `${key}.${name}: removed`),
      );
    }
  }

  if (updated) {
    writePackageJson(pkgPath, forkPkg);
  }

  return { updated, changes };
}

/**
 * Run the packages sync service.
 *
 * Discovers every package.json location upstream has, then merges the configured keys three-way
 * against the merge-base (see the file header for the rules).
 *
 * When `conflictedFiles` is provided (e.g. after a sync that left conflicts),
 * any package.json that is itself unmerged is skipped to avoid clobbering
 * conflict markers; all other package.json files are still synced.
 */
export async function runPackages(config: RuntimeConfig, options: { conflictedFiles?: string[] } = {}): Promise<void> {
  createSpinner('syncing package.json files...');

  const keysToSync = config.settings.packageJsonSync || ['dependencies', 'devDependencies'];
  const conflictedSet = new Set(options.conflictedFiles ?? []);

  const baseRef = await resolveMergeBase(config.forkPath, config.upstreamRef);
  const locations = await discoverPackageLocations(config.forkPath, config.upstreamRef);
  let changedCount = 0;
  const skipped: string[] = [];

  for (const location of locations) {
    const pkgRelPath = packageJsonPath(location);

    // Skip package.json files that are themselves conflicted from the merge —
    // writing to them would clobber the conflict markers the user must resolve.
    if (conflictedSet.has(pkgRelPath)) {
      skipped.push(pkgRelPath);
      continue;
    }

    spinnerText(`syncing ${location || 'root'}/package.json...`);

    const { updated } = await syncPackageJson(config, baseRef, location, keysToSync);

    if (updated) {
      changedCount += 1;
    }
  }

  spinnerSuccess(
    'package sync complete',
    `${changedCount} package.json${changedCount === 1 ? ' was' : 's were'} changed`,
  );

  // Report any package.json files deferred due to merge conflicts
  if (skipped.length > 0) {
    console.info();
    console.warn(
      `${warningMark} skipped ${skipped.length} conflicted package.json file(s) — resolve the conflicts, commit the merge, then rerun \`pnpm cella sync\`:`,
    );
    for (const path of skipped) {
      console.warn(`    ${pc.dim('→')} ${path}`);
    }
  }
}

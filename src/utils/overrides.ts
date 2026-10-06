/**
 * Override matching and validation: files matched against the ignored/pinned
 * paths, and config warnings for entries that cannot work.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzedFile, CellaCliConfig, IgnoredUpstreamGroup, ProtectedUpstreamGroup } from '../config/types';
import { warningMark } from './display';
import { fileExistsAtRef } from './git';
import { isGeneratedFile, isManagedFile } from './managed-files';
import { isUpstreamOnly } from './migration-notes';

/**
 * Whether a file path is owned by any of the given folders.
 *
 * Folders are directory prefixes (not globs): an entry matches the file when
 * the path equals the entry exactly or is nested under `entry + '/'`.
 *
 * @param filePath - The file path to test
 * @param folders - Folder prefixes (or exact paths) to match against
 */
export function isUnderAnyFolder(filePath: string, folders: string[]): boolean {
  return folders.some((folder) => {
    const entry = folder.replace(/\/+$/, '');
    return filePath === entry || filePath.startsWith(`${entry}/`);
  });
}

/**
 * Whether a file is inside an ignored path, or an upstream-only one (migration notes),
 * which every fork ignores without listing it.
 */
export function isIgnored(filePath: string, config: CellaCliConfig): boolean {
  return isUpstreamOnly(filePath) || isUnderAnyFolder(filePath, config.overrides?.ignored || []);
}

/**
 * Whether a file is in the pinned list.
 * Managed files always count as pinned (handled separately by cella).
 */
export function isPinned(filePath: string, config: CellaCliConfig): boolean {
  if (isManagedFile(filePath)) return true;
  return isUnderAnyFolder(filePath, config.overrides?.pinned || []);
}

/**
 * Group `upstreamOnly` files by the `ignored` entry they fall under, so a report can name the
 * folder from the config (plus derived app-module folders) with one diff hint per entry.
 *
 * A file under nested entries lands on the most specific one. Groups follow the order of
 * `ignored`; managed files and generated output are left out.
 *
 * @param files - Analyzed files (only those flagged `upstreamOnly` count)
 * @param ignored - The fork's effective `ignored` entries
 */
export function groupIgnoredUpstreamChanges(files: AnalyzedFile[], ignored: string[]): IgnoredUpstreamGroup[] {
  const entries = [...new Set(ignored.map((entry) => entry.replace(/\/+$/, '')).filter(Boolean))];
  const mostSpecificFirst = [...entries].sort((a, b) => b.length - a.length);
  const groups = new Map<string, IgnoredUpstreamGroup>();

  for (const file of files) {
    if (!file.upstreamOnly || isManagedFile(file.path) || isGeneratedFile(file.path)) continue;
    const entry = mostSpecificFirst.find((candidate) => isUnderAnyFolder(file.path, [candidate]));
    if (!entry) continue;

    const group = groups.get(entry) ?? { entry, paths: [], added: 0, deleted: 0 };
    group.paths.push(file.path);
    if (!file.existsInFork) group.added++;
    if (!file.existsInUpstream) group.deleted++;
    groups.set(entry, group);
  }

  for (const group of groups.values()) group.paths.sort();
  return entries.flatMap((entry) => groups.get(entry) ?? []);
}

/**
 * Group protected paths upstream also changed by the `pinned` or `ignored` entry they fall under,
 * so a report can print one diff hint per entry, not one per file.
 *
 * A path under nested entries lands on the most specific one; a path no entry covers (a managed
 * file) stands for itself. Groups follow the order the paths come in.
 *
 * @param paths - Protected paths upstream also changed (`MergeResult.protectedConflicts`)
 * @param config - The fork's sync config
 */
export function groupProtectedUpstreamChanges(paths: string[], config: CellaCliConfig): ProtectedUpstreamGroup[] {
  const entries = [...(config.overrides?.pinned ?? []), ...(config.overrides?.ignored ?? [])]
    .map((entry) => entry.replace(/\/+$/, ''))
    .filter(Boolean);
  const mostSpecificFirst = [...new Set(entries)].sort((a, b) => b.length - a.length);
  const groups = new Map<string, ProtectedUpstreamGroup>();

  for (const path of paths) {
    const entry = mostSpecificFirst.find((candidate) => isUnderAnyFolder(path, [candidate])) ?? path;
    const group = groups.get(entry) ?? { entry, paths: [] };
    group.paths.push(path);
    groups.set(entry, group);
  }

  for (const group of groups.values()) group.paths.sort();
  return [...groups.values()];
}

/**
 * Resolve effective pin status for a sync run, honoring the --unpinned flag.
 *
 * When `unpinned` is true, configured pins are disabled so upstream versions
 * surface as behind/diverged; managed files stay pinned (their content is
 * reconciled separately by cella).
 */
export function isPinnedForSync(filePath: string, config: CellaCliConfig, unpinned?: boolean): boolean {
  if (isManagedFile(filePath)) return true;
  if (unpinned) return false;
  return isPinned(filePath, config);
}

/** Validation warning */
interface ConfigWarning {
  type: 'pinned-glob' | 'pinned-not-found' | 'ignored-not-found';
  pattern: string;
  message: string;
}

/** Whether an entry contains glob characters (not supported in overrides). */
function hasGlobChars(entry: string): boolean {
  return entry.includes('*') || entry.includes('?');
}

/**
 * Validate config overrides and return warnings.
 *
 * Checks for:
 * - Pinned entries using glob patterns (not supported)
 * - Pinned entries that don't exist in fork
 * - Ignored entries that exist neither in the fork nor upstream
 *
 * A fork ignores some paths to keep them from arriving (a file upstream has and the fork deleted),
 * so an ignored entry missing from the fork is fine while upstream has the path. That is read at
 * `upstreamRef` as last fetched, without fetching: when the ref does not resolve (nothing fetched
 * yet), every ignored entry missing from the fork warns.
 *
 * @param config - The sync config to validate
 * @param forkPath - Path to the fork repository
 * @param upstreamRef - Upstream ref to look ignored entries up at (e.g. 'cella-upstream/main')
 */
export async function validateOverrides(
  config: CellaCliConfig,
  forkPath: string,
  upstreamRef?: string,
): Promise<ConfigWarning[]> {
  const warnings: ConfigWarning[] = [];

  const pinned = config.overrides?.pinned || [];
  for (const entry of pinned) {
    if (hasGlobChars(entry)) {
      warnings.push({
        type: 'pinned-glob',
        pattern: entry,
        message: `pin uses glob (not supported, use a path or folder): ${entry}`,
      });
    } else if (!existsSync(join(forkPath, entry))) {
      warnings.push({
        type: 'pinned-not-found',
        pattern: entry,
        message: `pin not found: ${entry}`,
      });
    }
  }

  const ignored = config.overrides?.ignored || [];
  for (const entry of ignored) {
    if (hasGlobChars(entry)) {
      warnings.push({
        type: 'ignored-not-found',
        pattern: entry,
        message: `ignored entry uses glob (not supported, use a path or folder): ${entry}`,
      });
    } else if (!existsSync(join(forkPath, entry.replace(/\/+$/, '')))) {
      if (upstreamRef && (await fileExistsAtRef(forkPath, upstreamRef, entry.replace(/\/+$/, '')))) continue;
      warnings.push({
        type: 'ignored-not-found',
        pattern: entry,
        message: `ignored entry not found: ${entry}`,
      });
    }
  }

  return warnings;
}

export function printWarnings(warnings: ConfigWarning[]): void {
  for (const warning of warnings) {
    console.info(`${warningMark} ${warning.message}`);
  }
}

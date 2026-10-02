/**
 * Override matching and validation utilities for sync CLI v2.
 *
 * Handles matching files against ignored/pinned paths and
 * validates config for potential issues.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzedFile, CellaCliConfig, IgnoredUpstreamGroup } from '../config/types';
import { warningMark } from './display';
import { isGeneratedFile, isManagedFile } from './managed-files';
import { isUpstreamOnly } from './migration-notes';

/**
 * Check if a file path is owned by any of the given folders.
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
 * Check if a file is inside an ignored path, or an upstream-only one (migration notes), which
 * every fork ignores without listing it.
 */
export function isIgnored(filePath: string, config: CellaCliConfig): boolean {
  return isUpstreamOnly(filePath) || isUnderAnyFolder(filePath, config.overrides?.ignored || []);
}

/**
 * Check if a file is in the pinned list.
 * Managed files are always considered pinned (handled separately by cella).
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
 * Resolve effective pin status for a sync run, honoring the --unpinned flag.
 *
 * When `unpinned` is true, configured pins are disabled so upstream versions
 * surface as behind/diverged — but managed files stay pinned (their content is
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

/**
 * Check if an entry contains glob characters (no longer supported).
 */
function hasGlobChars(entry: string): boolean {
  return entry.includes('*') || entry.includes('?');
}

/**
 * Validate config overrides and return warnings.
 *
 * Checks for:
 * - Pinned entries using glob patterns (no longer supported)
 * - Pinned entries that don't exist in fork
 * - Ignored entries that don't exist in fork
 *
 * @param config - The sync config to validate
 * @param forkPath - Path to the fork repository
 */
export function validateOverrides(config: CellaCliConfig, forkPath: string): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // Check pinned entries
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

  // Check ignored entries
  const ignored = config.overrides?.ignored || [];
  for (const entry of ignored) {
    if (hasGlobChars(entry)) {
      warnings.push({
        type: 'ignored-not-found',
        pattern: entry,
        message: `ignored entry uses glob (not supported, use a path or folder): ${entry}`,
      });
    } else if (!existsSync(join(forkPath, entry.replace(/\/+$/, '')))) {
      warnings.push({
        type: 'ignored-not-found',
        pattern: entry,
        message: `ignored entry not found: ${entry}`,
      });
    }
  }

  return warnings;
}

/**
 * Print validation warnings to console.
 */
export function printWarnings(warnings: ConfigWarning[]): void {
  for (const warning of warnings) {
    console.info(`${warningMark} ${warning.message}`);
  }
}

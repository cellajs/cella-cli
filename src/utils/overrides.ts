/**
 * Override matching and validation: files matched against the ignored/pinned
 * paths, and config warnings for entries that cannot work.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalyzedFile, CellaCliConfig, IgnoredUpstreamGroup, ProtectedUpstreamGroup } from '../config/types';
import { fileExistsAtRef, listChangedSinceRef, revParse } from './git';
import { isGeneratedFile, isManagedFile } from './managed-files';
import { isUpstreamOnly } from './migration-notes';

/** Normalize an override entry: trimmed, no leading `./`, no trailing slash. */
export function normalizeEntry(entry: string): string {
  return entry.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Whether a file path is owned by any of the given folders: entries are directory prefixes (not
 * globs) that match the path itself or anything nested under it.
 */
export function isUnderAnyFolder(filePath: string, folders: string[]): boolean {
  return folders.some((folder) => {
    const entry = normalizeEntry(folder);
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

/** Normalized, deduplicated entries in config order, and a lookup for the most specific one holding a path. */
function entryMatcher(list: string[]): [string[], (path: string) => string | undefined] {
  const entries = [...new Set(list.map(normalizeEntry).filter(Boolean))];
  const mostSpecificFirst = [...entries].sort((a, b) => b.length - a.length);
  return [entries, (path) => mostSpecificFirst.find((entry) => isUnderAnyFolder(path, [entry]))];
}

/**
 * Group `upstreamOnly` files by the most specific `ignored` entry they fall under, for one diff
 * hint per entry. Groups follow the order of `ignored`; managed files and generated output are
 * left out.
 */
export function groupIgnoredUpstreamChanges(files: AnalyzedFile[], ignored: string[]): IgnoredUpstreamGroup[] {
  const [entries, findEntry] = entryMatcher(ignored);
  const groups = new Map<string, IgnoredUpstreamGroup>();

  for (const file of files) {
    if (!file.upstreamOnly || isManagedFile(file.path) || isGeneratedFile(file.path)) continue;
    const entry = findEntry(file.path);
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
 * Group protected paths upstream also changed by the most specific `pinned` or `ignored` entry
 * they fall under, for one diff hint per entry. A path no entry covers (a managed file) stands for
 * itself; groups follow the order the paths come in.
 */
export function groupProtectedUpstreamChanges(paths: string[], config: CellaCliConfig): ProtectedUpstreamGroup[] {
  const [, findEntry] = entryMatcher([...(config.overrides?.pinned ?? []), ...(config.overrides?.ignored ?? [])]);
  const groups = new Map<string, ProtectedUpstreamGroup>();

  for (const path of paths) {
    const entry = findEntry(path) ?? path;
    const group = groups.get(entry) ?? { entry, paths: [] };
    group.paths.push(path);
    groups.set(entry, group);
  }

  for (const group of groups.values()) group.paths.sort();
  return [...groups.values()];
}

/**
 * Warnings for override entries that cannot work: globs, pins missing from the fork, and ignored
 * entries neither the fork nor upstream has (a fork may ignore a path to keep it from arriving).
 * Also pins that do nothing: inside an ignored path (app modules included), gone from upstream
 * (the path is the app's own), or identical to upstream (it only drops upstream's next change).
 * Upstream is read at `upstreamRef` as last fetched; while it does not resolve, every ignored
 * entry missing from the fork warns and the upstream checks on pins are skipped.
 */
export async function validateOverrides(
  config: CellaCliConfig,
  forkPath: string,
  upstreamRef?: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const ignored = config.overrides?.ignored ?? [];
  const upstream = upstreamRef && (await revParse(forkPath, upstreamRef)) ? upstreamRef : undefined;
  const pinsUpstreamHas: string[] = [];

  for (const entry of config.overrides?.pinned ?? []) {
    const path = normalizeEntry(entry);
    const ignoredEntry = ignored.find((folder) => isUnderAnyFolder(path, [folder]));
    if (/[*?]/.test(entry)) warnings.push(`pin uses glob (not supported, use a path or folder): ${entry}`);
    else if (!existsSync(join(forkPath, path))) warnings.push(`pin not found: ${entry}`);
    else if (ignoredEntry) warnings.push(`pin does nothing, '${normalizeEntry(ignoredEntry)}' is ignored: ${entry}`);
    else if (!upstream) continue;
    else if (await fileExistsAtRef(forkPath, upstream, path)) pinsUpstreamHas.push(entry);
    else warnings.push(`pin does nothing, upstream no longer has it: ${entry}`);
  }

  if (upstream && pinsUpstreamHas.length > 0) {
    const differs = await listChangedSinceRef(forkPath, upstream, pinsUpstreamHas.map(normalizeEntry));
    for (const entry of pinsUpstreamHas) {
      if (differs.some((changed) => isUnderAnyFolder(changed, [entry]))) continue;
      warnings.push(`pin is identical to upstream, it only drops upstream's next change: ${entry}`);
    }
  }

  for (const entry of config.overrides?.ignored ?? []) {
    const path = normalizeEntry(entry);
    if (/[*?]/.test(entry)) {
      warnings.push(`ignored entry uses glob (not supported, use a path or folder): ${entry}`);
    } else if (!existsSync(join(forkPath, path))) {
      if (upstreamRef && (await fileExistsAtRef(forkPath, upstreamRef, path))) continue;
      warnings.push(`ignored entry not found: ${entry}`);
    }
  }

  return warnings;
}

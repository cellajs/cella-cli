/**
 * Files that cella manages outside the normal file sync categories.
 */

/** Sync config path, relative to the fork repo root. Fork-owned, never synced from upstream. */
export const CONFIG_FILE = 'cella/cella.config.ts';

/**
 * Legacy config path, before the config moved into `cella/`. Kept so the one sync that
 * performs the root→`cella/` move still recognizes the file as managed at its old path:
 * during that move git may present the change under the old path (or as a delete+add that
 * skips rename detection), and an exact match on the new path alone would let it fall
 * through to a normal — conflicting — merge. Harmless to match forever; it can only appear
 * on the move sync of a not-yet-migrated fork.
 */
export const LEGACY_CONFIG_FILE = 'cella.config.ts';

/** Every path the sync config has lived at. Compared against to always-ignore across the move. */
export const CONFIG_FILE_PATHS: readonly string[] = [CONFIG_FILE, LEGACY_CONFIG_FILE];

/**
 * Check if a file path is the sync config, at its current or legacy (pre-`cella/`) path.
 */
export function isConfigFile(filePath: string): boolean {
  return CONFIG_FILE_PATHS.includes(filePath);
}

/**
 * Check if a file path is a package.json file.
 */
export function isPackageJson(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('/package.json');
}

/**
 * Check if a file path is managed by cella outside normal file sync categories.
 */
export function isManagedFile(filePath: string): boolean {
  return isPackageJson(filePath) || filePath === 'pnpm-lock.yaml' || isConfigFile(filePath);
}

/**
 * Files that cella manages outside the normal file sync categories.
 */

/** Sync config path, relative to the fork repo root. Fork-owned, never synced from upstream. */
export const CONFIG_FILE = 'cella/cella.config.ts';

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
  return isPackageJson(filePath) || filePath === 'pnpm-lock.yaml' || filePath === CONFIG_FILE;
}

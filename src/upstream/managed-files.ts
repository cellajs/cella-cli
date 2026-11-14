/**
 * Files that cella manages outside the normal file sync categories.
 */

/** CLI config path, relative to the fork repo root. Fork-owned, never synced from upstream. */
export const CONFIG_FILE = 'cella/cella.config.ts';

/** Whether a path is a package.json file. */
export function isPackageJson(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('/package.json');
}

/** Whether cella manages a path outside the normal sync categories: package.json files, the lockfile, the CLI config. */
export function isManagedFile(filePath: string): boolean {
  return isPackageJson(filePath) || filePath === 'pnpm-lock.yaml' || filePath === CONFIG_FILE;
}

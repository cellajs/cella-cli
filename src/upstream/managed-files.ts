/**
 * Files that cella manages outside the normal file merge categories.
 */

/** CLI config path, relative to the app root. App-owned, never merged from upstream. */
export const configFile = 'cella/cella.config.ts';

/** Whether a path is a package.json file. */
export function isPackageJson(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('/package.json');
}

/** Whether cella manages a path outside the normal merge categories: package.json files, the lockfile, the CLI config. */
export function isManagedFile(filePath: string): boolean {
  return isPackageJson(filePath) || filePath === 'pnpm-lock.yaml' || filePath === configFile;
}

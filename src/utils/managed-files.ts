/**
 * Files that cella manages outside the normal file sync categories.
 */

/** Sync config path, relative to the fork repo root. Fork-owned, never synced from upstream. */
export const CONFIG_FILE = 'cella/cella.config.ts';

/** Whether a path is a package.json file. */
export function isPackageJson(filePath: string): boolean {
  return filePath === 'package.json' || filePath.endsWith('/package.json');
}

/**
 * Check if a file path is generated output a fork regenerates itself: a `gen` path segment
 * (`sdk/gen/...`) or a `.gen.` file name (`routeTree.gen.ts`, `compose.gen.yml`). Upstream's
 * copy is never adopted, so upstream changes to it are not worth reporting.
 */
export function isGeneratedFile(filePath: string): boolean {
  const segments = filePath.split('/');
  return segments.includes('gen') || (segments.at(-1) ?? '').includes('.gen.');
}

/** Whether cella manages a path outside the normal sync categories: package.json files, the lockfile, the sync config. */
export function isManagedFile(filePath: string): boolean {
  return isPackageJson(filePath) || filePath === 'pnpm-lock.yaml' || filePath === CONFIG_FILE;
}

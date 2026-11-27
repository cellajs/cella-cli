import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app's root: the nearest folder, from `from` upward, that holds `infra/description.yml`.
 * @throws when no folder up to the file system's root holds one
 */
export function findAppRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  while (!existsSync(join(dir, 'infra', 'description.yml'))) {
    if (dirname(dir) === dir) throw new Error(`No infra/description.yml in ${from} or any folder above it: run this inside an app.`);
    dir = dirname(dir);
  }
  return dir;
}

/** The app's root folder, found from the working directory: its git checkout, root `package.json`, `.env` and environments file. */
export const repoRoot = findAppRoot();

/** The app's `infra/` folder: its description, Pulumi project and stack files, env files and debug captures. */
export const infraDir = join(repoRoot, 'infra');

/** The build files the package ships beside its bundle: the engine image's Dockerfile, and the agent's and the frontend proxy's folders. */
export const engineAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), 'infra-assets');

/** This machine's folder for the app, in the home folder and outside every checkout: what it holds serves each checkout and worktree here. */
export const machineDir = (appSlug: string): string => join(homedir(), '.config', appSlug);

/**
 * A new file's path under `infra/.debug/`, which git ignores and this makes: `<stem>-<time>.<extension>`.
 * @throws when the folder cannot be made
 */
export function debugFile(stem: string, extension: string): string {
  const dir = resolve(infraDir, '.debug');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolve(dir, `${stem}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`);
}

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app's `infra/` folder: its Pulumi project and stack files, `compose.gen.yml`, env files and debug captures, with the
 * app's root one level up. It is the folder of the app's `infra` workspace, which the package takes as a peer: engine
 * code reads its own files by import, never through this path.
 */
export const infraDir = dirname(createRequire(import.meta.url).resolve('infra/package.json'));

/** The app's root folder, one level above `infra/`: its git checkout, root `package.json`, `.env` and environments file. */
export const repoRoot = join(infraDir, '..');

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

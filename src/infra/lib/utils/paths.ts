import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The app root for a working directory: the directory itself, or its parent when it is the app's `infra` workspace (its `package.json` is
 * named `infra`), where that workspace's scripts run.
 * @throws when the root holds no `infra/description.yml`, or holds another one in `infra/infra/`
 */
export function appRootOf(dir: string): string {
  const manifest = join(dir, 'package.json');
  const parsed: { name?: unknown } = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  const root = parsed.name === 'infra' ? dirname(resolve(dir)) : resolve(dir);
  if (!existsSync(join(root, 'infra', 'description.yml'))) {
    throw new Error(
      `${root} has no infra/description.yml. An app that still describes its infra in infra/config/ moves it with the template's alignment infra-description (cella/alignments/): \`pnpm cella align\` lists it after the upgrade.`,
    );
  }
  const nested = join(root, 'infra', 'infra', 'description.yml');
  if (existsSync(nested)) throw new Error(`${nested}: the engine reads the app root's infra/description.yml alone: remove this one.`);
  return root;
}

/** The app's root folder, from the working directory: its git checkout, root `package.json`, `.env` and environments file. */
export const repoRoot = appRootOf(process.cwd());

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

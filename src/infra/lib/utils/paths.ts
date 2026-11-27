import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The infra folder's path from the app root. */
const infraFolder = join('cella', 'infra');

/** What a refusal of the app root says last: the alignment that moves an app's infra into `cella/infra/`. */
const alignmentHint =
  "The template's alignment infra-description (cella/alignments/) moves an app's infra from infra/ to cella/infra/: `pnpm cella align` lists it after the upgrade.";

/**
 * The app root for a working directory: the directory itself when it holds `cella/infra/description.yml`, or two folders up when it is that
 * `cella/infra` folder, where Pulumi runs the program.
 * @throws for a root on the layout with `infra/description.yml` or `infra/config/`, a root without `cella/infra/description.yml`, or one that
 * holds another description in `cella/infra/cella/infra/`
 */
export function appRootOf(dir: string): string {
  const here = resolve(dir);
  const up = resolve(here, '..', '..');
  // The old infra workspace of a checkout named cella ends in cella/infra too: its manifest tells it apart
  const inFolder = here === join(up, infraFolder) && existsSync(join(here, 'description.yml')) && !existsSync(join(here, 'package.json'));
  const root = inFolder ? up : here;
  if (existsSync(join(root, 'infra', 'description.yml')) || existsSync(join(root, 'infra', 'config'))) {
    throw new Error(`${root} keeps its infra in infra/, and the engine reads cella/infra/. ${alignmentHint}`);
  }
  if (!existsSync(join(root, infraFolder, 'description.yml'))) throw new Error(`${root} has no cella/infra/description.yml. ${alignmentHint}`);
  const nested = join(root, infraFolder, infraFolder, 'description.yml');
  if (existsSync(nested)) throw new Error(`${nested}: the engine reads the app root's cella/infra/description.yml alone: remove this one.`);
  return root;
}

/** The app's root folder, from the working directory: its git checkout, root `package.json`, `.env` and install. */
export const repoRoot = appRootOf(process.cwd());

/** The app's `cella/infra/` folder: its description, environments file, Pulumi project and stack files, env files and debug captures. */
export const infraDir = join(repoRoot, infraFolder);

/** The build files the package ships beside its bundle: the engine image's Dockerfile, and the agent's and the frontend proxy's folders. */
export const engineAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), 'infra-assets');

/** This machine's folder for the app, in the home folder and outside every checkout: what it holds serves each checkout and worktree here. */
export const machineDir = (appSlug: string): string => join(homedir(), '.config', appSlug);

/**
 * A new file's path under `cella/infra/.debug/`, which git ignores and this makes: `<stem>-<time>.<extension>`.
 * @throws when the folder cannot be made
 */
export function debugFile(stem: string, extension: string): string {
  const dir = resolve(infraDir, '.debug');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolve(dir, `${stem}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`);
}

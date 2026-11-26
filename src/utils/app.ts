import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';

/** The app's local database helpers (`shared/src/local-database.ts`), as the develop commands call them. */
interface LocalDatabases {
  port: (database: string) => number;
  url: (database: string, role: 'postgres' | 'runtime_role' | 'admin_role') => string;
  /** The env `backend/compose.yaml` reads: the project name and each database's host port. */
  composeEnv: () => Record<string, string>;
}

/**
 * Node strips the types of a file outside node_modules, so the app's own TS loads without a build or tsx.
 * @param mode the app config's mode. The config reads it once, at its first import in this process, and the dev port
 * offset applies in development mode only.
 */
async function importFromApp(
  repoRoot: string,
  file: string,
  mode: 'development' | 'production' = 'development',
): Promise<Record<string, unknown>> {
  const path = join(repoRoot, file);
  if (!existsSync(path)) throw new Error(`not an app built from cella: ${path} is missing`);
  process.env.NODE_ENV = mode;
  return import(pathToFileURL(path).href);
}

/**
 * The part of the app's config that `schema` reads, from its own `shared` package in `mode`. In a linked worktree a
 * development import claims that worktree's port slot, as `pnpm dev` would.
 * @throws when the config does not fit `schema`
 */
export async function loadAppConfig<T>(
  repoRoot: string,
  schema: z.ZodType<T>,
  mode: 'development' | 'production' = 'development',
): Promise<T> {
  const parsed = schema.safeParse((await importFromApp(repoRoot, 'shared/index.ts', mode)).appConfig);
  if (!parsed.success)
    throw new Error(`shared/index.ts exports no appConfig this CLI can read: ${parsed.error.message}`);
  return parsed.data;
}

/** The app's local database helpers. */
export async function loadLocalDatabases(repoRoot: string): Promise<LocalDatabases> {
  const module = await importFromApp(repoRoot, 'shared/src/local-database.ts');
  const { localDatabasePort, localDatabaseUrl, composeEnv } = module;
  if (
    typeof localDatabasePort !== 'function' ||
    typeof localDatabaseUrl !== 'function' ||
    typeof composeEnv !== 'function'
  ) {
    throw new Error('shared/src/local-database.ts lacks localDatabasePort, localDatabaseUrl or composeEnv');
  }
  return {
    port: (database) => localDatabasePort(database),
    url: (database, role) => localDatabaseUrl(database, role),
    composeEnv: () => composeEnv(),
  };
}

/**
 * A package as the app's `workspace` installed it, so a tool drives the app's own Playwright, TypeScript or Tailwind and
 * the CLI ships none. The package's ESM entry when it has one, else its CommonJS exports.
 * @throws when the workspace does not have the package installed
 */
export async function importFromWorkspace<T>(repoRoot: string, workspace: string, name: string): Promise<T> {
  const require = createRequire(join(repoRoot, workspace, 'package.json'));
  let manifestPath: string | undefined;
  try {
    manifestPath = require.resolve(`${name}/package.json`);
  } catch {
    // A package whose exports leave out package.json resolves by its main entry below
  }
  const root = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')).exports?.['.'] : undefined;
  const esm = typeof root?.import === 'string' ? root.import : root?.import?.default;
  if (manifestPath && typeof esm === 'string') return import(pathToFileURL(join(dirname(manifestPath), esm)).href);
  try {
    return require(name);
  } catch {
    throw new Error(`${name} is not installed in ${workspace}: run \`pnpm --filter ${workspace} add -D ${name}\``);
  }
}

/**
 * Where a tool keeps its results and state: `<git dir>/cella-<tool>/` of this checkout, or of the git directory every
 * worktree shares. Inside the git directory nothing shows in `git status`.
 */
export function toolDir(repoRoot: string, tool: string, scope: 'checkout' | 'repository' = 'checkout'): string {
  const flag = scope === 'checkout' ? '--absolute-git-dir' : '--git-common-dir';
  const gitDir = execFileSync('git', ['rev-parse', flag], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return join(resolve(repoRoot, gitDir), `cella-${tool}`);
}

/** The name and version in the app's root `package.json`. */
export function rootPackage(repoRoot: string): { name: string; version: string } {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
}

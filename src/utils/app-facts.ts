import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { setEnv } from './env';

const appConfigSchema = z.object({
  frontendUrl: z.string(),
  backendUrl: z.string(),
  devPortOffset: z.number(),
  services: z.record(
    z.string(),
    z.object({ enabled: z.boolean(), port: z.number(), internalPort: z.number().optional() }),
  ),
});

/** The part of the app's development config the develop commands read. */
export type AppFacts = z.infer<typeof appConfigSchema>;

/** The app's local database helpers (`shared/src/local-database.ts`), as the develop commands call them. */
export interface LocalDatabases {
  port: (database: string) => number;
  url: (database: string, role: 'postgres' | 'runtime_role' | 'admin_role') => string;
  /** The env `backend/compose.yaml` reads: the project name and each database's host port. */
  composeEnv: () => Record<string, string>;
}

/** Node strips the types of a file outside node_modules, so the app's own TS loads without a build or tsx. */
export async function importFromApp(forkPath: string, file: string): Promise<Record<string, unknown>> {
  const path = join(forkPath, file);
  if (!existsSync(path)) throw new Error(`not an app built from cella: ${path} is missing`);
  // The app's config reads the mode once, at its first import, and the dev port offset applies in development mode only
  setEnv('NODE_ENV', 'development');
  return import(pathToFileURL(path).href);
}

/**
 * The app's config in development mode, from its own `shared` package. In a linked worktree the import claims that
 * worktree's port slot, as `pnpm dev` would.
 */
export async function loadAppFacts(forkPath: string): Promise<AppFacts> {
  const parsed = appConfigSchema.safeParse((await importFromApp(forkPath, 'shared/index.ts')).appConfig);
  if (!parsed.success)
    throw new Error(`shared/index.ts exports no appConfig this CLI can read: ${parsed.error.message}`);
  return parsed.data;
}

/** The app's local database helpers. */
export async function loadLocalDatabases(forkPath: string): Promise<LocalDatabases> {
  const module = await importFromApp(forkPath, 'shared/src/local-database.ts');
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
export async function importFromWorkspace<T>(forkPath: string, workspace: string, name: string): Promise<T> {
  const require = createRequire(join(forkPath, workspace, 'package.json'));
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
 * A Docker image as a tool runs it, pinned by digest (`name[:tag]@sha256:…`) so every run scans with the same code.
 * Pulls it on first use; the pull shows Docker's own progress.
 * @throws when the reference has no digest, Docker does not answer, or the pull fails
 */
export function resolveImage(reference: string): string {
  if (!/@sha256:[0-9a-f]{64}$/.test(reference)) throw new Error(`${reference} is not pinned by digest`);
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker does not answer: start Docker (or OrbStack) first');
  }
  if (spawnSync('docker', ['image', 'inspect', reference], { stdio: 'ignore' }).status === 0) return reference;
  if (spawnSync('docker', ['pull', reference], { stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
    throw new Error(`could not pull ${reference}`);
  }
  return reference;
}

/**
 * Where a tool keeps its results and state: `<git dir>/cella-<tool>/` of this checkout, or of the git directory every
 * worktree shares. Inside the git directory nothing shows in `git status`.
 */
export function toolDir(forkPath: string, tool: string, scope: 'checkout' | 'repository' = 'checkout'): string {
  const flag = scope === 'checkout' ? '--absolute-git-dir' : '--git-common-dir';
  const gitDir = execFileSync('git', ['rev-parse', flag], { cwd: forkPath, encoding: 'utf8' }).trim();
  return join(resolve(forkPath, gitDir), `cella-${tool}`);
}

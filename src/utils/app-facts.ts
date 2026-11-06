import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
async function importFromApp(forkPath: string, file: string): Promise<Record<string, unknown>> {
  const path = join(forkPath, file);
  if (!existsSync(path)) throw new Error(`not an app built from cella: ${path} is missing`);
  return import(pathToFileURL(path).href);
}

/**
 * The app's config in development mode, from its own `shared` package. In a linked worktree the import claims that
 * worktree's port slot, as `pnpm dev` would.
 */
export async function loadAppFacts(forkPath: string): Promise<AppFacts> {
  // The dev port offset applies in development mode only
  setEnv('NODE_ENV', 'development');
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

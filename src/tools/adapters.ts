import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { importFromWorkspace } from '../utils/app-facts';
import { setEnv } from '../utils/env';
import type { Session } from './drive';

/** What `prepare` and a placeholder resolver get: the signed-in tool user, to call the API as. */
export type SignedIn = Pick<Session, 'email' | 'frontendUrl' | 'backendUrl'> & {
  /** `name=value`: the cookie header that signs a request in. */
  cookie: string;
};

export const signedIn = ({ email, frontendUrl, backendUrl, header }: Session): SignedIn => ({
  email,
  frontendUrl,
  backendUrl,
  cookie: header,
});

/** Brings the tool user into the state the pages expect, before the first visit. */
export type Prepare = (user: SignedIn) => Promise<void>;

/**
 * Values for the `{name}` placeholders of the paths, by name. A resolver that finds nothing returns null, and a path
 * that needs its value then fails with a message naming it.
 */
export type Placeholders = Record<string, (user: SignedIn) => Promise<string | null>>;

/** A zod schema that accepts any function; the adapter's types say which. */
export const fn = <T>() => z.custom<T>((value) => typeof value === 'function', 'expected a function');

export const placeholdersSchema = z.record(z.string(), fn<Placeholders[string]>());

/** Fills the `{name}` placeholders of `path`. */
export function fillPath(path: string, values: Record<string, string | null>, file: string): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`no value for {${name}}: its resolver in ${file} found nothing for the signed-in user`);
    return value;
  });
}

interface TsxApi {
  tsImport: (specifier: string, parentURL: string) => Promise<Record<string, unknown>>;
}

/**
 * Imports an adapter file under the app's own tsx and returns its default export. An adapter imports the app's SDK,
 * whose generated files import each other without an extension, and Node's own type stripping resolves no such import.
 */
export async function importAdapter(forkPath: string, file: string): Promise<unknown> {
  // An adapter reads the app config, which takes the development ports and URLs in development mode only
  setEnv('NODE_ENV', 'development');
  const { tsImport } = await importFromWorkspace<TsxApi>(forkPath, '.', 'tsx/esm/api');
  const module = await tsImport(pathToFileURL(join(forkPath, file)).href, import.meta.url);
  return module.default;
}

function parsed<T>(file: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`${file} does not fit this version of the CLI:\n${z.prettifyError(result.error)}`);
}

/**
 * A tool's adapter in the app's `cella/` folder: the base `<tool>.ts`, synced from the template, and the optional delta
 * `<tool>.app.ts`, pinned to the app, each checked against its schema. A missing delta means the base alone.
 * @throws when the base is missing or a file does not fit its schema
 */
export async function loadAdapter<Base, App>(
  forkPath: string,
  tool: string,
  baseSchema: z.ZodType<Base>,
  appSchema: z.ZodType<App>,
): Promise<{ base: Base; app: App | undefined }> {
  const baseFile = `cella/${tool}.ts`;
  const appFile = `cella/${tool}.app.ts`;
  if (!existsSync(join(forkPath, baseFile))) {
    throw new Error(`${baseFile} is missing: upgrade the app from cella to get the ${tool} adapter`);
  }
  const base = parsed(baseFile, baseSchema, await importAdapter(forkPath, baseFile));
  const app = existsSync(join(forkPath, appFile))
    ? parsed(appFile, appSchema, await importAdapter(forkPath, appFile))
    : undefined;
  return { base, app };
}

/**
 * The base's entries with the delta applied: `remove` drops ids, and an added entry replaces the base entry of its id in
 * place or else comes last.
 * @throws when `remove` names an id the base lacks, so a renamed base entry is noticed
 */
export function applyDelta<T extends { id: string }>(
  base: T[],
  { remove = [], add = [] }: { remove?: string[]; add?: T[] },
  file: string,
): T[] {
  const unknown = remove.filter((id) => !base.some((entry) => entry.id === id));
  if (unknown.length > 0) throw new Error(`${file} removes ${unknown.join(', ')}, which the base does not have`);
  const replaced = base
    .filter((entry) => !remove.includes(entry.id))
    .map((entry) => add.find((added) => added.id === entry.id) ?? entry);
  return [...replaced, ...add.filter((added) => !base.some((entry) => entry.id === added.id))];
}

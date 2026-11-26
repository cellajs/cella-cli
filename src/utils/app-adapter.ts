import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';
import { importFromWorkspace } from './app';
import { launchBrowser } from './browser';
import { mintSession, type Session, signOut } from './drive';
import { onShutdown } from './signals';

/** Brings the signed-in user into the state the pages expect, before the first page. */
export type Prepare = (user: Session) => Promise<void>;

/**
 * Values for the `{name}` placeholders of the paths, by name, read as the signed-in user before the first page. A
 * resolver that finds nothing returns null, and a path that needs its value then fails with a message naming it.
 */
export type Placeholders = Record<string, (user: Session) => Promise<string | null>>;

/** A step on a page that has loaded, such as opening a dialog. */
export type Opener = (page: Page) => Promise<void>;

/** UI that shows once per user, marked seen in the persisted UI store before the first page. */
export interface Suppress {
  /** `publicAlertsSeen` ids, such as the dev banner. */
  alerts?: string[];
  /** `hintsSeen` ids, such as a first-visit menu hint. */
  hints?: string[];
}

/**
 * What the base and the delta of a tool that signs in may both set. An adapter's types are interfaces, each with a
 * schema that satisfies it: a built declaration keeps an interface's field comments and drops those of a zod shape.
 */
export interface SignInFields {
  /** The delta's runs after the base's. */
  prepare?: Prepare;
  /** A name in both files takes the delta's. */
  placeholders?: Placeholders;
  /** The delta's lists join the base's. */
  suppress?: Suppress;
}

/** A zod schema that accepts any function; the adapter's types say which. */
const fn = <T>() => z.custom<T>((value) => typeof value === 'function', 'expected a function');

export const openerSchema = fn<Opener>();

/** A route on the frontend, or one that starts with a placeholder. */
export const pathSchema = z.string().startsWith('/').or(z.string().startsWith('{'));

/** The schema of `SignInFields`, spread into each adapter file's schema. */
export const signInShape = {
  prepare: fn<Prepare>().optional(),
  placeholders: z.record(z.string(), fn<Placeholders[string]>()).optional(),
  suppress: z.strictObject({ alerts: z.array(z.string()).optional(), hints: z.array(z.string()).optional() }).optional(),
};

/**
 * What a signed-in run takes from both adapter files, joined as `SignInFields` describes: `seen` holds the UI store
 * fields that mark the suppressed UI seen.
 */
export function mergeSignIn(base: SignInFields, app: SignInFields = {}) {
  const both = (key: keyof Suppress) => [...(base.suppress?.[key] ?? []), ...(app.suppress?.[key] ?? [])];
  return {
    prepare: [base.prepare, app.prepare].filter((step) => step !== undefined),
    placeholders: { ...base.placeholders, ...app.placeholders },
    seen: { publicAlertsSeen: both('alerts'), hintsSeen: both('hints') },
  };
}

export type SignInSetup = ReturnType<typeof mergeSignIn>;

/** A signed-in run of a tool: one browser, and the user its pages and API calls act as. */
export interface SignedInRun {
  user: Session;
  /** The resolved placeholders. */
  values: Record<string, string | null>;
  browser: Browser;
  /** Closes the browser and signs the user out, so a finished run leaves no live session behind; ctrl-c runs it too. */
  close: () => Promise<void>;
}

/**
 * Signs the tool user in, runs the `prepare` steps and resolves the placeholders as that user, then starts the browser.
 * `env` points the session mint at the database the app runs on, and its `ADMIN_EMAIL` is the default user.
 * @throws when there is no user to sign in as, or a step throws; the user is signed out first
 */
export async function signIn(
  repoRoot: string,
  { prepare, placeholders }: SignInSetup,
  { email, env }: { email?: string; env?: NodeJS.ProcessEnv },
): Promise<SignedInRun> {
  const address = email ?? env?.ADMIN_EMAIL ?? process.env.ADMIN_EMAIL;
  if (!address) throw new Error('no user to sign in as: pass --email, or set ADMIN_EMAIL in .env');
  const user = mintSession(address, { repoRoot, env, hours: 4 });
  let browser: Browser | undefined;
  const close = async () => {
    forget();
    await browser?.close();
    await signOut(user);
  };
  const forget = onShutdown(close);
  try {
    for (const step of prepare) await step(user);
    const values: SignedInRun['values'] = {};
    for (const [name, resolve] of Object.entries(placeholders)) values[name] = await resolve(user);
    browser = await launchBrowser(repoRoot);
    return { user, values, browser, close };
  } catch (error) {
    await close();
    throw error;
  }
}

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
async function importAdapter(repoRoot: string, file: string): Promise<unknown> {
  // An adapter reads the app config, which takes the development ports and URLs in development mode only
  process.env.NODE_ENV = 'development';
  const { tsImport } = await importFromWorkspace<TsxApi>(repoRoot, '.', 'tsx/esm/api');
  const module = await tsImport(pathToFileURL(join(repoRoot, file)).href, import.meta.url);
  return module.default;
}

function parsed<T>(file: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(`${file} does not fit this version of the CLI:\n${z.prettifyError(result.error)}`);
}

/**
 * A tool's adapter in the app's `cella/` folder: the base `<tool>.ts`, which each upgrade brings from the template, and the optional delta
 * `<tool>.app.ts`, pinned to the app, each checked against its schema. A missing delta means the base alone.
 * @throws when the base is missing or a file does not fit its schema
 */
export async function loadAdapter<Base, App>(
  repoRoot: string,
  tool: string,
  baseSchema: z.ZodType<Base>,
  appSchema: z.ZodType<App>,
): Promise<{ base: Base; app: App | undefined }> {
  const baseFile = `cella/${tool}.ts`;
  const appFile = `cella/${tool}.app.ts`;
  if (!existsSync(join(repoRoot, baseFile))) {
    throw new Error(`${baseFile} is missing: upgrade the app from cella to get the ${tool} adapter`);
  }
  const base = parsed(baseFile, baseSchema, await importAdapter(repoRoot, baseFile));
  const app = existsSync(join(repoRoot, appFile)) ? parsed(appFile, appSchema, await importAdapter(repoRoot, appFile)) : undefined;
  return { base, app };
}

/**
 * The base's entries with the delta applied: `remove` drops ids, and an added entry replaces the base entry of its id in
 * place or else comes last. A string is its own id, and no delta leaves the base as it is.
 * @throws when `remove` names an id the base lacks, so a renamed base entry is noticed
 */
export function applyDelta<T extends { id: string } | string>(base: T[], delta: { remove?: string[]; add?: T[] } | undefined, file: string): T[] {
  const { remove = [], add = [] } = delta ?? {};
  const idOf = (entry: T) => (typeof entry === 'string' ? entry : entry.id);
  const has = (list: T[], id: string) => list.some((entry) => idOf(entry) === id);
  const unknown = remove.filter((id) => !has(base, id));
  if (unknown.length > 0) throw new Error(`${file} removes ${unknown.join(', ')}, which the base does not have`);
  const replaced = base.filter((entry) => !remove.includes(idOf(entry))).map((entry) => add.find((added) => idOf(added) === idOf(entry)) ?? entry);
  return [...replaced, ...add.filter((added) => !has(base, idOf(added)))];
}

/**
 * The entries of `ids` in list order, or all of them when `ids` is empty.
 * @throws naming each id the list lacks, and the ids it has
 */
export function selectEntries<T extends { id: string }>(entries: T[], ids: string[], noun: string): T[] {
  const unknown = ids.filter((id) => !entries.some((entry) => entry.id === id));
  if (unknown.length > 0) {
    throw new Error(`no ${noun} ${unknown.join(', ')}: this app has ${entries.map((entry) => entry.id).join(', ')}`);
  }
  return ids.length > 0 ? entries.filter((entry) => ids.includes(entry.id)) : entries;
}

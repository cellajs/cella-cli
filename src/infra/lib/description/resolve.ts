import { posix } from 'node:path';
import type { z } from 'zod';
import { validateServices } from '../../compose/infrastructure';
import type { AppServiceConfig } from '../../compose/types';
import { postgresManaged } from '../../resources/stores/catalog';
import { frontendProxyDockerfile } from '../builder/builder-machine';
import { proxyEnvNames } from '../env-suppliers';
import { type GeneralConfig, validateGeneral } from '../general-config';
import type { ManagedKeyConfig, MintedKeyField } from '../managed-keys-config';
import type { RuntimeSecretConfig } from '../runtime-secrets-config';
import type { StoreProvisioner } from '../stores';
import { errorMessage } from '../utils/errors';
import {
  type DescribedEngineConfig,
  type DescriptionFile,
  descriptionSchema,
  engineConfigSchema,
  type ProxyHeaders,
  proxyHeadersSchema,
} from './schema';

/**
 * Reads one export of a file in the app root, at a path the resolver has checked stays inside it.
 * @returns the export's value, `undefined` when the file has no such export
 * @throws when the file does not load
 */
export type ImportExport = (path: string, exportName: string) => Promise<unknown>;

/** The registries of `infra/description.yml` alone, which import nothing of the app: any module may read them before `APP_MODE` is set. */
export interface FileRegistries {
  appServices: Readonly<Record<string, AppServiceConfig>>;
  processIdentityEnv: readonly string[];
  generalConfig: GeneralConfig;
  runtimeSecretsConfig: Readonly<Record<string, RuntimeSecretConfig>>;
  managedKeysConfig: Readonly<Record<string, ManagedKeyConfig>>;
  appStores: Readonly<Record<string, StoreProvisioner>>;
  /** The engine proxy's `headers` reference, which the app stage reads; undefined when no service runs the engine's proxy. */
  proxyHeadersReference: string | undefined;
}

/** What the mode's `appConfig` adds to the file registries, once checked against them. */
export interface AppRegistries {
  engineConfig: DescribedEngineConfig;
  /** Undefined when no service runs the engine's proxy. */
  proxyHeaders: ProxyHeaders | undefined;
  /** The source text of each derived secret's function, by its reference. */
  derivationSources: Readonly<Record<string, string>>;
}

const fileName = 'infra/description.yml';

/** The `dockerfile` that names the engine's frontend proxy. */
const proxyDockerfile = 'engine:proxy';

function refuse(path: string, message: string): never {
  throw new Error(`${fileName}: ${path}: ${message}`);
}

/** Parses with a schema, or throws one line per issue that names the key path. */
function parse<T extends z.ZodType>(schema: T, input: unknown, source: string): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const lines = result.error.issues.flatMap((issue) => {
    const path = issue.path.join('.');
    const paths = issue.code === 'unrecognized_keys' ? issue.keys.map((key) => (path ? `${path}.${key}` : key)) : [path || '(root)'];
    return paths.map((keyPath) => `${source}: ${keyPath}: ${issue.message}`);
  });
  throw new Error(lines.join('\n'));
}

/** `COOKIE_SECRET` gives `cookieSecret`: the id code addresses a runtime secret by. */
const idOf = (variable: string): string => variable.toLowerCase().replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const kebabOf = (variable: string): string => variable.toLowerCase().replaceAll('_', '-');

/** Checks a reference's form: its file stays inside the app root. */
function referenceOf(reference: string, path: string): { file: string; exportName: string } {
  const [file, exportName] = reference.split('#');
  const relative = posix.normalize(file);
  if (posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) refuse(path, `'${reference}' leaves the app root`);
  return { file: relative, exportName };
}

async function importReference(reference: string, path: string, importExport: ImportExport): Promise<unknown> {
  const { file, exportName } = referenceOf(reference, path);
  let value: unknown;
  try {
    value = await importExport(file, exportName);
  } catch (error) {
    refuse(path, `'${reference}' does not load: ${errorMessage(error)}`);
  }
  if (value === undefined) refuse(path, `'${file}' has no export '${exportName}'`);
  return value;
}

/** Splits a service's env: a value holding `@{` becomes the placeholder `${NAME}` and a binding, any other value stays literal. */
function envOf(slug: string, entries: Readonly<Record<string, string>>, isProxy: boolean): Pick<AppServiceConfig, 'env' | 'bindings'> {
  const env: Record<string, string> = {};
  const bindings: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (isProxy && proxyEnvNames.includes(name)) refuse(`services.${slug}.env.${name}`, 'the engine supplies it to the proxy');
    if (value.includes('@{')) bindings[name] = value;
    env[name] = value.includes('@{') ? `\${${name}}` : value;
  }
  if (isProxy) for (const name of proxyEnvNames) env[name] = `\${${name}}`;
  return { ...(Object.keys(env).length > 0 && { env }), ...(Object.keys(bindings).length > 0 && { bindings }) };
}

function resolveServices(file: DescriptionFile): { services: Record<string, AppServiceConfig>; proxyHeadersReference: string | undefined } {
  const services: Record<string, AppServiceConfig> = {};
  let proxyHeadersReference: string | undefined;
  for (const [slug, entry] of Object.entries(file.services)) {
    const path = `services.${slug}`;
    const { dockerfile, env = {}, headers, ...fields } = entry;
    const isProxy = dockerfile === proxyDockerfile;
    if (isProxy && headers === undefined) refuse(`${path}.headers`, `the ${proxyDockerfile} service takes a reference to its header values`);
    if (!isProxy && headers !== undefined) refuse(`${path}.headers`, `only the ${proxyDockerfile} service takes headers`);
    if (headers !== undefined) {
      if (proxyHeadersReference !== undefined) refuse(`${path}.dockerfile`, `only one service runs the ${proxyDockerfile}`);
      referenceOf(headers, `${path}.headers`);
      proxyHeadersReference = headers;
    }
    services[slug] = {
      ...fields,
      image: `\${REGISTRY}/${entry.reusesImageOf ?? slug}:\${${slug.toUpperCase().replaceAll('-', '_')}_TAG:-latest}`,
      ...(dockerfile !== undefined && { dockerfile: isProxy ? frontendProxyDockerfile : dockerfile }),
      ...envOf(slug, env, isProxy),
    };
  }
  try {
    validateServices(services);
  } catch (error) {
    refuse('services', errorMessage(error));
  }
  return { services, proxyHeadersReference };
}

function resolveSecrets(file: DescriptionFile, storedNames: Map<string, string>, importExport: ImportExport): Record<string, RuntimeSecretConfig> {
  const secrets: Record<string, RuntimeSecretConfig> = {};
  for (const [variable, entry] of Object.entries(file.runtimeSecrets)) {
    const path = `runtimeSecrets.${variable}`;
    const { secretName = kebabOf(variable), required, generation, rotatable, derivedFrom, group, description, services } = entry;
    services.forEach((slug, index) => {
      if (!Object.hasOwn(file.services, slug)) refuse(`${path}.services.${index}`, `names no service '${slug}'`);
    });
    if (rotatable !== undefined && generation !== 'random') refuse(`${path}.rotatable`, 'takes generation: random');
    if (generation && derivedFrom) refuse(`${path}.derivedFrom`, 'a derived secret takes no generation');
    if (required !== undefined && (generation || derivedFrom)) refuse(`${path}.required`, 'a generated or derived secret is always required');
    const owner = storedNames.get(secretName);
    if (owner) refuse(`${path}.secretName`, `'${secretName}' is also the stored name of ${owner}`);
    storedNames.set(secretName, `runtimeSecrets.${variable}`);
    const id = idOf(variable);
    if (secrets[id]) refuse(path, `gives the id '${id}' of another variable`);

    const base = { secretName, description, envVar: variable, services, ...(group !== undefined && { group }) };
    if (generation === 'random') {
      secrets[id] = { ...base, required: true, valueSource: 'engine', generation, ...(rotatable !== undefined && { rotatable }) };
    } else if (derivedFrom) {
      if (!Object.hasOwn(file.runtimeSecrets, derivedFrom.secret))
        refuse(`${path}.derivedFrom.secret`, `names no runtime secret '${derivedFrom.secret}'`);
      const withPath = `${path}.derivedFrom.with`;
      const reference = derivedFrom.with;
      referenceOf(reference, withPath);
      const derive = async (source: string): Promise<string> => {
        const fn = await importReference(reference, withPath, importExport);
        if (typeof fn !== 'function') refuse(withPath, `'${reference}' is no function`);
        const value: unknown = await fn(source);
        if (typeof value !== 'string') refuse(withPath, `'${reference}' returned no string`);
        return value;
      };
      secrets[id] = {
        ...base,
        required: true,
        valueSource: 'engine',
        generation: 'manual',
        derivedFrom: { secretId: idOf(derivedFrom.secret), reference, derive },
      };
    } else {
      secrets[id] = { ...base, required: required ?? false, valueSource: 'operator', generation: 'manual' };
    }
  }
  return secrets;
}

function resolveManagedKeys(file: DescriptionFile): Record<string, ManagedKeyConfig> {
  const keys: Record<string, ManagedKeyConfig> = {};
  for (const [id, entry] of Object.entries(file.managedKeys)) {
    const assign: Partial<Record<MintedKeyField, string>> = {};
    for (const field of ['accessKey', 'secretKey'] as const) {
      const variable = entry.assign[field];
      if (variable === undefined) continue;
      if (!Object.hasOwn(file.runtimeSecrets, variable)) refuse(`managedKeys.${id}.assign.${field}`, `names no runtime secret '${variable}'`);
      assign[field] = idOf(variable);
    }
    keys[id] = { ...entry, assign };
  }
  return keys;
}

/**
 * The file stage: turns the parsed description into the registries the engine reads before `APP_MODE` is set. It imports nothing: a
 * derived secret's `derive` imports its function through `importExport` when it is first called.
 * @throws on an unknown key, a wrong type or a broken rule, naming the key's path
 */
export function resolveFile(file: unknown, importExport: ImportExport): FileRegistries {
  const description = parse(descriptionSchema, file, fileName);

  const appStores: Record<string, StoreProvisioner> = {};
  for (const [id, { secretConsumers }] of Object.entries(description.stores)) appStores[id] = postgresManaged({ secretConsumers });
  const storedNames = new Map<string, string>();
  for (const [id, store] of Object.entries(appStores)) {
    for (const secret of store.secrets?.() ?? []) storedNames.set(secret.secretName, `store '${id}'`);
  }

  try {
    validateGeneral(description.general);
  } catch (error) {
    refuse('general.schedule.everyMinutes', errorMessage(error));
  }

  const { services, proxyHeadersReference } = resolveServices(description);
  return {
    appServices: services,
    processIdentityEnv: description.processIdentityEnv,
    generalConfig: description.general,
    runtimeSecretsConfig: resolveSecrets(description, storedNames, importExport),
    managedKeysConfig: resolveManagedKeys(description),
    appStores,
    proxyHeadersReference,
  };
}

const shown = (value: unknown): string => (value === undefined ? 'none' : JSON.stringify(value));

/** Refuses a port, internal port or path the file states where the mode's `appConfig.services.<slug>` gives another. */
function checkEndpoints(services: FileRegistries['appServices'], config: DescribedEngineConfig): void {
  for (const [slug, service] of Object.entries(services)) {
    const endpoint = config.services[slug];
    if (!endpoint) continue;
    const compare = (field: string, stated: unknown, configured: unknown, source = field) => {
      if (stated !== configured) {
        refuse(`services.${slug}.${field}`, `states ${shown(stated)} where appConfig.services.${slug}.${source} gives ${shown(configured)}`);
      }
    };
    // The proxy listens on a port of its own: appConfig's frontend port is the dev server's.
    if (service.dockerfile !== frontendProxyDockerfile) compare('port', service.port, endpoint.port);
    compare('internalPort', service.internalPort, endpoint.internalPort);
    if (service.lbRoute === 'path') {
      const path = endpoint.publicUrl === undefined ? undefined : URL.parse(endpoint.publicUrl)?.pathname;
      compare('pathPrefix', service.pathPrefix, path, 'publicUrl');
    }
  }
}

/**
 * The app stage: checks the mode's `appConfig` against the file registries and reads the app's references.
 * @param mode the `APP_MODE` the entry point set
 * @throws for an `appConfig` of another mode, a port, internal port or path that differs from the file's, or a reference that names no
 * file, no export or the wrong kind of value
 */
export async function resolveApp(
  files: Pick<FileRegistries, 'appServices' | 'runtimeSecretsConfig' | 'proxyHeadersReference'>,
  appConfig: unknown,
  mode: string | undefined,
  importExport: ImportExport,
): Promise<AppRegistries> {
  const engineConfig = parse(engineConfigSchema, appConfig, 'appConfig');
  if (engineConfig.mode !== mode) {
    throw new Error(
      `appConfig: mode '${engineConfig.mode}' loaded where APP_MODE is ${mode === undefined ? 'unset' : `'${mode}'`}: the entry point sets APP_MODE before the app stage loads.`,
    );
  }
  checkEndpoints(files.appServices, engineConfig);

  let proxyHeaders: ProxyHeaders | undefined;
  const { proxyHeadersReference: headers } = files;
  if (headers !== undefined) {
    const slug = Object.keys(files.appServices).find((key) => files.appServices[key]?.dockerfile === frontendProxyDockerfile);
    const path = `services.${slug}.headers`;
    proxyHeaders = parse(proxyHeadersSchema, await importReference(headers, path, importExport), `${fileName}: ${path}`);
  }

  const derivationSources: Record<string, string> = {};
  for (const secret of Object.values(files.runtimeSecretsConfig)) {
    if (!secret.derivedFrom) continue;
    const { reference } = secret.derivedFrom;
    const path = `runtimeSecrets.${secret.envVar}.derivedFrom.with`;
    const fn = await importReference(reference, path, importExport);
    if (typeof fn !== 'function') refuse(path, `'${reference}' is no function`);
    derivationSources[reference] = String(fn);
  }

  return { engineConfig, proxyHeaders, derivationSources };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { infraDir, repoRoot } from '../utils/paths';
import { resolveFile } from './resolve';

/** Imports a file of the app root by path and reads one export: the app stage and a derived secret's first `derive` call it. */
export async function importAppExport(path: string, exportName: string): Promise<unknown> {
  const module: Record<string, unknown> = await import(pathToFileURL(join(repoRoot, path)).href);
  return module[exportName];
}

/**
 * The file stage: the registries of `cella/infra/description.yml`, which import nothing of the app: any module may load them before the
 * entry point sets `APP_MODE`. The engine config and the proxy's header values are the app stage's (`./app`).
 */
export const { appServices, processIdentityEnv, generalConfig, runtimeSecretsConfig, managedKeysConfig, appStores, proxyHeadersReference } =
  resolveFile(parse(readFileSync(join(infraDir, 'description.yml'), 'utf8')), importAppExport);

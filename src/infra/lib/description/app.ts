import { join } from 'node:path';
import { appServices, importAppExport, proxyHeadersReference, runtimeSecretsConfig } from './index';
import { resolveApp } from './resolve';

/**
 * The app stage: the app's `appConfig` for the `APP_MODE` the entry point set, checked against the file stage, and the values its
 * references name. Only the Pulumi program's context imports it statically; every other module imports it once `APP_MODE` is set.
 */
export const { engineConfig, proxyHeaders, derivationProbes } = await resolveApp(
  { appServices, runtimeSecretsConfig, proxyHeadersReference },
  await importAppExport(join('shared', 'index.ts'), 'appConfig'),
  process.env.APP_MODE,
  importAppExport,
);

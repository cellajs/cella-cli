import { rootPackage } from '../../../utils/app';
import { supportedImageContract, supportedSchemaVersion } from '../../agent/src/plan';
import type { EngineConfig } from '../engine-config';
import { repoRoot } from '../utils/paths';
import { descriptionHash } from './applied-engine';
import { supplierContext } from './static-env';

/** The fields of the engine config the engine reads, and no other field of the app's config: a change to one of them owes an apply. */
function engineFields(config: EngineConfig): EngineConfig {
  const { s3 } = config;
  return {
    slug: config.slug,
    appSlug: config.appSlug,
    mode: config.mode,
    domain: config.domain,
    frontendUrl: config.frontendUrl,
    backendUrl: config.backendUrl,
    singleVM: config.singleVM,
    s3: {
      region: s3.region,
      host: s3.host,
      publicBucketName: s3.publicBucketName,
      privateBucketName: s3.privateBucketName,
      publicCDNUrl: s3.publicCDNUrl,
      privateCDNUrl: s3.privateCDNUrl,
    },
    services: Object.fromEntries(Object.entries(config.services).map(([slug, { enabled, publicUrl }]) => [slug, { enabled, publicUrl }])),
    retention: { backupDays: config.retention.backupDays },
  };
}

/**
 * The app as the engine of one environment sees it: the engine config's fields, every registry of `infra/description.yml` the apply and the
 * deploy read (the runtime secrets and managed keys as the engine reads them, each derived secret with what its function answers for the engine's probe input),
 * each value the engine supplies to the proxy's env, the boot plan's contract version, and the Node, pnpm and repository the root
 * `package.json` names, which the builder and the engine run on. A store is described by its kind and its factory's settings. Run once
 * `APP_MODE` names the environment: the app stage loads here.
 * @param root the checkout whose `package.json` is read
 */
export async function appDescription(root = repoRoot): Promise<Record<string, unknown>> {
  const [
    { appStores, appServices, processIdentityEnv, generalConfig },
    { engineConfig: config, proxyHeaders, derivationProbes },
    { runtimeSecrets },
    { managedKeys },
    { healthContract },
    { proxyEnvSuppliers },
  ] = await Promise.all([
    import('../description'),
    import('../description/app'),
    import('../runtime-secrets'),
    import('../managed-keys'),
    import('../health-contract'),
    import('../env-suppliers'),
  ]);
  const context = supplierContext(config);
  const pkg = rootPackage(root);
  return {
    engine: engineFields(config),
    toolchain: { node: pkg.engines?.node, packageManager: pkg.packageManager, repository: pkg.repository },
    // The agent is the release's and its boot plan the engine's: the contract they share must match.
    bootPlan: { schemaVersion: supportedSchemaVersion, imageContract: supportedImageContract },
    services: appServices,
    processIdentityEnv,
    general: generalConfig,
    health: healthContract,
    // A change to a derivation, or to what it calls, owes an apply: its answer for the probe stands where the wrapper that imports it would
    runtimeSecrets: runtimeSecrets.map(({ derivedFrom, ...secret }) =>
      derivedFrom
        ? {
            ...secret,
            derivedFrom: { secretId: derivedFrom.secretId, reference: derivedFrom.reference, probe: derivationProbes[derivedFrom.reference] },
          }
        : secret,
    ),
    stores: Object.fromEntries(Object.entries(appStores).map(([id, store]) => [id, { kind: store.kind, settings: store.settings }])),
    managedKeys,
    env: Object.fromEntries(Object.entries(proxyEnvSuppliers(proxyHeaders)).map(([name, supply]) => [name, supply(context)])),
  };
}

/** The hash of this checkout's description of the app for the loaded environment: one function for the apply, the engine image and the builder. */
export async function appDescriptionHash(root?: string): Promise<string> {
  return descriptionHash(await appDescription(root));
}

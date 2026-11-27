/**
 * What an app's own tests read of the engine to check its files against it: the proxy's Caddyfile and headers, the apex
 * redirect its shared code copies, the services and runtime secrets its description resolves to, and the operator actions its docs name.
 */

export { appServices } from './lib/description';
export { deriveInfra, redirectedApexOrigin } from './lib/naming';
export { actionLabel, isOperatorActionId, type MenuRowId, menuRow, menuRows, type OperatorActionId, operatorActions } from './lib/operator-actions';
export { type RuntimeSecretDefinition, runtimeSecretConsumers, runtimeSecrets, runtimeSecretsForConsumer } from './lib/runtime-secrets';
export type { SecretManagerSecret } from './lib/scaleway/scaleway-secret-manager';
export { engineAssetsDir } from './lib/utils/paths';
export { type EnsureSecretsClient, ensureSecrets, generateSecretValue } from './tasks/ensure-secrets';
export { securityHeaders } from './tasks/smoke';

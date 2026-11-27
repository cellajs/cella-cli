/**
 * What an app's own tests read of the engine to check its files against it: the proxy's build folder, the apex redirect its shared code
 * copies, the services and runtime secrets its description resolves to, and the operator actions and the tasks a person runs, which its
 * docs name.
 */

export { documentedTasks } from './cli/help';
export { appServices } from './lib/description';
export { redirectedApexOrigin } from './lib/naming';
export { actionLabel, isOperatorActionId, type MenuRowId, menuRow, menuRows, type OperatorActionId, operatorActions } from './lib/operator-actions';
export { runtimeSecretConsumers, runtimeSecrets, runtimeSecretsForConsumer } from './lib/runtime-secrets';
export { engineAssetsDir } from './lib/utils/paths';

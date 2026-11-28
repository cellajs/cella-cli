import type * as pulumi from '@pulumi/pulumi';
import * as scaleway from '@pulumiverse/scaleway';
import { protectsStoredData, type RuntimeSecretDefinition, runtimeSecrets } from '../lib/runtime-secrets';
import { runtimeFolder } from '../lib/scaleway/secret-paths';
import { region, tags } from '../pulumi-context';
import { derivedRuntimeSecretData } from './stores';

/**
 * The value a store supplies for a runtime secret, or undefined for one the program writes no version of. The store plugins in
 * resources/stores bind these values (connection strings, CA data), written as versions here. The operator task ensure-secrets makes
 * the generated and derived values, and ensure-database the database connection strings, straight into Secret Manager: they never pass
 * through the state.
 */
function storeSuppliedData(definition: RuntimeSecretDefinition): pulumi.Input<string> | undefined {
  if (definition.valueSource !== 'engine') return undefined;
  const supplied = derivedRuntimeSecretData[definition.id];
  if (supplied !== undefined) return supplied;
  if (definition.generation === 'random' || definition.derivedFrom || definition.database) return undefined;
  throw new Error(
    `secrets: pulumi-owned secret '${definition.id}' has generation 'manual' but no derived value: add it to derivedRuntimeSecretData.`,
  );
}

/**
 * A runtime secret's container, one per value, in the runtime folder, which only the deploy key reads: the deploy composes each machine's
 * env file from them. One whose value protects stored data outlives a destroy and a registry entry that disappears, as the final
 * dump of a teardown needs it, and an install adopts it again (lib/stack/kept-resources.ts).
 */
function secretContainer(definition: RuntimeSecretDefinition): void {
  const secret = new scaleway.secrets.Secret(
    `secret-${definition.secretName}`,
    { name: definition.secretName, path: runtimeFolder, description: definition.description, region, tags },
    { retainOnDelete: protectsStoredData(definition) },
  );
  const supplied = storeSuppliedData(definition);
  if (supplied !== undefined) {
    new scaleway.secrets.Version(`secret-version-${definition.secretName}`, { secretId: secret.id, data: supplied, region });
  }
}

for (const definition of runtimeSecrets) secretContainer(definition);

import { managedKeysConfig } from './description';
import type { ManagedKeyConfig, MintedKeyField } from './managed-keys-config';
import { type RuntimeSecretId, runtimeSecrets } from './runtime-secrets';

/** A managed key's id: a key of the description's `managedKeys`. */
export type ManagedKeyId = string;

/** A managed-key definition: its config data plus the id (the config key). */
export interface ManagedKeyDefinition extends ManagedKeyConfig {
  id: ManagedKeyId;
}

/** Flattened, ordered managed-key definitions derived from the app config. */
export const managedKeys: ManagedKeyDefinition[] = Object.entries(managedKeysConfig).map(([id, definition]) => ({
  id,
  ...definition,
}));

// Fail fast at load time: a misconfiguration here becomes a bad IAM call or a mis-seeded secret at install.
{
  const operatorIds = runtimeSecrets.filter((secret) => secret.valueSource === 'operator').map((secret) => secret.id);
  const operatorSecretIds = new Set(operatorIds);
  const seenSuffixes = new Set<string>();
  const seenSecretIds = new Set<string>();
  for (const key of managedKeys) {
    if (seenSuffixes.has(key.suffix)) {
      throw new Error(`managedKeys: duplicate suffix '${key.suffix}' (key '${key.id}').`);
    }
    seenSuffixes.add(key.suffix);
    if (key.permissionSets.length === 0) {
      throw new Error(`managedKeys: key '${key.id}' has no permissionSets: grant at least one or remove it.`);
    }
    const assigned = Object.entries(key.assign) as [MintedKeyField, RuntimeSecretId][];
    if (assigned.length === 0) {
      throw new Error(`managedKeys: key '${key.id}' assigns no runtime secret: set assign.accessKey and/or assign.secretKey.`);
    }
    for (const [field, secretId] of assigned) {
      if (!operatorSecretIds.has(secretId)) {
        throw new Error(
          `managedKeys: key '${key.id}' assigns ${field} → '${secretId}', which is not an operator-managed runtime secret. ` +
            `Minted values are written out-of-band, so the target must be valueSource: 'operator' in the description's runtimeSecrets.`,
        );
      }
      if (seenSecretIds.has(secretId)) {
        throw new Error(`managedKeys: runtime secret '${secretId}' is assigned by more than one managed key.`);
      }
      seenSecretIds.add(secretId);
    }
  }
}

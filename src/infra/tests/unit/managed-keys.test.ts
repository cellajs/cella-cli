import { describe, expect, it } from 'vitest';
import { managedKeysConfig } from '../../lib/description';
import { managedKeys } from '../../lib/managed-keys';
import { runtimeSecrets } from '../../lib/runtime-secrets';

describe('managed key registry', () => {
  it('derives managedKeys from the app config, keyed by id, preserving order', () => {
    expect(managedKeys.map((key) => key.id)).toEqual(Object.keys(managedKeysConfig));
    for (const key of managedKeys) {
      const { id, ...rest } = key;
      expect(rest).toEqual(managedKeysConfig[id]);
    }
  });

  it('uses unique suffixes', () => {
    const suffixes = new Set<string>();
    for (const key of managedKeys) {
      expect(suffixes.has(key.suffix), `duplicate managed key suffix: ${key.suffix}`).toBe(false);
      suffixes.add(key.suffix);
    }
  });

  it('assigns every minted half to a distinct operator-managed runtime secret', () => {
    const operatorSecretIds = new Set(runtimeSecrets.filter((secret) => secret.valueSource === 'operator').map((secret) => secret.id));
    const usedSecretIds = new Set<string>();
    for (const key of managedKeys) {
      const entries = Object.entries(key.assign);
      expect(entries.length, `${key.id} must assign at least one half`).toBeGreaterThan(0);
      for (const [field, secretId] of entries) {
        expect(operatorSecretIds.has(secretId), `${key.id}.${field} → ${secretId} must be an operator runtime secret`).toBe(true);
        expect(usedSecretIds.has(secretId), `runtime secret ${secretId} assigned by more than one managed key`).toBe(false);
        usedSecretIds.add(secretId);
      }
    }
  });
});

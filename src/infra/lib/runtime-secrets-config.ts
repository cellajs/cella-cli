import type { ServiceName } from '../compose/compose';

export type RuntimeSecretValueSource = 'engine' | 'operator';
export type RuntimeSecretGeneration = 'manual' | 'random';

/** One runtime secret as `runtimeSecrets` of `infra/description.yml` resolves it, keyed by its id; `RuntimeSecretDefinition` (lib/runtime-secrets.ts) is the flattened shape. */
export interface RuntimeSecretConfig {
  /** Scaleway Secret Manager container name (kebab-case). */
  secretName: string;
  /** Human-readable purpose, surfaced in tooling and the container description. */
  description: string;
  /** Environment variable the consuming service reads the value as. */
  envVar: string;
  /** Whether deploy/health gating treats the value's absence as fatal. */
  required: boolean;
  /** `'engine'` = the engine makes the value (generated, derived, a database's connection string, a store's output); `'operator'` = the operator sets it. */
  valueSource: RuntimeSecretValueSource;
  /** `'random'` = Pulumi RandomPassword; `'manual'` = derived/hand-supplied. */
  generation: RuntimeSecretGeneration;
  /** Services that receive the secret in their machine's `.env.runtime`, which the deploy composes from the runtime folder. */
  services: readonly ServiceName[];
  /** The row of "Env vars & secrets" an operator value is listed in, with every value that names the same one. Unset, the value is its own row. */
  group?: string;
  /** A pulumi-owned value computed from another pulumi-owned secret's value (a public key from its private key), so the two change together. */
  derivedFrom?: RuntimeSecretDerivation;
  /**
   * A generated value "Rotate secrets" may replace: one that protects no stored data (a signing key, a secret two services share). A key that
   * encrypts or hashes stored data is left out: a new value would leave that data unreadable or unmatched. A value derived from a rotatable
   * one follows it.
   */
  rotatable?: boolean;
}

/** How a derived secret's value follows its source: the source secret's id and a pure function of the source value. */
export interface RuntimeSecretDerivation {
  secretId: string;
  /** The `'<path>#<export>'` of the app's function `derive` calls. */
  reference: string;
  /** Imports the referenced function on its first call. */
  derive: (sourceValue: string) => string | Promise<string>;
}

/**
 * The uploads key's two halves, which Update identities and Rotate keys write into the runtime folder: the key of the uploads application,
 * which a service with `s3Access` signs uploads and presigned URLs with. Its consumers are those services.
 */
export const uploadsKeySecrets = [
  { secretName: 'uploads-access-key', envVar: 'S3_ACCESS_KEY_ID', half: 'accessKey' },
  { secretName: 'uploads-secret-key', envVar: 'S3_ACCESS_KEY_SECRET', half: 'secretKey' },
] as const;

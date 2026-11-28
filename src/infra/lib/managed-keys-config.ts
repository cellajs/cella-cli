import type { RuntimeSecretId } from './runtime-secrets';

/** Which half of a minted Scaleway IAM key a managed key routes into a runtime secret: a single-token key uses only `secretKey`, an access/secret pair uses both. */
export type MintedKeyField = 'accessKey' | 'secretKey';

/** One managed key as `managedKeys` of `cella/infra/description.yml` resolves it, keyed by its id; `ManagedKeyDefinition` is the flattened shape. */
export interface ManagedKeyConfig {
  /** IAM application/policy name suffix: `<slug>-<mode>-<suffix>`. Also the API-key description prefix. */
  suffix: string;
  /** Human-readable label for prompts and summaries. */
  label: string;
  /** IAM application description (shown in the Scaleway console). */
  appDescription: string;
  /** IAM policy description (shown in the Scaleway console). */
  policyDescription: string;
  /** Project-scoped permission sets granted to the minted key's policy. */
  permissionSets: readonly string[];
  /** Install opt-in prompt. Minting is ALWAYS operator-confirmed, never silent. */
  prompt: { message: string; default: boolean };
  /** Routes each minted key half to the runtime secret that stores it, keyed by `RuntimeSecretId` so a typo is a compile error. */
  assign: Partial<Record<MintedKeyField, RuntimeSecretId>>;
}

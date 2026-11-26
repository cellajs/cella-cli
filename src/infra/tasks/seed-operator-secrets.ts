import { operatorManagedRuntimeSecrets } from '../lib/runtime-secrets';
import { createSecretManagerClient } from '../lib/scaleway/scaleway-secret-manager';
import { runtimeFolder } from '../lib/scaleway/secret-paths';
import { isEnvFileDeliverable } from '../lib/utils/compose-env-value';

export interface SeedOperatorSecretsOptions {
  secretKey: string;
  projectId: string;
  region: string;
  /** Initial values keyed by runtime secret id (e.g. `adminEmail`). Empty/undefined entries are skipped. */
  values: Partial<Record<string, string>>;
  log?: (message: string) => void;
}

const defaultLog = (message: string) => console.info(message);

/**
 * Seed operator-managed runtime secrets with their first value during setup.
 *
 * Pulumi already creates the empty containers, so this only writes an initial
 * Version for the values the operator typed at the prompt. Containers that already
 * have a version are left untouched, so re-runs never clobber a value set later
 * via "Env vars & secrets".
 *
 * @see resources/secrets.ts
 */
export async function seedOperatorSecrets(options: SeedOperatorSecretsOptions): Promise<void> {
  const log = options.log ?? defaultLog;
  const client = createSecretManagerClient({ secretKey: options.secretKey, region: options.region, projectId: options.projectId });

  for (const secret of operatorManagedRuntimeSecrets) {
    const value = options.values[secret.id];
    if (!value) continue;
    const verdict = isEnvFileDeliverable(value);
    if (!verdict.ok) {
      const form = verdict.reason === 'quote' ? "no single quote (') and no backslash at the end" : 'one line only';
      throw new Error(`${secret.secretName}: ${form}. The deploy checks presence only, and the form is checked here.`);
    }

    const existing = await client.getSecretByName(secret.secretName, runtimeFolder);
    if (existing?.version_count && existing.version_count > 0) {
      log(`skip ${secret.secretName}: already has ${existing.version_count} version(s)`);
      continue;
    }
    const ensured = existing ?? (await client.ensureSecret({ name: secret.secretName, path: runtimeFolder, description: secret.description }));
    await client.putSecretValue({ secretId: ensured.id, value, description: 'Seeded during setup', disablePrevious: false });
    log(`seed ${secret.secretName}`);
  }
}

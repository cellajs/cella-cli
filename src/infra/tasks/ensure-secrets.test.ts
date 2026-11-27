import { describe, expect, it } from 'vitest';
import { type RuntimeSecretDefinition, runtimeSecrets } from '../lib/runtime-secrets';
import { type EnsureSecretsClient, ensureSecrets } from './ensure-secrets';

/** Secret Manager as a fake: `path + name` → the value its latest version holds (undefined for an empty container); writes are recorded. */
function fakeClient(store: Record<string, string | undefined>) {
  const writes: Record<string, string> = {};
  const client: EnsureSecretsClient = {
    getSecretByName: async (name, path) =>
      `${path}${name}` in store ? { id: `${path}${name}`, name, path, version_count: store[`${path}${name}`] === undefined ? 0 : 1 } : undefined,
    accessLatestValue: async (id) => store[id] ?? '',
    putSecretValue: async (input) => {
      writes[input.secretId] = input.value;
      store[input.secretId] = input.value;
      return {};
    },
  };
  return { client, writes };
}

/** The fixture app's runtime secret stored under `secretName`. */
function secret(secretName: string): RuntimeSecretDefinition {
  const found = runtimeSecrets.find((candidate) => candidate.secretName === secretName);
  if (!found) throw new Error(`the fixture app has no runtime secret '${secretName}'`);
  return found;
}

/** A stand-in for the app's derivation, which answers a promise as the lazily imported function does. */
const derive = async (source: string) => `derived-from:${source}`;

/** The fixture's Yjs key pair, its public key derived by the stand-in. */
function yjsPair(): RuntimeSecretDefinition[] {
  const publicKey = secret('yjs-token-public-key');
  if (!publicKey.derivedFrom) throw new Error('the fixture derives yjs-token-public-key');
  return [secret('yjs-token-private-key'), { ...publicKey, derivedFrom: { ...publicKey.derivedFrom, derive } }];
}

const cookie = secret('cookie-secret');

describe('ensureSecrets', () => {
  it('makes a fresh value for a container without one', async () => {
    const { client, writes } = fakeClient({ '/runtime/cookie-secret': undefined });
    await ensureSecrets({ client, secrets: [cookie], generate: () => 'fresh', log: () => {} });
    expect(writes).toEqual({ '/runtime/cookie-secret': 'fresh' });
  });

  // The app's env schema requires at least 32 characters of a generated secret
  it('makes a generated value of 32 URL-safe characters', async () => {
    const { client, writes } = fakeClient({ '/runtime/cookie-secret': undefined });
    await ensureSecrets({ client, secrets: [cookie], log: () => {} });
    expect(writes['/runtime/cookie-secret']).toMatch(/^[\w-]{32}$/);
  });

  it('must not replace a value that exists', async () => {
    const { client, writes } = fakeClient({ '/runtime/cookie-secret': 'kept' });
    await ensureSecrets({ client, secrets: [cookie], generate: () => 'fresh', log: () => {} });
    expect(writes).toEqual({});
  });

  it("gives a derived secret what the named function returns for its source's value", async () => {
    const material = 'known-yjs-token-key-material-of-32-chars';
    const { client, writes } = fakeClient({ '/runtime/yjs-token-private-key': material, '/runtime/yjs-token-public-key': undefined });
    await ensureSecrets({ client, secrets: yjsPair(), log: () => {} });
    expect(writes).toEqual({ '/runtime/yjs-token-public-key': await derive(material) });
  });

  it('leaves a secret whose container does not exist yet for the next run', async () => {
    const { client, writes } = fakeClient({});
    expect(await ensureSecrets({ client, secrets: [cookie], generate: () => 'fresh', log: () => {} })).toEqual([]);
    expect(writes).toEqual({});
  });

  it('must not rotate a key that protects stored data: the data would become unreadable', async () => {
    const { client, writes } = fakeClient({ '/runtime/data-encryption-key': 'kept-data-key-of-32-characters-x' });
    await ensureSecrets({ client, secrets: [secret('data-encryption-key')], generate: () => 'fresh', rotate: true, log: () => {} });
    expect(writes).toEqual({});
  });

  it('rotates a generated secret to a fresh value, and recomputes what derives from it', async () => {
    const { client, writes } = fakeClient({
      '/runtime/cookie-secret': 'old',
      '/runtime/yjs-token-private-key': 'old-material-of-32-characters-xx',
      '/runtime/yjs-token-public-key': 'old-public',
    });
    let n = 0;
    await ensureSecrets({ client, secrets: [cookie, ...yjsPair()], generate: () => `fresh-${n++}`, rotate: true, log: () => {} });
    expect(writes['/runtime/cookie-secret']).not.toBe('old');
    const material = writes['/runtime/yjs-token-private-key'] ?? '';
    expect(material).not.toBe('old-material-of-32-characters-xx');
    expect(writes['/runtime/yjs-token-public-key']).toBe(await derive(material));
  });
});

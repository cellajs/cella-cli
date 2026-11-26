import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployRules } from '../lib/scaleway/deploy-policy';
import { principalNames } from '../lib/scaleway/principals';
import { clearOrganizationEnv, makeFetch } from '../tests/helpers/fake-fetch';
import { setupCiKey } from './setup-ci-key';

clearOrganizationEnv();

const baseOpts = {
  callerSecretKey: 'caller-secret',
  organizationId: 'org-1',
  projectId: 'proj-1',
  slug: 'demo',
  mode: 'production',
  log: () => {},
};

/** Group enrollment routes: find-or-create `demo-production` + add-member. */
const groupRoutes = [
  {
    method: 'GET',
    match: '/iam/v1alpha1/groups?',
    body: { groups: [{ id: 'grp-1', name: 'demo-production', application_ids: [] }] },
  },
  { method: 'POST', match: '/iam/v1alpha1/groups/grp-1/add-member', body: { id: 'grp-1' } },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-22T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('setupCiKey', () => {
  it('creates the deploy application under the name the engine knows, with the deploy rules', async () => {
    const { fn, calls } = makeFetch([
      { method: 'GET', match: '/iam/v1alpha1/applications?', body: { applications: [] } },
      { method: 'POST', match: '/iam/v1alpha1/applications', body: { id: 'app-new', name: 'demo-production-ci-deploy' } },
      ...groupRoutes,
      { method: 'GET', match: '/iam/v1alpha1/policies?', body: { policies: [] } },
      { method: 'POST', match: '/iam/v1alpha1/policies', body: { id: 'pol-new', name: 'demo-production-ci-deploy-policy' } },
      { method: 'GET', match: '/iam/v1alpha1/api-keys?', body: { api_keys: [] } },
      { method: 'POST', match: '/iam/v1alpha1/api-keys', body: { access_key: 'SCWNEW', secret_key: 'sekret', application_id: 'app-new' } },
    ]);
    vi.stubGlobal('fetch', fn);

    await setupCiKey(baseOpts);

    const appCreate = calls.find((c) => c.url.endsWith('/applications') && c.init.method === 'POST')!;
    expect(JSON.parse(appCreate.init.body as string).name).toBe(principalNames(baseOpts.slug, baseOpts.mode).ciDeploy);

    const policyCreate = calls.find((c) => c.url.endsWith('/policies') && c.init.method === 'POST')!;
    // The deploy rules, the same ones Update identities writes in place (lib/scaleway/deploy-policy.ts).
    expect(JSON.parse(policyCreate.init.body as string).rules).toEqual(deployRules({ projectId: 'proj-1' }));
  });

  it('mints the fresh key BEFORE deleting the replaced ones (no keyless window on mint failure)', async () => {
    const { fn, calls } = makeFetch([
      {
        method: 'GET',
        match: '/iam/v1alpha1/applications?',
        body: { applications: [{ id: 'app-1', name: 'demo-production-ci-deploy' }] },
      },
      ...groupRoutes,
      {
        method: 'GET',
        match: '/iam/v1alpha1/policies?',
        body: { policies: [{ id: 'pol-1', name: 'demo-production-ci-deploy-policy' }] },
      },
      { method: 'DELETE', match: '/iam/v1alpha1/policies/pol-1', body: {} },
      { method: 'POST', match: '/iam/v1alpha1/policies', body: { id: 'pol-1', name: 'demo-production-ci-deploy-policy' } },
      {
        method: 'GET',
        match: '/iam/v1alpha1/api-keys?',
        body: { api_keys: [{ access_key: 'SCWOLD1' }, { access_key: 'SCWOLD2' }] },
      },
      { method: 'DELETE', match: '/iam/v1alpha1/api-keys/SCWOLD1', body: {} },
      { method: 'DELETE', match: '/iam/v1alpha1/api-keys/SCWOLD2', body: {} },
      { method: 'POST', match: '/iam/v1alpha1/api-keys', body: { access_key: 'SCWNEW', secret_key: 'sekret', application_id: 'app-1' } },
    ]);
    vi.stubGlobal('fetch', fn);

    await setupCiKey(baseOpts);

    const apiKeyDeletes = calls.filter((c) => c.init.method === 'DELETE' && c.url.includes('/api-keys/'));
    expect(apiKeyDeletes.map((c) => c.url)).toEqual([expect.stringContaining('/api-keys/SCWOLD1'), expect.stringContaining('/api-keys/SCWOLD2')]);
    const mintIndex = calls.findIndex((c) => c.init.method === 'POST' && c.url.endsWith('/api-keys'));
    const firstDeleteIndex = calls.findIndex((c) => c.init.method === 'DELETE' && c.url.includes('/api-keys/'));
    expect(mintIndex).toBeGreaterThanOrEqual(0);
    expect(firstDeleteIndex).toBeGreaterThan(mintIndex);
  });
});

import { type ScwAuth, scwFetch, scwListAll, scwSend } from './scw-fetch';

export const iamBase = 'https://api.scaleway.com/iam/v1alpha1';
export const accountBase = 'https://api.scaleway.com/account/v3';

export interface ScwApiKey {
  access_key: string;
  secret_key: string;
  created_at?: string;
}

/** An api key as IAM describes it (no secret): its bearer is exactly one of `user_id` / `application_id`. */
export interface ScwApiKeyRecord {
  access_key: string;
  description?: string;
  expires_at?: string | null;
  application_id?: string | null;
  user_id?: string | null;
  default_project_id?: string;
}

/** Describe one api key. A key may describe itself, so this is the self-inspection every principal can perform. */
export async function getApiKey(auth: ScwAuth, accessKey: string): Promise<ScwApiKeyRecord> {
  return scwFetch<ScwApiKeyRecord>(auth, 'GET', `${iamBase}/api-keys/${accessKey}`);
}

/** Resolve the organization id owning a project (the api-key-free path). */
export async function resolveOrganizationIdViaProject(auth: ScwAuth, projectId: string): Promise<string> {
  const project = await scwFetch<{ organization_id?: string }>(auth, 'GET', `${accountBase}/projects/${projectId}`);
  if (!project?.organization_id) {
    throw new Error(`Could not resolve organization_id from project ${projectId}: set SCW_DEFAULT_ORGANIZATION_ID in .env and run again.`);
  }
  return project.organization_id;
}

/** Resolve an IAM application's id from its (unique) name. Returns null when not found. */
export async function resolveApplicationIdByName(auth: ScwAuth, organizationId: string, name: string): Promise<string | null> {
  const { applications = [] } = await scwFetch<{ applications?: Array<{ id: string; name: string }> }>(
    auth,
    'GET',
    `${iamBase}/applications?name=${encodeURIComponent(name)}&organization_id=${organizationId}&page_size=20`,
  );
  return applications.find((app) => app.name === name)?.id ?? null;
}

export interface IamPolicy {
  id: string;
  name: string;
  description?: string;
  /** Principal bindings: a policy targets exactly one of application / user / group. */
  application_id?: string;
  user_id?: string;
  group_id?: string;
}

/** A rule as IAM returns it. */
export interface LiveRule {
  permission_set_names?: readonly string[];
  project_ids?: readonly string[] | null;
  organization_id?: string | null;
  condition?: string | null;
}

/** Every policy in the organization, paged. The list endpoint's `application_id` filter is unreliable, so callers filter by principal client-side. */
export async function listOrganizationPolicies(auth: ScwAuth, organizationId: string): Promise<IamPolicy[]> {
  return scwListAll<IamPolicy>(auth, (page) => `${iamBase}/policies?organization_id=${organizationId}&page=${page}&page_size=100`, 'policies');
}

/** An IAM policy by its exact name within an organization, or undefined: the name filter narrows the list, and the name decides. */
export async function findPolicy(auth: ScwAuth, organizationId: string, name: string): Promise<IamPolicy | undefined> {
  const { policies = [] } = await scwFetch<{ policies?: IamPolicy[] }>(
    auth,
    'GET',
    `${iamBase}/policies?organization_id=${organizationId}&policy_name=${encodeURIComponent(name)}&page_size=20`,
  );
  return policies.find((policy) => policy.name === name);
}

/** A policy's rules, one page of 100. */
export async function policyRules(auth: ScwAuth, policyId: string): Promise<LiveRule[]> {
  return (await scwFetch<{ rules?: LiveRule[] | null }>(auth, 'GET', `${iamBase}/rules?policy_id=${policyId}&page_size=100`)).rules ?? [];
}

/** All api keys on an application (one page of 100; a declared identity holds one key). */
export async function listApiKeys(auth: ScwAuth, organizationId: string, applicationId: string): Promise<ScwApiKey[]> {
  const { api_keys = [] } = await scwFetch<{ api_keys?: ScwApiKey[] }>(
    auth,
    'GET',
    `${iamBase}/api-keys?application_id=${applicationId}&organization_id=${organizationId}&page_size=100`,
  );
  return api_keys;
}

/** Mint a fresh api key on an application or a user, optionally expiring (RFC 3339). */
export async function createApiKey(
  auth: ScwAuth,
  opts: { applicationId?: string; userId?: string; description: string; defaultProjectId: string; expiresAt?: string },
): Promise<ScwApiKey> {
  return scwFetch<ScwApiKey>(auth, 'POST', `${iamBase}/api-keys`, {
    ...(opts.applicationId ? { application_id: opts.applicationId } : {}),
    ...(opts.userId ? { user_id: opts.userId } : {}),
    description: opts.description,
    default_project_id: opts.defaultProjectId,
    ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
  });
}

export async function deleteApiKey(auth: ScwAuth, accessKey: string): Promise<void> {
  await scwSend(auth, 'DELETE', `${iamBase}/api-keys/${accessKey}`);
}

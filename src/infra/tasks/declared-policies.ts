import type { DeclaredPolicy } from '../lib/scaleway/declared-identities';
import { sameRules } from '../lib/scaleway/declared-identities';
import { findPolicy, IAM_BASE, policyRules, resolveApplicationIdByName } from '../lib/scaleway/iam-client';
import { type ScwAuth, scwFetch, scwSend } from '../lib/scaleway/scw-fetch';

/** What one declared policy needs: nothing, a policy made, its rules replaced, or its application made first. */
export interface DeclaredPolicyStep {
  policy: string;
  change: 'none' | 'create' | 'update' | 'missing-application';
}

/** What writing the declared policies would change, read with any key that holds IAM read. Nothing is written. */
export async function planDeclaredPolicies(auth: ScwAuth, organizationId: string, wanted: readonly DeclaredPolicy[]): Promise<DeclaredPolicyStep[]> {
  const steps: DeclaredPolicyStep[] = [];
  for (const policy of wanted) {
    if (!(await resolveApplicationIdByName(auth, organizationId, policy.applicationName))) {
      steps.push({ policy: policy.name, change: 'missing-application' });
      continue;
    }
    const live = await findPolicy(auth, organizationId, policy.name);
    if (!live) steps.push({ policy: policy.name, change: 'create' });
    else steps.push({ policy: policy.name, change: sameRules(await policyRules(auth, live.id), policy.rules) ? 'none' : 'update' });
  }
  return steps;
}

/**
 * Write the declared policies: create a missing one, and replace the rules of one that differs in place, so its key keeps its rights in
 * between. Needs IAM write: an Owner API key. Every application must exist already (the registry principals are ensured first).
 */
export async function writeDeclaredPolicies(
  auth: ScwAuth,
  organizationId: string,
  wanted: readonly DeclaredPolicy[],
  log: (message: string) => void = console.info,
): Promise<DeclaredPolicyStep[]> {
  const steps: DeclaredPolicyStep[] = [];
  for (const policy of wanted) {
    const applicationId = await resolveApplicationIdByName(auth, organizationId, policy.applicationName);
    if (!applicationId) throw new Error(`IAM application '${policy.applicationName}' does not exist, so '${policy.name}' cannot be written.`);
    const live = await findPolicy(auth, organizationId, policy.name);
    if (!live) {
      await scwFetch(auth, 'POST', `${IAM_BASE}/policies`, {
        name: policy.name,
        description: policy.description,
        organization_id: organizationId,
        application_id: applicationId,
        rules: policy.rules,
        tags: policy.tags,
      });
      log(`  created ${policy.name}`);
      steps.push({ policy: policy.name, change: 'create' });
      continue;
    }
    if (live.application_id && live.application_id !== applicationId) {
      throw new Error(`'${policy.name}' grants to another application than '${policy.applicationName}': fix it in the console.`);
    }
    if (sameRules(await policyRules(auth, live.id), policy.rules)) {
      steps.push({ policy: policy.name, change: 'none' });
      continue;
    }
    await scwSend(auth, 'PUT', `${IAM_BASE}/rules`, { policy_id: live.id, rules: policy.rules });
    log(`  updated the rules of ${policy.name}`);
    steps.push({ policy: policy.name, change: 'update' });
  }
  return steps;
}

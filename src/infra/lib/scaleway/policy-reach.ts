import { findPolicy, type IamPolicy, type LiveRule, policyRules } from './iam-client';
import type { ScwAuth } from './scw-fetch';

/** Where a policy reaches: the projects its `projectSets` rules name, and the condition all of its rules agree on. */
export interface PolicyReach {
  projectIds: string[];
  /** Undefined when the rules carry no condition, or not one and the same. */
  condition?: string;
}

/** The reach of a policy's rules, read from the rules that hold one of `projectSets`. */
export function policyReach(rules: readonly LiveRule[], projectSets: readonly string[]): PolicyReach {
  const projectIds = [
    ...new Set(
      rules.filter((rule) => (rule.permission_set_names ?? []).some((set) => projectSets.includes(set))).flatMap((rule) => rule.project_ids ?? []),
    ),
  ];
  const conditions = new Set(rules.map((rule) => rule.condition ?? ''));
  const [only] = [...conditions];
  return { projectIds, ...(conditions.size === 1 && only ? { condition: only } : {}) };
}

/** A policy as IAM lists it, with its rules. */
export interface LivePolicy extends IamPolicy {
  rules: LiveRule[];
}

/** A policy of the organization by name, with its rules; undefined when there is none. */
export async function readPolicy(auth: ScwAuth, organizationId: string, policyName: string): Promise<LivePolicy | undefined> {
  const policy = await findPolicy(auth, organizationId, policyName);
  return policy && { ...policy, rules: await policyRules(auth, policy.id) };
}

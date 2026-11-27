import { rootPackage } from '../../../utils/app';
import { generalConfig } from '../description';
import type { EngineConfig } from '../engine-config';
import { resolvePerMode } from '../general-config';
import { engineFolder } from '../scaleway/secret-paths';
import { findJobDefinition } from '../scaleway/serverless-jobs';
import { isEnvironment } from '../stack/environment';
import { repoRoot } from '../utils/paths';

/** The deploy key's copy the main job's definition references: `{ accessKey, secretKey }`, written when the key is made or replaced. */
const deployKeySecretName = 'deploy-key';

/** The folder of the secrets the definition references: the engine's, which only the operator reads. */
const mainJobSecretFolder = engineFolder.replace(/\/$/, '');

/** How a run ends, as its exit code. A scheduled run starts a target once; a blocked one waits for the operator. */
export const mainJobExit = {
  /** The target is live: deployed by this run, or already serving (`unchanged` in the record); a scheduled run that started nothing. */
  deployed: 0,
  /** The deploy failed; a role it had not switched still serves the release before. A failed target is not started again by itself. */
  failed: 1,
  /**
   * A required runtime value is missing, which the run's record names, or the target needs an apply (`apply needed`): Manage runtime
   * secrets stores the value, the apply makes one it owns or publishes the target's description, and both start the target again at their end.
   */
  blocked: 2,
} as const;

/**
 * How a run ended, for a person. Scaleway reports a run that exited 0 as `succeeded` with no exit code, so the state says
 * deployed; a `failed` run's exit code tells blocked from failed; every other end (an interrupted run) is failed.
 */
export function mainJobOutcome(run: { state: string; exit_code?: number | null }): 'deployed' | 'blocked' | 'failed' {
  if (run.state === 'succeeded') return 'deployed';
  if (run.state === 'failed' && run.exit_code === mainJobExit.blocked) return 'blocked';
  return 'failed';
}

/** The id of the environment's main job definition, read with `key`; undefined before an apply made it. */
export async function findMainJob(scope: { appConfig: EngineConfig; projectId: string }, key: { secretKey: string }): Promise<string | undefined> {
  // Lazy: naming loads the description's service registry.
  const { deriveInfra } = await import('../naming');
  const { naming, region } = deriveInfra(scope.appConfig);
  return findJobDefinition({ secretKey: key.secretKey }, { region, projectId: scope.projectId, name: naming.resource('main') });
}

/** The root `package.json`'s `engines.node`: the Node every run of the engine starts on. */
export function rootNodeVersion(root = repoRoot): string {
  return (rootPackage(root) as { engines: { node: string } }).engines.node;
}

/**
 * The names a run's engine sees, all others dropped: the target and the retry counter a start by hand sets, the deploy key the definition
 * references and the project. A start call may set any other name too (`NODE_OPTIONS`, `GIT_CONFIG_*`, `RELEASES_ONLY`); none reaches
 * Node, git or the release check.
 */
export const mainJobEnvNames = ['TARGET_SHA', 'RETRY', 'DEPLOY_KEY_JSON', 'SCW_DEFAULT_PROJECT_ID', 'SCW_DEFAULT_ORGANIZATION_ID'] as const;

/**
 * The run's first program, in the engine image an apply published: it hands over to the image's own `main-job` task with an environment
 * of {@link mainJobEnvNames} alone, whose exit code is the run's. Nothing is fetched or installed: the run is the image, the target is
 * only built and checked by it. POSIX sh reads no startup file when it runs a command string.
 */
export const mainJobScript = `cd /engine || exit 1
exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root ${mainJobEnvNames.map((name) => `${name}="$${name}"`).join(' ')} pnpm --silent --filter infra main-job
`;

/** How long one run may take before Scaleway ends it: the definition's time limit, and the age a deploy's machine can reach unnamed. */
export const mainJobTimeLimitHours = 1;

/** When Scaleway starts a run by itself: a cron expression and the canonical time zone it is read in. */
export interface MainJobSchedule {
  schedule: string;
  timezone: string;
}

/**
 * The minutes between an environment's scheduled runs, `general.schedule.everyMinutes` of infra/description.yml.
 * @throws for a mode that is no environment, which has no main job
 */
export function scheduleEveryMinutes(mode: string): number {
  if (!isEnvironment(mode)) throw new Error(`'${mode}' is no environment with a main job`);
  return resolvePerMode(generalConfig.schedule.everyMinutes, mode);
}

/**
 * A scheduled run every `everyMinutes`: it ends within seconds when the target has a run, and deploys the target when it has none. The
 * cadence is how soon a release or a merged environments line deploys.
 */
function mainJobSchedule(everyMinutes: number): MainJobSchedule {
  return { schedule: everyMinutes === 1 ? '* * * * *' : `*/${everyMinutes} * * * *`, timezone: 'Etc/UTC' };
}

/**
 * The main job's definition as the last apply publishes it: the apply writes it, and the inventory compares the live one against it. The
 * main job is one Serverless Jobs definition per environment that runs at most one deploy of a target per run on the engine image the
 * apply published. Its keys arrive by secret reference. A run its schedule starts finds the target itself; a start by hand carries the
 * target and the retry counter, the only values a start carries: anyone who reads job runs can see them.
 */
export interface MainJobDeclaration {
  imageUri: string;
  startupCommands: string[];
  env: Record<string, string>;
  /** The secrets a run reads, by the env var each lands in: its name in {@link secretFolder}. An optional one may be missing from an older stack. */
  secretReferences: Record<string, { name: string; optional?: true }>;
  secretFolder: string;
  cron: MainJobSchedule;
}

/**
 * The declared definition of an environment's main job: the engine image by digest, the script, the project and the schedule.
 * @param everyMinutes the cadence of {@link scheduleEveryMinutes}.
 * @throws for an image named by a tag, which can move to another image
 */
export function declaredMainJob(opts: { projectId: string; organizationId: string; image: string; everyMinutes: number }): MainJobDeclaration {
  if (!/@sha256:[0-9a-f]{64}$/.test(opts.image)) throw new Error(`the main job runs the engine image by its digest, got '${opts.image}'`);
  return {
    imageUri: opts.image,
    startupCommands: ['/bin/sh', '-c', mainJobScript],
    env: { SCW_DEFAULT_PROJECT_ID: opts.projectId, SCW_DEFAULT_ORGANIZATION_ID: opts.organizationId },
    // The deploy key only: a deploy plans no stack.
    secretReferences: { DEPLOY_KEY_JSON: { name: deployKeySecretName } },
    secretFolder: mainJobSecretFolder,
    cron: mainJobSchedule(opts.everyMinutes),
  };
}

/** The Secret Manager calls that store the deploy key's copy. */
interface DeployKeySecrets {
  ensureSecret(input: { name: string; path: string; description: string }): Promise<{ id: string }>;
  putSecretValue(input: { secretId: string; value: string; description: string; disablePrevious: boolean }): Promise<unknown>;
}

/**
 * Store the deploy key's copy the main job's definition references, in the engine folder, on the operator key: done when a setup or a
 * rotation of keys makes the key, so a run always starts with the key that is valid. The earlier version is disabled.
 */
export async function storeDeployKeyCopy(secrets: DeployKeySecrets, key: { accessKey: string; secretKey: string }): Promise<void> {
  const container = await secrets.ensureSecret({
    name: deployKeySecretName,
    path: mainJobSecretFolder,
    description: "The deploy key, for the main job's runs (referenced by its definition)",
  });
  await secrets.putSecretValue({
    secretId: container.id,
    value: JSON.stringify({ accessKey: key.accessKey, secretKey: key.secretKey }),
    description: 'Written when the deploy key was made',
    disablePrevious: true,
  });
}

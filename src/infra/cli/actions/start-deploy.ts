import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { printable } from '../../../utils/terminal-text';
import { commitRefs, listRemoteRefs } from '../../lib/deploy/git-remote';
import { readLiveRecord } from '../../lib/deploy/live-record';
import { findMainJob, mainJobOutcome } from '../../lib/deploy/main-job';
import { repositoryUrl } from '../../lib/deploy/repository-key';
import { commitRecords } from '../../lib/deploy/run-store';
import { rotationTarget } from '../../lib/deploy/scheduled-run';
import { commitName, ENVIRONMENTS_FILE, parseEnvironmentsFile, resolveTarget, type Target } from '../../lib/deploy/target';
import { deriveInfra } from '../../lib/naming';
import { actionLabel, menuPath } from '../../lib/operator-actions';
import { type KeyPair, resolveOperatorIdentity } from '../../lib/scaleway/operator-identity';
import { listJobRuns, runEnded, startJobRun } from '../../lib/scaleway/serverless-jobs';
import { leaseDeploys, leaseLive, lockKey, peekLock } from '../../lib/stack/control-store';
import { checkMark, crossMark, pc, warningMark } from '../../lib/utils/cli-output';
import { errorMessage } from '../../lib/utils/errors';
import { repoRoot } from '../../lib/utils/paths';
import { confirmOrDefault, endAction, type InfraContext, stackNameFor } from '../shared';
import { bootDiagOn, deployAndFollow, deployFixes, type FollowOutcome, followLiveDeploy, liveCommit, liveDeploy } from './deploy-follow';
import { acquireOperatorKey } from './operator-unlock';

/**
 * Start one run of the environment's main job by hand, on the operator key, for the environment's target as the environments file of this
 * checkout says it, and follow the run until it ends: deployed (or already serving), blocked (a runtime value is owed) or failed. A scheduled
 * run does the same by itself at the environment's cadence; this is the operator's way for a target the schedule does not start again.
 * @param opts.asked the caller asked the person already, so the deploy starts without a second question.
 */
export async function runStartDeploy(context: InfraContext, opts: { asked?: boolean } = {}): Promise<void> {
  const environment = context.environment;
  const target = await environmentTarget(context);
  if (!target) {
    console.error(
      `${crossMark} ${environment} has no line in ${ENVIRONMENTS_FILE}, so it deploys nothing: add \`${environment} branch:main\` there.`,
    );
    return endAction(1);
  }
  const name = commitName(await commitRefs(), target.sha);
  if (target.retry > 0) console.info(pc.dim(`\n${actionLabel('deploy-now')}: ${name} to ${environment}, retry ${target.retry}.\n`));
  // A deploy under way is followed, not doubled: the observer key finds it without a paste, the operator key once it is in hand.
  const observer = resolveOperatorIdentity().observer;
  if (observer && (await followIfLive(context, observer)) === 'deployed') return;
  if (!opts.asked && !(await confirmOrDefault({ id: 'deploy.confirm', message: `Deploy ${name} to ${environment}?`, default: true }))) return;

  const operator = await acquireOperatorKey(context);
  if (!observer && (await followIfLive(context, operator)) === 'deployed') return;
  const definitionId = await findMainJob(context, operator);
  if (!definitionId) {
    console.error(
      `${crossMark} ${environment} has no main job yet: "${menuPath('apply')}" makes it, once the deploy key's copy is in the engine folder ("${menuPath('rotate-keys')}").`,
    );
    return endAction(1, { fix: ['apply', 'rotate-keys'] });
  }
  const outcome = await deployAndFollow(context, operator, definitionId, target, 'Started');
  if (outcome !== 'deployed') endAction(1, { fix: deployFixes(outcome) });
}

/**
 * Follow the deploy under way, when one is, and say how it ended; `none` when no deploy runs. The person asked to deploy: a deploy that is
 * running is what they want to watch, and one that ends deployed leaves nothing to start.
 */
async function followIfLive(context: InfraContext, key: KeyPair): Promise<FollowOutcome | 'none'> {
  const live = await liveDeploy(context, key).catch(() => undefined);
  if (!live) return 'none';
  console.info(`${pc.yellow('●')} ${commitName(await commitRefs(), live.record.target)} is deploying.`);
  return followLiveDeploy(context, key, live);
}

/** How long a target read waits for the repository before it fails with a line, so a stalled remote never hangs an action. */
const TARGET_REFS_TIMEOUT_MS = 20_000;

/**
 * The environment's target, as the environments file of this checkout and the repository's refs say it; none for an environment other than
 * production without a line.
 */
export async function environmentTarget(context: InfraContext): Promise<Target | undefined> {
  const file = join(repoRoot, ENVIRONMENTS_FILE);
  const line = existsSync(file) ? parseEnvironmentsFile(readFileSync(file, 'utf8')).get(context.environment) : undefined;
  return resolveTarget({
    environment: context.environment,
    line,
    listRemote: listRemoteRefs(repositoryUrl(), process.env.REPOSITORY_READ_KEY, { timeoutMs: TARGET_REFS_TIMEOUT_MS }),
  });
}

/**
 * Whether the environment never deployed: no run record and no live record, read on the operator key.
 * @returns False when either read fails, said in a line, so no first deploy is offered on a guess.
 */
export async function awaitsFirstDeploy(context: InfraContext, key: KeyPair): Promise<boolean> {
  try {
    const diag = await bootDiagOn(context, key);
    const [runs, live] = await Promise.all([diag.store.listRuns(1), readLiveRecord(diag.control, diag.bucket, stackNameFor(context))]);
    return runs.length === 0 && Object.keys(live.record.roles).length === 0;
  } catch (error) {
    console.warn(
      `${warningMark} The deploy history could not be read (${errorMessage(error)}): "${actionLabel('deploy-now')}" deploys ${context.environment}.`,
    );
    return false;
  }
}

/**
 * End a rotation on the operator key: deploy the live commit again, which the rotation's counter makes replace every machine, as the live
 * record names the counter each machine was booted under, then start the environment's target when it is another commit with no run under
 * its retry counter. The running machines hold keys or values the rotation replaced, and a scheduled run deploys only when the target
 * moves; a deploy of the live commit, a release that deployed before, puts them on the rotated ones whatever becomes of the target. The
 * live run is followed to its end, as the target's run would wait on the lease behind it, and when it does not deploy the target is left
 * for the action that clears the block or `deploy`. Where the live commit is not the target, a person confirms each deploy: the deploy key
 * writes the live record and the run records, which set only the defaults. After the live deploy a target that ran before is declined by
 * default, as a scheduled run leaves it: a rotation keeps a rollback in place. A no to the live commit asks for the target in its place,
 * yes by default, after its runs are shown. Before the first deploy there is no live commit, and when the live record cannot be read there
 * is none known: the target alone is started.
 */
export async function redeployAfterRotation(context: InfraContext, key: KeyPair): Promise<void> {
  const auth = { secretKey: key.secretKey };
  const { region } = deriveInfra(context.appConfig);
  const definitionId = await findMainJob(context, key);
  if (!definitionId) {
    console.warn(`${warningMark} ${context.environment} has no main job yet: deploy with "${menuPath('deploy-now')}" once an apply made it.`);
    return;
  }
  const live = await bootDiagOn(context, key)
    .then((diag) => liveCommit(context, diag))
    .catch((error) => {
      console.warn(`${warningMark} The live commit could not be read (${errorMessage(error)}): the target alone is started.`);
      return undefined;
    });
  const target = await environmentTarget(context);
  if (
    live &&
    (target?.sha === live ||
      (await confirmOrDefault({ message: `The live record names ${commitName(await commitRefs(), live)}: deploy it again?`, default: true })))
  ) {
    const outcome = await deployAndFollow(
      context,
      key,
      definitionId,
      { sha: live, retry: 0 },
      `Deploying the live ${commitName(await commitRefs(), live)} again, which replaces every machine`,
    );
    if (outcome !== 'deployed') {
      console.warn(`${warningMark} The machines keep what the rotation replaced until a deploy succeeds; the target is not started.`);
      return;
    }
    if (!target || target.sha === live) return;
    const ran = await targetHasRun(context, key, live, target);
    const targetName = commitName(await commitRefs(), target.sha);
    if (!(await confirmOrDefault({ message: `Deploy ${targetName} to ${context.environment}?`, default: !ran }))) return;
  } else if (live && target) {
    await targetHasRun(context, key, live, target);
    if (!(await confirmOrDefault({ message: `Deploy ${commitName(await commitRefs(), target.sha)} to ${context.environment}?`, default: true }))) {
      console.warn(`${warningMark} No deploy is started: the machines hold what the rotation replaced until "${menuPath('deploy-now')}" runs one.`);
      return;
    }
  }
  if (!target) {
    console.warn(
      `${warningMark} ${context.environment} has no line in ${ENVIRONMENTS_FILE}, so no deploy replaces its machines: they hold what the rotation replaced.`,
    );
    return;
  }
  await startJobRun(auth, { region, definitionId, values: { TARGET_SHA: target.sha, RETRY: String(target.retry) } });
  console.info(`${checkMark} Deploying ${commitName(await commitRefs(), target.sha)}.`);
}

/**
 * Whether the target has a run under its retry counter, which no scheduled run starts again (`decideScheduledRun`), said in one line: the
 * environment then stays on the live commit by default, as a rollback by hand left it. Runs that cannot be read count as one: a rotation
 * never undoes a rollback it could not see.
 */
async function targetHasRun(context: InfraContext, key: KeyPair, live: string, target: Target): Promise<boolean> {
  const [refs, records] = await Promise.all([
    commitRefs(),
    bootDiagOn(context, key)
      .then((diag) => commitRecords(diag.store, target.sha))
      .catch((error: unknown) => ({ error: errorMessage(error) })),
  ]);
  const [liveName, targetName] = [commitName(refs, live), commitName(refs, target.sha)];
  const verdict = rotationTarget(target, records);
  if (verdict.action === 'start') return false;
  if ('unread' in verdict) {
    console.warn(
      `${warningMark} The runs of ${targetName} could not be read (${verdict.unread}): by default ${context.environment} stays on ${liveName}.`,
    );
    return true;
  }
  console.info(
    `${checkMark} ${targetName} has run ${printable(verdict.record.run)} (${printable(verdict.record.outcome)}): by default ${context.environment} stays on ${liveName}.`,
  );
  return true;
}

/**
 * Start the environment's main job again for the target whose last deploy ended blocked or apply needed, on the operator key: the apply,
 * or Env vars & secrets for a missing secret, does it at its end, as a scheduled run never starts a target and retry counter that have
 * a record. The last deploy is the newest record, or a newer job run started by hand that exited blocked and wrote no record. Nothing while a
 * deploy holds the lease, or when the last deploy ended otherwise; a target that moved on since is the schedule's. The lease decides, not
 * the run list: a scheduled run looks for seconds every cadence and deploys nothing. A start by hand still queued holds no lease, so the
 * target can deploy twice, and the second deploy ends unchanged.
 * @returns Whether it started a run.
 */
export async function startBlockedTarget(context: InfraContext, key: KeyPair): Promise<boolean> {
  const auth = { secretKey: key.secretKey };
  const { region } = deriveInfra(context.appConfig);
  const definitionId = await findMainJob(context, key);
  if (!definitionId) return false;
  const { store, control, bucket } = await bootDiagOn(context, key);
  const held = await peekLock(control, bucket, lockKey(context.environment));
  if (held && leaseLive(held) && leaseDeploys(held)) return false;
  const [newest] = await store.listRuns(1);
  const record = newest ? await store.currentRecord(newest) : undefined;
  const ended = (await listJobRuns(auth, { region, projectId: context.projectId, definitionId })).find(runEnded);
  const sha = ended?.environment_variables?.TARGET_SHA;
  const unrecorded = ended && sha && mainJobOutcome(ended) === 'blocked' && (!record || (ended.created_at ?? '') > record.startedAt);
  const last = unrecorded
    ? { target: sha, retry: ended.environment_variables?.RETRY ?? '0', outcome: 'blocked' }
    : record && (record.outcome === 'blocked' || record.outcome === 'apply needed')
      ? { target: record.target, retry: String(record.retry ?? 0), outcome: record.outcome }
      : undefined;
  if (!last) return false;
  await startJobRun(auth, { region, definitionId, values: { TARGET_SHA: last.target, RETRY: last.retry } });
  console.info(`${checkMark} The last deploy was ${last.outcome}: deploying ${commitName(await commitRefs(), last.target)} again.`);
  return true;
}

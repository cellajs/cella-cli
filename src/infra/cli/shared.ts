import { spawnSync } from 'node:child_process';
import type { EngineConfig } from '../lib/engine-config';
import { deriveInfra } from '../lib/naming';
import { actionCommand, menuPath, type OperatorActionId } from '../lib/operator-actions';
import type { KeyPair } from '../lib/scaleway/operator-identity';
import { allPrincipalNames } from '../lib/scaleway/principals';
import { buildProviderEnv } from '../lib/scaleway/provider-env';
import { controlActor, lockKey, makeControlClient, pruneLockVersions, stateBackendUrl, stateBucket } from '../lib/stack/control-store';
import type { StackContext } from '../lib/stack/stack-context';
import { acquireLease, installSignalRelease } from '../lib/stack/stack-lease';
import { crossMark, type Hint, hasPerson, pc, printFailureHint, warningMark } from '../lib/utils/cli-output';
import { errorMessage } from '../lib/utils/errors';
import { infraDir } from '../lib/utils/paths';
import { isPromptAbort } from './prompts/abort';
import { confirm, input, PromptBack } from './prompts/back';
import { inMenuSession, runEnvironment } from './session';

/** Stack information and state, passed to every CLI action handler. */
export interface InfraContext extends StackContext {
  hasCiKey: boolean;
}

/** What a failed action offers after it printed its failure. */
export interface EndOptions {
  /** The actions that fix the failure: a menu session offers each by its menu name, a single-action run prints its command. */
  fix?: OperatorActionId | readonly OperatorActionId[];
  /** The retry row's words, for a retry that does more than run the action again. */
  retry?: string;
  /** The operator already chose to leave from the ways out the action offered: nothing more is offered. */
  left?: boolean;
}

/**
 * Ends the running action after it printed its failure. It is thrown, and every `finally` on the way out runs: the menu then offers a retry
 * and the fixes, and a single-action run exits with `exitCode`.
 */
export class ActionEnded extends Error {
  readonly exitCode: number;
  readonly fix: readonly OperatorActionId[];
  readonly retry?: string;
  readonly left: boolean;

  constructor(exitCode: number, opts: EndOptions = {}) {
    super(`the action ended with exit code ${exitCode}`);
    this.name = 'ActionEnded';
    this.exitCode = exitCode;
    this.fix = opts.fix === undefined ? [] : typeof opts.fix === 'string' ? [opts.fix] : opts.fix;
    this.retry = opts.retry;
    this.left = opts.left === true;
  }
}

/** End the running action with `code` (see {@link ActionEnded}). Call it after printing what went wrong. */
export function endAction(code = 1, opts: EndOptions = {}): never {
  throw new ActionEnded(code, opts);
}

/** Print a failure with the command that recovers from it, then end the running action. */
export function endActionWithHint(message: string, hint: Hint, code = 1): never {
  printFailureHint(message, hint);
  return endAction(code);
}

/** True for the errors that end an action on purpose: the action ending itself, the operator's Ctrl-C and Esc. A catch-all lets them through. */
export function endsAction(error: unknown): boolean {
  return error instanceof ActionEnded || isPromptAbort(error) || error instanceof PromptBack;
}

/**
 * True when the run takes prompt defaults without asking: `--defaults`, a person on the fast path. A required input such as the Owner API
 * key is still asked, so the CLI never changes infrastructure without someone at the prompt.
 */
export const autoAcceptDefaults = (): boolean => process.argv.includes('--defaults');

/** True when the run asks a person for a choice that has a default: a person at a terminal, without `--defaults`. */
export function asksPerson(): boolean {
  return hasPerson() && !autoAcceptDefaults();
}

/** `confirm` that resolves to its default under `--defaults`; an `id` keeps the answer for a step back or a retry. */
export async function confirmOrDefault(opts: { message: string; default: boolean; id?: string }): Promise<boolean> {
  if (autoAcceptDefaults()) {
    console.info(pc.dim(`  [defaults] ${opts.message} -> ${opts.default ? 'yes' : 'no'}`));
    return opts.default;
  }
  return confirm(opts);
}

/** Optional free-text `input` that resolves to its default under `--defaults`. */
export async function inputOrDefault(opts: { message: string; default?: string }): Promise<string> {
  if (autoAcceptDefaults()) {
    const value = opts.default ?? '';
    console.info(pc.dim(`  [defaults] ${opts.message} -> ${value || '<empty>'}`));
    return value;
  }
  return input({ message: opts.message, default: opts.default });
}

/** The stack name every action targets, derived from the mode on the DIY backend: `organization/infra/<mode>`. Never prompted. */
export function stackNameFor(context: Pick<InfraContext, 'environment'>): string {
  return `organization/infra/${context.environment}`;
}

/** S3-backend login URL for the app's Pulumi state bucket. */
export function pulumiLoginUrl(appConfig: EngineConfig): string {
  return stateBackendUrl(stateBucket(appConfig.slug), appConfig.s3.region);
}

/** `pulumi login` (ends the action on failure) plus a best-effort `pulumi stack select` against the S3 state backend; the caller may still be about to init the stack. */
function pulumiLoginAndSelect(env: NodeJS.ProcessEnv, appConfig: EngineConfig, targetStack: string): void {
  const login = spawnSync('pulumi', ['login', pulumiLoginUrl(appConfig)], { cwd: infraDir, env, stdio: 'inherit' });
  if (login.status !== 0) {
    const names = allPrincipalNames(appConfig, appConfig.mode);
    console.error(
      `${crossMark} pulumi login failed (exit ${login.status}). The state bucket admits the '${names.operator}', '${names.observer}' and '${names.ciDeploy}' applications, and a key made for another project reaches it only as \`<access key>@<project id>\`.`,
    );
    endAction(login.status ?? 1);
  }
  spawnSync('pulumi', ['stack', 'select', targetStack], { cwd: infraDir, env, stdio: 'ignore' });
}

/**
 * Open the environment's stack on `key`: its name, and the provider env (lib/scaleway/provider-env.ts) logged in to the state backend with
 * the stack selected. The key's organization id, when it carries one, reaches the provider. Ends the action when the login fails.
 */
export function openStack(
  context: Pick<InfraContext, 'appConfig' | 'environment' | 'projectId'>,
  key: KeyPair & { organizationId?: string },
): { stack: string; env: Record<string, string> } {
  const stack = stackNameFor(context);
  const env = buildProviderEnv(infraDir, { ...key, projectId: context.projectId, stateBackendUrl: pulumiLoginUrl(context.appConfig) });
  pulumiLoginAndSelect(env, context.appConfig, stack);
  return { stack, env };
}

/** Handle to a held stack lease; `release` logs failures, never throws, and does nothing on a second call. */
export interface StackLockHandle {
  release: () => Promise<void>;
  /** True once a renewal found the lock taken by another run: nothing may change after that. */
  readonly lost: boolean;
}

/** The leases this process holds, so an action that ends without releasing its own cannot leave the environment leased under the menu. */
const heldLocks = new Set<StackLockHandle>();

/**
 * Release every stack lease still held and report how many there were. The menu calls it after each action: a lease renews itself for as
 * long as the process lives, so one that outlived its action would keep the environment leased until the operator quits.
 */
export async function releaseHeldLocks(): Promise<number> {
  const leftover = [...heldLocks];
  for (const handle of leftover) await handle.release();
  return leftover.length;
}

/** An ISO moment as `HH:MM UTC`, for a line that says since when. */
function utcTime(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

/** How long an operator run waits for another holder's lease to lapse: longer than one lifetime, so a dead run always frees the stack in time. */
const operatorLockWaitMs = 5 * 60_000;

/**
 * Take the environment's lease (`control/<mode>/lock.json` in its boot-diag bucket) so a second operator or a deploy cannot change it concurrently. A live lock held by someone else is waited out (a dead
 * run's lease lapses within minutes); a holder that keeps renewing wins, and the action ends pointing at the unlock action.
 * The lease renews itself while held and is released on Ctrl-C, so an interrupted run leaves nothing behind.
 */
export async function acquireStackLockOrEnd(opts: {
  appConfig: EngineConfig;
  accessKey: string;
  secretKey: string;
  stack: string;
  operation: string;
  ttlMs?: number;
  /** What a refusal says has become of the action, for one that changed something before it took the lease; "Nothing was changed." by default. */
  refusal?: string;
}): Promise<StackLockHandle> {
  const s3 = await makeControlClient(opts.appConfig.s3.region, opts.accessKey, opts.secretKey);
  const bucket = deriveInfra(opts.appConfig).naming.bootDiagBucket;
  const key = lockKey(opts.stack);
  // Only a person's key deletes versions here, and a lease of too many takes no write from an operator or from a deploy.
  const pruned = await pruneLockVersions(s3, bucket, key).catch((error: unknown) => {
    console.warn(`${warningMark} The lease's old versions could not be deleted (${errorMessage(error)}).`);
    return 0;
  });
  if (pruned >= 1000) console.info(pc.dim(`  Deleted ${pruned} old versions of the lease, which Scaleway refuses writes over.`));
  let lastWaitLine = 0;
  const result = await acquireLease({
    s3,
    bucket,
    key,
    owner: controlActor(),
    operation: opts.operation,
    ttlMs: opts.ttlMs,
    waitMs: operatorLockWaitMs,
    onWait: (held, remainingMs) => {
      if (Date.now() - lastWaitLine < 30_000) return;
      lastWaitLine = Date.now();
      console.info(
        `${warningMark} Another run holds the lease of ${opts.stack}: ${pc.cyan(held.owner)} (${held.operation}), since ${utcTime(held.acquiredAt)}.`,
      );
      console.info(pc.dim(`  One deploy or action runs at a time. Waiting up to ${Math.ceil(remainingMs / 60_000)} min for it to end…`));
    },
    onRenewFailed: (reason, lost) =>
      console.warn(`${warningMark} stack lease renewal failed (${reason})${lost ? ': this run no longer holds the lock' : ''}`),
  });
  if (!result.acquired) {
    const { owner, operation, acquiredAt } = result.held;
    console.error(
      `${crossMark} ${pc.cyan(owner)} still holds the lease of ${opts.stack} (${operation}, since ${utcTime(acquiredAt)}). ${opts.refusal ?? 'Nothing was changed.'}`,
    );
    console.error(pc.dim(`  A run that died lets go within minutes. ${pointTo('unlock')} clears one that did not, or remove s3://${bucket}/${key}.`));
    endAction(1, { fix: 'unlock', retry: 'Wait 5 more minutes' });
  }
  const uninstall = installSignalRelease(result.lease, { log: (msg) => console.warn(`${warningMark} ${msg}`) });
  const handle: StackLockHandle = {
    release: async () => {
      if (!heldLocks.delete(handle)) return;
      uninstall();
      await result.lease.release().catch((e) => console.warn(`${warningMark} failed to release lease: ${errorMessage(e)}`));
    },
    get lost() {
      return result.lease.lost;
    },
  };
  heldLocks.add(handle);
  return handle;
}

/**
 * Where a message sends the operator for an action: its menu name when the menu shows (a menu session), the command a single-action run
 * types. The command names this run's environment: typed without `--mode`, it would run on the one stack file an app may have.
 */
export function pointTo(id: OperatorActionId, menu = inMenuSession()): string {
  if (menu) return `"${menuPath(id)}"`;
  const environment = runEnvironment();
  return `\`${actionCommand(id)}${environment ? ` --mode ${environment}` : ''}\``;
}

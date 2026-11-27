import { errorMessage } from '../../lib/utils/errors';
import { isRecord } from '../../lib/utils/guards';
import { appDir, profileArgs } from './boot';
import { type ExecFn, mustExec } from './exec';
import type { AgentState } from './health';
import type { BootPlan } from './plan';

/**
 * Docker's checks of a container in a row that got no answer before the agent restarts it. Docker checks plain `/health` every 5 s with a
 * 5 s timeout (compose/infrastructure.ts): three silent checks are about half a minute in which the process answered nothing at all.
 */
export const silentChecksBeforeRestart = 3;

/** The window in which restarts of one container count towards {@link maxRestartsPerWindow}. */
export const restartWindowMs = 60 * 60_000;

/** Restarts of one container within the window: a container that needs one more is left as it is from then on. */
export const maxRestartsPerWindow = 3;

/** The wait after a restart before the next one, doubled by each restart in the window. */
export const restartBackoffMs = 2 * 60_000;

/** Docker's exit code for a check it ended at its timeout or could not run. An error answer, such as a 503 while a dependency is away, exits 1. */
const noAnswer = -1;

/** Seconds a restart lets the stop signal work before Docker kills the process: one that answered no check handles no signal either. */
const restartStopSeconds = 10;

/** Ceiling on the docker calls of a watch round. */
const dockerCallSeconds = 60;

/** One app container as Docker reports it, times in milliseconds. */
export interface ContainerReading {
  id: string;
  name: string;
  /** Docker's state: `running`, `paused`, `restarting`, `exited` and the rest. */
  status: string;
  /** When the container's current run started. */
  startedAt: number;
  /** `no` for a container the machine's unit supervises or a one-shot release companion. */
  restartPolicy: string;
  /** Docker's health state and its last checks, oldest first, which it keeps across a restart; undefined without a healthcheck. */
  health?: { status: string; checks: { start: number; exitCode: number; output: string }[] };
}

/** What the agent did to one container: when it restarted it, and whether it gave up on it. */
export interface RestartRecord {
  restarts: number[];
  gaveUp: boolean;
  /** The end of the backoff last logged, so a deferral is logged once. */
  deferredUntil?: number;
}

export type RestartVerdict =
  | { act: 'none' }
  | { act: 'restart'; silentChecks: number; restart: number }
  | { act: 'defer'; until: number }
  | { act: 'give-up'; restarts: number };

/** The checks since the container's start that got no answer, counted back from the last. */
function silentChecks(container: ContainerReading): number {
  const checks = container.health?.checks ?? [];
  let count = 0;
  for (let index = checks.length - 1; index >= 0; index--) {
    const check = checks[index];
    if (!check || check.start < container.startedAt || check.exitCode !== noAnswer) break;
    count++;
  }
  return count;
}

/**
 * Whether the agent restarts a container now: one that runs, that Docker marks unhealthy (only past its start period), and whose last
 * {@link silentChecksBeforeRestart} checks since its start got no answer at all. One that answers with an error, as one whose dependency
 * is away, is left. Never before the boot completed or once a drain began, never a container whose restart policy is `no`, and never one
 * given up on. A restart waits out the backoff, and a container that needs more than {@link maxRestartsPerWindow} is given up.
 */
export function restartVerdict(container: ContainerReading, record: RestartRecord, agent: AgentState, now: number): RestartVerdict {
  if (!agent.booted || agent.draining || record.gaveUp) return { act: 'none' };
  if (container.restartPolicy === 'no' || container.status !== 'running' || container.health?.status !== 'unhealthy') return { act: 'none' };
  const silent = silentChecks(container);
  if (silent < silentChecksBeforeRestart) return { act: 'none' };
  const recent = record.restarts.filter((at) => now - at < restartWindowMs);
  if (recent.length >= maxRestartsPerWindow) return { act: 'give-up', restarts: recent.length };
  const last = recent.at(-1);
  if (last !== undefined) {
    const until = last + restartBackoffMs * 2 ** (recent.length - 1);
    if (now < until) return { act: 'defer', until };
  }
  return { act: 'restart', silentChecks: silent, restart: recent.length + 1 };
}

/** What a watch round does outside this module, so a test passes its own. */
export interface WatchEffects {
  /** The machine's app containers as Docker reports them. */
  readContainers(): Promise<ContainerReading[]>;
  /** Restart one container in place, by its id: its own logs and Docker's health log stay. */
  restartContainer(id: string): Promise<void>;
  now(): number;
  log(step: string, fields?: Record<string, string | number | boolean>): void;
}

/**
 * One watch round: read the app containers, and restart each that {@link restartVerdict} says to, one at a time. Each restart, deferral
 * and give-up is a log line naming the container. `records` keeps what the agent did, by container name, for as long as the agent runs.
 */
export async function watchContainers(fx: WatchEffects, agent: AgentState, records: Map<string, RestartRecord>): Promise<void> {
  let containers: ContainerReading[];
  try {
    containers = await fx.readContainers();
  } catch (error) {
    fx.log('containers-unread', { message: errorMessage(error) });
    return;
  }
  for (const container of containers) {
    const record = records.get(container.name) ?? { restarts: [], gaveUp: false };
    records.set(container.name, record);
    const now = fx.now();
    const verdict = restartVerdict(container, record, agent, now);
    if (verdict.act === 'defer' && record.deferredUntil !== verdict.until) {
      record.deferredUntil = verdict.until;
      fx.log('restart-deferred', { container: container.name, until: new Date(verdict.until).toISOString() });
    } else if (verdict.act === 'give-up') {
      record.gaveUp = true;
      fx.log('restart-given-up', { container: container.name, restarts: verdict.restarts, window_minutes: restartWindowMs / 60_000 });
    } else if (verdict.act === 'restart') {
      record.restarts.push(now);
      const check = container.health?.checks.at(-1)?.output ?? '';
      fx.log('restart', {
        container: container.name,
        restart: verdict.restart,
        of: maxRestartsPerWindow,
        silent_checks: verdict.silentChecks,
        check,
      });
      await fx
        .restartContainer(container.id)
        .catch((error: unknown) => fx.log('restart-failed', { container: container.name, message: errorMessage(error) }));
    }
  }
}

/** The fields of `docker inspect` a watch round reads, one JSON object a line: the state alone, never the environment, which holds secrets. */
const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"state":{{json .State}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}}}';

const unexpected = (line: string) => new Error(`docker inspect: unexpected line ${line.slice(0, 200)}`);

/** One line of {@link inspectFormat} as a reading. */
function parseContainerLine(line: string): ContainerReading {
  const raw: unknown = JSON.parse(line);
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.restartPolicy !== 'string') throw unexpected(line);
  const state = raw.state;
  if (!isRecord(state) || typeof state.Status !== 'string' || typeof state.StartedAt !== 'string') throw unexpected(line);
  const reading: ContainerReading = {
    id: raw.id,
    name: raw.name.replace(/^\//, ''),
    status: state.Status,
    startedAt: Date.parse(state.StartedAt),
    restartPolicy: raw.restartPolicy,
  };
  const health = state.Health;
  if (health === undefined || health === null) return reading;
  if (!isRecord(health) || typeof health.Status !== 'string' || !Array.isArray(health.Log)) throw unexpected(line);
  const checks = health.Log.map((check: unknown) => {
    if (!isRecord(check) || typeof check.Start !== 'string' || typeof check.ExitCode !== 'number') throw unexpected(line);
    return { start: Date.parse(check.Start), exitCode: check.ExitCode, output: typeof check.Output === 'string' ? check.Output.slice(0, 200) : '' };
  });
  return { ...reading, health: { status: health.Status, checks } };
}

/** The containers of the plan's services in the Compose project at `dir`, the stopped ones included, as Docker reports them. */
export async function readContainers(exec: ExecFn, plan: Pick<BootPlan, 'services'>, dir = appDir): Promise<ContainerReading[]> {
  const timeoutMs = dockerCallSeconds * 1000;
  const listed = await mustExec(exec, 'docker', ['compose', ...profileArgs(plan), 'ps', '--all', '--quiet', ...plan.services], {
    cwd: dir,
    timeoutMs,
  });
  const ids = listed.stdout.split('\n').filter((id) => id.trim() !== '');
  if (ids.length === 0) return [];
  const inspected = await mustExec(exec, 'docker', ['inspect', '--format', inspectFormat, ...ids], { timeoutMs });
  return inspected.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseContainerLine);
}

/** Restart a container in place: Docker sends its stop signal, kills it after {@link restartStopSeconds}, and starts it again. */
export async function restartContainer(exec: ExecFn, id: string): Promise<void> {
  await mustExec(exec, 'docker', ['restart', '--timeout', String(restartStopSeconds), id], {
    timeoutMs: (restartStopSeconds + dockerCallSeconds) * 1000,
  });
}

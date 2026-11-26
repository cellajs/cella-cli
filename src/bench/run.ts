import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import pc from '../utils/colors';
import { type BaselineEntry, loadBaseline, runnerEpoch, saveBaseline } from './baseline';
import { evaluateChecks } from './checks';
import { counted, createHttpClient, errorCode } from './http';
import { type Distribution, type EndpointSummary, Metrics } from './metrics';
import { compactLine, LiveDisplay, liveLines, type Output, type SummaryView, summaryLines } from './report';
import { play, roleSequencer, type ScheduleEvent, schedule } from './scheduler';
import { readSse } from './sse';
import { type CheckResult, type Phase, type RunOutcome, type Scenario, splitMetricKey, type Vu, type VuClient, type VuFn } from './types';

const defaultIntervalMs = 5000;
const lagWarnMs = 50;
/** The loop-delay sampler's period: it records whole periods, so an idle loop reads this much. */
const lagResolutionMs = 10;
const defaultDrainTimeoutSeconds = 300;
/** Seconds an aborted VU gets to unwind before the run reports without it. */
const abortGraceSeconds = 5;
/** Logs kept per scenario; older ones are deleted. */
const logsKept = 30;

interface RunOptions {
  /** Scenario name: labels the output, the log file and the baseline history. */
  name: string;
  /** Base URL that relative request paths join. */
  target: string;
  /** Holds `baselines/` and `logs/`. */
  dataDir: string;
  short?: boolean;
  /** Milliseconds of network round trip every request and stream of the run emulates; 0 when unset. */
  rttMs?: number;
  /** One result line at the end, no full summary. */
  quiet?: boolean;
  /** The app's own checks of what the run did, after the load stopped. */
  afterRun?: (outcome: RunOutcome) => Promise<CheckResult[]>;
  /** Where the live display and the summary go; stdout when unset. */
  output?: Output;
}

export interface RunSummary {
  type: 'summary';
  runner: typeof runnerEpoch;
  scenario: string;
  startedAt: string;
  durationS: number;
  short: boolean;
  rttMs: number;
  vus: { created: number; completed: number; failed: number };
  requests: number;
  requestRate: number;
  http: Distribution | null;
  endpoints: Record<string, EndpointSummary>;
  histograms: Record<string, Distribution>;
  counters: Record<string, number>;
  errors: Record<string, { count: number; message: string }>;
  checks: CheckResult[];
  generatorLagP99MaxMs: number;
  attachments: Record<string, unknown>;
}

interface RunResult {
  ok: boolean;
  summary: RunSummary;
  /** This run's numbers in baseline shape, also for a run that failed or was short. */
  current: BaselineEntry;
  /** The entry this run was compared against; null when none of this runner epoch exists. */
  baseline: BaselineEntry | null;
  logFile: string;
}

/** Identity: types a scenario module and checks its counter and histogram names, nothing at runtime. */
export function defineScenario<const C extends string = never, const H extends string = never>(scenario: Scenario<C, H>): Scenario<C, H> {
  return scenario;
}

type AnyScenario = Scenario<string, string>;

interface Plan {
  events: ScheduleEvent[] | Generator<ScheduleEvent>;
  phases: Phase[];
  plannedS: number | null;
  pick: () => { role: string | null; fn: VuFn<string, string> };
}

/** The arrivals of a run: the scenario's phases; one VU for `run`; in short mode one VU per role. */
function plan(scenario: AnyScenario, short: boolean): Plan {
  if (scenario.run) {
    const fn = scenario.run;
    return {
      events: [
        { kind: 'phase', at: 0, phase: 0 },
        { kind: 'arrival', at: 0, phase: 0 },
      ],
      phases: [{ name: 'run', duration: 0 }],
      plannedS: null,
      pick: () => ({ role: null, fn }),
    };
  }
  const roles = scenario.roles ?? [{ name: '', weight: 1, vu: scenario.vu }];
  if (roles.some((role) => !(role.weight > 0))) throw new Error('every role needs a weight above 0');
  let i = 0;
  const next = short ? () => roles[i++ % roles.length] : roleSequencer(roles);
  const pick = () => {
    const role = next();
    return { role: scenario.roles ? role.name : null, fn: role.vu };
  };
  if (short) {
    const events: ScheduleEvent[] = [{ kind: 'phase', at: 0, phase: 0 }, ...roles.map((): ScheduleEvent => ({ kind: 'arrival', at: 0, phase: 0 }))];
    return { events, phases: [{ name: 'smoke', duration: 1 }], plannedS: 1, pick };
  }
  const plannedS = scenario.phases.reduce((sum, phase) => sum + phase.duration, 0);
  return { events: schedule(scenario.phases), phases: scenario.phases, plannedS, pick };
}

function logFileFor(dataDir: string, name: string, startedAt: Date): string {
  const dir = join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const old = readdirSync(dir)
    .filter((file) => file.startsWith(`${name}-`) && file.endsWith('.jsonl'))
    .sort();
  for (const file of old.slice(0, Math.max(0, old.length - logsKept + 1))) rmSync(join(dir, file), { force: true });
  return join(dir, `${name}-${startedAt.toISOString().slice(0, 19).replaceAll(':', '-')}.jsonl`);
}

function phaseText(phase: Phase): string {
  if (phase.arrivalCount !== undefined) return `${phase.arrivalCount} VUs over ${phase.duration}s`;
  const rate = phase.arrivalRate ?? 0;
  if (phase.rampTo !== undefined && phase.rampTo !== rate) return `${rate} → ${phase.rampTo}/s over ${phase.duration}s`;
  return `${rate}/s for ${phase.duration}s`;
}

/** What the VUs, the ticker and the drain of one run share. */
interface RunState {
  metrics: Metrics;
  stop: AbortController;
  rttMs: number;
  display: LiveDisplay;
  phaseName: string;
  /** VUs started and not settled. */
  active: number;
  /** Called when `active` drops to 0. */
  onIdle: (() => void) | null;
  attachments: Record<string, unknown>;
  /** The first message of each error that failed a VU. */
  errors: Record<string, { message: string }>;
}

/** Starts one VU of `fn`: it counts as created, then completed or failed, and closes its clients' connections when it settles. */
function launch(state: RunState, fn: VuFn<string, string>, vu: Pick<Vu<string, string>, 'index' | 'role' | 'short'>, target: string): void {
  const { metrics, stop, display, rttMs } = state;
  const resolveUrl = (url: string) => (/^[a-z]+:\/\//.test(url) ? url : `${target}${url}`);
  // A stream the VU left open ends with it: an open one would keep the process from exiting.
  const ended = new AbortController();
  const streamSignal = AbortSignal.any([stop.signal, ended.signal]);
  const sse: VuClient['sse'] = (url, onEvent, sseOptions = {}) => readSse(resolveUrl(url), onEvent, sseOptions, metrics, streamSignal, rttMs);
  const clients: ReturnType<typeof createHttpClient>[] = [];
  const client = (): VuClient => {
    const http = createHttpClient(target, metrics, stop.signal, rttMs);
    clients.push(http);
    return { http, sse };
  };
  const own = client();
  metrics.counter('vusers.created');
  state.active++;
  Promise.resolve()
    .then(() =>
      fn({
        ...vu,
        ...own,
        signal: stop.signal,
        client,
        think: (thinkMs) => delay(thinkMs, undefined, { signal: stop.signal }),
        counter: (counter, n) => metrics.counter(counter, n),
        histogram: (histogram, value) => metrics.histogram(histogram, value),
        log: (text) => display.log(text),
        attach: (key, data) => {
          state.attachments[key] = data;
        },
      }),
    )
    .then(
      () => metrics.counter('vusers.completed'),
      (error: unknown) => {
        metrics.counter('vusers.failed');
        const code = stop.signal.aborted ? 'aborted' : errorCode(error);
        if (!(error as { [counted]?: boolean })?.[counted] || stop.signal.aborted) metrics.counter(`errors.${code}`);
        state.errors[code] ??= { message: error instanceof Error ? error.message : String(error) };
      },
    )
    .finally(async () => {
      ended.abort();
      await Promise.all(clients.map((http) => http.close()));
      state.active--;
      if (state.active === 0) state.onIdle?.();
    });
}

/**
 * A ticker for the live display: each tick logs the interval and renders its line, and warns once when the
 * generator's event loop lags. `finish` stops the sampler and returns the worst lag and the warning.
 */
function liveTicker(
  state: RunState,
  scenario: AnyScenario,
  { name, plannedS, log }: { name: string; plannedS: number | null; log: (entry: object) => void },
) {
  const { metrics, display } = state;
  const declared = new Set<string>(scenario.counters ?? []);
  const { name: primaryName } = splitMetricKey(scenario.primary ?? 'http.response_time.p95');
  const lag = monitorEventLoopDelay({ resolution: lagResolutionMs });
  lag.enable();
  let lagP99Max = 0;
  let lagWarning: string | null = null;
  const started = performance.now();
  let lastTick = started;

  const tick = () => {
    const now = performance.now();
    const intervalS = (now - lastTick) / 1000;
    lastTick = now;
    const { counters, histograms } = metrics.tick();
    const lagP99 = Math.max(0, lag.percentile(99) / 1e6 - lagResolutionMs);
    lag.reset();
    lagP99Max = Math.max(lagP99Max, lagP99);
    const elapsedS = (now - started) / 1000;
    if (lagP99 > lagWarnMs && !lagWarning) {
      lagWarning = `generator event-loop lag p99 ${Math.round(lagP99)} ms (over ${lagWarnMs} ms): the load generator is saturated, latencies include its own queueing`;
      display.log(`  ⚠ ${lagWarning}`);
    }
    const custom = Object.entries(counters).filter(([counter, n]) => declared.has(counter) && n > 0);
    const primary = primaryName.startsWith('http.') ? undefined : histograms[primaryName];
    const vus = {
      started: counters['vusers.created'] ?? 0,
      active: state.active,
      completed: metrics.get('vusers.completed'),
      failed: metrics.get('vusers.failed'),
    };
    log({
      type: 'interval',
      t: Math.round(elapsedS * 10) / 10,
      phase: state.phaseName,
      vus,
      counters,
      histograms,
      lagP99Ms: lagP99,
    });
    display.render(
      liveLines({
        scenario: name,
        phase: state.phaseName,
        rttMs: state.rttMs,
        elapsedS,
        plannedS,
        vus,
        intervalS: Math.max(intervalS, 0.001),
        counters,
        http: histograms['http.response_time'],
        primary: primary && { name: primaryName, distribution: primary },
        custom,
        lagP99,
      }),
    );
  };
  const ticker = setInterval(tick, defaultIntervalMs);
  return {
    finish: () => {
      clearInterval(ticker);
      tick();
      lag.disable();
      return { lagP99Max, lagWarning, durationS: (performance.now() - started) / 1000 };
    },
  };
}

/** Waits for the VUs in flight after the last arrival; past the scenario's drain timeout it aborts them. */
async function drain(state: RunState, scenario: AnyScenario): Promise<void> {
  if (state.active === 0) return;
  if (!scenario.run) state.phaseName = 'drain';
  const drainS = scenario.drainTimeout ?? (scenario.run ? Number.POSITIVE_INFINITY : defaultDrainTimeoutSeconds);
  const idle = new Promise<void>((resolve) => {
    state.onIdle = resolve;
  });
  // The timers are cancelled once the VUs are done: a pending one would keep the process alive.
  const timers = new AbortController();
  const wait = (seconds: number) => delay(seconds * 1000, 'timeout' as const, { signal: timers.signal }).catch(() => null);
  const timedOut = Number.isFinite(drainS) ? wait(drainS) : new Promise<never>(() => {});
  if ((await Promise.race([idle, timedOut])) === 'timeout') {
    state.display.log(`  ⚠ ${state.active} VUs still running after ${drainS} s: aborted`);
    state.stop.abort();
    await Promise.race([idle, wait(abortGraceSeconds)]);
  }
  timers.abort();
}

/** This run's numbers in baseline shape. */
function baselineEntry(
  metrics: Metrics,
  distributions: Record<string, Distribution>,
  { name, startedAt, durationS, primaryKey, rttMs }: { name: string; startedAt: Date; durationS: number; primaryKey: string; rttMs: number },
): BaselineEntry {
  const requests = metrics.get('http.requests');
  const http = distributions['http.response_time'];
  const { name: primaryName, stat: primaryStat } = splitMetricKey(primaryKey);
  return {
    runner: runnerEpoch,
    timestamp: startedAt.toISOString(),
    scenario: name,
    rttMs,
    requests,
    requestRate: Math.round((requests / durationS) * 10) / 10,
    mean: http?.mean ?? 0,
    p50: http?.p50 ?? 0,
    p95: http?.p95 ?? 0,
    p99: http?.p99 ?? 0,
    errors: [...metrics.counters].reduce((sum, [counter, n]) => (counter.startsWith('errors.') ? sum + n : sum), 0),
    vusersCreated: metrics.get('vusers.created'),
    vusersFailed: metrics.get('vusers.failed'),
    primary: { metric: primaryKey, value: primaryStat ? (distributions[primaryName]?.[primaryStat] ?? 0) : 0 },
    endpoints: Object.fromEntries(
      Object.entries(metrics.endpointSummaries()).map(([label, e]) => [
        label,
        {
          requests: e.requests,
          p50: e.ttfb.p50,
          p95: e.ttfb.p95,
          p99: e.ttfb.p99,
          nonOk: e.nonOk,
          timeouts: e.timeouts,
        },
      ]),
    ),
  };
}

/**
 * Runs a scenario: arrivals in an open loop, a live line every interval, then the checks (the scenario's, then the
 * app's `afterRun`), the summary, a baseline comparison, and for a passing full run a new baseline entry. Every
 * interval and the summary go to a JSONL log.
 */
export async function runScenario(scenario: AnyScenario, options: RunOptions): Promise<RunResult> {
  const { name, target, dataDir, short = false, quiet = false, rttMs = 0 } = options;
  const output = options.output ?? process.stdout;
  const startedAt = new Date();
  const logFile = logFileFor(dataDir, name, startedAt);
  const log = (entry: object) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  const { events, phases, plannedS, pick } = plan(scenario, short);
  const primaryKey = scenario.primary ?? 'http.response_time.p95';
  const showPhases = !(quiet && output.isTTY);
  const state: RunState = {
    metrics: new Metrics(),
    stop: new AbortController(),
    rttMs,
    display: new LiveDisplay(Boolean(output.isTTY), output),
    phaseName: phases[0]?.name ?? '',
    active: 0,
    onIdle: null,
    attachments: {},
    errors: {},
  };
  const { metrics, display } = state;

  if (!quiet) display.log(`${pc.dim('▸')} running ${name}${short ? ' (short)' : ''}: ${scenario.description}`);
  const ticker = liveTicker(state, scenario, { name, plannedS, log });
  let index = 0;
  await play(
    events,
    (event) => {
      if (event.kind === 'arrival') {
        const { role, fn } = pick();
        return launch(state, fn, { index: index++, role, short }, target);
      }
      state.phaseName = phases[event.phase].name;
      if (showPhases && !scenario.run && !short) display.log(`  ${pc.dim('phase')} ${state.phaseName} · ${phaseText(phases[event.phase])}`);
    },
    state.stop.signal,
  );
  await drain(state, scenario);
  const { lagP99Max, lagWarning, durationS } = ticker.finish();

  const counters = Object.fromEntries(metrics.counters);
  const distributions = Object.fromEntries(
    metrics.histogramNames().flatMap((histogram) => {
      const d = metrics.distribution(histogram);
      return d ? [[histogram, d]] : [];
    }),
  );
  const checks = evaluateChecks(scenario.checks ?? {}, { counters, distributions, short });
  if (options.afterRun) {
    display.render([`${name} ${pc.dim('· checking what the app recorded')}`]);
    const rejected = checks.some((check) => check.id === 'responses' && !check.ok);
    checks.push(...(await options.afterRun({ counters, checks: [...checks], rejected, short })));
  }
  display.clear();
  const ok = checks.every((check) => check.ok);

  const current = baselineEntry(metrics, distributions, { name, startedAt, durationS, primaryKey, rttMs });
  const { baseline, older } = short ? { baseline: null, older: 0 } : loadBaseline(dataDir, name, rttMs);
  const saved = !short && ok ? saveBaseline(dataDir, current) : null;
  const summary: RunSummary = {
    type: 'summary',
    runner: runnerEpoch,
    scenario: name,
    startedAt: startedAt.toISOString(),
    durationS,
    short,
    rttMs,
    vus: { created: current.vusersCreated, completed: metrics.get('vusers.completed'), failed: current.vusersFailed },
    requests: current.requests,
    requestRate: current.requestRate,
    http: distributions['http.response_time'] ?? null,
    endpoints: metrics.endpointSummaries(),
    histograms: Object.fromEntries(Object.entries(distributions).filter(([histogram]) => !histogram.startsWith('http.'))),
    counters,
    errors: Object.fromEntries(
      Object.entries(counters).flatMap(([counter, n]) =>
        counter.startsWith('errors.') ? [[counter.slice(7), { count: n, message: state.errors[counter.slice(7)]?.message ?? '' }]] : [],
      ),
    ),
    checks,
    generatorLagP99MaxMs: lagP99Max,
    attachments: state.attachments,
  };
  log(summary);

  const view: SummaryView = {
    ...summary,
    counters: Object.entries(counters).filter(([counter]) => !/^(vusers|http|errors)\./.test(counter)),
    compared: !short && ok,
    baseline,
    olderBaselines: older,
    current,
    saved,
    logFile,
    lagWarning,
  };
  if (quiet) display.log(compactLine(view));
  else for (const line of ['', ...summaryLines(view), '']) display.log(line);

  return { ok, summary, current, baseline: ok ? baseline : null, logFile };
}

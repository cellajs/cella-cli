import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { select } from '@inquirer/prompts';
import pc from '../../utils/colors';
import { createSpinner, MENU_DIVIDER, printStep, spinnerFail, warningMark } from '../../utils/display';
import { getEnv } from '../../utils/env';
import { errorMessage } from '../../utils/errors';
import { acquireLock } from './lock';
import { type SuiteRow, suiteLines } from './report';
import { BENCH_REQUEST_ENV, type BenchRequest } from './request';
import { runScenario } from './run';
import type { CheckResult, Scenario } from './types';

/** After a saturating scenario, a 5 s pause left sse-fanout's p95 ten times higher. */
const DEFAULT_COOLDOWN_S = 15;

/** What a scenario's run left for the app to check. */
export interface RunOutcome {
  counters: Record<string, number>;
  /** The runner's checks: a run whose responses were rejected may skip the app's. */
  checks: CheckResult[];
  short: boolean;
}

export interface AppChecks {
  checks: CheckResult[];
  /** Cells of the `--all` table by column name. */
  columns?: Record<string, string>;
}

/** The app's side of a bench run: the stack it measures and its hooks around the scenarios. */
export interface Bench<State = undefined> {
  /** Base URL that relative request paths join; one run at a time holds it. */
  target: string;
  /** Waits for the stack to answer; throws what is missing. */
  preflight?: () => Promise<void>;
  /** Writes the data the scenarios read, unless `--skip-seed`. */
  seed?: () => Promise<void>;
  /** After the seed, and with `--skip-seed` too: a throw stops the run before anything is measured. */
  beforeAll?: (options: { skipSeed: boolean }) => Promise<void>;
  /** Before each scenario; what it returns reaches `afterEach`. */
  beforeEach?: (scenario: string) => Promise<State>;
  /** The app's checks of what the stack did with a scenario's load. `state` is undefined without `beforeEach`. */
  afterEach?: (outcome: RunOutcome, state: State | undefined) => Promise<AppChecks>;
  /** Seconds between the full runs of `--all`; 15 when unset. */
  cooldownSeconds?: number;
}

function readRequest(): BenchRequest {
  const raw = getEnv(BENCH_REQUEST_ENV);
  if (!raw) throw new Error('this is the app side of `pnpm cella bench`: run that instead');
  return JSON.parse(raw);
}

const isScenario = (value: unknown): value is Scenario =>
  typeof value === 'object' && value !== null && 'description' in value && typeof value.description === 'string';

async function loadScenario(dir: string, name: string): Promise<Scenario> {
  const { default: scenario } = await import(pathToFileURL(join(dir, `${name}.ts`)).href);
  if (!isScenario(scenario)) throw new Error(`scenarios/${name}.ts has no \`export default defineScenario(...)\``);
  return scenario;
}

/** A scenario picked from a list of all of them with their descriptions; undefined for exit. */
async function pickScenario(dir: string): Promise<string | undefined> {
  const names = readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => basename(file, '.ts'))
    .sort();
  const choices = [];
  for (const name of names) {
    const { description } = await loadScenario(dir, name);
    choices.push({ value: name, name: `${name.padEnd(22)}${pc.dim(description)}` });
  }
  const picked = await select({
    message: 'select a scenario',
    choices: [
      ...choices,
      { type: 'separator' as const, separator: MENU_DIVIDER },
      { value: '', name: pc.red(`${'exit'.padEnd(22)}${pc.dim('quit without running')}`) },
    ],
    loop: false,
  });
  return picked || undefined;
}

async function runRequest<State>(bench: Bench<State>, request: BenchRequest): Promise<number> {
  const picked = request.scenarios.length > 0 ? undefined : await pickScenario(request.scenariosDir);
  const names = picked ? [picked] : request.scenarios;
  if (names.length === 0) return 0;
  const scenarios: [name: string, scenario: Scenario][] = [];
  for (const name of names) scenarios.push([name, await loadScenario(request.scenariosDir, name)]);

  if (bench.preflight) {
    createSpinner(`checking the stack at ${bench.target}`);
    await bench.preflight();
  }
  printStep('stack', bench.target);

  // A second run would seed and reset under the first one's measurement
  const claimed = acquireLock(request.dataDir, bench.target, request.all ? '--all' : names[0]);
  if ('holder' in claimed) {
    const { pid, scenario, startedAt } = claimed.holder;
    const message = `another bench run holds ${bench.target}: pid ${pid} runs ${scenario} since ${new Date(startedAt).toLocaleTimeString('en-GB')}`;
    throw new Error(message);
  }
  const { lock } = claimed;
  for (const other of lock.others) {
    console.info(
      `${warningMark} bench pid ${other.pid} runs ${other.scenario} on ${other.target}: it shares this machine, numbers will be skewed`,
    );
  }

  if (bench.seed && !request.skipSeed) {
    createSpinner('seeding the bench data');
    await bench.seed();
    printStep('seeded', pc.dim('bench data written again'));
  }
  await bench.beforeAll?.({ skipSeed: request.skipSeed });

  const cooldownS = request.all && !request.short ? (bench.cooldownSeconds ?? DEFAULT_COOLDOWN_S) : 0;
  const rows: SuiteRow[] = [];
  for (const [index, [name, scenario]] of scenarios.entries()) {
    lock.update(name);
    const state = await bench.beforeEach?.(name);
    let columns: Record<string, string> = {};
    const result = await runScenario(scenario, {
      name,
      target: bench.target,
      dataDir: request.dataDir,
      short: request.short,
      quiet: request.all,
      afterRun: async (outcome) => {
        if (!bench.afterEach) return [];
        const app = await bench.afterEach(outcome, state);
        columns = app.columns ?? {};
        return app.checks;
      },
    });
    rows.push({ name, ok: result.ok, current: result.current, baseline: result.baseline, columns });

    if (cooldownS > 0 && index < scenarios.length - 1) {
      const spinner = createSpinner(`cooling down ${cooldownS} s`);
      await sleep(cooldownS * 1000);
      spinner.stop();
    }
  }
  lock.release();

  const failed = rows.filter((row) => !row.ok).map((row) => row.name);
  if (request.all && !request.short) for (const line of suiteLines(rows)) console.info(line);
  else if (request.all && failed.length === 0) console.info(`\n${pc.green('✓')} every scenario passed its short run`);
  else if (request.all) console.info(`\n${pc.red('✗')} the short run failed for ${failed.join(', ')}`);
  return failed.length > 0 ? 1 : 0;
}

/**
 * The app's bench entry: runs what `pnpm cella bench` asked for with the app's hooks. The preflight, a lock on the
 * target, the seed and `beforeAll` come first; then each scenario between `beforeEach` and `afterEach`, the app's checks
 * joining the scenario's own. Sets the exit code: 1 when a scenario failed or a hook threw.
 */
export async function runBench<State = undefined>(bench: Bench<State>): Promise<void> {
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  try {
    process.exitCode = await runRequest(bench, readRequest());
  } catch (error) {
    spinnerFail(errorMessage(error));
    process.exitCode = 1;
  }
}

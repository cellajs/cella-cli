import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Command } from '../command';
import { runCommand, withTestbed } from '../testbed';
import { toolDir } from '../utils/app';
import { type BenchRequest, benchRequestEnv } from './request';

/** The app's bench, in the backend so that it imports the backend's modules by `#/`. */
const benchDir = 'backend/bench';
/**
 * The app's entry, run by the backend's tsx in the backend folder, so the backend's tsconfig paths resolve. Node's Web
 * Storage is off: it warns once a library probes `localStorage`.
 */
const entryCommand = ['pnpm', 'exec', 'tsx', '--no-experimental-webstorage', 'bench/run.ts'];

interface BenchOptions {
  /** Unset: pick one from a list, unless `all`. */
  scenario?: string;
  all: boolean;
  short: boolean;
  skipSeed: boolean;
  rttMs: number;
  /** Run on a testbed: this checkout's running one, else one started for the run and stopped after. */
  isolated: boolean;
}

/** Runs the app's `bench/run.ts` with the request in its environment. */
async function launchBench(repoRoot: string, options: BenchOptions): Promise<number> {
  if (!existsSync(join(repoRoot, benchDir, 'run.ts'))) {
    throw new Error(`${benchDir}/run.ts is missing: upgrade the app from cella first`);
  }
  const scenariosDir = join(repoRoot, benchDir, 'scenarios');
  const names = readdirSync(scenariosDir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => basename(file, '.ts'))
    .sort();
  if (options.scenario && !names.includes(options.scenario)) {
    throw new Error(`unknown scenario '${options.scenario}'. expected one of: ${names.join(', ')}`);
  }

  const request: BenchRequest = {
    scenarios: options.all ? names : options.scenario ? [options.scenario] : [],
    all: options.all,
    short: options.short,
    skipSeed: options.skipSeed,
    rttMs: options.rttMs,
    scenariosDir,
    dataDir: toolDir(repoRoot, 'bench', 'repository'),
  };
  const run = (env: NodeJS.ProcessEnv) =>
    runCommand(join(repoRoot, 'backend'), { ...env, [benchRequestEnv]: JSON.stringify(request) }, entryCommand);
  return options.isolated ? withTestbed(repoRoot, (testbed) => run(testbed.env)) : run({ ...process.env });
}

export const benchCommand: Command<BenchOptions> = {
  name: 'bench',
  group: 'develop',
  description: 'load-test the running app and check what the stack did with the load',
  jobs: [],
  operands: ['[scenario]', 'a scenario of backend/bench/scenarios/ (default: pick one from a list)'],
  options: [
    ['--all', 'run every scenario in turn, one line each and a table at the end'],
    ['--short', 'smoke run: one VU per role, no thresholds, no baselines'],
    ['--isolated', 'run on a testbed, not on the stack `pnpm dev` runs'],
    ['--skip-seed', 'keep the bench data the last run seeded'],
    ['--rtt <ms>', 'emulate a network round trip of <ms> on every request and stream'],
  ],
  parse: ({ operands, opts }) => {
    const [scenario, ...extra] = operands;
    if (extra.length > 0) throw new Error(`unexpected argument '${extra[0]}'. bench runs one scenario, or --all`);
    if (scenario && opts.all === true) throw new Error('name a scenario or pass --all, not both');
    const rttMs = opts.rtt === undefined ? 0 : Number(opts.rtt);
    if (!Number.isInteger(rttMs) || rttMs < 0) throw new Error('--rtt takes a whole number of milliseconds, 0 or more');
    return {
      scenario,
      all: opts.all === true,
      short: opts.short === true,
      skipSeed: opts.skipSeed === true,
      rttMs,
      isolated: opts.isolated === true,
    };
  },
  run: launchBench,
};

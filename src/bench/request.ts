/** The variable that hands the app's bench entry what `pnpm cella bench` asks of it, as JSON. */
export const BENCH_REQUEST_ENV = 'CELLA_BENCH';

/** What `pnpm cella bench` asks of the app's bench entry. */
export interface BenchRequest {
  /** Scenario names in run order; empty to pick one from a list. */
  scenarios: string[];
  /** Every scenario in turn: one line each, a cooldown between full runs and a table at the end. */
  all: boolean;
  short: boolean;
  skipSeed: boolean;
  /** Absolute path of the folder whose `<name>.ts` modules are the scenarios. */
  scenariosDir: string;
  /** Holds `baselines/`, `logs/` and `locks/`. */
  dataDir: string;
}

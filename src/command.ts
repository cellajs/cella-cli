import type { CellaCliConfig } from './config/types';

/** A command's `--help` heading and menu place; a gate shows in `--help` only, since scripts and CI run it. */
export type CommandGroup = 'develop' | 'security' | 'operate' | 'upstream' | 'gate';

/** Flags or an argument in commander's notation, with its line in `--help`. */
export type CommandOption = [flags: string, description: string];

/** What the menu knows when it decides which commands to show. */
export interface MenuContext {
  /** The app's `cella.config.ts` lists forks; false without that file. */
  hasForks: boolean;
  /** The checkout is the template itself, which has no upstream to upgrade from. */
  isUpstreamRepo: boolean;
  /** The app has an `infra` workspace. */
  hasInfra: boolean;
}

interface CommandBase<Options, Job extends string | undefined> {
  name: string;
  group: CommandGroup;
  description: string;
  /** Whether the menu shows it: always unless set, and never for a gate. */
  inMenu?: (context: MenuContext) => boolean;
  /** Runs outside a git repository too: the entry skips its git check. */
  outsideGit?: true;
  /**
   * Takes every word after its name unparsed, parses them itself and prints all the run shows: the entry adds no
   * header or closing line, and `--help` after the name is the command's own.
   */
  handsOver?: true;
  /**
   * The jobs its first operand names, the default first. The entry refuses any other and hands the default to `parse`
   * when none is named; the menu asks for one that runs without words. Empty: the command has one job.
   */
  jobs: [name: Exclude<Job, undefined>, description: string][];
  /**
   * The words it takes after the job, in commander's notation such as `[scenario]` or `[paths...]`; none when unset.
   * Variadic ones also collect the words after `--`, which `parse` gets apart as the passthrough.
   */
  operands?: CommandOption;
  /** Its options; one that names a job is refused with any other job and says so in `--help`. */
  options?: [flags: string, description: string, job?: Exclude<Job, undefined>][];
  /** What the words after `--` are for, in `--help`, for a command without operands. */
  passthrough?: CommandOption;
  /** The options, by attribute name (`json` for `--json`), that keep stdout for the payload: the rest goes to stderr. */
  machineOutput?: string[];
  parse(input: { job: Job; operands: string[]; opts: Record<string, unknown>; passthrough: string[] }): Options;
}

/**
 * A command of the CLI: it declares its jobs, operands and options and parses them into its own shape. `run` returns the
 * exit code: 0 when the run is done or a plain rerun advances it, 1 when a check failed or a person must act before it
 * can go on. A thrown error and a usage error exit 2. A command that reads the app's `cella/cella.config.ts` sets
 * `needsConfig`, and the entry loads the config for its `run`.
 */
export type Command<Options = unknown, Job extends string | undefined = string | undefined> = CommandBase<Options, Job> &
  (
    | { needsConfig?: undefined; run(repoRoot: string, options: Options): Promise<number> }
    | { needsConfig: true; run(repoRoot: string, options: Options, config: CellaCliConfig): Promise<number> }
  );

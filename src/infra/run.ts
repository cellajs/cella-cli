import { type CliArgs, parseCliArgs } from './cli/args';
import { infraHelp } from './cli/help';
import { isEnvironment } from './lib/stack/environment';
import { crossMark, pc } from './lib/utils/cli-output';
import { ExitCodeError, errorMessage } from './lib/utils/errors';

/**
 * The engine's tasks by name, which `cella infra <task>` runs: CI calls them by `pnpm cella infra <task>`, the image, the builder and the
 * engine itself by the `cella` package's bin (lib/utils/engine-task.ts). A task is handed the words after its name.
 */
export const tasks: Record<string, (words: string[]) => Promise<unknown>> = {
  'main-job': async () => {
    const { liveEffects, mainJob } = await import('./tasks/main-job');
    process.exit(await mainJob(process.env, liveEffects()));
  },
  deploy: async (words) => (await import('./tasks/deploy')).main(words),
  'description-hash': async (words) => (await import('./tasks/description-hash')).main(words),
  description: async (words) => (await import('./tasks/description-hash')).printDescription(words),
  'builder-script': async (words) => (await import('./tasks/print-builder-script')).main(words),
  compose: async () => (await import('./compose/synth')).main(),
  'privileged-footprint': async (words) => (await import('./tasks/privileged-footprint')).main(words),
  'privileged-check': async (words) => (await import('./tasks/privileged-check')).main(words),
  'release-applied-check': async () => (await import('./tasks/release-applied-check')).main(),
  'ensure-state-bucket': async () => (await import('./tasks/ensure-state-bucket')).main(),
  'repair-certs': async (words) => (await import('./tasks/repair-certs')).main(words),
};

/** Why the CLI cannot start on `args`, then where the help lists what it takes; undefined when it can. */
function usageError(args: CliArgs): string | undefined {
  const listed = (line: string, lists: 'actions' | 'options') => `${crossMark} ${line}\n  ${pc.dim(`pnpm cella infra help lists the ${lists}`)}`;
  if (args.refusal) return listed(args.refusal, 'options');
  if (args.unknownAction) return listed(`'${args.unknownAction}' is no action of the infra CLI.`, 'actions');
  if (args.mode !== undefined && !isEnvironment(args.mode)) return `${crossMark} --mode must be 'production' or 'staging' (got '${args.mode}').`;
  if (!args.action && !process.stdin.isTTY) return listed('The menu needs a terminal. Name an action to run one without it.', 'actions');
  return undefined;
}

/**
 * Runs a task, or the infra CLI with every other first word: the CLI ends the process itself, after a prompt aborted at its
 * top level too. The help and a command line the CLI refuses are answered before the CLI's import loads the app's config.
 * @returns a task's exit code, 0 after the help, 2 for a command line the CLI refuses
 */
export async function runInfra(words: string[]): Promise<number> {
  const [first = '', ...rest] = words;
  const task = Object.hasOwn(tasks, first) ? tasks[first] : undefined;
  if (task) return runTask(task, rest);
  const args = parseCliArgs(words);
  if (args.help) {
    process.stdout.write(infraHelp());
    return 0;
  }
  const refusal = usageError(args);
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  const { runInfraCli } = await import('./cli/infra-cli');
  try {
    await runInfraCli(args);
  } catch (error) {
    // A rejection at the CLI's top level ends here, and the CLI's uncaught-exception handler never sees it
    const { endIfPromptAbort } = await import('./cli/prompts/abort');
    if (!endIfPromptAbort(error)) throw error;
  }
  return 0;
}

/**
 * Runs one task to its end. A check that fails without throwing, such as the release check when an apply is owed, sets
 * the process's exit code: the CLI ends with it.
 * @returns the code the task returned, else the exit code it set, else 0; the code an `ExitCodeError` names, or 1 for another error
 */
export async function runTask(task: (words: string[]) => Promise<unknown>, words: string[]): Promise<number> {
  try {
    const code = await task(words);
    return typeof code === 'number' ? code : Number(process.exitCode ?? 0);
  } catch (error) {
    console.error(errorMessage(error));
    return error instanceof ExitCodeError ? error.exitCode : 1;
  }
}

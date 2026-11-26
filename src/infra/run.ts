import { ExitCodeError, errorMessage } from './lib/utils/errors';

/**
 * The engine's tasks by the script name the app's `infra` workspace runs them under: the main job, the image and the
 * builder, CI and the engine itself call them. A task is handed the words after its name.
 */
export const tasks: Record<string, (words: string[]) => Promise<unknown>> = {
  'main-job': async () => {
    const { liveEffects, mainJob } = await import('./tasks/main-job');
    process.exit(await mainJob(process.env, liveEffects()));
  },
  deploy: async (words) => (await import('./tasks/deploy')).main(words),
  'description-hash': async (words) => (await import('./tasks/description-hash')).main(words),
  'builder-script': async (words) => (await import('./tasks/print-builder-script')).main(words),
  'compose-generate': async (words) => (await import('./compose/synth')).main(words),
  'compose-check': async (words) => (await import('./compose/synth')).main([...words, '--check']),
  'privileged-footprint': async (words) => (await import('./tasks/privileged-footprint')).main(words),
  'privileged-check': async (words) => (await import('./tasks/privileged-check')).main(words),
  'release-applied-check': async () => (await import('./tasks/release-applied-check')).main(),
  'ensure-state-bucket': async () => (await import('./tasks/ensure-state-bucket')).main(),
  'repair-certs': async (words) => (await import('./tasks/repair-certs')).main(words),
};

/**
 * Runs a task, or the infra CLI with every other first word: the CLI ends the process itself, after a prompt aborted at its
 * top level too.
 * @returns a task's exit code
 */
export async function runInfra(words: string[]): Promise<number> {
  const [first = '', ...rest] = words;
  const task = Object.hasOwn(tasks, first) ? tasks[first] : undefined;
  if (task) return runTask(task, rest);
  const { runInfraCli } = await import('./cli/infra-cli');
  try {
    await runInfraCli(words);
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

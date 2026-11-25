import { ExitCodeError, errorMessage } from './lib/utils/errors';

/**
 * The engine's tasks by the script name the app's `infra` workspace runs them under: the main job, the image and the
 * builder, CI and the engine itself call them. A task that reads its own words gets them in `process.argv`.
 */
const tasks: Record<string, (words: string[]) => Promise<unknown>> = {
  'main-job': async () => {
    const { liveEffects, mainJob } = await import('./tasks/main-job');
    process.exit(await mainJob(process.env, liveEffects()));
  },
  deploy: () => import('./tasks/deploy'),
  'description-hash': () => import('./tasks/description-hash'),
  'builder-script': () => import('./tasks/print-builder-script'),
  'compose-generate': async () => (await import('./compose/synth')).main(),
  'compose-check': async () => (await import('./compose/synth')).main(),
  'privileged-footprint': async (words) => (await import('./tasks/privileged-footprint')).main(words),
  'privileged-check': async (words) => (await import('./tasks/privileged-check')).main(words),
  'release-applied-check': async () => (await import('./tasks/release-applied-check')).main(),
  'ensure-state-bucket': async (words) => (await import('./tasks/ensure-state-bucket')).main(words),
  'repair-certs': async (words) => (await import('./tasks/repair-certs')).main(words),
};

/**
 * Runs a task, or the infra CLI with every other first word: the CLI reads its words from `process.argv` and ends the
 * process itself.
 * @returns a task's exit code: 0, or the code an `ExitCodeError` names, else 1
 */
export async function runInfra(words: string[]): Promise<number> {
  const [first = '', ...rest] = words;
  const task = Object.hasOwn(tasks, first) ? tasks[first] : undefined;
  if (!task) {
    process.argv = [process.argv[0] ?? 'node', 'infra', ...words];
    await import('./cli/infra-cli');
    return 0;
  }
  process.argv = [process.argv[0] ?? 'node', first, ...rest, ...(first === 'compose-check' ? ['--check'] : [])];
  try {
    await task(rest);
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return error instanceof ExitCodeError ? error.exitCode : 1;
  }
}

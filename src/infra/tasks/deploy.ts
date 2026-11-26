import { errorMessage } from '../lib/utils/errors';

/**
 * Thin loader for the deploy task. APP_MODE must be in the environment BEFORE the deploy implementation's import graph loads: ESM hoists
 * imports, and that graph evaluates the app's config at load time. Parse the mode here with no app imports, then load the implementation
 * dynamically.
 * @returns 1 without a mode; a run that fails ends the process with its exit code
 */
export async function main(words: string[]): Promise<number> {
  const modeIndex = words.indexOf('--mode');
  const mode = modeIndex >= 0 ? words[modeIndex + 1] : undefined;
  if (!mode) {
    console.error('Usage: deploy --mode <staging|production> --sha <git-sha> [--retry <n>]');
    return 1;
  }
  process.env.APP_MODE = mode;

  const { deployFailureHint, main: deploy } = await import('./deploy-run');
  await deploy(words).catch(async (err: unknown) => {
    const { failWithHint } = await import('../lib/utils/cli-output');
    const { ExitCodeError } = await import('../lib/utils/errors');
    // A run that ended blocked or apply needed keeps its exit code: the main job tells it from a failure.
    failWithHint(errorMessage(err), deployFailureHint(err, mode), err instanceof ExitCodeError ? err.exitCode : 1);
  });
  return 0;
}

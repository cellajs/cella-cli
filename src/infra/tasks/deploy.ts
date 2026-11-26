import { errorMessage } from '../lib/utils/errors';

// Thin loader for the deploy command. APP_MODE must be in the environment BEFORE the deploy implementation's import graph loads: ESM
// hoists imports, and that graph evaluates the app's config at load time. Parse the mode here with no app imports, then load the
// implementation dynamically.
const argv = process.argv.slice(2);
const modeIndex = argv.indexOf('--mode');
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
if (!mode) {
  console.error('Usage: deploy --mode <staging|production> --sha <git-sha> [--retry <n>]');
  process.exit(1);
}
process.env.APP_MODE = mode;

const { deployFailureHint, main } = await import('./deploy-run');
await main(argv).catch(async (err: unknown) => {
  const { failWithHint } = await import('../lib/utils/cli-output');
  const { ExitCodeError } = await import('../lib/utils/errors');
  // A run that ended blocked or apply needed keeps its exit code, so the main job can tell it from a failure.
  failWithHint(errorMessage(err), deployFailureHint(err, mode), err instanceof ExitCodeError ? err.exitCode : 1);
});

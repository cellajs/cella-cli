/**
 * The hash of this checkout's description of the app for one environment, printed alone on stdout: what an apply records, the engine
 * image's build checks and a builder reports from the target's checkout, keyless. APP_MODE is set before the config loads, as deploy.ts does.
 * With --json it prints the description itself as the canonical text the hash is taken of, which a builder puts in the manifest beside it.
 * @returns 1 without `--mode` or APP_MODE
 */
export async function main(words: string[]): Promise<number> {
  const modeIndex = words.indexOf('--mode');
  const mode = modeIndex >= 0 ? words[modeIndex + 1] : process.env.APP_MODE;
  if (!mode) {
    console.error('Usage: description-hash --mode <staging|production> [--json] (or APP_MODE)');
    return 1;
  }
  process.env.APP_MODE = mode;

  const [{ appDescription, appDescriptionHash }, { canonicalJson }] = await Promise.all([
    import('../lib/deploy/app-description'),
    import('../lib/deploy/applied-engine'),
  ]);
  process.stdout.write(`${words.includes('--json') ? canonicalJson(await appDescription()) : await appDescriptionHash()}\n`);
  return 0;
}
